#include "DeepgramSpeech.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <atomic>
#include <cstring>
#include <esp_heap_caps.h>
#include <freertos/semphr.h>
#include <mbedtls/platform.h>
#include "AudioPlayer.h"
#include "DeepgramRootCa.h"
#include "DeepgramWire.h"
#include "SpeechWire.h"

namespace copilot {
namespace {
constexpr char kPreferencesNamespace[] = "agent-speech";
// With mbedTLS in PSRAM, internal RAM still holds the socket, lwIP buffers and the task stack.
constexpr size_t kMinTlsInternalBytes = 12 * 1024;
constexpr uint32_t kTaskStackBytes = 12 * 1024;
constexpr uint32_t kConnectTimeoutMs = 10000;
constexpr uint32_t kResponseTimeoutMs = 20000;
constexpr uint32_t kHandshakeTimeoutSeconds = 15;
constexpr size_t kPlaybackChunkBytes = 4096;
// The longest clip plays for 15 seconds; give the audio task a little longer to finish.
constexpr uint32_t kPlaybackWaitMs = (kMaxSpeechSeconds + 5) * 1000;

SemaphoreHandle_t lock = nullptr;
TaskHandle_t task = nullptr;
char key[kMaxDeepgramKeyBytes + 1] = {};
char model[kMaxDeepgramModelBytes + 1] = "flux-haley-en";
char pendingText[kMaxSpeakTextBytes + 1] = {};
size_t pendingLength = 0;
// Always a string literal, so the status page can read it at any time.
std::atomic<const char*> lastError{nullptr};
std::atomic<bool> speaking{false};

class Locked {
 public:
  Locked() { xSemaphoreTake(lock, portMAX_DELAY); }
  ~Locked() { xSemaphoreGive(lock); }
};

// Collects the response body into a fixed PSRAM buffer; HTTPClient decodes chunked replies first.
class BufferStream : public Stream {
 public:
  BufferStream(uint8_t* buffer, size_t capacity) : buffer_(buffer), capacity_(capacity) {}
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* data, size_t bytes) override {
    if (bytes > capacity_ - used_) {
      overflow_ = true;
      return 0;
    }
    std::memcpy(buffer_ + used_, data, bytes);
    used_ += bytes;
    return bytes;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  size_t used() const { return used_; }
  bool overflow() const { return overflow_; }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t used_ = 0;
  bool overflow_ = false;
};

// This core builds mbedTLS to allocate only internal RAM, where its two 16 KB record buffers
// rarely fit beside Wi-Fi and the renderer. While this request runs, mbedTLS allocates from
// PSRAM first. heap_caps_free releases blocks from either heap, so anything allocated before
// or after the switch is freed correctly.
void* tlsCalloc(size_t count, size_t size) {
  return heap_caps_calloc_prefer(count, size, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
                                 MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void tlsFree(void* pointer) {
  heap_caps_free(pointer);
}

// The core's own esp_mbedtls_mem_calloc under CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC. Its header
// arrives through the TLS headers without C linkage, so it can't be named here.
void* tlsInternalCalloc(size_t count, size_t size) {
  return heap_caps_calloc(count, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

class TlsInPsram {
 public:
  TlsInPsram() { mbedtls_platform_set_calloc_free(tlsCalloc, tlsFree); }
  ~TlsInPsram() { mbedtls_platform_set_calloc_free(tlsInternalCalloc, tlsFree); }
};

// Clears a copy of the key on every way out of the request.
class Wipe {
 public:
  Wipe(char* data, size_t bytes) : data_(data), bytes_(bytes) {}
  ~Wipe() { std::memset(data_, 0, bytes_); }

 private:
  char* data_;
  size_t bytes_;
};

void fail(const char* error) {
  lastError.store(error);
  Serial.printf("DEEPGRAM error=%s\n", error);
}

const char* statusError(int status) {
  if (status == 401 || status == 403) return "Deepgram rejected the API key.";
  if (status == 429) return "Deepgram rate limit reached. Try again shortly.";
  if (status == 400) return "Deepgram rejected the speech request.";
  if (status < 0) return "Could not reach Deepgram.";
  return "Deepgram speech failed.";
}

// Hands the samples to the audio task in pieces and waits until the speaker is done with them.
void play(const uint8_t* pcm, size_t bytes) {
  if (const char* error = beginSpeech(bytes / sizeof(int16_t))) return fail(error);
  for (size_t sent = 0; sent < bytes; sent += kPlaybackChunkBytes) {
    const size_t chunk = bytes - sent < kPlaybackChunkBytes ? bytes - sent : kPlaybackChunkBytes;
    if (const char* error = writeSpeech(pcm + sent, chunk)) return fail(error);
  }
  if (const char* error = finishSpeech()) return fail(error);
  const uint32_t started = millis();
  while (speechBusy() && millis() - started < kPlaybackWaitMs) vTaskDelay(pdMS_TO_TICKS(20));
}

void speakPending() {
  static char localKey[kMaxDeepgramKeyBytes + 1];
  static char localModel[kMaxDeepgramModelBytes + 1];
  static char text[kMaxSpeakTextBytes + 1];
  size_t length;
  Wipe wipeKey(localKey, sizeof(localKey));
  {
    Locked locked;
    std::memcpy(localKey, key, sizeof(localKey));
    std::memcpy(localModel, model, sizeof(localModel));
    std::memcpy(text, pendingText, sizeof(text));
    length = pendingLength;
  }
  if (!localKey[0]) return fail("Add a Deepgram API key in Settings.");
  if (WiFi.status() != WL_CONNECTED) return fail("The device is not connected to Wi-Fi.");
  char path[160];
  if (!buildSpeakPath(localModel, path, sizeof(path))) return fail("Invalid speech request.");
  // The escaped body can reach 3 KB; keep it out of internal RAM, which TLS needs.
  char* body = static_cast<char*>(heap_caps_malloc(kMaxSpeakBodyBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!body) return fail("Not enough memory for the speech request.");
  const size_t bodyLength = buildSpeakBody(text, length, body, kMaxSpeakBodyBytes);
  if (!bodyLength) {
    heap_caps_free(body);
    return fail("Invalid speech request.");
  }

  const size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  Serial.printf("DEEPGRAM request internal_free=%u internal_largest=%u psram_largest=%u\n",
                static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                static_cast<unsigned>(largest),
                static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM)));
  if (largest < kMinTlsInternalBytes) {
    heap_caps_free(body);
    return fail("Not enough memory for a secure connection.");
  }

  uint8_t* audio = nullptr;
  int status = -1;
  size_t received = 0;
  bool overflow = false;
  {
    TlsInPsram tlsInPsram;
    NetworkClientSecure client;
    // Pinned roots: the key never goes to a server that can't prove it is api.deepgram.com.
    client.setCACert(kDeepgramRootCa);
    client.setHandshakeTimeout(kHandshakeTimeoutSeconds);
    HTTPClient http;
    http.setReuse(false);
    http.setConnectTimeout(kConnectTimeoutMs);
    http.setTimeout(kResponseTimeoutMs);
    if (!http.begin(client, kDeepgramHost, 443, path, true)) {
      heap_caps_free(body);
      return fail("Could not reach Deepgram.");
    }
    char authorization[sizeof("Token ") + kMaxDeepgramKeyBytes];
    Wipe wipeAuthorization(authorization, sizeof(authorization));
    std::snprintf(authorization, sizeof(authorization), "Token %s", localKey);
    http.addHeader("Authorization", authorization);
    http.addHeader("Content-Type", "application/json");
    status = http.POST(reinterpret_cast<uint8_t*>(body), bodyLength);
    heap_caps_free(body);
    if (status == HTTP_CODE_OK) {
      const int declared = http.getSize();
      if (declared > static_cast<int>(kMaxSpeechPayloadBytes)) {
        http.end();
        return fail("Deepgram audio was longer than 15 seconds.");
      }
      // A known length needs only that much PSRAM; a chunked reply may need the 15-second maximum.
      const size_t capacity = declared > 0 ? static_cast<size_t>(declared) : kMaxSpeechPayloadBytes;
      audio = static_cast<uint8_t*>(heap_caps_malloc(capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!audio) {
        http.end();
        return fail("Not enough memory for the speech audio.");
      }
      BufferStream stream(audio, capacity);
      const int written = http.writeToStream(&stream);
      received = stream.used();
      overflow = stream.overflow();
      if (written < 0 && !overflow) status = written;
    }
    http.end();
  }

  if (status != HTTP_CODE_OK) {
    heap_caps_free(audio);
    return fail(statusError(status));
  }
  if (overflow) {
    heap_caps_free(audio);
    return fail("Deepgram audio was longer than 15 seconds.");
  }
  size_t offset = 0;
  size_t bytes = 0;
  if (!findDeepgramPcm(audio, received, offset, bytes)) {
    heap_caps_free(audio);
    return fail("Deepgram returned no audio.");
  }
  Serial.printf("DEEPGRAM play frames=%u\n", static_cast<unsigned>(bytes / sizeof(int16_t)));
  play(audio + offset, bytes);
  heap_caps_free(audio);
}

void speechTask(void*) {
  while (true) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    speakPending();
    speaking.store(false);
  }
}
}

void beginDeepgramSpeech() {
  if (lock) return;
  lock = xSemaphoreCreateMutex();
  if (!lock) {
    Serial.println("DEEPGRAM error=mutex-create");
    return;
  }
  Preferences preferences;
  if (preferences.begin(kPreferencesNamespace, true)) {
    char savedKey[kMaxDeepgramKeyBytes + 1] = {};
    char savedModel[kMaxDeepgramModelBytes + 1] = {};
    // Missing keys would log errors at startup, so look before reading.
    const size_t keyLength = preferences.isKey("key")
        ? preferences.getString("key", savedKey, sizeof(savedKey)) : 0;
    const size_t modelLength = preferences.isKey("model")
        ? preferences.getString("model", savedModel, sizeof(savedModel)) : 0;
    preferences.end();
    // getString counts the terminator.
    if (keyLength > 1 && validDeepgramKey(savedKey, keyLength - 1)) std::memcpy(key, savedKey, keyLength);
    if (modelLength > 1 && validFluxModel(savedModel, modelLength - 1)) std::memcpy(model, savedModel, modelLength);
    std::memset(savedKey, 0, sizeof(savedKey));
  }
}

const char* setDeepgramConfig(const char* newKey, const char* newModel) {
  if (!lock) return "Deepgram speech is unavailable.";
  const size_t keyLength = std::strlen(newKey);
  const size_t modelLength = std::strlen(newModel);
  if ((keyLength && !validDeepgramKey(newKey, keyLength)) || !validFluxModel(newModel, modelLength))
    return "Invalid speech settings.";
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return "Could not save speech settings.";
  bool saved = preferences.putString("model", newModel) == modelLength;
  if (keyLength) saved = saved && preferences.putString("key", newKey) == keyLength;
  else if (preferences.isKey("key")) preferences.remove("key");
  preferences.end();
  if (!saved) return "Could not save speech settings.";
  Locked locked;
  std::memcpy(key, newKey, keyLength + 1);
  std::memcpy(model, newModel, modelLength + 1);
  lastError.store(nullptr);
  return nullptr;
}

bool deepgramConfigured() {
  if (!lock) return false;
  Locked locked;
  return key[0] != '\0';
}

bool deepgramSpeaking() {
  return speaking.load();
}

const char* deepgramError() {
  return lastError.load();
}

DeepgramRequest requestDeepgramSpeech(const char* text, size_t length) {
  if (!lock || !audioReady()) return DeepgramRequest::Unavailable;
  if (!validSpeakText(text, length)) return DeepgramRequest::Invalid;
  if (!deepgramConfigured()) return DeepgramRequest::Unconfigured;
  // The task starts on first use, so a device that never calls Deepgram keeps its RAM.
  if (!task && xTaskCreatePinnedToCore(speechTask, "deepgram", kTaskStackBytes, nullptr, 1, &task, 0) != pdPASS) {
    task = nullptr;
    Serial.println("DEEPGRAM error=task-create");
    return DeepgramRequest::Unavailable;
  }
  bool idle = false;
  if (speechBusy() || !speaking.compare_exchange_strong(idle, true)) return DeepgramRequest::Busy;
  {
    Locked locked;
    std::memcpy(pendingText, text, length);
    pendingText[length] = '\0';
    pendingLength = length;
  }
  lastError.store(nullptr);
  xTaskNotifyGive(task);
  return DeepgramRequest::Accepted;
}
}

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

// Validation and request building for the device's own Deepgram Flux TTS calls. Header-only so
// the host tests can check it without the ESP32 toolchain.
namespace copilot {
constexpr size_t kMinDeepgramKeyBytes = 20;
constexpr size_t kMaxDeepgramKeyBytes = 128;
constexpr size_t kMaxDeepgramModelBytes = 40;
constexpr size_t kMaxSpeakTextBytes = 500;
// Each byte escapes to at most six (\u00XX), plus the braces and field name.
constexpr size_t kMaxSpeakBodyBytes = kMaxSpeakTextBytes * 6 + 16;
constexpr char kDeepgramHost[] = "api.deepgram.com";

// Printable ASCII without spaces, the same rule the daemon applies.
inline bool validDeepgramKey(const char* key, size_t length) {
  if (!key || length < kMinDeepgramKeyBytes || length > kMaxDeepgramKeyBytes) return false;
  for (size_t i = 0; i < length; ++i)
    if (key[i] < 0x21 || key[i] > 0x7e) return false;
  return true;
}

// flux-{voice}-en, with a lowercase voice name.
inline bool validFluxModel(const char* model, size_t length) {
  constexpr size_t kPrefix = 5;  // "flux-"
  constexpr size_t kSuffix = 3;  // "-en"
  if (!model || length <= kPrefix + kSuffix || length > kMaxDeepgramModelBytes) return false;
  if (std::strncmp(model, "flux-", kPrefix) != 0
      || std::strncmp(model + length - kSuffix, "-en", kSuffix) != 0) return false;
  for (size_t i = kPrefix; i < length - kSuffix; ++i)
    if (model[i] < 'a' || model[i] > 'z') return false;
  return true;
}

// Reads the "KEY\nMODEL" body of POST /speech-config. An empty key clears the setting.
// Returns nullptr on success, or the reason the body was rejected.
inline const char* parseDeepgramConfig(const char* body, size_t length,
                                       char* key, size_t keyCapacity,
                                       char* model, size_t modelCapacity) {
  if (!body || keyCapacity <= kMaxDeepgramKeyBytes || modelCapacity <= kMaxDeepgramModelBytes)
    return "Invalid speech settings.";
  const char* newline = static_cast<const char*>(std::memchr(body, '\n', length));
  if (!newline) return "Send the key and model on separate lines.";
  const size_t keyLength = static_cast<size_t>(newline - body);
  size_t modelLength = length - keyLength - 1;
  const char* modelText = newline + 1;
  while (modelLength > 0 && (modelText[modelLength - 1] == '\n' || modelText[modelLength - 1] == '\r'))
    --modelLength;
  if (keyLength != 0 && !validDeepgramKey(body, keyLength)) return "Invalid Deepgram API key.";
  if (!validFluxModel(modelText, modelLength)) return "Invalid Deepgram Flux voice.";
  std::memcpy(key, body, keyLength);
  key[keyLength] = '\0';
  std::memcpy(model, modelText, modelLength);
  model[modelLength] = '\0';
  return nullptr;
}

// Text for POST /speak-text: not blank, at most 500 bytes, no control characters but tabs.
inline bool validSpeakText(const char* text, size_t length) {
  if (!text || length == 0 || length > kMaxSpeakTextBytes) return false;
  bool visible = false;
  for (size_t i = 0; i < length; ++i) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (c < 0x20 && c != '\t') return false;
    if (c == 0x7f) return false;
    if (c != ' ' && c != '\t') visible = true;
  }
  return visible;
}

// Writes {"text":"..."} with JSON escaping. UTF-8 bytes pass through unchanged.
// Returns the body length, or 0 when it does not fit.
inline size_t buildSpeakBody(const char* text, size_t length, char* output, size_t capacity) {
  static constexpr char kOpen[] = "{\"text\":\"";
  static constexpr char kClose[] = "\"}";
  size_t used = sizeof(kOpen) - 1;
  if (!output || capacity < used + sizeof(kClose)) return 0;
  std::memcpy(output, kOpen, used);
  for (size_t i = 0; i < length; ++i) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    char escaped[7];
    size_t bytes = 1;
    if (c == '"' || c == '\\') {
      escaped[0] = '\\';
      escaped[1] = static_cast<char>(c);
      bytes = 2;
    } else if (c < 0x20) {
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
      bytes = 6;
    } else {
      escaped[0] = static_cast<char>(c);
    }
    if (used + bytes + sizeof(kClose) > capacity) return 0;
    std::memcpy(output + used, escaped, bytes);
    used += bytes;
  }
  std::memcpy(output + used, kClose, sizeof(kClose));
  return used + sizeof(kClose) - 1;
}

// Finds the samples in Deepgram's reply: the whole body, or what follows a WAV data chunk id.
// A streamed WAV header can carry a placeholder size, so the bytes that arrived win.
inline bool findDeepgramPcm(const uint8_t* audio, size_t length, size_t& offset, size_t& bytes) {
  offset = 0;
  bytes = length;
  if (length >= 12 && std::memcmp(audio, "RIFF", 4) == 0 && std::memcmp(audio + 8, "WAVE", 4) == 0) {
    for (size_t at = 12; at + 8 <= length;) {
      const uint32_t size = static_cast<uint32_t>(audio[at + 4]) | static_cast<uint32_t>(audio[at + 5]) << 8
          | static_cast<uint32_t>(audio[at + 6]) << 16 | static_cast<uint32_t>(audio[at + 7]) << 24;
      if (std::memcmp(audio + at, "data", 4) == 0) {
        offset = at + 8;
        bytes = length - offset < size ? length - offset : size;
        break;
      }
      if (size > length - at - 8) return false;
      at += 8 + size + (size & 1);
    }
    if (offset == 0) return false;
  }
  bytes &= ~static_cast<size_t>(1);
  return bytes > 0;
}

// The batch Flux TTS request: raw 24 kHz mono signed 16-bit PCM, the format the speaker plays.
inline bool buildSpeakPath(const char* model, char* output, size_t capacity) {
  if (!model || !validFluxModel(model, std::strlen(model))) return false;
  const int written = std::snprintf(
      output, capacity, "/v2/speak?model=%s&encoding=linear16&sample_rate=24000&container=none", model);
  return written > 0 && static_cast<size_t>(written) < capacity;
}
}

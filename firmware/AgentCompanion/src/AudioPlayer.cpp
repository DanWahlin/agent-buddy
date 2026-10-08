#include "AudioPlayer.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <freertos/stream_buffer.h>
#include "../generated/audio_assets.h"
#include "Config.h"
#include "SpeechWire.h"
#include "audio/es8311.h"

namespace copilot {
namespace {
struct AudioAsset {
  const int16_t* samples;
  uint32_t count;
};

I2SClass i2s;
QueueHandle_t cueQueue = nullptr;
StreamBufferHandle_t speechStream = nullptr;
es8311_handle_t codec = nullptr;
std::atomic<uint8_t> currentVolume{kDefaultSoundVolume};
std::atomic<bool> ready{false};
std::atomic<bool> speechReserved{false};
std::atomic<bool> speechStarted{false};
std::atomic<bool> speechEnded{false};
std::atomic<bool> speechAborted{false};
std::atomic<uint32_t> speechExpectedBytes{0};
std::atomic<uint32_t> speechReceivedBytes{0};

AudioAsset assetForCue(AudioCue cue) {
  switch (cue) {
    case AudioCue::Working:
      return {kAudioWorking, kAudioWorkingSamples};
    case AudioCue::Attention:
      return {kAudioAttention, kAudioAttentionSamples};
    case AudioCue::Complete:
      return {kAudioComplete, kAudioCompleteSamples};
    case AudioCue::Surprise:
      return {kAudioSurprise, kAudioSurpriseSamples};
    case AudioCue::Settings:
      return {kAudioSettings, kAudioSettingsSamples};
  }
  return {nullptr, 0};
}

int codecVolume(uint8_t volume) {
  return kAudioMinimumCodecVolume +
         (volume * (kAudioMaximumCodecVolume - kAudioMinimumCodecVolume) + 50) / 100;
}

bool writeAll(const uint8_t* data, size_t size) {
  while (size > 0) {
    const size_t written = i2s.write(data, size);
    if (written == 0) return false;
    data += written;
    size -= written;
  }
  return true;
}

bool startOutput() {
  const uint8_t volume = soundVolume();
  if (volume == 0) return false;
  if (es8311_voice_volume_set(codec, codecVolume(volume), nullptr) != ESP_OK) {
    Serial.println("AUDIO error=codec-output");
    return false;
  }
  digitalWrite(kAudioAmplifierPin, HIGH);
  delay(4);
  if (es8311_voice_mute(codec, false) == ESP_OK) return true;
  digitalWrite(kAudioAmplifierPin, LOW);
  Serial.println("AUDIO error=codec-output");
  return false;
}

void stopOutput() {
  constexpr size_t kSilenceFrames = 96;
  static int16_t silence[kSilenceFrames * 2] = {};
  writeAll(reinterpret_cast<const uint8_t*>(silence), sizeof(silence));
  es8311_voice_mute(codec, true);
  delay(2);
  digitalWrite(kAudioAmplifierPin, LOW);
}

bool playCue(AudioCue cue, AudioCue& replacement) {
  const uint8_t volume = soundVolume();
  if (volume == 0) return true;
  const AudioAsset asset = assetForCue(cue);
  if (!asset.samples || asset.count == 0) return true;

  if (!startOutput()) return true;

  constexpr size_t kChunkFrames = 512;
  static int16_t stereo[kChunkFrames * 2];
  bool interrupted = false;
  bool interruptedBySpeech = false;
  for (uint32_t offset = 0; offset < asset.count; offset += kChunkFrames) {
    if (soundVolume() == 0) break;
    if (speechStarted.load()) {
      interruptedBySpeech = true;
      break;
    }
    if (xQueueReceive(cueQueue, &replacement, 0) == pdTRUE) {
      interrupted = true;
      break;
    }
    const size_t frames =
        min(static_cast<uint32_t>(kChunkFrames), asset.count - offset);
    for (size_t frame = 0; frame < frames; ++frame) {
      stereo[frame * 2] = asset.samples[offset + frame];
      stereo[frame * 2 + 1] = asset.samples[offset + frame];
    }
    if (!writeAll(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
      Serial.println("AUDIO error=i2s-write");
      break;
    }
  }

  stopOutput();
  return interruptedBySpeech || !interrupted;
}

void playSpeech() {
  const uint32_t expected = speechExpectedBytes.load();
  uint32_t played = 0;
  bool output = startOutput();
  constexpr size_t kMonoBytes = 1024;
  static uint8_t mono[kMonoBytes + 1];
  static int16_t stereo[(kMonoBytes / 2) * 2];
  size_t pending = 0;
  while (!speechAborted.load()) {
    if (played == expected) {
      if (speechEnded.load()) break;
      vTaskDelay(1);
      continue;
    }
    const size_t received = xStreamBufferReceive(
        speechStream, mono + pending,
        std::min<size_t>(kMonoBytes - pending, expected - played),
        pdMS_TO_TICKS(250));
    if (received == 0) {
      if (speechEnded.load()) break;
      continue;
    }
    const size_t available = pending + received;
    const size_t audioBytes = available & ~size_t{1};
    if (output && soundVolume() > 0) {
      const size_t frames = audioBytes / 2;
      for (size_t frame = 0; frame < frames; ++frame) {
        const int16_t sample = static_cast<int16_t>(
            static_cast<uint16_t>(mono[frame * 2])
            | static_cast<uint16_t>(mono[frame * 2 + 1]) << 8);
        stereo[frame * 2] = sample;
        stereo[frame * 2 + 1] = sample;
      }
      if (!writeAll(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
        Serial.println("AUDIO error=i2s-write");
        speechAborted.store(true);
        break;
      }
    } else {
      if (output) stopOutput();
      output = false;
    }
    pending = available - audioBytes;
    if (pending) mono[0] = mono[audioBytes];
    played += received;
  }
  if (output) stopOutput();
  else digitalWrite(kAudioAmplifierPin, LOW);
  if (!speechAborted.load() && (played != expected || pending != 0))
    Serial.printf("AUDIO error=speech-short played=%u expected=%u\n",
                  static_cast<unsigned>(played), static_cast<unsigned>(expected));
  xStreamBufferReset(speechStream);
  speechExpectedBytes.store(0);
  speechReceivedBytes.store(0);
  speechEnded.store(false);
  speechAborted.store(false);
  speechStarted.store(false);
  speechReserved.store(false);
}

void audioTask(void*) {
  pinMode(kAudioAmplifierPin, OUTPUT);
  digitalWrite(kAudioAmplifierPin, LOW);
  i2s.setPins(kAudioBclkPin, kAudioWordSelectPin, kAudioDataOutPin, -1,
              kAudioMclkPin);
  if (!i2s.begin(I2S_MODE_STD, kAudioSampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    Serial.println("AUDIO error=i2s-init");
    vTaskDelete(nullptr);
    return;
  }

  codec = es8311_create(0, ES8311_ADDRESS_0);
  const es8311_clock_config_t clock = {
      .mclk_inverted = false,
      .sclk_inverted = false,
      .mclk_from_mclk_pin = true,
      .mclk_frequency = static_cast<int>(kAudioSampleRate * 256),
      .sample_frequency = static_cast<int>(kAudioSampleRate),
  };
  if (!codec ||
      es8311_init(codec, &clock, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) !=
          ESP_OK ||
      es8311_sample_frequency_config(codec, clock.mclk_frequency,
                                     clock.sample_frequency) != ESP_OK ||
      es8311_voice_fade(codec, ES8311_FADE_64LRCK) != ESP_OK ||
      es8311_voice_mute(codec, true) != ESP_OK) {
    Serial.println("AUDIO error=codec-init");
    if (codec) {
      es8311_delete(codec);
      codec = nullptr;
    }
    i2s.end();
    vTaskDelete(nullptr);
    return;
  }
  Serial.printf("AUDIO ready sample_rate=%u volume=%u\n", kAudioSampleRate,
                static_cast<unsigned>(currentVolume.load()));
  ready.store(true);

  AudioCue cue;
  while (true) {
    if (speechStarted.load()) {
      playSpeech();
      continue;
    }
    if (xQueueReceive(cueQueue, &cue, pdMS_TO_TICKS(20)) != pdTRUE) continue;
    AudioCue replacement = cue;
    while (!playCue(cue, replacement)) cue = replacement;
  }
}
}

bool beginAudio() {
  if (cueQueue) return true;
  cueQueue = xQueueCreate(1, sizeof(AudioCue));
  speechStream = xStreamBufferCreate(kSpeechStreamBufferBytes, 1);
  if (!cueQueue || !speechStream) {
    Serial.println("AUDIO error=queue-create");
    if (cueQueue) vQueueDelete(cueQueue);
    if (speechStream) vStreamBufferDelete(speechStream);
    cueQueue = nullptr;
    speechStream = nullptr;
    return false;
  }
  if (xTaskCreatePinnedToCore(audioTask, "audio", 6144, nullptr, 1, nullptr, 1) !=
      pdPASS) {
    vQueueDelete(cueQueue);
    vStreamBufferDelete(speechStream);
    cueQueue = nullptr;
    speechStream = nullptr;
    Serial.println("AUDIO error=task-create");
    return false;
  }
  return true;
}

bool audioReady() {
  return ready.load();
}

void setSoundVolume(uint8_t volume) {
  currentVolume.store(volume > 100 ? 100 : volume);
  if (volume == 0 && cueQueue) xQueueReset(cueQueue);
}

uint8_t soundVolume() {
  return currentVolume.load();
}

bool queueAudioCue(AudioCue cue) {
  if (!cueQueue || soundVolume() == 0) return false;
  return xQueueOverwrite(cueQueue, &cue) == pdPASS;
}

const char* beginSpeech(uint32_t frames) {
  if (!ready.load() || !speechStream) return "Audio output is unavailable.";
  if (frames == 0 || frames > kMaxSpeechFrames) return "Invalid speech length.";
  bool expected = false;
  if (!speechReserved.compare_exchange_strong(expected, true))
    return "Speech playback is already in progress.";
  xStreamBufferReset(speechStream);
  speechExpectedBytes.store(frames * sizeof(int16_t));
  speechReceivedBytes.store(0);
  speechEnded.store(false);
  speechAborted.store(false);
  speechStarted.store(true);
  return nullptr;
}

const char* writeSpeech(const uint8_t* data, size_t bytes) {
  if (!speechStarted.load()) return "Speech playback was not started.";
  const uint32_t received = speechReceivedBytes.load();
  const uint32_t expected = speechExpectedBytes.load();
  if (!data || bytes == 0 || bytes > expected - received) {
    abortSpeech();
    return "Invalid speech audio length.";
  }
  size_t written = 0;
  while (written < bytes) {
    const size_t count = xStreamBufferSend(
        speechStream, data + written, bytes - written, pdMS_TO_TICKS(2000));
    if (count == 0) {
      abortSpeech();
      return "Speech audio stream timed out.";
    }
    written += count;
  }
  speechReceivedBytes.store(received + bytes);
  return nullptr;
}

const char* finishSpeech() {
  if (!speechStarted.load()) return "Speech playback was not started.";
  if (speechReceivedBytes.load() != speechExpectedBytes.load()) {
    abortSpeech();
    return "Speech audio ended before all samples arrived.";
  }
  speechEnded.store(true);
  return nullptr;
}

void abortSpeech() {
  if (!speechStarted.load()) return;
  speechAborted.store(true);
  speechEnded.store(true);
}

bool speechBusy() {
  return speechReserved.load();
}
}

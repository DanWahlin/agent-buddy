#include "AudioPlayer.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <atomic>
#include <cstring>
#include "../generated/audio_assets.h"
#include "Config.h"
#include "audio/es8311.h"

namespace copilot {
namespace {
struct AudioAsset {
  const int16_t* samples;
  uint32_t count;
};

I2SClass i2s;
QueueHandle_t cueQueue = nullptr;
es8311_handle_t codec = nullptr;
std::atomic<uint8_t> currentVolume{kDefaultSoundVolume};
std::atomic<bool> ready{false};

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

bool playCue(AudioCue cue, AudioCue& replacement) {
  const uint8_t volume = soundVolume();
  if (volume == 0) return true;
  const AudioAsset asset = assetForCue(cue);
  if (!asset.samples || asset.count == 0) return true;

  if (es8311_voice_volume_set(codec, codecVolume(volume), nullptr) != ESP_OK) {
    Serial.println("AUDIO error=codec-output");
    return true;
  }
  digitalWrite(kAudioAmplifierPin, HIGH);
  delay(4);
  if (es8311_voice_mute(codec, false) != ESP_OK) {
    digitalWrite(kAudioAmplifierPin, LOW);
    Serial.println("AUDIO error=codec-output");
    return true;
  }

  constexpr size_t kChunkFrames = 512;
  static int16_t stereo[kChunkFrames * 2];
  bool interrupted = false;
  for (uint32_t offset = 0; offset < asset.count; offset += kChunkFrames) {
    if (soundVolume() == 0) break;
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

  memset(stereo, 0, sizeof(stereo));
  writeAll(reinterpret_cast<const uint8_t*>(stereo), 96 * 4);
  es8311_voice_mute(codec, true);
  delay(2);
  digitalWrite(kAudioAmplifierPin, LOW);
  return !interrupted;
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
    if (xQueueReceive(cueQueue, &cue, portMAX_DELAY) != pdTRUE) continue;
    AudioCue replacement = cue;
    while (!playCue(cue, replacement)) cue = replacement;
  }
}
}

bool beginAudio() {
  if (cueQueue) return true;
  cueQueue = xQueueCreate(1, sizeof(AudioCue));
  if (!cueQueue) {
    Serial.println("AUDIO error=queue-create");
    return false;
  }
  if (xTaskCreatePinnedToCore(audioTask, "audio", 6144, nullptr, 1, nullptr, 1) !=
      pdPASS) {
    vQueueDelete(cueQueue);
    cueQueue = nullptr;
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
}

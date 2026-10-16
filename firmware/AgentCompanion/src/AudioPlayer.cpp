#include "AudioPlayer.h"

#include <Arduino.h>
#include <atomic>
#include <cstring>
#include "../generated/audio_assets.h"
#include "Config.h"
#include "boards/BoardDrivers.h"

namespace copilot {
namespace {
struct AudioAsset {
  const int16_t* samples;
  uint32_t count;
};

QueueHandle_t cueQueue = nullptr;
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

bool playCue(AudioCue cue, AudioCue& replacement) {
  const uint8_t volume = soundVolume();
  if (volume == 0) return true;
  const AudioAsset asset = assetForCue(cue);
  if (!asset.samples || asset.count == 0) return true;

  auto& output = board::audioOutput();
  if (!output.enable(volume)) {
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
    if (!output.write(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
      Serial.println("AUDIO error=i2s-write");
      break;
    }
  }

  memset(stereo, 0, sizeof(stereo));
  output.write(reinterpret_cast<const uint8_t*>(stereo), 96 * 4);
  output.disable();
  return !interrupted;
}

void audioTask(void*) {
  if (const char* error = board::audioOutput().begin(kAudioSampleRate)) {
    Serial.printf("AUDIO error=%s\n", error);
    vTaskDelete(nullptr);
    return;
  }
  Serial.printf("AUDIO ready sample_rate=%u volume=%u mclk=%d\n", kAudioSampleRate,
                static_cast<unsigned>(currentVolume.load()), board::audioOutput().mclkPin());
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

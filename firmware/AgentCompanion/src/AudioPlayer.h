#pragma once
#include <cstdint>

namespace copilot {
enum class AudioCue : uint8_t {
  Working,
  Attention,
  Complete,
  Surprise,
  Settings,
};

bool beginAudio();
bool audioReady();
void setSoundVolume(uint8_t volume);
uint8_t soundVolume();
bool queueAudioCue(AudioCue cue);
}

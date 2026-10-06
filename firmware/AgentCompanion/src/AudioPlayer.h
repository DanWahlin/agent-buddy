#pragma once
#include <cstddef>
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
const char* beginSpeech(uint32_t frames);
const char* writeSpeech(const uint8_t* data, size_t bytes);
const char* finishSpeech();
void abortSpeech();
bool speechBusy();
}

#pragma once
#include "Config.h"
#include "SpriteMotion.h"
#include "CharacterPack.h"
#include <cstddef>
#include <cstdint>

namespace copilot {
using InflateSprite = bool (*)(uint8_t*, size_t, const uint8_t*, size_t, size_t, size_t);

// Renders base/patch packs: one base image per pose plus blink patches around the eyes.
class SpriteRenderer {
 public:
  SpriteRenderer(uint16_t* firstOpenPatch, uint16_t* secondOpenPatch, uint16_t* patch,
                 size_t patchCapacity, uint16_t* firstOutput, uint16_t* secondOutput,
                 InflateSprite inflate, int outputWidth = kSpriteWidth,
                 int outputHeight = kSpriteHeight);
  bool render(const SpritePose& pose, uint16_t* frame);
  void invalidate();
  const char* error() const { return error_; }
  uint32_t decodeUs = 0, compositeUs = 0, eyesUs = 0;

 private:
  bool decode(const SpriteBlock& block, uint16_t* output, size_t pixels, size_t width, size_t stride);
  uint16_t* openPatches_[2];
  uint16_t* patch_;
  size_t patchCapacity_;
  uint16_t* outputs_[2];
  int outputWidth_, outputHeight_;
  uint32_t outputKeys_[2] = {UINT32_MAX, UINT32_MAX};
  uint32_t baseKeys_[2] = {UINT32_MAX, UINT32_MAX};
  InflateSprite inflate_;
  const char* error_ = nullptr;
};
}

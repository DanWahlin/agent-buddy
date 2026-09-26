#pragma once

#include "SpriteRenderer.h"
#include <cstdint>

namespace copilot {
// Renders full-frame packs: one complete image per pose and blink level.
class FullFrameRenderer {
 public:
  FullFrameRenderer(uint16_t* scratch, uint16_t* cached, InflateSprite inflate)
      : scratch_(scratch), cached_(cached), inflate_(inflate) {}
  bool render(const SpritePose& pose, float effectSeconds, uint16_t* frame);
  void invalidate() { cacheKey_ = UINT32_MAX; }
  const char* error() const { return error_; }

 private:
  bool decode(const CharacterPack& pack, unsigned blockIndex, uint16_t* output);
  uint16_t* scratch_;
  uint16_t* cached_;
  InflateSprite inflate_;
  uint32_t cacheKey_ = UINT32_MAX;
  const char* error_ = nullptr;
};
}

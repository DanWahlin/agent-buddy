#pragma once
#include "../../../../firmware/AgentCompanion/src/Config.h"
#include "../../../../firmware/AgentCompanion/src/Motion.h"
#include "../generated/turn_atlas.h"
#include <cstddef>
#include <cstdint>

namespace copilot {
using InflateAtlas = bool (*)(uint8_t*, size_t, const uint8_t*, size_t);

class AtlasRenderer {
 public:
  AtlasRenderer(uint8_t* first, uint8_t* second, InflateAtlas inflate);
  bool render(const Pose& pose, uint16_t* frame);
  const char* error() const { return error_; }
  uint32_t decodeUs = 0, compositeUs = 0, eyesUs = 0;

 private:
  struct CachedFrame {
    int index = -1;
    uint8_t* pixels = nullptr;
    uint32_t palette[256]{};
  };
  bool load(int index, CachedFrame& slot);
  void drawEye(const AtlasEye& eye, const Pose& pose, uint16_t* frame);
  CachedFrame cache_[2];
  InflateAtlas inflate_;
  const char* error_ = nullptr;
  alignas(16) uint16_t row_[kAtlasWidth];
};
}

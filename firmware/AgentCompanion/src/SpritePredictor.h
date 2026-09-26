#pragma once
#include "Config.h"
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace copilot {
class SpritePredictor {
 public:
  bool reset(uint8_t* output, size_t bytes, size_t width, size_t stride = 0) {
    output_ = nullptr;
    if (!stride) stride = width;
    if (!output || reinterpret_cast<uintptr_t>(output) % alignof(uint16_t)
        || !width || width > kCharacterFrameWidth || stride < width || stride > kCharacterFrameWidth
        || !bytes || bytes % (width * 2)) return false;
    output_ = reinterpret_cast<uint16_t*>(output);
    remaining_ = bytes / 2;
    width_ = width;
    stride_ = stride;
    column_ = 0;
    std::memset(previous_, 0, width * sizeof(previous_[0]));
    return true;
  }

  bool consume(const uint8_t* encoded, size_t bytes) {
    if (!output_ || !encoded || bytes % 2 || bytes / 2 > remaining_) return false;
    size_t left = bytes / 2;
    while (left) {
      const size_t count = left < width_ - column_ ? left : width_ - column_;
      uint16_t* row = previous_ + column_;
      for (size_t i = 0; i < count; ++i) {
        const uint16_t delta = (uint16_t(encoded[i * 2]) << 8) | encoded[i * 2 + 1];
        row[i] = __builtin_bswap16(static_cast<uint16_t>(delta + __builtin_bswap16(row[i])));
      }
      // Reconstruct in internal RAM, then burst-copy instead of individual PSRAM stores.
      std::memcpy(output_, row, count * sizeof(uint16_t));
      output_ += count;
      encoded += count * 2;
      left -= count;
      remaining_ -= count;
      column_ += count;
      if (column_ == width_) {
        column_ = 0;
        if (remaining_) output_ += stride_ - width_;
      }
    }
    return true;
  }

  bool complete() const { return output_ && remaining_ == 0; }

 private:
  uint16_t previous_[kCharacterFrameWidth];
  uint16_t* output_ = nullptr;
  size_t width_ = 0, stride_ = 0, column_ = 0, remaining_ = 0;
};
}

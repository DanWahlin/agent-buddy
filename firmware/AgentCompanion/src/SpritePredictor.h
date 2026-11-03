#pragma once
#include "Config.h"
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace copilot {
// The columns [begin, end) of an output row that hold every pixel that a decode changed; begin >= end
// when the row didn't change.
struct SpriteRowChange {
  uint16_t begin, end;
};

class SpritePredictor {
 public:
  // With `changes` (an entry for each output row), pixels that the output already holds aren't
  // written again, and each row's entry gives the columns that changed.
  bool reset(uint8_t* output, size_t bytes, size_t width, size_t stride = 0,
             SpriteRowChange* changes = nullptr) {
    output_ = nullptr;
    if (!stride) stride = width;
    if (!output || reinterpret_cast<uintptr_t>(output) % alignof(uint16_t)
        || !width || width > kCharacterFrameWidth || stride < width || stride > kCharacterFrameWidth
        || !bytes || bytes % (width * 2)) return false;
    output_ = reinterpret_cast<uint16_t*>(output);
    remaining_ = bytes / 2;
    width_ = width;
    stride_ = stride;
    column_ = row_ = 0;
    changes_ = changes;
    if (changes) std::fill(changes, changes + bytes / 2 / width, SpriteRowChange{static_cast<uint16_t>(width), 0});
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
      if (changes_) {
        size_t first = 0, last = count;
        while (first < last && output_[first] == row[first]) ++first;
        while (last > first && output_[last - 1] == row[last - 1]) --last;
        if (first < last) {
          std::memcpy(output_ + first, row + first, (last - first) * sizeof(uint16_t));
          SpriteRowChange& change = changes_[row_];
          change.begin = static_cast<uint16_t>(std::min<size_t>(change.begin, column_ + first));
          change.end = static_cast<uint16_t>(std::max<size_t>(change.end, column_ + last));
        }
      } else {
        std::memcpy(output_, row, count * sizeof(uint16_t));
      }
      output_ += count;
      encoded += count * 2;
      left -= count;
      remaining_ -= count;
      column_ += count;
      if (column_ == width_) {
        column_ = 0;
        ++row_;
        if (remaining_) output_ += stride_ - width_;
      }
    }
    return true;
  }

  bool complete() const { return output_ && remaining_ == 0; }

 private:
  uint16_t previous_[kCharacterFrameWidth] = {};
  uint16_t* output_ = nullptr;
  size_t width_ = 0, stride_ = 0, column_ = 0, row_ = 0, remaining_ = 0;
  SpriteRowChange* changes_ = nullptr;
};
}

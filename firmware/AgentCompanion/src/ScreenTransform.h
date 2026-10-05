#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace copilot {
enum class Rgb565Order { Native, Display };

struct ScreenPixels {
  const uint16_t* pixels;
  int x, y, width, height;
  Rgb565Order order;
};

// Display scanout and touch use the same inverse, pixel-centered transform.
class ScreenTransform {
 public:
  ScreenTransform(int size, float angle) : size_(size) {
    valid_ = size > 0 && size <= INT16_MAX / 2 && std::isfinite(angle);
    if (!valid_) return;
    center_ = (size - 1) * kHalf;
    cosine_ = static_cast<int32_t>(std::lround(std::cos(angle) * kOne));
    sine_ = static_cast<int32_t>(std::lround(std::sin(angle) * kOne));
  }

  bool panelToContent(int16_t panelX, int16_t panelY,
                      int16_t& contentX, int16_t& contentY) const {
    if (!valid_ || panelX < 0 || panelY < 0 || panelX >= size_ || panelY >= size_)
      return false;
    int32_t x, y;
    inverse(panelX, panelY, x, y);
    const int pixelX = (x + kHalf) >> 16;
    const int pixelY = (y + kHalf) >> 16;
    if (pixelX < 0 || pixelY < 0 || pixelX >= size_ || pixelY >= size_) return false;
    contentX = static_cast<int16_t>(pixelX);
    contentY = static_cast<int16_t>(pixelY);
    return true;
  }

  bool renderRows(const ScreenPixels& source, int firstRow, int rows,
                  uint16_t* output, size_t capacity) const {
    if (!valid_ || !source.pixels || !output || source.x < 0 || source.y < 0
        || source.width <= 0 || source.height <= 0
        || source.x >= size_ || source.y >= size_
        || source.width > size_ - source.x || source.height > size_ - source.y
        || firstRow < 0 || firstRow >= size_ || rows <= 0 || rows > size_ - firstRow
        || capacity < static_cast<size_t>(size_) * rows) return false;
    if (source.order == Rgb565Order::Display)
      render<true>(source, firstRow, rows, output);
    else
      render<false>(source, firstRow, rows, output);
    return true;
  }

 private:
  static constexpr int32_t kOne = INT32_C(1) << 16;
  static constexpr int32_t kHalf = kOne / 2;

  void inverse(int x, int y, int32_t& sourceX, int32_t& sourceY) const {
    const int32_t dx = x * kOne - center_;
    const int32_t dy = y * kOne - center_;
    sourceX = center_ + static_cast<int32_t>(
        (static_cast<int64_t>(cosine_) * dx + static_cast<int64_t>(sine_) * dy) >> 16);
    sourceY = center_ + static_cast<int32_t>(
        (-static_cast<int64_t>(sine_) * dx + static_cast<int64_t>(cosine_) * dy) >> 16);
  }

  template<bool DisplayOrder>
  static uint16_t encode(uint16_t pixel) {
    if constexpr (DisplayOrder) return pixel;
    return static_cast<uint16_t>((pixel >> 8) | (pixel << 8));
  }

  template<bool DisplayOrder>
  void render(const ScreenPixels& source, int firstRow, int rows, uint16_t* output) const {
    for (int row = firstRow; row < firstRow + rows; ++row, output += size_) {
      if (cosine_ == kOne && sine_ == 0) {
        std::fill(output, output + size_, 0);
        if (row < source.y || row >= source.y + source.height) continue;
        const uint16_t* input = source.pixels + (row - source.y) * source.width;
        if constexpr (DisplayOrder) {
          std::memcpy(output + source.x, input, source.width * sizeof(uint16_t));
        } else {
          for (int x = 0; x < source.width; ++x) output[source.x + x] = encode<false>(input[x]);
        }
        continue;
      }
      int32_t sourceX, sourceY;
      inverse(0, row, sourceX, sourceY);
      for (int x = 0; x < size_; ++x) {
        const int pixelX = ((sourceX + kHalf) >> 16) - source.x;
        const int pixelY = ((sourceY + kHalf) >> 16) - source.y;
        output[x] = static_cast<unsigned>(pixelX) < static_cast<unsigned>(source.width)
                        && static_cast<unsigned>(pixelY) < static_cast<unsigned>(source.height)
            ? encode<DisplayOrder>(source.pixels[pixelY * source.width + pixelX]) : 0;
        sourceX += cosine_;
        sourceY -= sine_;
      }
    }
  }

  int size_;
  int32_t center_ = 0, cosine_ = 0, sine_ = 0;
  bool valid_ = false;
};
}

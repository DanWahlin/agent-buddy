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

  static int64_t ceilDivide(int64_t value, int32_t divisor) {
    if (value >= INT32_MIN && value <= INT32_MAX) {
      const int32_t dividend = static_cast<int32_t>(value);
      const int32_t quotient = dividend / divisor;
      return static_cast<int64_t>(quotient) + (dividend - quotient * divisor > 0);
    }
    return value >= 0 ? (value + divisor - 1) / divisor : value / divisor;
  }

  static void clipSpan(int32_t start, int32_t step, int32_t limit,
                       int& first, int& last) {
    int64_t begin, end;
    if (step > 0) {
      begin = ceilDivide(-static_cast<int64_t>(start), step);
      end = ceilDivide(static_cast<int64_t>(limit) - start, step);
    } else if (step < 0) {
      begin = ceilDivide(static_cast<int64_t>(start) - limit + 1, -step);
      end = ceilDivide(static_cast<int64_t>(start) + 1, -step);
    } else {
      if (start < 0 || start >= limit) last = first;
      return;
    }
    if (begin >= last || end <= first || first >= last) {
      last = first;
    } else {
      first = static_cast<int>(std::max<int64_t>(first, begin));
      last = static_cast<int>(std::min<int64_t>(last, end));
    }
  }

  template<bool DisplayOrder>
#if defined(ARDUINO_ARCH_ESP32) && !defined(__clang__)
  // Speed-optimize scanout without changing the firmware's size-optimized build.
  __attribute__((optimize("O3")))
#endif
  void render(const ScreenPixels& source, int firstRow, int rows, uint16_t* output) const {
    if (cosine_ == kOne && sine_ == 0) {
      for (int row = firstRow; row < firstRow + rows; ++row, output += size_) {
        std::fill(output, output + size_, 0);
        if (row < source.y || row >= source.y + source.height) continue;
        const uint16_t* input = source.pixels + (row - source.y) * source.width;
        if constexpr (DisplayOrder) {
          std::memcpy(output + source.x, input, source.width * sizeof(uint16_t));
        } else {
          for (int x = 0; x < source.width; ++x) output[source.x + x] = encode<false>(input[x]);
        }
      }
      return;
    }
    constexpr int kTileRows = 4;
    constexpr int kTileColumns = 16;
    const int width = source.width, height = source.height;
    const uint16_t* pixels = source.pixels;
    // Nearby output rows reuse source cache lines, including near a quarter turn.
    for (int row = firstRow; row < firstRow + rows; row += kTileRows) {
      const int tileRows = std::min(kTileRows, firstRow + rows - row);
      int32_t rowX[kTileRows], rowY[kTileRows];
      int first[kTileRows], last[kTileRows];
      for (int y = 0; y < tileRows; ++y) {
        inverse(0, row + y, rowX[y], rowY[y]);
        rowX[y] += kHalf - source.x * kOne;
        rowY[y] += kHalf - source.y * kOne;
        int begin = 0, end = size_;
        clipSpan(rowX[y], cosine_, width * kOne, begin, end);
        clipSpan(rowY[y], -sine_, height * kOne, begin, end);
        first[y] = begin < end ? begin : 0;
        last[y] = begin < end ? end : 0;
        rowX[y] += first[y] * cosine_;
        rowY[y] -= first[y] * sine_;
        uint16_t* destination = output + (row + y - firstRow) * size_;
        std::fill(destination, destination + first[y], 0);
        std::fill(destination + last[y], destination + size_, 0);
      }
      for (int column = 0; column < size_; column += kTileColumns) {
        const int columns = std::min(kTileColumns, size_ - column);
        for (int y = 0; y < tileRows; ++y) {
          const int begin = std::max(column, first[y]);
          const int end = std::min(column + columns, last[y]);
          if (begin >= end) continue;
          int32_t sourceX = rowX[y], sourceY = rowY[y];
          uint16_t* destination = output + (row + y - firstRow) * size_ + begin;
          for (int x = begin; x < end; ++x) {
            *destination++ = encode<DisplayOrder>(pixels[(sourceY >> 16) * width + (sourceX >> 16)]);
            sourceX += cosine_;
            sourceY -= sine_;
          }
          rowX[y] = sourceX;
          rowY[y] = sourceY;
        }
      }
    }
  }

  int size_;
  int32_t center_ = 0, cosine_ = 0, sine_ = 0;
  bool valid_ = false;
};
}

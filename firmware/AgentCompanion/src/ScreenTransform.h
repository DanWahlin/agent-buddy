#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include "Rgb565.h"

namespace copilot {
enum class Rgb565Order { Native, Display };

struct ScreenPixels {
  const uint16_t* pixels;
  int x, y, width, height;
  Rgb565Order order;
};

// Display scanout and touch use the same inverse, pixel-centered transform.
// Content is drawn at contentSize x contentSize. The panel is panelWidth x panelHeight, and it shows
// the content at shownSize x shownSize around its center. At full size (shownSize == contentSize), a
// panel narrower or shorter than the content shows its middle, and black fills the rest of a larger
// one. A smaller shownSize (down to half the content size) scales the content down, and each panel
// pixel averages a 2x2 content block.
class ScreenTransform {
 public:
  ScreenTransform(int size, float angle) : ScreenTransform(size, size, angle) {}

  // A square panel that shows all of the content.
  ScreenTransform(int panelSize, int contentSize, float angle)
      : ScreenTransform(panelSize, panelSize, contentSize, panelSize, angle) {}

  ScreenTransform(int panelWidth, int panelHeight, int contentSize, int shownSize, float angle)
      : width_(panelWidth), height_(panelHeight), content_(contentSize) {
    valid_ = panelWidth > 0 && panelHeight > 0 && panelWidth <= INT16_MAX / 2
             && panelHeight <= INT16_MAX / 2 && shownSize > 0 && contentSize >= shownSize
             && contentSize <= 2 * shownSize && contentSize <= INT16_MAX / 2 && std::isfinite(angle);
    if (!valid_) return;
    panelCenterX_ = (panelWidth - 1) * kHalf;
    panelCenterY_ = (panelHeight - 1) * kHalf;
    contentCenter_ = (contentSize - 1) * kHalf;
    box_ = contentSize > shownSize;
    // The scale is exactly 1 when the content shows at full size, so those steps equal the unscaled ones.
    const float scale = static_cast<float>(contentSize) / static_cast<float>(shownSize);
    cosine_ = static_cast<int32_t>(std::lround(std::cos(angle) * scale * kOne));
    sine_ = static_cast<int32_t>(std::lround(std::sin(angle) * scale * kOne));
  }

  bool panelToContent(int16_t panelX, int16_t panelY,
                      int16_t& contentX, int16_t& contentY) const {
    if (!valid_ || panelX < 0 || panelY < 0 || panelX >= width_ || panelY >= height_)
      return false;
    int32_t x, y;
    inverse(panelX, panelY, x, y);
    const int pixelX = (x + kHalf) >> 16;
    const int pixelY = (y + kHalf) >> 16;
    if (pixelX < 0 || pixelY < 0 || pixelX >= content_ || pixelY >= content_) return false;
    contentX = static_cast<int16_t>(pixelX);
    contentY = static_cast<int16_t>(pixelY);
    return true;
  }

  bool renderRows(const ScreenPixels& source, int firstRow, int rows,
                  uint16_t* output, size_t capacity) const {
    if (!valid_ || !source.pixels || !output || source.x < 0 || source.y < 0
        || source.width <= 0 || source.height <= 0
        || source.x >= content_ || source.y >= content_
        || source.width > content_ - source.x || source.height > content_ - source.y
        || firstRow < 0 || firstRow >= height_ || rows <= 0 || rows > height_ - firstRow
        || capacity < static_cast<size_t>(width_) * rows) return false;
    if (source.order == Rgb565Order::Display) {
      if (box_) render<true, true>(source, firstRow, rows, output);
      else render<true, false>(source, firstRow, rows, output);
    } else {
      if (box_) render<false, true>(source, firstRow, rows, output);
      else render<false, false>(source, firstRow, rows, output);
    }
    return true;
  }

 private:
  static constexpr int32_t kOne = INT32_C(1) << 16;
  static constexpr int32_t kHalf = kOne / 2;
  // RGB565 with green moved to the high half, so a sum of four pixels keeps each channel apart.
  static constexpr uint32_t kSpreadMask = 0x07E0F81Fu;

  void inverse(int x, int y, int32_t& sourceX, int32_t& sourceY) const {
    const int32_t dx = x * kOne - panelCenterX_;
    const int32_t dy = y * kOne - panelCenterY_;
    sourceX = contentCenter_ + static_cast<int32_t>(
        (static_cast<int64_t>(cosine_) * dx + static_cast<int64_t>(sine_) * dy) >> 16);
    sourceY = contentCenter_ + static_cast<int32_t>(
        (-static_cast<int64_t>(sine_) * dx + static_cast<int64_t>(cosine_) * dy) >> 16);
  }

  template<bool DisplayOrder>
  static uint16_t encode(uint16_t pixel) {
    if constexpr (DisplayOrder) return pixel;
    return swapBytes(pixel);
  }

  static uint32_t spread(uint16_t pixel) {
    return (pixel | static_cast<uint32_t>(pixel) << 16) & kSpreadMask;
  }

  // Averages a 2x2 block per channel and returns it in display order.
  template<bool DisplayOrder>
  static uint16_t average(uint16_t a, uint16_t b, uint16_t c, uint16_t d) {
    if constexpr (DisplayOrder) {
      a = swapBytes(a);
      b = swapBytes(b);
      c = swapBytes(c);
      d = swapBytes(d);
    }
    const uint32_t sum = ((spread(a) + spread(b) + spread(c) + spread(d)) >> 2) & kSpreadMask;
    return swapBytes(static_cast<uint16_t>(sum | sum >> 16));
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

  // Box: the panel is smaller than the content. Each panel pixel then averages the 2x2 block whose
  // top-left pixel is under its center, and pixels whose block leaves the source stay black.
  template<bool DisplayOrder, bool Box>
#if defined(ARDUINO_ARCH_ESP32) && !defined(__clang__)
  // Speed-optimize scanout without changing the firmware's size-optimized build.
  __attribute__((optimize("O3")))
#endif
  void render(const ScreenPixels& source, int firstRow, int rows, uint16_t* output) const {
    if (!Box && cosine_ == kOne && sine_ == 0) {
      // Upright at full size: each panel pixel shows the content pixel a whole number of pixels away,
      // as the general path below rounds it.
      const int shiftX = (contentCenter_ - panelCenterX_ + kHalf) >> 16;
      const int shiftY = (contentCenter_ - panelCenterY_ + kHalf) >> 16;
      // The source's columns on the panel, clipped to it.
      const int first = std::max(source.x - shiftX, 0);
      const int last = std::min(source.x + source.width - shiftX, width_);
      for (int row = firstRow; row < firstRow + rows; ++row, output += width_) {
        std::fill(output, output + width_, 0);
        const int contentRow = row + shiftY;
        if (first >= last || contentRow < source.y || contentRow >= source.y + source.height) continue;
        const uint16_t* input = source.pixels + (contentRow - source.y) * source.width
                                + (first + shiftX - source.x);
        if constexpr (DisplayOrder) {
          std::memcpy(output + first, input, (last - first) * sizeof(uint16_t));
        } else {
          for (int x = 0; x < last - first; ++x) output[first + x] = encode<false>(input[x]);
        }
      }
      return;
    }
    constexpr int kTileRows = 4;
    constexpr int kTileColumns = 16;
    // Nearest sampling rounds to the closest pixel; the box takes the block's top-left pixel.
    constexpr int32_t kRound = Box ? 0 : kHalf;
    constexpr int kReach = Box ? 1 : 0;
    const int width = source.width, height = source.height;
    const uint16_t* pixels = source.pixels;
    // Nearby output rows reuse source cache lines, including near a quarter turn.
    for (int row = firstRow; row < firstRow + rows; row += kTileRows) {
      const int tileRows = std::min(kTileRows, firstRow + rows - row);
      int32_t rowX[kTileRows], rowY[kTileRows];
      int first[kTileRows], last[kTileRows];
      for (int y = 0; y < tileRows; ++y) {
        inverse(0, row + y, rowX[y], rowY[y]);
        rowX[y] += kRound - source.x * kOne;
        rowY[y] += kRound - source.y * kOne;
        int begin = 0, end = width_;
        clipSpan(rowX[y], cosine_, (width - kReach) * kOne, begin, end);
        clipSpan(rowY[y], -sine_, (height - kReach) * kOne, begin, end);
        first[y] = begin < end ? begin : 0;
        last[y] = begin < end ? end : 0;
        rowX[y] += first[y] * cosine_;
        rowY[y] -= first[y] * sine_;
        uint16_t* destination = output + (row + y - firstRow) * width_;
        std::fill(destination, destination + first[y], 0);
        std::fill(destination + last[y], destination + width_, 0);
      }
      for (int column = 0; column < width_; column += kTileColumns) {
        const int columns = std::min(kTileColumns, width_ - column);
        for (int y = 0; y < tileRows; ++y) {
          const int begin = std::max(column, first[y]);
          const int end = std::min(column + columns, last[y]);
          if (begin >= end) continue;
          int32_t sourceX = rowX[y], sourceY = rowY[y];
          uint16_t* destination = output + (row + y - firstRow) * width_ + begin;
          for (int x = begin; x < end; ++x) {
            const uint16_t* pixel = pixels + (sourceY >> 16) * width + (sourceX >> 16);
            if constexpr (Box)
              *destination++ = average<DisplayOrder>(pixel[0], pixel[1], pixel[width], pixel[width + 1]);
            else
              *destination++ = encode<DisplayOrder>(*pixel);
            sourceX += cosine_;
            sourceY -= sine_;
          }
          rowX[y] = sourceX;
          rowY[y] = sourceY;
        }
      }
    }
  }

  int width_, height_, content_;
  int32_t panelCenterX_ = 0, panelCenterY_ = 0, contentCenter_ = 0, cosine_ = 0, sine_ = 0;
  bool box_ = false, valid_ = false;
};
}

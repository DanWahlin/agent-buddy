#pragma once
#include "CharacterPlacement.h"
#include "SpriteRenderer.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

#if defined(ARDUINO_ARCH_ESP32) && !defined(__clang__)
// Speed-optimize scaling without changing the firmware's size-optimized build.
#define CHARACTER_SCALER_FAST __attribute__((optimize("O3")))
#else
#define CHARACTER_SCALER_FAST
#endif

namespace copilot {
// Draws the character art bigger, at a CharacterPlacement, into the two character frames.
// SpriteRenderer renders a pose into one art buffer (kCharacterFrameWidth x kFrameHeight, display
// byte order); then each frame gets again only the pixels of the art that changed since that frame
// last got them, row by row, so an unchanged pose costs nothing and a blink only rescales the eyes.
// PSRAM traffic is most of the cost, so black that a frame already shows isn't written again.
// Pixels are filtered bilinearly in 5-bit steps, so the clay art stays smooth, and black stays
// exactly black: effects draw only on black, and a tap on the character is a tap on a pixel that
// isn't black.
class CharacterScaler {
 public:
  static constexpr int kArtWidth = kCharacterFrameWidth;
  static constexpr int kArtHeight = kFrameHeight;
  static constexpr size_t kArtPixels = static_cast<size_t>(kArtWidth) * kArtHeight;

  explicit CharacterScaler(const CharacterPlacement& placement) {
    const double scale = placement.scale;
    // The content's center is frame column kArtWidth / 2 and art row kArtHeight / 2. Each frame
    // pixel samples the art at the position that maps to its center.
    for (int x = 0; x < kCharacterFrameWidth; ++x) {
      const double source = kArtWidth / 2.0 + (x + .5 - kArtWidth / 2.0) / scale - .5;
      sample(source, kArtWidth, columns_[x]);
      // The art is as wide as the frame and only grows, so this changes nothing; it keeps every
      // read inside the art.
      if (columns_[x].source < 0) columns_[x] = {0, 0};
      if (columns_[x].source >= kArtWidth - 1) columns_[x] = {kArtWidth - 1, 0};
    }
    for (int source = -1; source <= kArtWidth + 1; ++source)
      columnStarts_[source + 1] = static_cast<int16_t>(first(columns_, kCharacterFrameWidth, source));
    const double center = kCharacterFrameHeight / 2.0 + placement.offsetY;
    for (int y = 0; y < kCharacterFrameHeight; ++y) {
      const double source = kArtHeight / 2.0 + (y + .5 - center) / scale - .5;
      sample(source, kArtHeight, rows_[y]);
    }
    changed({0, 0, kArtWidth, kArtHeight});
  }

  // The art changed inside this area (art pixels).
  void changed(const SpriteArea& area) {
    const int top = std::max(area.y, 0), bottom = std::min(area.y + area.height, kArtHeight);
    for (int row = top; row < bottom; ++row) changed(row, area.x, area.x + area.width);
  }

  // Art row `row` changed in columns [begin, end).
  void changed(int row, int begin, int end) {
    begin = std::max(begin, 0);
    end = std::min(end, kArtWidth);
    if (row < 0 || row >= kArtHeight || begin >= end) return;
    for (int index = 0; index < 2; ++index) {
      include(pending_[index][row], begin, end);
      pendingTop_[index] = std::min(pendingTop_[index], row);
      pendingBottom_[index] = std::max(pendingBottom_[index], row + 1);
    }
  }

  // Whether frame `index` (0 or 1) already shows the art.
  bool upToDate(int index) const { return pendingTop_[index & 1] >= pendingBottom_[index & 1]; }

  // The art pixels that frame `index` hasn't got yet.
  size_t pendingPixels(int index) const {
    size_t pixels = 0;
    for (int row = pendingTop_[index & 1]; row < pendingBottom_[index & 1]; ++row)
      pixels += std::max(pending_[index & 1][row].end - pending_[index & 1][row].begin, 0);
    return pixels;
  }

  // Brings frame `index` (0 or 1) up to date with the art.
  CHARACTER_SCALER_FAST
  void draw(const uint16_t* art, uint16_t* frame, int index) {
    index &= 1;
    Span* pending = pending_[index];
    const int pendingTop = pendingTop_[index], pendingBottom = pendingBottom_[index];
    if (pendingTop >= pendingBottom) return;
    // Frame rows whose samples read a changed art row: a sample reads its row and the next one.
    const int top = first(rows_, kCharacterFrameHeight, pendingTop - 1);
    const int bottom = first(rows_, kCharacterFrameHeight, pendingBottom);
    int cachedRows[2] = {kNoRow, kNoRow};
    for (int y = top; y < bottom; ++y) {
      const Sample& row = rows_[y];
      const uint32_t weight = row.weight;
      // The frame columns whose samples read changed art in this row's art rows.
      Span dirty = changedColumns(pending, row.source, weight ? 2 : 1);
      if (dirty.begin >= dirty.end) continue;
      int lines[2] = {0, 0};
      for (int tap = 0; tap < (weight ? 2 : 1); ++tap) {
        const int source = row.source + tap;
        int slot = cachedRows[0] == source ? 0 : cachedRows[1] == source ? 1 : -1;
        if (slot < 0) {
          // The other slot holds the row before this one, which this row no longer needs.
          slot = cachedRows[0] == row.source ? 1 : 0;
          cachedRows[slot] = source;
          // Every frame row that reads this art row reads changed columns inside this span.
          const Span needed = changedColumns(pending, source - 1, 3);
          scaleRow(art, source, needed.begin, needed.end, slot);
        }
        lines[tap] = slot;
      }
      const int left = dirty.begin, right = dirty.end;
      // Black outside the lines' art, which the lines hold as zero.
      int begin = std::max<int>(spans_[lines[0]].begin, left), end = std::min<int>(spans_[lines[0]].end, right);
      if (weight) {
        const int secondBegin = std::max<int>(spans_[lines[1]].begin, left);
        const int secondEnd = std::min<int>(spans_[lines[1]].end, right);
        if (begin >= end) {
          begin = secondBegin;
          end = secondEnd;
        } else if (secondBegin < secondEnd) {
          begin = std::min(begin, secondBegin);
          end = std::max(end, secondEnd);
        }
      }
      // Of what isn't art now, only the part that was art before (the row's span the last time)
      // is cleared.
      uint16_t* output = frame + static_cast<size_t>(y) * kCharacterFrameWidth;
      Span& shown = shown_[index][y];
      if (begin >= end) begin = end = left;
      clear(output, std::max<int>(shown.begin, left), std::min<int>(shown.end, begin));
      clear(output, std::max<int>(shown.begin, end), std::min<int>(shown.end, right));
      // Art outside [left, right) stays; the span may cover some black.
      Span next;
      include(next, shown.begin, std::min<int>(shown.end, left));
      include(next, std::max<int>(shown.begin, right), shown.end);
      include(next, begin, end);
      shown = next;
      if (begin < end) {
        const uint32_t* above = lines_[lines[0]];
        if (weight == 0) {
          for (int x = begin; x < end; ++x) output[x] = pack(above[x]);
        } else {
          const uint32_t* below = lines_[lines[1]];
          const uint32_t keep = 32 - weight;
          for (int x = begin; x < end; ++x) output[x] = pack(mix(above[x], keep, below[x], weight));
        }
      }
    }
    for (int row = pendingTop; row < pendingBottom; ++row) pending[row] = {};
    pendingTop_[index] = kArtHeight;
    pendingBottom_[index] = 0;
  }

 private:
  static constexpr int kNoRow = INT32_MIN / 2;
  static constexpr uint32_t kSpread = 0x07E0F81Fu;
  struct Sample {
    int16_t source;
    uint8_t weight;  // Of the next source pixel, 0..31.
  };
  struct Span {
    int16_t begin = 0, end = 0;
  };

  static void sample(double position, int size, Sample& result) {
    int source = static_cast<int>(std::floor(position));
    int weight = static_cast<int>(std::lround((position - source) * 32));
    if (weight == 32) {
      ++source;
      weight = 0;
    }
    // Far outside the art both samples are black; keep the index small.
    source = std::clamp(source, -2, size + 1);
    result = {static_cast<int16_t>(source), static_cast<uint8_t>(weight)};
  }

  // The first entry whose source is at least `source`; entries rise with their index.
  static int first(const Sample* samples, int count, int source) {
    return static_cast<int>(std::lower_bound(samples, samples + count, source,
        [](const Sample& sample, int value) { return sample.source < value; }) - samples);
  }

  static void include(Span& span, int begin, int end) {
    if (begin >= end) return;
    if (span.begin >= span.end) {
      span = {static_cast<int16_t>(begin), static_cast<int16_t>(end)};
      return;
    }
    span.begin = static_cast<int16_t>(std::min<int>(span.begin, begin));
    span.end = static_cast<int16_t>(std::max<int>(span.end, end));
  }
  static void clear(uint16_t* output, int begin, int end) {
    if (begin < end) std::memset(output + begin, 0, (end - begin) * sizeof(uint16_t));
  }

  // The frame columns whose samples read a changed pixel in art rows [source, source + count).
  Span changedColumns(const Span* pending, int source, int count) const {
    Span changed;
    for (int row = std::max(source, 0); row < std::min(source + count, kArtHeight); ++row)
      include(changed, pending[row].begin, pending[row].end);
    if (changed.begin >= changed.end) return {};
    // A sample reads its column and the next one.
    return {static_cast<int16_t>(columnStart(changed.begin - 1)), static_cast<int16_t>(columnStart(changed.end))};
  }

  // RGB565 in display byte order, spread so that one multiply weighs all three channels.
  static inline uint32_t spread(uint16_t pixel) {
    const uint32_t rgb = static_cast<uint16_t>((pixel >> 8) | (pixel << 8));
    return (rgb | (rgb << 16)) & kSpread;
  }
  static inline uint16_t pack(uint32_t spread) {
    const uint32_t rgb = (spread | (spread >> 16)) & 0xFFFFu;
    return static_cast<uint16_t>((rgb >> 8) | (rgb << 8));
  }
  // Weights 0..32 that add up to 32. Rounds to the nearest step, so equal pixels (and black) stay
  // unchanged.
  static inline uint32_t mix(uint32_t a, uint32_t weightA, uint32_t b, uint32_t weightB) {
    return ((a * weightA + b * weightB + 0x02008010u) >> 5) & kSpread;
  }

  // The first frame column that samples art column `source` or one to its right.
  int columnStart(int source) const {
    return columnStarts_[std::clamp(source, -1, kArtWidth + 1) + 1];
  }

  // Art row `source` scaled across frame columns [left, right) into line `slot`, spread; black
  // outside the art. Only the row's span of art that isn't black is weighed.
  CHARACTER_SCALER_FAST
  void scaleRow(const uint16_t* art, int source, int left, int right, int slot) {
    uint32_t* line = lines_[slot];
    Span& span = spans_[slot];
    span = {static_cast<int16_t>(left), static_cast<int16_t>(left)};
    if (left < right && source >= 0 && source < kArtHeight) {
      const uint16_t* pixels = art + static_cast<size_t>(source) * kArtWidth;
      int begin = columns_[left].source, end = std::min(columns_[right - 1].source + 2, kArtWidth);
      while (begin < end && !pixels[begin]) ++begin;
      while (end > begin && !pixels[end - 1]) --end;
      if (begin < end) {
        for (int x = begin; x < end; ++x) spread_[x] = spread(pixels[x]);
        // Samples next to the span read one black pixel on each side.
        if (begin > 0) spread_[begin - 1] = 0;
        if (end < kArtWidth) spread_[end] = 0;
        const int first = std::max(columnStart(begin - 1), left), last = std::min(columnStart(end), right);
        if (first < last) span = {static_cast<int16_t>(first), static_cast<int16_t>(last)};
      }
    }
    if (span.begin > left) std::memset(line + left, 0, (span.begin - left) * sizeof(uint32_t));
    if (right > span.end) std::memset(line + span.end, 0, (right - span.end) * sizeof(uint32_t));
    for (int x = span.begin; x < span.end; ++x) {
      const Sample& column = columns_[x];
      const uint32_t weight = column.weight;
      line[x] = weight ? mix(spread_[column.source], 32 - weight, spread_[column.source + 1], weight)
                       : spread_[column.source];
    }
  }

  Sample columns_[kCharacterFrameWidth];
  int16_t columnStarts_[kArtWidth + 3];
  Sample rows_[kCharacterFrameHeight];
  // Per frame: the columns of each art row that changed since the frame last got them.
  Span pending_[2][kArtHeight];
  int pendingTop_[2] = {kArtHeight, kArtHeight}, pendingBottom_[2] = {0, 0};
  uint32_t spread_[kArtWidth];
  uint32_t lines_[2][kCharacterFrameWidth];
  Span spans_[2];
  // Each frame row's columns that may not be black. The frames start black.
  Span shown_[2][kCharacterFrameHeight];
};
}  // namespace copilot

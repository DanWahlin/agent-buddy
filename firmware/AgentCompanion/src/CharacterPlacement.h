#pragma once
#include "Config.h"
#include <algorithm>
#include <cmath>

namespace copilot {
// Where the character art is drawn. A board with room around the character (kCharacterMaxScale
// above 1 in its BoardConfig.h) draws the art bigger than the pack has it: scaled around the
// content's center, then moved up or down by offsetY content rows. CharacterScaler draws it; the
// pack, the effects, and the badges don't change.
struct CharacterPlacement {
  float scale = 1;
  int offsetY = 0;
  bool scaled() const { return scale != 1 || offsetY != 0; }
};

// The scaled art stays between these content rows: under the top of the content, and above the
// usage lines (CharacterEffects::usageText; two lines start at row 410).
constexpr int kCharacterTop = 0;
constexpr int kCharacterBottom = 406;
static_assert(kCharacterMaxScale >= 1 && kCharacterMaxScale <= 2,
              "A board can draw the character up to twice its size.");
static_assert(kCharacterMaxScale == 1 || kShownContentSize == kDisplaySize,
              "Only a panel that shows the content at full size can draw the character bigger.");

// The biggest placement, up to kCharacterMaxScale, that keeps the art's bounds (pack frame pixels:
// kSpriteWidth x kFrameHeight, as a base/patch pack's header gives them) on the panel and between
// kCharacterTop and kCharacterBottom. Art that can't grow keeps its size and place.
inline CharacterPlacement fitCharacter(int x, int y, int width, int height) {
  if (kCharacterMaxScale <= 1 || width <= 0 || height <= 0) return {};
  constexpr double center = kDisplaySize / 2.0;
  // The content columns that the panel shows, inside the character frame.
  constexpr int visibleLeft = std::max(kCharacterFrameX, -kPanelContentX);
  constexpr int visibleRight = std::min(kCharacterFrameX + kCharacterFrameWidth, kPanelWidth - kPanelContentX);
  const double left = kCharacterFrameX + x, right = left + width;
  const double top = kFrameY + y, bottom = top + height;
  double scale = kCharacterMaxScale;
  if (left < center) scale = std::min(scale, (center - visibleLeft) / (center - left));
  if (right > center) scale = std::min(scale, (visibleRight - center) / (right - center));
  scale = std::min(scale, static_cast<double>(kCharacterBottom - kCharacterTop) / height);
  if (scale <= 1) return {};
  // Move as little as keeps the scaled art between the limits; nearer the usage lines when both
  // can't hold to the pixel.
  const double scaledTop = center + scale * (top - center);
  const double scaledBottom = center + scale * (bottom - center);
  const int lowest = static_cast<int>(std::ceil(kCharacterTop - scaledTop));
  const int highest = static_cast<int>(std::floor(kCharacterBottom - scaledBottom));
  const int offsetY = lowest > highest ? highest : std::clamp(0, lowest, highest);
  return {static_cast<float>(scale), offsetY};
}
}  // namespace copilot

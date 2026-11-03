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

// A round panel shows the content inside this circle around its center; the art keeps 4 pixels
// from its edge.
constexpr float kRoundArtRadius = kDisplaySize / 2.0f - 4;
// Characters are round, so a pack's art stays inside the superellipse |u|^4 + |v|^4 = 1 that
// fills its bounds: every built-in and Christmas pack does, to within 7%. On a round panel the
// fit uses this outline grown by 8% and cut by the bounds, since the bounds' corners are empty.
constexpr int kRoundOutlinePoints = 64;
constexpr float kRoundOutlineGrowth = 1.08f;

// The biggest placement on a round panel: the art outline (content pixels from the center) inside
// the circle, its rows between kCharacterTop and kCharacterBottom, and its columns in the frame.
// Tries each offset and keeps the biggest scale, then the smallest move.
inline CharacterPlacement fitRoundCharacter(float left, float top, float right, float bottom) {
  constexpr float center = kDisplaySize / 2.0f, pi = 3.14159265358979f;
  float outlineX[kRoundOutlinePoints], outlineY[kRoundOutlinePoints];
  for (int i = 0; i < kRoundOutlinePoints; ++i) {
    const float angle = 2 * pi * i / kRoundOutlinePoints, cosine = std::cos(angle), sine = std::sin(angle);
    const float radius = kRoundOutlineGrowth
        / std::sqrt(std::sqrt(cosine * cosine * cosine * cosine + sine * sine * sine * sine));
    const float u = std::clamp(radius * cosine, -1.0f, 1.0f), v = std::clamp(radius * sine, -1.0f, 1.0f);
    outlineX[i] = (left + right) / 2 + (right - left) / 2 * u - center;
    outlineY[i] = (top + bottom) / 2 + (bottom - top) / 2 * v - center;
  }
  auto fits = [&](float scale, int offsetY) {
    if (center + scale * (top - center) + offsetY < kCharacterTop
        || center + scale * (bottom - center) + offsetY > kCharacterBottom
        || center + scale * (left - center) < kCharacterFrameX
        || center + scale * (right - center) > kCharacterFrameX + kCharacterFrameWidth) return false;
    for (int i = 0; i < kRoundOutlinePoints; ++i) {
      const float x = scale * outlineX[i], y = scale * outlineY[i] + offsetY;
      if (x * x + y * y > kRoundArtRadius * kRoundArtRadius) return false;
    }
    return true;
  };
  CharacterPlacement best;
  for (int distance = 0; distance <= 80; ++distance) {
    for (int offsetY : {-distance, distance}) {
      if (!fits(1, offsetY)) continue;
      float low = 1, high = kCharacterMaxScale;
      if (fits(high, offsetY)) low = high;
      for (int step = 0; step < 24 && low < high; ++step) {
        const float middle = (low + high) / 2;
        (fits(middle, offsetY) ? low : high) = middle;
      }
      if (low > best.scale) best = {low, offsetY};
    }
  }
  return best.scale > 1 ? best : CharacterPlacement{};
}

// The biggest placement, up to kCharacterMaxScale, that keeps the art's bounds (pack frame pixels:
// kSpriteWidth x kFrameHeight, as a base/patch pack's header gives them) on the panel and between
// kCharacterTop and kCharacterBottom. Art that can't grow keeps its size and place.
inline CharacterPlacement fitCharacter(int x, int y, int width, int height) {
  if (kCharacterMaxScale <= 1 || width <= 0 || height <= 0) return {};
  if (kRoundPanel)
    return fitRoundCharacter(kCharacterFrameX + x, kFrameY + y, kCharacterFrameX + x + width, kFrameY + y + height);
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

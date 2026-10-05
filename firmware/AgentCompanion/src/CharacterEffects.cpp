#include "CharacterEffects.h"
#include "CharacterModel.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <initializer_list>

namespace copilot {
namespace {
// Largest ring that keeps a whole badge inside the 412 px frame, so it stays a true circle.
constexpr int kOrbitRadius = 186;
// Six trail steps of 0.16 rad put the head dot this far ahead of the orbit's base angle.
constexpr double kOrbitLeadAngle = 6 * .16;
uint16_t color(int r, int g, int b, double brightness = 1) {
  const uint16_t rgb = (static_cast<unsigned>(r * brightness) >> 3) << 11
      | (static_cast<unsigned>(g * brightness) >> 2) << 5
      | (static_cast<unsigned>(b * brightness) >> 3);
  return static_cast<uint16_t>((rgb << 8) | (rgb >> 8));
}
uint16_t darken(uint16_t swapped, double amount) {
  const uint16_t rgb = static_cast<uint16_t>((swapped << 8) | (swapped >> 8));
  const int r = ((rgb >> 11) & 31) * 255 / 31;
  const int g = ((rgb >> 5) & 63) * 255 / 63;
  const int b = (rgb & 31) * 255 / 31;
  return color(r, g, b, amount);
}
struct Rgb {
  float r, g, b;
};
Rgb unpack(uint16_t swapped) {
  const uint16_t rgb = static_cast<uint16_t>((swapped << 8) | (swapped >> 8));
  return {((rgb >> 11) & 31) * 255.0f / 31, ((rgb >> 5) & 63) * 255.0f / 63, (rgb & 31) * 255.0f / 31};
}
float coverage(float value) {
  return std::clamp(value, 0.0f, 1.0f);
}
// The ESP32-S3 FPU is single precision only, so badge edges use a float sqrt table, not double math.
constexpr int kMaxSmoothReach = 24;
constexpr int kDistanceEntries = 2 * kMaxSmoothReach * kMaxSmoothReach + 1;
const float* distanceTable() {
  static float table[kDistanceEntries];
  static bool ready = false;
  if (!ready) {
    for (int i = 0; i < kDistanceEntries; ++i) table[i] = std::sqrt(static_cast<float>(i));
    ready = true;
  }
  return table;
}
// 5x7 glyphs for the usage lines; the first column is bit 4.
struct UsageGlyph {
  char character;
  uint8_t rows[7];
};
constexpr UsageGlyph kUsageFont[] = {
  {'0', {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}}, {'1', {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E}},
  {'2', {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}}, {'3', {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E}},
  {'4', {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}}, {'5', {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E}},
  {'6', {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}}, {'7', {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08}},
  {'8', {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}}, {'9', {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C}},
  {',', {0x00, 0x00, 0x00, 0x00, 0x0C, 0x04, 0x08}}, {'.', {0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C}},
  {':', {0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00}}, {'A', {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11}},
  {'B', {0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E}}, {'C', {0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E}},
  {'I', {0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E}}, {'K', {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11}},
  {'M', {0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11}}, {'T', {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04}},
  {'e', {0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E}}, {'k', {0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12}},
  {'n', {0x00, 0x00, 0x16, 0x19, 0x11, 0x11, 0x11}}, {'o', {0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E}},
  {'s', {0x00, 0x00, 0x0F, 0x10, 0x0E, 0x01, 0x1E}},
};
const uint8_t* usageGlyph(char character) {
  for (const auto& glyph : kUsageFont)
    if (glyph.character == character) return glyph.rows;
  return nullptr;
}
uint32_t hash(uint32_t value) {
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  return value ^ (value >> 16);
}
}

CharacterEffects::CharacterEffects(uint16_t* firstOutput, uint16_t* secondOutput, const AgentBadges* badges,
                                   uint16_t* overlayScratch)
    : outputs_{firstOutput, secondOutput}, badges_(badges), overlay_(overlayScratch) {}

AgentBadgePoint CharacterEffects::badgeAnchor(
    CharacterMode mode, AgentBadgeRole role, int index, int count, double seconds) {
  if (index < 0 || count <= 0) return {};
  count = std::min(count, 4);
  index = std::min(index, count - 1);
  constexpr double pi = 3.14159265358979323846;
  if (mode == CharacterMode::Working && role == AgentBadgeRole::Working) {
    // The first badge replaces the head of the orbiting dot trail; others share the same ring.
    const double angle = seconds * pi / 6 + kOrbitLeadAngle + index * 2 * pi / count;
    return {kFrameWidth / 2 + int(std::lround(kOrbitRadius * std::cos(angle))),
            kFrameHeight / 2 + int(std::lround(kOrbitRadius * std::sin(angle))), true};
  }
  // Fan out on an arc around the display center, starting opposite the attention "?" at (348, 56)
  // (-141 degrees, radius 190) and alternating up and down so badges stay clear of ears and antennae.
  if ((mode == CharacterMode::Attention && role == AgentBadgeRole::Attention)
      || (mode == CharacterMode::Complete && role == AgentBadgeRole::Complete)) {
    constexpr double steps[] = {0, 15, -15, 30};
    const double angle = (-141 + steps[index]) * pi / 180;
    constexpr int arcRadius = 200;
    const int displayX = kDisplaySize / 2 + int(std::lround(arcRadius * std::cos(angle)));
    const int displayY = kDisplaySize / 2 + int(std::lround(arcRadius * std::sin(angle)));
    return {displayX - kCharacterFrameX - kCharacterArtX, displayY - kFrameY, true};
  }
  return {};
}

int CharacterEffects::buffer(uint16_t* frame) {
  if (!outputs_[0] || !outputs_[1] || outputs_[0] == outputs_[1]) {
    error_ = "Effects require two distinct persistent output buffers.";
    return -1;
  }
  if (frame == outputs_[0]) return 0;
  if (frame == outputs_[1]) return 1;
  error_ = "Effect output buffer is not registered.";
  return -1;
}

bool CharacterEffects::restore(uint16_t* frame) {
  error_ = nullptr;
  const int index = buffer(frame);
  if (index < 0) return false;
  // Overlays saved whatever was under them, including other effects, so undo them first, newest first.
  for (int region = regionCounts_[index] - 1; region >= 0; --region) {
    const OverlayRegion& area = regions_[index][region];
    const uint16_t* saved = overlay_ + (index * kOverlayBadges + region) * kOverlaySpan * kOverlaySpan;
    for (int row = 0; row < area.height; ++row)
      std::memcpy(frame + (area.y + row) * kCharacterFrameWidth + area.x, saved + row * kOverlaySpan,
                  area.width * sizeof(uint16_t));
  }
  regionCounts_[index] = 0;
  for (size_t i = 0; i < counts_[index]; ++i) frame[damage_[index][i]] = 0;
  counts_[index] = 0;
  return true;
}

void CharacterEffects::pixel(int x, int y, uint16_t rgb) {
  x += kCharacterArtX;
  y += kFrameY;
  if (x < 0 || y < 0 || x >= kCharacterFrameWidth || y >= kCharacterFrameHeight || !rgb) return;
  const int displayX = x + kCharacterFrameX, displayY = y;
  const int circleDx = displayX - kDisplaySize / 2, circleDy = displayY - kDisplaySize / 2;
  if (circleDx * circleDx + circleDy * circleDy > (kDisplaySize / 2) * (kDisplaySize / 2)) return;
  // Protect black facial interiors as well as every non-black artwork pixel.
  const int dx = x - kCharacterFrameWidth / 2, dy = y - kDisplaySize / 2;
  if (int64_t(dx) * dx * 135 * 135 + int64_t(dy) * dy * 160 * 160
      < int64_t(160) * 160 * 135 * 135) return;
  const uint32_t index = y * kCharacterFrameWidth + x;
  if (outputs_[active_][index]) return;
  if (counts_[active_] == kDamageBudget) {
    error_ = "Effect damage budget exceeded.";
    return;
  }
  damage_[active_][counts_[active_]++] = index;
  outputs_[active_][index] = rgb;
}

void CharacterEffects::dot(int x, int y, int radius, uint16_t rgb) {
  for (int dy = -radius; dy <= radius; ++dy)
    for (int dx = -radius; dx <= radius; ++dx)
      if (dx * dx + dy * dy <= radius * radius) pixel(x + dx, y + dy, rgb);
}

void CharacterEffects::spark(int x, int y, int radius, uint16_t rgb) {
  for (int i = -radius; i <= radius; ++i) {
    pixel(x + i, y, rgb);
    pixel(x, y + i, rgb);
  }
}

void CharacterEffects::glyph(
    const uint8_t* rows, int rowCount, int x, int y, int scale, uint16_t rgb) {
  for (int row = 0; row < rowCount; ++row)
    for (int column = 0; column < 5; ++column)
      if (rows[row] & (1 << (4 - column)))
        for (int dy = 0; dy < scale; ++dy)
          for (int dx = 0; dx < scale; ++dx)
            pixel(x + column * scale + dx, y + row * scale + dy, rgb);
}

// Draws a filled disc with an outline ring, anti-aliased by how much of each pixel the shapes cover.
// Effects only paint over black, so blending against black is exact.
void CharacterEffects::smoothDisc(int x, int y, double outer, double ringWidth,
                                  uint16_t fill, uint16_t ringColor, double ringAlpha) {
  const Rgb inside = unpack(fill), edge = unpack(ringColor);
  const float outerEdge = static_cast<float>(outer) + .5f;
  const float innerEdge = static_cast<float>(outer - ringWidth) + .5f;
  const float alpha = static_cast<float>(ringAlpha);
  const int reach = std::min(kMaxSmoothReach, static_cast<int>(std::ceil(outer)) + 1);
  const float* distances = distanceTable();
  for (int dy = -reach; dy <= reach; ++dy) {
    for (int dx = -reach; dx <= reach; ++dx) {
      const float distance = distances[dx * dx + dy * dy];
      const float disc = coverage(outerEdge - distance);
      if (disc <= 0) continue;
      const float inner = coverage(innerEdge - distance);
      const float body = fill ? inner : 0;
      const float band = (disc - inner) * alpha;
      const int r = static_cast<int>(inside.r * body + edge.r * band + .5f);
      const int g = static_cast<int>(inside.g * body + edge.g * band + .5f);
      const int b = static_cast<int>(inside.b * body + edge.b * band + .5f);
      pixel(x + dx, y + dy, color(std::min(r, 255), std::min(g, 255), std::min(b, 255)));
    }
  }
}

bool CharacterEffects::beginOverlay(int x, int y) {
  if (!overlay_ || regionCounts_[active_] == kOverlayBadges) return false;
  const int left = std::max(0, x + kCharacterArtX - kOverlayReach);
  const int top = std::max(0, y + kFrameY - kOverlayReach);
  const int right = std::min(kCharacterFrameWidth, x + kCharacterArtX + kOverlayReach + 1);
  const int bottom = std::min(kCharacterFrameHeight, y + kFrameY + kOverlayReach + 1);
  if (right <= left || bottom <= top) return false;
  const int region = regionCounts_[active_]++;
  regions_[active_][region] = {static_cast<int16_t>(left), static_cast<int16_t>(top),
                               static_cast<uint8_t>(right - left), static_cast<uint8_t>(bottom - top)};
  uint16_t* saved = overlay_ + (active_ * kOverlayBadges + region) * kOverlaySpan * kOverlaySpan;
  for (int row = top; row < bottom; ++row)
    std::memcpy(saved + (row - top) * kOverlaySpan, outputs_[active_] + row * kCharacterFrameWidth + left,
                (right - left) * sizeof(uint16_t));
  return true;
}

// Paints over whatever is there (art included), blending the anti-aliased edge with the real pixel.
void CharacterEffects::overlayPixel(int x, int y, uint16_t rgb, float alpha) {
  x += kCharacterArtX;
  y += kFrameY;
  if (alpha <= 0 || x < 0 || y < 0 || x >= kCharacterFrameWidth || y >= kCharacterFrameHeight) return;
  const int circleDx = x + kCharacterFrameX - kDisplaySize / 2, circleDy = y - kDisplaySize / 2;
  if (circleDx * circleDx + circleDy * circleDy > (kDisplaySize / 2) * (kDisplaySize / 2)) return;
  uint16_t& target = outputs_[active_][y * kCharacterFrameWidth + x];
  if (alpha >= 1) {
    target = rgb;
    return;
  }
  const Rgb top = unpack(rgb), under = unpack(target);
  target = color(static_cast<int>(under.r + (top.r - under.r) * alpha + .5f),
                 static_cast<int>(under.g + (top.g - under.g) * alpha + .5f),
                 static_cast<int>(under.b + (top.b - under.b) * alpha + .5f));
}

void CharacterEffects::overlayDisc(int x, int y, float outer, float ringWidth,
                                   uint16_t fill, uint16_t ringColor, float ringAlpha) {
  const float* distances = distanceTable();
  const int reach = std::min(kMaxSmoothReach, static_cast<int>(std::ceil(outer)) + 1);
  for (int dy = -reach; dy <= reach; ++dy) {
    for (int dx = -reach; dx <= reach; ++dx) {
      const float distance = distances[dx * dx + dy * dy];
      const float disc = coverage(outer + .5f - distance);
      if (disc <= 0) continue;
      const float inner = coverage(outer - ringWidth + .5f - distance);
      if (fill && inner > 0) overlayPixel(x + dx, y + dy, fill, inner);
      if (disc > inner) overlayPixel(x + dx, y + dy, ringColor, (disc - inner) * ringAlpha);
    }
  }
}

void CharacterEffects::badge(const AgentBadgeIcon& icon, AgentBadgeRole role, int x, int y, double seconds) {
  constexpr int radius = 17;
  if (beginOverlay(x, y)) {
    if (role == AgentBadgeRole::Attention) {
      const float breath = .72f + .24f * std::sin(static_cast<float>(seconds) * 3.14159265f);
      overlayDisc(x, y, radius + 4.5f, 2, 0, color(255, 192, 86), breath);
    }
    overlayDisc(x, y, radius + 1.5f, 1.6f, color(17, 20, 27), darken(icon.color, .85), 1);
    for (int row = 0; row < 24; ++row)
      for (int column = 0; column < 24; ++column)
        if (icon.mask[row * 3 + column / 8] & (0x80 >> (column % 8)))
          overlayPixel(x - 12 + column, y - 12 + row, icon.color, 1);
    return;
  }
  if (role == AgentBadgeRole::Attention) {
    const double breath = .72 + .24 * std::sin(seconds * 3.14159265358979323846);
    smoothDisc(x, y, radius + 4.5, 2, 0, color(255, 192, 86), breath);
  }
  // pixel() never overwrites what's already drawn, so paint front to back: glyph, fill, outline.
  // Every badge shares a near-black fill; the agent's color tints the glyph and the ring.
  const uint16_t glyphColor = icon.color;
  constexpr int glyphLeft = -12, glyphTop = -12;
  for (int row = 0; row < 24; ++row) {
    for (int column = 0; column < 24; ++column) {
      const uint8_t byte = icon.mask[row * 3 + column / 8];
      if (byte & (0x80 >> (column % 8))) pixel(x + glyphLeft + column, y + glyphTop + row, glyphColor);
    }
  }
  smoothDisc(x, y, radius + 1.5, 1.6, color(17, 20, 27), darken(icon.color, .85), 1);
}

bool CharacterEffects::showsBadge(AgentBadgeRole role) const {
  if (!badges_) return false;
  const auto snapshot = badges_->snapshot();
  for (int i = 0; i < snapshot.activeCount; ++i)
    if (snapshot.active[i].role == role) return true;
  return false;
}

void CharacterEffects::agentBadges(const CharacterState& state) {
  if (!badges_ || (state.mode != CharacterMode::Working && state.mode != CharacterMode::Attention
      && state.mode != CharacterMode::Complete)) return;
  const auto snapshot = badges_->snapshot();
  AgentBadgeRole wanted = AgentBadgeRole::Working;
  if (state.mode == CharacterMode::Attention) wanted = AgentBadgeRole::Attention;
  else if (state.mode == CharacterMode::Complete) wanted = AgentBadgeRole::Complete;
  const int limit = std::min<int>(snapshot.activeCount, 4);
  int matching = 0;
  for (int i = 0; i < snapshot.activeCount; ++i)
    if (snapshot.active[i].role == wanted) ++matching;
  matching = std::min(matching, 4);
  int rendered = 0;
  for (int i = 0; i < limit && rendered < matching; ++i) {
    const auto& active = snapshot.active[i];
    if (active.role != wanted) continue;
    const AgentBadgeIcon* icon = nullptr;
    for (int j = 0; j < snapshot.iconCount; ++j) {
      if (std::strcmp(snapshot.icons[j].id, active.id) == 0) {
        icon = &snapshot.icons[j];
        break;
      }
    }
    if (!icon) continue;
    const auto anchor = badgeAnchor(state.mode, wanted, rendered, matching, state.effectSeconds);
    if (anchor.visible) badge(*icon, wanted, anchor.x, anchor.y, state.effectSeconds);
    ++rendered;
  }
}

void CharacterEffects::workingBits(double seconds) {
  constexpr uint8_t glyphs[2][9] = {
    {14, 17, 17, 17, 17, 17, 17, 17, 14},
    {4, 12, 4, 4, 4, 4, 4, 4, 14},
  };
  constexpr int lanes[] = {-24, -12, 10, 22};
  constexpr int top = -kFrameY - 9, bottom = 34;
  // Recycle beyond the physical top edge; fade only where digits meet the head.
  const double cycle = seconds / 4;
  for (int lane = 0; lane < 4; ++lane) {
    for (int slot = 0; slot < 2; ++slot) {
      double phase = cycle + lane * .125 + slot * .5;
      phase -= std::floor(phase);
      const double ramp = std::min(1.0, (lane < 2 ? 1 - phase : phase) / .15);
      const uint16_t rgb = color(124, 222, 242, .85 * ramp * ramp * (3 - 2 * ramp));
      if (!rgb) continue;
      const int travel = static_cast<int>(std::lround((bottom - top) * phase));
      const int y = lane < 2 ? top + travel : bottom - travel;
      const int x = kFrameWidth / 2 + lanes[lane];
      const uint8_t* glyph = glyphs[(lane + slot) % 2];
      this->glyph(glyph, 9, x, y, 1, rgb);
    }
  }
}

void CharacterEffects::sleepingZs(double seconds) {
  constexpr uint8_t z[] = {31, 1, 2, 4, 8, 16, 31};
  constexpr int rightXs[] = {228, 253, 281};
  constexpr int leftXs[] = {167, 142, 105};
  constexpr int scales[] = {1, 1, 2};
  constexpr int bottom = 72, top = -18;
  for (int lane = 0; lane < 3; ++lane) {
    const double position = seconds / 3.6 + lane * .31;
    const uint32_t sequence = static_cast<uint32_t>(std::floor(position));
    const double phase = position - std::floor(position);
    const double edge = std::min(phase, 1 - phase);
    const double fade = std::min(1.0, edge / .14);
    const int y = bottom - static_cast<int>(std::lround((bottom - top) * phase));
    const bool right = hash(sequence * 13 + lane * 101) & 1;
    glyph(z, 7, right ? rightXs[lane] : leftXs[lane], y, scales[lane],
          color(174, 190, 255, .85 * fade));
  }
}

// Centered under the character, inside the round screen: one line, or two stacked lines.
void CharacterEffects::usageText(const CharacterState& state) {
  if (!badges_) return;
  const UsageLines usage = badges_->usage();
  if (!usage.count) return;
  constexpr int scale = 2, advance = 6 * scale, lineHeight = 17;
  const double brightness = state.mode == CharacterMode::Sleep ? .55 : 1;
  const uint16_t label = color(150, 162, 190, brightness), value = color(236, 241, 255, brightness);
  const int firstTop = usage.count == 1 ? 420 : 410;
  for (int line = 0; line < usage.count; ++line) {
    const char* text = usage.text[line];
    const int length = static_cast<int>(std::strlen(text));
    const char* colon = std::strchr(text, ':');
    const int width = length * advance - scale;
    int x = kDisplaySize / 2 - width / 2 - kCharacterFrameX - kCharacterArtX;
    const int y = firstTop + line * lineHeight - kFrameY;
    for (int i = 0; i < length; ++i, x += advance) {
      if (const uint8_t* rows = usageGlyph(text[i]))
        glyph(rows, 7, x, y, scale, colon && text + i <= colon ? label : value);
    }
  }
}

bool CharacterEffects::render(const CharacterState& state, uint16_t* frame) {
  error_ = nullptr;
  const int index = buffer(frame);
  if (index < 0) return false;
  if (counts_[index]) {
    error_ = "Restore previous effects before rendering this output buffer.";
    return false;
  }
  if (static_cast<uint8_t>(state.mode) > static_cast<uint8_t>(CharacterMode::Sleep)
      || static_cast<uint8_t>(state.requestedMode) > static_cast<uint8_t>(CharacterMode::Sleep)
      || !std::isfinite(state.effectSeconds) || state.effectSeconds < 0 || state.effectSeconds > 12
      || state.pose.direction >= kSpriteDirections || state.pose.index > 23 || state.pose.blinkLevel > 4) {
    error_ = "Invalid character effect state.";
    return false;
  }
  active_ = index;
  const double t = state.effectSeconds;
  constexpr double pi = 3.14159265358979323846;
  if (state.mode == CharacterMode::Working) {
    const bool badgeLeads = showsBadge(AgentBadgeRole::Working);
    double x = std::cos(t * pi / 6), y = std::sin(t * pi / 6);
    constexpr double cosine = .9872272833756269, sine = .15931820661424598;
    for (int i = 0; i < 7; ++i) {
      if (i == 6 && badgeLeads) break;
      dot(kFrameWidth / 2 + int(std::lround(kOrbitRadius * x)),
          kFrameHeight / 2 + int(std::lround(kOrbitRadius * y)), i == 6 ? 5 : 2,
          color(80, 215, 239, .30 + i * .108));
      const double nextX = x * cosine - y * sine;
      y = x * sine + y * cosine;
      x = nextX;
    }
    workingBits(t);
    agentBadges(state);
  } else if (state.mode == CharacterMode::Sleep) {
    sleepingZs(t);
  } else if (state.mode == CharacterMode::Attention) {
    const double breath = .78 + .17 * std::sin(t * pi / 2);
    constexpr uint8_t question[] = {14, 17, 1, 2, 4, 0, 4};
    const uint16_t amber = color(255, 192, 86, breath);
    double ringX = 1, ringY = 0;
    for (int i = 0; i < 32; ++i) {
      dot(348 + int(std::lround(23 * ringX)), 56 + int(std::lround(23 * ringY)), 1,
          color(255, 192, 86, breath * .3));
      const double nextX = ringX * .9807852804032304 - ringY * .19509032201612825;
      ringY = ringX * .19509032201612825 + ringY * .9807852804032304;
      ringX = nextX;
    }
    for (int y = 0; y < 7; ++y)
      for (int x = 0; x < 5; ++x)
        if (question[y] & (1 << (4 - x)))
          dot(340 + x * 4, 44 + y * 4, 2, amber);
    if (!showsBadge(AgentBadgeRole::Attention)) dot(35, 70, 2, color(255, 192, 86, breath * .45));
    agentBadges(state);
  } else if (state.mode == CharacterMode::Complete && t < 3) {
    constexpr double xs[] = {1, .809017, .309017, -.309017, -.809017, -1, -.809017, -.309017, .309017, .809017};
    constexpr double ys[] = {0, .587785, .951057, .951057, .587785, 0, -.587785, -.951057, -.951057, -.587785};
    for (int side : {-1, 1}) {
      const double launch = (t - .3) / .5;
      if (launch >= 0 && launch < 1) {
        const int x = 200 + side * (160 - int(20 * launch));
        const int y = 278 - int(198 * (2 * launch - launch * launch));
        dot(x, y, 2, color(255, 222, 154));
        for (int tail = 3; tail < 11; ++tail)
          pixel(x, y + tail, color(190, 161, 247, (11 - tail) / 12.0));
      }
      const double age = t - .8;
      if (age >= 0 && age < 1.5) {
        const double radius = 80 * age / (1 + age);
        const double brightness = 1 - age / 1.5;
        const int centerX = 200 + side * 140, centerY = 80 + int(20 * age * age);
        for (int ray = 0; ray < 10; ++ray) {
          const int x = centerX + int(radius * xs[ray]), y = centerY + int(radius * ys[ray]);
          const uint16_t rgb = ray % 2 ? color(121, 229, 209, brightness)
              : color(247, 206, 118, brightness);
          dot(x, y, 1, rgb);
          pixel(centerX + int((radius - 4) * xs[ray]), centerY + int((radius - 4) * ys[ray]),
                color(190, 161, 247, brightness * .5));
        }
      }
    }
    const double fade = t < 1.8 ? 1 : (3 - t) / 1.2;
    for (uint32_t i = 0; i < 36; ++i) {
      const uint32_t seed = hash(state.eventId * 37 + i);
      const double age = t - (seed % 300) / 1000.0;
      if (age < 0) continue;
      const int side = i % 2 ? 1 : -1;
      const int x = kFrameWidth / 2 + side * (154 + int((seed >> 8) % 32))
          + int(side * 14 * age);
      const int y = 42 + int((seed >> 16) % 65) - int(48 * age) + int(62 * age * age);
      const uint16_t rgb = i % 3 == 0 ? color(121, 229, 209, fade)
          : i % 3 == 1 ? color(247, 206, 118, fade) : color(190, 161, 247, fade);
      if (i % 7 == 0) spark(x, y, 3, rgb);
      else {
        pixel(x, y, rgb); pixel(x + 1, y, rgb);
        pixel(x, y + 1, rgb); pixel(x + 1, y + 1, rgb);
        pixel(x + 2, y, rgb); pixel(x + 2, y + 1, rgb);
      }
    }
    agentBadges(state);
  }
  // Immediate, quiet acknowledgement even while a surprise waits for center.
  if (state.eventId && t < .5 && (state.requestedMode == CharacterMode::Surprise
      || state.mode == CharacterMode::Surprise)) {
    const uint16_t rgb = color(174, 217, 251, (.5 - t) * 1.6);
    spark(38 - int(t * 10), 65 - int(t * 14), 3, rgb);
    spark(362 + int(t * 10), 65 - int(t * 14), 3, rgb);
  }
  usageText(state);
  return error_ == nullptr;
}
}

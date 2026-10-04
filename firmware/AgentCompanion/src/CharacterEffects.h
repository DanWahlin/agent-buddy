#pragma once
#include "AgentBadges.h"
#include "CharacterMotion.h"
#include "Config.h"
#include <cstddef>

namespace copilot {
struct AgentBadgePoint {
  int x = 0;
  int y = 0;
  bool visible = false;
};

class CharacterEffects {
 public:
  static constexpr size_t kDamageBudget = 6144;
  // Badges draw above the character by saving the square they cover and restoring it next frame.
  static constexpr int kOverlayBadges = 4;
  static constexpr int kOverlayReach = 24;
  static constexpr int kOverlaySpan = 2 * kOverlayReach + 1;
  static constexpr size_t kOverlayScratchPixels = 2 * kOverlayBadges * kOverlaySpan * kOverlaySpan;
  // Without overlay scratch (kOverlayScratchPixels), badges draw behind the character art.
  CharacterEffects(uint16_t* firstOutput, uint16_t* secondOutput, const AgentBadges* badges = nullptr,
                   uint16_t* overlayScratch = nullptr);
  static AgentBadgePoint badgeAnchor(
      CharacterMode mode, AgentBadgeRole role, int index, int count, double seconds);
  // Restore before SpriteRenderer::render; overlay only after its successful render.
  bool restore(uint16_t* frame);
  bool render(const CharacterState& state, uint16_t* frame);
  const char* error() const { return error_; }

 private:
  int buffer(uint16_t* frame);
  void pixel(int x, int y, uint16_t color);
  void dot(int x, int y, int radius, uint16_t color);
  void spark(int x, int y, int radius, uint16_t color);
  void glyph(const uint8_t* rows, int rowCount, int x, int y, int scale, uint16_t color);
  void agentBadges(const CharacterState& state);
  bool showsBadge(AgentBadgeRole role) const;
  void badge(const AgentBadgeIcon& icon, AgentBadgeRole role, int x, int y, double seconds);
  void smoothDisc(int x, int y, double outer, double ringWidth, uint16_t fill, uint16_t ringColor, double ringAlpha);
  bool beginOverlay(int x, int y);
  void overlayPixel(int x, int y, uint16_t rgb, float alpha);
  void overlayDisc(int x, int y, float outer, float ringWidth, uint16_t fill, uint16_t ringColor, float ringAlpha);
  struct OverlayRegion {
    int16_t x, y;
    uint8_t width, height;
  };
  void workingBits(double seconds);
  void sleepingZs(double seconds);
  void usageText(const CharacterState& state);
  uint16_t* outputs_[2];
  const AgentBadges* badges_ = nullptr;
  uint32_t damage_[2][kDamageBudget] = {};
  size_t counts_[2] = {};
  uint16_t* overlay_ = nullptr;
  OverlayRegion regions_[2][kOverlayBadges] = {};
  uint8_t regionCounts_[2] = {};
  int active_ = 0;
  const char* error_ = nullptr;
};
}

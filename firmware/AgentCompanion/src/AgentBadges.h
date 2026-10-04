#pragma once
#include "CharacterMotion.h"
#include <cstddef>
#include <cstdint>
#if defined(ARDUINO)
#include <Arduino.h>
#endif

namespace copilot {
constexpr size_t kMaxAgentIcons = 8;
constexpr size_t kMaxActiveAgentBadges = 8;
constexpr size_t kAgentBadgeIdMax = 16;
constexpr size_t kAgentBadgeMaskBytes = 72;
// Usage lines such as "AIC: 26,458" and "Tokens: 1.2M", shown at the bottom of the screen.
constexpr size_t kMaxUsageLines = 2;
constexpr size_t kUsageLineMax = 18;

struct UsageLines {
  char text[kMaxUsageLines][kUsageLineMax + 1] = {};
  uint8_t count = 0;
};

struct AgentBadgeIcon {
  char id[kAgentBadgeIdMax + 1] = {};
  uint16_t color = 0;
  uint8_t mask[kAgentBadgeMaskBytes] = {};
  bool used = false;
};

enum class AgentBadgeRole : uint8_t { Working, Attention, Complete };

struct ActiveAgentBadge {
  char id[kAgentBadgeIdMax + 1] = {};
  AgentBadgeRole role = AgentBadgeRole::Working;
};

struct AgentBadgesSnapshot {
  AgentBadgeIcon icons[kMaxAgentIcons] = {};
  ActiveAgentBadge active[kMaxActiveAgentBadges] = {};
  uint8_t iconCount = 0;
  uint8_t activeCount = 0;
  uint32_t revision = 0;
};

class AgentBadges {
 public:
  bool setIconPacket(const char* payload);
  bool setActivePacket(const char* payload);
  void clearActive();
  // Lines split by '|'; an empty packet clears them.
  bool setUsagePacket(const char* payload);
  AgentBadgesSnapshot snapshot() const;
  UsageLines usage() const;
  const char* error() const { return error_; }
  uint8_t activeCount() const { return activeCount_; }

 private:
  int findIcon(const char* id) const;
  void setError(const char* error) { error_ = error; }

  AgentBadgeIcon icons_[kMaxAgentIcons] = {};
  ActiveAgentBadge active_[kMaxActiveAgentBadges] = {};
  uint8_t activeCount_ = 0;
  UsageLines usage_;
  uint32_t revision_ = 0;
  const char* error_ = nullptr;
#if defined(ARDUINO)
  mutable portMUX_TYPE lock_ = portMUX_INITIALIZER_UNLOCKED;
#endif
};
}

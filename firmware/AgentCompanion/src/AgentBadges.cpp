#include "AgentBadges.h"
#include <cstring>

namespace copilot {
namespace {
bool validIdChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
}

bool parseId(const char*& cursor, char* id) {
  size_t length = 0;
  while (validIdChar(*cursor)) {
    if (length == kAgentBadgeIdMax) return false;
    id[length++] = *cursor++;
  }
  if (length == 0) return false;
  id[length] = '\0';
  return true;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool parseColor(const char* text, uint16_t& color) {
  int values[6];
  for (int i = 0; i < 6; ++i) {
    values[i] = hexValue(text[i]);
    if (values[i] < 0) return false;
  }
  const int r = values[0] * 16 + values[1];
  const int g = values[2] * 16 + values[3];
  const int b = values[4] * 16 + values[5];
  const uint16_t rgb = static_cast<uint16_t>(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
  color = static_cast<uint16_t>((rgb << 8) | (rgb >> 8));
  return true;
}

int base64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

bool decodeBase64(const char* input, uint8_t* output, size_t outputSize) {
  const size_t length = std::strlen(input);
  if (length == 0 || (length % 4) != 0) return false;
  size_t out = 0;
  for (size_t i = 0; i < length; i += 4) {
    int values[4];
    int padding = 0;
    for (int j = 0; j < 4; ++j) {
      const char c = input[i + j];
      if (c == '=') {
        values[j] = 0;
        ++padding;
      } else if (padding) return false;
      else {
        values[j] = base64Value(c);
        if (values[j] < 0) return false;
      }
    }
    if (padding > 2 || (padding && i + 4 != length)) return false;
    const uint32_t combined = (static_cast<uint32_t>(values[0]) << 18)
        | (static_cast<uint32_t>(values[1]) << 12)
        | (static_cast<uint32_t>(values[2]) << 6)
        | static_cast<uint32_t>(values[3]);
    const int bytes = 3 - padding;
    if (out + bytes > outputSize) return false;
    if (bytes >= 1) output[out++] = static_cast<uint8_t>(combined >> 16);
    if (bytes >= 2) output[out++] = static_cast<uint8_t>(combined >> 8);
    if (bytes >= 3) output[out++] = static_cast<uint8_t>(combined);
  }
  return out == outputSize;
}

bool parseRole(char c, AgentBadgeRole& role) {
  if (c == 'w') { role = AgentBadgeRole::Working; return true; }
  if (c == 'a') { role = AgentBadgeRole::Attention; return true; }
  if (c == 'c') { role = AgentBadgeRole::Complete; return true; }
  return false;
}
}

bool AgentBadges::setIconPacket(const char* payload) {
  error_ = nullptr;
  if (!payload) {
    setError("missing icon packet");
    return false;
  }
  AgentBadgeIcon parsed;
  const char* cursor = payload;
  if (!parseId(cursor, parsed.id) || *cursor++ != ':') {
    setError("invalid icon id");
    return false;
  }
  if (std::strlen(cursor) < 7 || !parseColor(cursor, parsed.color) || cursor[6] != ':') {
    setError("invalid icon color");
    return false;
  }
  cursor += 7;
  if (!decodeBase64(cursor, parsed.mask, sizeof(parsed.mask))) {
    setError("invalid icon mask");
    return false;
  }
  parsed.used = true;
#if defined(ARDUINO)
  portENTER_CRITICAL(&lock_);
#endif
  int slot = findIcon(parsed.id);
  if (slot < 0) {
    for (size_t i = 0; i < kMaxAgentIcons; ++i) {
      if (!icons_[i].used) { slot = static_cast<int>(i); break; }
    }
  }
  if (slot >= 0) {
    icons_[slot] = parsed;
    ++revision_;
  }
#if defined(ARDUINO)
  portEXIT_CRITICAL(&lock_);
#endif
  if (slot < 0) {
    setError("icon table full");
    return false;
  }
  return true;
}

bool AgentBadges::setActivePacket(const char* payload) {
  error_ = nullptr;
  if (!payload) {
    setError("missing agents packet");
    return false;
  }
  ActiveAgentBadge parsed[kMaxActiveAgentBadges] = {};
  uint8_t count = 0;
  const char* cursor = payload;
  if (*cursor) {
    for (;;) {
      if (count == kMaxActiveAgentBadges || !parseId(cursor, parsed[count].id) || *cursor++ != '='
          || !parseRole(*cursor++, parsed[count].role)) {
        setError("invalid agents packet");
        return false;
      }
      ++count;
      if (*cursor == '\0') break;
      if (*cursor++ != ',') {
        setError("invalid agents separator");
        return false;
      }
    }
  }
#if defined(ARDUINO)
  portENTER_CRITICAL(&lock_);
#endif
  std::memset(active_, 0, sizeof(active_));
  for (uint8_t i = 0; i < count; ++i) active_[i] = parsed[i];
  activeCount_ = count;
  ++revision_;
#if defined(ARDUINO)
  portEXIT_CRITICAL(&lock_);
#endif
  return true;
}

void AgentBadges::clearActive() {
#if defined(ARDUINO)
  portENTER_CRITICAL(&lock_);
#endif
  std::memset(active_, 0, sizeof(active_));
  activeCount_ = 0;
  ++revision_;
#if defined(ARDUINO)
  portEXIT_CRITICAL(&lock_);
#endif
}

AgentBadgesSnapshot AgentBadges::snapshot() const {
  AgentBadgesSnapshot result;
#if defined(ARDUINO)
  portENTER_CRITICAL(&lock_);
#endif
  for (size_t i = 0; i < kMaxAgentIcons; ++i) {
    if (!icons_[i].used) continue;
    result.icons[result.iconCount++] = icons_[i];
  }
  for (uint8_t i = 0; i < activeCount_; ++i) result.active[i] = active_[i];
  result.activeCount = activeCount_;
  result.revision = revision_;
#if defined(ARDUINO)
  portEXIT_CRITICAL(&lock_);
#endif
  return result;
}

int AgentBadges::findIcon(const char* id) const {
  for (size_t i = 0; i < kMaxAgentIcons; ++i)
    if (icons_[i].used && std::strcmp(icons_[i].id, id) == 0) return static_cast<int>(i);
  return -1;
}
}

#pragma once
#include <cstdint>

namespace copilot {
constexpr int16_t kOrientationOffsetLimitTenths = 150;

inline bool validOrientationOffset(int16_t tenths) {
  return tenths >= -kOrientationOffsetLimitTenths && tenths <= kOrientationOffsetLimitTenths
      && tenths % 5 == 0;
}

inline bool parseOrientationOffset(const char* text, int16_t& tenths) {
  if (!text || !*text) return false;
  const bool negative = *text == '-';
  if (negative) ++text;
  unsigned value = 0, digits = 0;
  for (; *text; ++text) {
    if (*text < '0' || *text > '9' || ++digits > 3) return false;
    value = value * 10 + static_cast<unsigned>(*text - '0');
  }
  if (!digits || value > kOrientationOffsetLimitTenths || value % 5) return false;
  tenths = static_cast<int16_t>(negative ? -static_cast<int>(value) : static_cast<int>(value));
  return true;
}
}

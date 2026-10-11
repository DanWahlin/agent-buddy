#pragma once
#include <cstdint>

namespace copilot {
// Millisecond deadlines on the wrapping millis() clock. 0 means "no deadline",
// so a deadline that lands on 0 moves to 1.
constexpr uint32_t deadlineAfter(uint32_t now, uint32_t delayMs) {
  const uint32_t deadline = now + delayMs;
  return deadline ? deadline : 1;
}

constexpr bool elapsed(uint32_t now, uint32_t deadline) {
  return deadline && static_cast<int32_t>(now - deadline) >= 0;
}
}

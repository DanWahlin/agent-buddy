#pragma once
#include <cstdint>

// The panel takes RGB565 high byte first, so frame buffers keep pixels byte-swapped.
namespace copilot {
constexpr uint16_t swapBytes(uint16_t value) {
  return static_cast<uint16_t>((value << 8) | (value >> 8));
}

// Packs 8-bit channels into native RGB565.
constexpr uint16_t rgb565(unsigned r, unsigned g, unsigned b) {
  return static_cast<uint16_t>((r >> 3) << 11 | (g >> 2) << 5 | (b >> 3));
}
}

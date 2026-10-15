#pragma once
// Tells the 1.75-C from the other 1.75 boards (standard, -B, -G). Plain C++: native tests include it.
#include <cstdint>
#include "BoardConfig.h"

namespace copilot {
namespace board {
// Standard: the 1.75, -B, and -G, which have the TCA9554 I/O expander. C: the 1.75-C, which does not.
enum class Variant : uint8_t { Standard, C };

constexpr const char* variantName(Variant variant) { return variant == Variant::C ? "c" : "standard"; }

constexpr int audioMclkPin(Variant variant) {
  return variant == Variant::C ? kAudioMclkPinC : kAudioMclkPin;
}

// Wire.endTransmission() results for an empty write, which probes an address.
constexpr uint8_t kI2cProbeAcknowledged = 0;
constexpr uint8_t kI2cProbeNotAcknowledged = 2;
constexpr uint8_t kVariantProbeAttempts = 3;

// `probe` returns the Wire.endTransmission() result for the expander address. Only a clear answer
// counts. Bus errors keep Standard, because the -C MCLK pin is an expansion header pin on the others.
template <typename Probe>
Variant detectVariant(Probe probe) {
  for (uint8_t attempt = 0; attempt < kVariantProbeAttempts; ++attempt) {
    const uint8_t result = probe();
    if (result == kI2cProbeAcknowledged) return Variant::Standard;
    if (result == kI2cProbeNotAcknowledged) return Variant::C;
  }
  return Variant::Standard;
}
}  // namespace board
}  // namespace copilot

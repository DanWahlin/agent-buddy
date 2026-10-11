#pragma once
// Device-only drivers for the Waveshare ESP32-S3-Touch-AMOLED-1.75 (see BoardConfig.h).
#include "BoardConfig.h"
#include <Arduino_GFX_Library.h>
#include <TouchDrvCSTXXX.hpp>

namespace copilot {
namespace board {
using TouchController = TouchDrvCST92xx;
constexpr uint8_t kTouchPointCapacity = 2;
static_assert(kTouchI2cAddress == CST92XX_SLAVE_ADDRESS, "Touch address differs from the driver.");

inline Arduino_DataBus& displayBus() {
  static Arduino_ESP32QSPI bus(kDisplayCsPin, kDisplaySckPin, kDisplayD0Pin, kDisplayD1Pin,
                               kDisplayD2Pin, kDisplayD3Pin, true);
  return bus;
}

inline DisplayPanel& displayPanel() {
  static DisplayPanel panel(&displayBus(), kDisplayResetPin, 0, kDisplaySize, kDisplaySize,
                            kDisplayColumnOffset, 0, 0, 0);
  return panel;
}
}  // namespace board
}  // namespace copilot

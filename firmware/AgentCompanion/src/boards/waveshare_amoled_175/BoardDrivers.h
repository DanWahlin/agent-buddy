#pragma once
// Device-only drivers for the Waveshare ESP32-S3-Touch-AMOLED-1.75 (see BoardConfig.h).
#include "BoardConfig.h"
#include "BoardVariant.h"
#include "../drivers/Es8311AudioOutput.h"
#include "../drivers/Qmi8658Accelerometer.h"
#include "../../DisplayDma.h"
#include <Arduino_GFX_Library.h>
#include <TouchDrvCSTXXX.hpp>
#include <Wire.h>

namespace copilot {
namespace board {
using TouchController = TouchDrvCST92xx;
constexpr uint8_t kTouchPointCapacity = 2;
static_assert(kTouchI2cAddress == CST92XX_SLAVE_ADDRESS, "Touch address differs from the driver.");
static_assert(kImuI2cAddress == QMI8658_L_SLAVE_ADDRESS, "IMU address differs from the driver.");
static_assert(kAudioCodecI2cAddress == ES8311_ADDRESS_0, "Codec address differs from the driver.");

// Runs first in setup(). This board needs nothing before its drivers start.
inline void beginBoard() {}

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

// CO5300 QSPI pixel write: each frame starts with the RAMWR command and address.
inline DisplayScanout displayScanout() {
  return {ESP32QSPI_SPI_HOST, 0, 8, 24, true, kDisplayQspiWriteCommand, kDisplayQspiPixelAddress,
          kDisplayCsPin, -1};
}

inline void setDisplayBrightness(uint8_t brightness) { displayPanel().setBrightness(brightness); }

inline void configureTouch(TouchController&) {}

// The QMI8658 axes are already the orientation frame (see ScreenOrientation.h), so read() needs
// no axis change on this board. The IMU starts after touch, then sets the shared bus clock.
inline Qmi8658Accelerometer& accelerometer() {
  static Qmi8658Accelerometer sensor(Wire, kImuI2cAddress, kI2cFrequency);
  return sensor;
}

// Detected once, from the shared I2C bus. setup() asks right after touch starts the bus; before
// that, every probe fails and the result is Standard.
inline Variant variant() {
  static const Variant detected = detectVariant([] {
    Wire.beginTransmission(kIoExpanderI2cAddress);
    return Wire.endTransmission();
  });
  return detected;
}

inline Es8311AudioOutput& audioOutput() {
  static Es8311AudioOutput output({audioMclkPin(variant()), kAudioBclkPin, kAudioWordSelectPin, kAudioDataOutPin,
                                   kAudioAmplifierPin, kI2cPort, kAudioCodecI2cAddress,
                                   kAudioMinimumCodecVolume, kAudioMaximumCodecVolume});
  return output;
}
}  // namespace board
}  // namespace copilot

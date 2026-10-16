#pragma once
// Device-only drivers for the Waveshare ESP32-S3-Touch-LCD-1.54 (see BoardConfig.h).
#include "BoardConfig.h"
#include "../drivers/Es8311AudioOutput.h"
#include "../drivers/Qmi8658Accelerometer.h"
#include "../../DisplayDma.h"
#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <TouchDrvCSTXXX.hpp>
#include <Wire.h>

namespace copilot {
namespace board {
using TouchController = TouchDrvCST816;
constexpr uint8_t kTouchPointCapacity = 1;
static_assert(kTouchI2cAddress == CST816_SLAVE_ADDRESS, "Touch address differs from the driver.");
static_assert(kImuI2cAddress == QMI8658_L_SLAVE_ADDRESS, "IMU address differs from the driver.");
static_assert(kAudioCodecI2cAddress == ES8311_ADDRESS_0, "Codec address differs from the driver.");

// This board has one variant.
enum class Variant : uint8_t { Standard };
constexpr const char* variantName(Variant) { return "standard"; }
inline Variant variant() { return Variant::Standard; }

// Runs first in setup(): keeps the board on when it runs on battery, and keeps the backlight off
// until the first frame fades in.
inline void beginBoard() {
  pinMode(kBatteryPowerLatchPin, OUTPUT);
  digitalWrite(kBatteryPowerLatchPin, HIGH);
  ledcAttach(kDisplayBacklightPin, kDisplayBacklightPwmHz, kDisplayBacklightPwmBits);
  ledcWrite(kDisplayBacklightPin, 0);
}

// The bus is shared with DisplayDma, so it takes the SPI host only while it writes.
inline Arduino_DataBus& displayBus() {
  static Arduino_ESP32SPIDMA bus(kDisplayDcPin, kDisplayCsPin, kDisplaySckPin, kDisplayMosiPin,
                                 GFX_NOT_DEFINED, SPI2_HOST, true);
  return bus;
}

inline DisplayPanel& displayPanel() {
  static DisplayPanel panel(&displayBus(), kDisplayResetPin, 0, true, kPanelSize, kPanelSize);
  return panel;
}

// Arduino_ST7789 runs the bus in SPI mode 3, and the panel takes pixels with data/command high.
inline DisplayScanout displayScanout() {
  return {SPI2_HOST, 3, 0, 0, false, 0, 0, kDisplayCsPin, kDisplayDcPin};
}

inline void setDisplayBrightness(uint8_t brightness) {
  constexpr uint32_t maximum = (1u << kDisplayBacklightPwmBits) - 1;
  ledcWrite(kDisplayBacklightPin, (brightness * maximum + 127) / 255);
}

// The CST816 sleeps when idle and then misses I2C reads; the touch sweep reads it every 250 ms.
inline void configureTouch(TouchController& touch) { touch.disableAutoSleep(); }

// The QMI8658 sits a quarter turn from the panel: the panel's top edge is the sensor's +y side.
// read() gives samples in the orientation frame (see ScreenOrientation.h): its x is the sensor's y,
// and its y is the sensor's -x. The IMU starts after touch, then sets the shared bus clock.
class QuarterTurnAccelerometer {
 public:
  const char* begin() { return sensor_.begin(); }
  bool read(float& x, float& y, float& z) {
    float sensorX, sensorY;
    if (!sensor_.read(sensorX, sensorY, z)) return false;
    x = sensorY;
    y = -sensorX;
    return true;
  }

 private:
  Qmi8658Accelerometer sensor_{Wire, kImuI2cAddress, kI2cFrequency};
};

inline QuarterTurnAccelerometer& accelerometer() {
  static QuarterTurnAccelerometer sensor;
  return sensor;
}

inline Es8311AudioOutput& audioOutput() {
  static Es8311AudioOutput output({kAudioMclkPin, kAudioBclkPin, kAudioWordSelectPin, kAudioDataOutPin,
                                   kAudioAmplifierPin, kI2cPort, kAudioCodecI2cAddress,
                                   kAudioMinimumCodecVolume, kAudioMaximumCodecVolume,
                                   kAudioAmplifierStartupMs});
  return output;
}
}  // namespace board
}  // namespace copilot

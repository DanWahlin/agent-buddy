#pragma once
// Device-only drivers for the Waveshare ESP32-S3-Touch-AMOLED-2.06 (see BoardConfig.h).
#include "BoardConfig.h"
#include "../drivers/Es8311AudioOutput.h"
#include "../drivers/Ft3168Touch.h"
#include "../drivers/Qmi8658Accelerometer.h"
#include "../../DisplayDma.h"
#include <Arduino_GFX_Library.h>
#include <Wire.h>

namespace copilot {
namespace board {
using TouchController = Ft3168Touch;
constexpr uint8_t kTouchPointCapacity = 2;
// The FT3168 goes to monitor mode about 10 s after the last touch, and it doesn't answer on I2C
// until a touch wakes it. Its interrupt line pulses for each report, so the firmware reads it only
// after a pulse and during a touch, as Waveshare's factory firmware does: no idle sweep.
constexpr bool kTouchIdleSweep = false;
static_assert(kImuI2cAddress == QMI8658_L_SLAVE_ADDRESS, "IMU address differs from the driver.");
static_assert(kAudioCodecI2cAddress == ES8311_ADDRESS_0, "Codec address differs from the driver.");

// This board has one variant.
enum class Variant : uint8_t { Standard };
constexpr const char* variantName(Variant) { return "standard"; }
inline Variant variant() { return Variant::Standard; }

// Runs first in setup(). This board needs nothing before its drivers start.
inline void beginBoard() {}

inline Arduino_DataBus& displayBus() {
  static Arduino_ESP32QSPI bus(kDisplayCsPin, kDisplaySckPin, kDisplayD0Pin, kDisplayD1Pin,
                               kDisplayD2Pin, kDisplayD3Pin, true);
  return bus;
}

inline DisplayPanel& displayPanel() {
  static DisplayPanel panel(&displayBus(), kDisplayResetPin, 0, kPanelWidth, kPanelHeight,
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

// The QMI8658's +x side is the panel's top edge and its +y side the panel's right edge, so its axes
// are already the orientation frame (see ScreenOrientation.h). The IMU starts after touch, then sets
// the shared bus clock.
inline Qmi8658Accelerometer& accelerometer() {
  static Qmi8658Accelerometer sensor(Wire, kImuI2cAddress, kI2cFrequency);
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

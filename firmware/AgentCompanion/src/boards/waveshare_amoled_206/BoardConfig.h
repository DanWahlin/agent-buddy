#pragma once
// Waveshare ESP32-S3-Touch-AMOLED-2.06.
// Hardware: CO5300 410x502 AMOLED on QSPI, FT3168 touch, QMI8658 IMU, ES8311 codec, AXP2101 power
// (its default outputs power the board, so the firmware leaves it alone).
// Pin source: pin_config.h and the examples in waveshareteam/ESP32-S3-Touch-AMOLED-2.06 at
// 30f3b23b3d4bb38d32f7d0cddffb66759668a855. The build uses the 1.75's vendor libraries (see
// firmware/boards.json), which have the same CO5300 driver.
// Plain constants only: native tests include this file without the vendor libraries.
#include <cstdint>

class Arduino_CO5300;

namespace copilot {
namespace board {
// Declared here so display code can name the panel without the vendor library.
using DisplayPanel = ::Arduino_CO5300;
constexpr char kId[] = "waveshare-amoled-206";
constexpr char kName[] = "Waveshare ESP32-S3-Touch-AMOLED-2.06";
constexpr char kDisplayPanelName[] = "CO5300";
constexpr char kTouchControllerName[] = "FT3168";
constexpr char kImuName[] = "QMI8658";
}  // namespace board

// The firmware draws 466x466 content on every board. This panel is 410x502, and it shows the
// content at full size: the middle 410 columns, with 18 black rows above and below them.
constexpr int kDisplaySize = 466;
constexpr int kPanelWidth = 410;
constexpr int kPanelHeight = 502;
constexpr int kShownContentSize = kDisplaySize;
constexpr int kDisplayCsPin = 12;
constexpr int kDisplaySckPin = 11;
constexpr int kDisplayD0Pin = 4;
constexpr int kDisplayD1Pin = 5;
constexpr int kDisplayD2Pin = 6;
constexpr int kDisplayD3Pin = 7;
constexpr int kDisplayResetPin = 8;
// The panel's visible area starts at column 22 of the controller's memory.
constexpr int kDisplayColumnOffset = 22;
constexpr int kSpiFrequency = 80000000;
// CO5300 QSPI pixel write: command 0x32, address 0x003C00 (RAMWR).
constexpr uint8_t kDisplayQspiWriteCommand = 0x32;
constexpr uint32_t kDisplayQspiPixelAddress = 0x003C00;
constexpr int kBrightness = 155;

constexpr int kAudioMclkPin = 16;
constexpr int kAudioBclkPin = 41;
constexpr int kAudioWordSelectPin = 45;
constexpr int kAudioDataOutPin = 40;
constexpr int kAudioAmplifierPin = 46;
// The same amplifier start time as the 1.75, which stays silent for over 100 ms after it turns on.
constexpr unsigned kAudioAmplifierStartupMs = 150;
constexpr uint8_t kAudioCodecI2cAddress = 0x18;
// The ES8311 volume for 1% and for 100% sound volume, tuned for the board's speaker.
constexpr int kAudioMinimumCodecVolume = 68;
constexpr int kAudioMaximumCodecVolume = 82;

// Touch, IMU, and audio codec share one I2C bus (Arduino Wire, I2C port 0) with the AXP2101 and the
// PCF85063 clock, which the firmware doesn't use.
constexpr unsigned kI2cPort = 0;
constexpr uint32_t kI2cFrequency = 400000;
constexpr int kTouchSda = 15;
constexpr int kTouchScl = 14;
constexpr int kTouchInterrupt = 38;
constexpr int kTouchReset = 9;
constexpr uint8_t kTouchI2cAddress = 0x38;
// The FT3168 reports panel pixels as they are.
constexpr bool kTouchMirrorX = false;
constexpr bool kTouchMirrorY = false;
constexpr uint8_t kImuI2cAddress = 0x6B;

// The BOOT button. Held at power-on it starts the ROM downloader; after that it is free to read.
constexpr int kBootButtonPin = 0;
}  // namespace copilot

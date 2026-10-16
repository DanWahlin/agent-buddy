#pragma once
// Waveshare ESP32-S3-Touch-AMOLED-1.75-B and -C.
// Hardware: CO5300 466x466 AMOLED on QSPI, CST9217 touch, QMI8658 IMU, ES8311 codec.
// Pin source: Waveshare's schematic and examples at the revision in firmware/boards.json.
// Plain constants only: native tests include this file without the vendor libraries.
#include <cstdint>

class Arduino_CO5300;

namespace copilot {
namespace board {
// Declared here so display code can name the panel without the vendor library.
using DisplayPanel = ::Arduino_CO5300;
constexpr char kId[] = "waveshare-amoled-175";
constexpr char kName[] = "Waveshare ESP32-S3-Touch-AMOLED-1.75";
constexpr char kDisplayPanelName[] = "CO5300";
constexpr char kTouchControllerName[] = "CST9217";
constexpr char kImuName[] = "QMI8658";
}  // namespace board

// The panel shows the 466x466 content at full size.
constexpr int kDisplaySize = 466;
constexpr int kPanelSize = kDisplaySize;
constexpr int kDisplayCsPin = 12;
constexpr int kDisplaySckPin = 38;
constexpr int kDisplayD0Pin = 4;
constexpr int kDisplayD1Pin = 5;
constexpr int kDisplayD2Pin = 6;
constexpr int kDisplayD3Pin = 7;
// The 1.75-C wires LCD reset to GPIO1 and touch reset to GPIO2; see docs/development.md.
constexpr int kDisplayResetPin = 39;
// The panel's visible area starts at column 6 of the controller's memory.
constexpr int kDisplayColumnOffset = 6;
constexpr int kSpiFrequency = 80000000;
// CO5300 QSPI pixel write: command 0x32, address 0x003C00 (RAMWR).
constexpr uint8_t kDisplayQspiWriteCommand = 0x32;
constexpr uint32_t kDisplayQspiPixelAddress = 0x003C00;
constexpr int kBrightness = 155;

// Audio MCLK is GPIO42, except on the 1.75-C, which uses GPIO16 (expansion header pin 8 on the
// others). Only the others have the TCA9554 I/O expander at 0x20; BoardVariant.h uses that.
constexpr int kAudioMclkPin = 42;
constexpr int kAudioMclkPinC = 16;
constexpr uint8_t kIoExpanderI2cAddress = 0x20;
constexpr int kAudioBclkPin = 9;
constexpr int kAudioWordSelectPin = 45;
constexpr int kAudioDataOutPin = 8;
constexpr int kAudioAmplifierPin = 46;
constexpr uint8_t kAudioCodecI2cAddress = 0x18;
// The ES8311 volume for 1% and for 100% sound volume, tuned for the board's speaker.
constexpr int kAudioMinimumCodecVolume = 68;
constexpr int kAudioMaximumCodecVolume = 82;

// Touch, IMU, and audio codec share one I2C bus (Arduino Wire, I2C port 0).
constexpr unsigned kI2cPort = 0;
constexpr uint32_t kI2cFrequency = 400000;
constexpr int kTouchSda = 15;
constexpr int kTouchScl = 14;
constexpr int kTouchInterrupt = 11;
constexpr int kTouchReset = 40;
constexpr uint8_t kTouchI2cAddress = 0x5A;
constexpr bool kTouchMirrorX = true;
constexpr bool kTouchMirrorY = true;
constexpr uint8_t kImuI2cAddress = 0x6B;

// The BOOT button. Held at power-on it starts the ROM downloader; after that it is free to read.
constexpr int kBootButtonPin = 0;
}  // namespace copilot

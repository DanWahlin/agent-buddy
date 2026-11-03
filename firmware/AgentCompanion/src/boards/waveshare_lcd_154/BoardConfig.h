#pragma once
// Waveshare ESP32-S3-Touch-LCD-1.54.
// Hardware: ST7789 240x240 IPS LCD on SPI with a PWM backlight, CST816 touch, QMI8658 IMU, ES8311
// codec, and a battery power latch.
// Pin source: Waveshare's ESP32-S3-Touch-LCD-1.54 examples at revision
// 5157db7c888e476fd57f8a95020800377447478f (github.com/waveshareteam/ESP32-S3-Touch-LCD-1.54).
// Plain constants only: native tests include this file without the vendor libraries.
#include <cstdint>

class Arduino_ST7789;

namespace copilot {
namespace board {
// Declared here so display code can name the panel without the vendor library.
using DisplayPanel = ::Arduino_ST7789;
constexpr char kId[] = "waveshare-lcd-154";
constexpr char kName[] = "Waveshare ESP32-S3-Touch-LCD-1.54";
constexpr char kDisplayPanelName[] = "ST7789";
constexpr char kTouchControllerName[] = "CST816";
constexpr char kImuName[] = "QMI8658";
}  // namespace board

// The firmware draws 466x466 content on every board. This panel is 240x240, so scanout shows the
// content at about half size (see ScreenTransform.h).
constexpr int kDisplaySize = 466;
constexpr int kPanelWidth = 240;
constexpr int kPanelHeight = 240;
constexpr int kShownContentSize = 240;
constexpr int kDisplayCsPin = 21;
constexpr int kDisplayDcPin = 45;
constexpr int kDisplaySckPin = 38;
constexpr int kDisplayMosiPin = 39;
constexpr int kDisplayResetPin = 40;
// The panel's pins go through the GPIO matrix, so 40 MHz is the fastest reliable SPI clock.
constexpr int kSpiFrequency = 40000000;
constexpr int kDisplayBacklightPin = 46;
constexpr uint32_t kDisplayBacklightPwmHz = 5000;
constexpr uint8_t kDisplayBacklightPwmBits = 10;
constexpr int kBrightness = 155;

// On battery the board stays on only while this pin is high. setup() sets it first.
constexpr int kBatteryPowerLatchPin = 2;

constexpr int kAudioMclkPin = 8;
constexpr int kAudioBclkPin = 9;
constexpr int kAudioWordSelectPin = 10;
constexpr int kAudioDataOutPin = 12;
constexpr int kAudioAmplifierPin = 7;
// The amplifier stays silent for over 100 ms after it turns on, which would cut the short settings
// sound to nothing.
constexpr unsigned kAudioAmplifierStartupMs = 150;
constexpr uint8_t kAudioCodecI2cAddress = 0x18;
// The ES8311 volume for 1% and for 100% sound volume, tuned for the board's speaker.
constexpr int kAudioMinimumCodecVolume = 70;
constexpr int kAudioMaximumCodecVolume = 83;

// Touch, IMU, and audio codec share one I2C bus (Arduino Wire, I2C port 0).
constexpr unsigned kI2cPort = 0;
constexpr uint32_t kI2cFrequency = 400000;
constexpr int kTouchSda = 42;
constexpr int kTouchScl = 41;
constexpr int kTouchInterrupt = 48;
constexpr int kTouchReset = 47;
constexpr uint8_t kTouchI2cAddress = 0x15;
constexpr bool kTouchMirrorX = false;
constexpr bool kTouchMirrorY = false;
constexpr uint8_t kImuI2cAddress = 0x6B;

// The BOOT button. Held at power-on it starts the ROM downloader; after that it is free to read.
constexpr int kBootButtonPin = 0;
}  // namespace copilot

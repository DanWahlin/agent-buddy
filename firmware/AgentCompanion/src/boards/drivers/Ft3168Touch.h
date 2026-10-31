#pragma once
// FocalTech FT3168 capacitive touch on I2C. Header-only: only a board that includes it needs it.
// SensorLib's FT6X36 driver doesn't accept this chip. The registers and the reset timing come from
// Waveshare's FT3x68 driver (Arduino_DriveBus): 0x02 holds the number of touch points, 0x03-0x06 the
// first point, and 0x09-0x0C the second; 0xA0 is the chip ID, and 0xA5 the power mode.
#include <Arduino.h>
#include <Wire.h>
#include <cstddef>
#include <cstdint>

namespace copilot {
namespace board {
class Ft3168Touch {
 public:
  // TouchInput attaches the interrupt line itself, so only the reset pin is kept.
  void setPins(int reset, int /*interrupt*/) { reset_ = reset; }

  // Starts the shared I2C bus, resets the controller, and sets active mode.
  // Returns false when the controller doesn't answer. About 10 s after the last touch, the
  // controller goes to monitor mode by itself, and it doesn't answer on I2C until a touch wakes it,
  // so a board reads it only after its interrupt (kTouchIdleSweep in BoardDrivers.h).
  bool begin(TwoWire& wire, uint8_t address, int sda, int scl) {
    wire_ = &wire;
    address_ = address;
    if (!wire.begin(sda, scl)) return false;
    if (reset_ >= 0) {
      pinMode(reset_, OUTPUT);
      digitalWrite(reset_, HIGH);
      delay(1);
      digitalWrite(reset_, LOW);
      delay(20);
      digitalWrite(reset_, HIGH);
      delay(50);
    }
    // The controller can need a little longer than the reset delay before it answers. Any answer
    // counts, so the chip ID read only shows that the controller is there.
    bool answered = false;
    for (int attempt = 0; attempt < kStartAttempts && !answered; ++attempt) {
      if (attempt) delay(10);
      uint8_t chipId;
      answered = read(kChipIdRegister, &chipId, 1);
    }
    if (!answered || !write(kPowerModeRegister, kPowerModeActive)) return false;
    delay(20);
    return true;
  }

  uint8_t getSupportTouchPoint() const { return kPointCapacity; }

  void setMaxCoordinates(uint16_t x, uint16_t y) {
    maxX_ = x;
    maxY_ = y;
  }

  void setMirrorXY(bool mirrorX, bool mirrorY) {
    mirrorX_ = mirrorX;
    mirrorY_ = mirrorY;
  }

  // Reads up to `size` touch points in panel pixels. Returns how many points touch the panel, or 0
  // when none do or the read fails.
  uint8_t getPoint(int16_t* x, int16_t* y, uint8_t size) {
    if (!x || !y || !size || !wire_) return 0;
    // Point count, then each point's six registers: X high, X low, Y high, Y low, and two not used.
    uint8_t data[1 + 6 * kPointCapacity - 2];
    if (!read(kPointCountRegister, data, sizeof(data))) return 0;
    const uint8_t count = data[0] & 0x0F;
    // 0x0F, and anything above the capacity, means no valid points.
    if (count == 0 || count > kPointCapacity) return 0;
    for (uint8_t point = 0; point < count && point < size; ++point) {
      const uint8_t* registers = data + 1 + 6 * point;
      int16_t pointX = static_cast<int16_t>((registers[0] & 0x0F) << 8 | registers[1]);
      int16_t pointY = static_cast<int16_t>((registers[2] & 0x0F) << 8 | registers[3]);
      if (mirrorX_ && maxX_) pointX = static_cast<int16_t>(maxX_ - pointX);
      if (mirrorY_ && maxY_) pointY = static_cast<int16_t>(maxY_ - pointY);
      x[point] = pointX;
      y[point] = pointY;
    }
    return count;
  }

 private:
  static constexpr uint8_t kPointCapacity = 2;
  static constexpr uint8_t kPointCountRegister = 0x02;
  static constexpr uint8_t kChipIdRegister = 0xA0;
  static constexpr uint8_t kPowerModeRegister = 0xA5;
  static constexpr uint8_t kPowerModeActive = 0x00;
  static constexpr int kStartAttempts = 10;

  // A register write, a stop, and then the read, as Waveshare's driver does.
  bool read(uint8_t reg, uint8_t* data, size_t length) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    if (wire_->endTransmission() != 0) return false;
    if (wire_->requestFrom(address_, length) != length) return false;
    return wire_->readBytes(data, length) == length;
  }

  bool write(uint8_t reg, uint8_t value) {
    wire_->beginTransmission(address_);
    wire_->write(reg);
    wire_->write(value);
    return wire_->endTransmission() == 0;
  }

  TwoWire* wire_ = nullptr;
  uint8_t address_ = 0;
  int reset_ = -1;
  uint16_t maxX_ = 0;
  uint16_t maxY_ = 0;
  bool mirrorX_ = false;
  bool mirrorY_ = false;
};
}  // namespace board
}  // namespace copilot

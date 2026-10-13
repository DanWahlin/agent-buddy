#pragma once
// QMI8658 accelerometer on I2C. Header-only: only a board that includes it needs SensorLib.
#include <SensorQMI8658.hpp>
#include <Wire.h>
#include <cstdint>

namespace copilot {
namespace board {
class Qmi8658Accelerometer {
 public:
  Qmi8658Accelerometer(TwoWire& wire, uint8_t address, uint32_t busFrequency)
      : wire_(wire), address_(address), busFrequency_(busFrequency) {}

  // Returns nullptr, or the reason the sensor is not available.
  const char* begin() {
    if (!sensor_.begin(wire_, address_)) return "QMI8658 orientation sensor initialization failed.";
    if (sensor_.configAccelerometer(SensorQMI8658::ACC_RANGE_2G, SensorQMI8658::ACC_ODR_62_5Hz,
                                    SensorQMI8658::LPF_MODE_2) != 0)
      return "QMI8658 accelerometer configuration failed.";
    if (!sensor_.enableAccelerometer()) return "QMI8658 accelerometer enable failed.";
    if (!wire_.setClock(busFrequency_)) return "QMI8658 I2C clock configuration failed.";
    return nullptr;
  }

  // Reads a new sample in the sensor's own axes. Returns false when no new sample is ready.
  bool read(float& x, float& y, float& z) {
    return sensor_.getDataReady() && sensor_.getAccelerometer(x, y, z);
  }

 private:
  SensorQMI8658 sensor_;
  TwoWire& wire_;
  uint8_t address_;
  uint32_t busFrequency_;
};
}  // namespace board
}  // namespace copilot

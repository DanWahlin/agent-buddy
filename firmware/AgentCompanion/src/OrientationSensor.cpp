#include "OrientationSensor.h"
#include "Config.h"
#include <Arduino.h>
#include <Wire.h>

namespace copilot {
bool OrientationSensor::begin() {
  error_ = nullptr;
  if (!sensor_.begin(Wire, QMI8658_L_SLAVE_ADDRESS)) {
    error_ = "QMI8658 orientation sensor initialization failed.";
    return false;
  }
  if (sensor_.configAccelerometer(SensorQMI8658::ACC_RANGE_2G,
                                  SensorQMI8658::ACC_ODR_62_5Hz,
                                  SensorQMI8658::LPF_MODE_2) != 0) {
    error_ = "QMI8658 accelerometer configuration failed.";
    return false;
  }
  if (!sensor_.enableAccelerometer()) {
    error_ = "QMI8658 accelerometer enable failed.";
    return false;
  }
  available_ = true;
  return true;
}

bool OrientationSensor::update() {
  if (!available_) return false;
  const uint32_t now = millis();
  if (now - lastPollMs_ < kOrientationPollMs) return false;
  lastPollMs_ = now;
  if (!sensor_.getDataReady()) return false;
  float x, y, z;
  if (!sensor_.getAccelerometer(x, y, z)) return false;
  accelerometerX_ = x;
  accelerometerY_ = y;
  accelerometerZ_ = z;
  return orientation_.update(x, y);
}
}

#include "OrientationSensor.h"
#include "Config.h"
#include "boards/BoardDrivers.h"
#include <Arduino.h>

namespace copilot {
bool OrientationSensor::begin() {
  error_ = board::accelerometer().begin();
  available_ = !error_;
  return available_;
}

bool OrientationSensor::update() {
  if (!available_) return false;
  const uint32_t now = millis();
  if (now - lastPollMs_ < kOrientationPollMs) return false;
  lastPollMs_ = now;
  float x, y, z;
  if (!board::accelerometer().read(x, y, z)) return false;
  accelerometerX_ = x;
  accelerometerY_ = y;
  accelerometerZ_ = z;
  return orientation_.update(x, y);
}
}

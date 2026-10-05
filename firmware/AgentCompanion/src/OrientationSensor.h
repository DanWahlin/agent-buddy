#pragma once
#include "ScreenOrientation.h"
#include <SensorQMI8658.hpp>
#include <cstdint>

namespace copilot {
class OrientationSensor {
 public:
  bool begin();
  bool update();
  bool available() const { return available_; }
  float angle() const { return orientation_.angle(); }
  float accelerometerX() const { return accelerometerX_; }
  float accelerometerY() const { return accelerometerY_; }
  float accelerometerZ() const { return accelerometerZ_; }
  const char* error() const { return error_; }

 private:
  SensorQMI8658 sensor_;
  ScreenOrientation orientation_;
  const char* error_ = nullptr;
  float accelerometerX_ = 0.0f;
  float accelerometerY_ = 0.0f;
  float accelerometerZ_ = 0.0f;
  uint32_t lastPollMs_ = 0;
  bool available_ = false;
};
}

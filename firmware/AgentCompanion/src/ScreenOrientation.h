#pragma once
#include "ScreenTransform.h"
#include <cmath>
#include <cstdint>

namespace copilot {
constexpr float kOrientationPi = 3.14159265358979323846f;

class ScreenOrientation {
 public:
  bool update(float accelerometerX, float accelerometerY) {
    // Board axes mapped to display coordinates: screen X = -sensor Y,
    // screen Y = sensor X.
    if (!std::isfinite(accelerometerX) || !std::isfinite(accelerometerY)) return false;
    const float magnitude = std::hypot(accelerometerX, accelerometerY);
    if (magnitude < kMinimumInPlaneGravity) return false;
    const float target = std::atan2(accelerometerY, accelerometerX);
    const bool firstSample = !initialized_;
    if (!initialized_) {
      filteredAngle_ = target;
      initialized_ = true;
    } else {
      filteredAngle_ = shortestAngle(
          filteredAngle_ + shortestAngle(target - filteredAngle_) * kSmoothing);
    }
    if (!firstSample
        && std::fabs(shortestAngle(filteredAngle_ - reportedAngle_)) < kMinimumAngleChange)
      return false;
    reportedAngle_ = filteredAngle_;
    return true;
  }

  float angle() const { return reportedAngle_; }

  bool initialized() const { return initialized_; }

  static bool panelToContent(float angle, int size, int16_t panelX, int16_t panelY,
                             int16_t& contentX, int16_t& contentY) {
    return ScreenTransform(size, angle).panelToContent(panelX, panelY, contentX, contentY);
  }

  static float shortestAngle(float angle) {
    while (angle > kOrientationPi) angle -= 2.0f * kOrientationPi;
    while (angle < -kOrientationPi) angle += 2.0f * kOrientationPi;
    return angle;
  }

 private:
  static constexpr float kMinimumInPlaneGravity = 0.22f;
  static constexpr float kSmoothing = 0.16f;
  static constexpr float kMinimumAngleChange = 0.002f;
  float filteredAngle_ = 0.0f;
  float reportedAngle_ = 0.0f;
  bool initialized_ = false;
};

class DisplayOrientation {
 public:
  bool update(float requested) {
    if (!std::isfinite(requested)) return false;
    requested = ScreenOrientation::shortestAngle(requested);
    constexpr float quarterTurn = kOrientationPi / 2.0f;
    const float cardinal = ScreenOrientation::shortestAngle(
        std::round(requested / quarterTurn) * quarterTurn);
    const float currentCardinal = ScreenOrientation::shortestAngle(
        std::round(angle_ / quarterTurn) * quarterTurn);
    if (angle_ == currentCardinal
        && std::fabs(ScreenOrientation::shortestAngle(requested - angle_)) < kSnapExit)
      requested = angle_;
    else if (std::fabs(ScreenOrientation::shortestAngle(requested - cardinal)) < kSnapEnter)
      requested = cardinal;
    if (requested == angle_) return false;
    angle_ = requested;
    return true;
  }

  float angle() const { return angle_; }

 private:
  static constexpr float kSnapEnter = 0.5f * kOrientationPi / 180.0f;
  static constexpr float kSnapExit = 1.5f * kOrientationPi / 180.0f;
  float angle_ = 0.0f;
};
}

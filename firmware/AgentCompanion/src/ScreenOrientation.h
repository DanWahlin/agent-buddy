#pragma once
#include <cmath>
#include <cstdint>

namespace copilot {
constexpr float kOrientationPi = 3.14159265358979323846f;

class ScreenOrientation {
 public:
  bool update(float accelerometerX, float accelerometerY) {
    // Board axes mapped to display coordinates: screen X = -sensor Y,
    // screen Y = sensor X.
    float downX = -accelerometerY;
    float downY = accelerometerX;
    const float magnitude = std::sqrt(downX * downX + downY * downY);
    if (magnitude < kMinimumInPlaneGravity) return false;
    downX /= magnitude;
    downY /= magnitude;

    const bool firstSample = !initialized_;
    const float previous = angle();
    if (!initialized_) {
      filteredDownX_ = downX;
      filteredDownY_ = downY;
      initialized_ = true;
    } else {
      filteredDownX_ += (downX - filteredDownX_) * kSmoothing;
      filteredDownY_ += (downY - filteredDownY_) * kSmoothing;
      const float filteredMagnitude =
          std::sqrt(filteredDownX_ * filteredDownX_ + filteredDownY_ * filteredDownY_);
      if (filteredMagnitude > 0.0f) {
        filteredDownX_ /= filteredMagnitude;
        filteredDownY_ /= filteredMagnitude;
      }
    }
    return firstSample
        || std::fabs(shortestAngle(angle() - previous)) >= kMinimumAngleChange;
  }

  float angle() const {
    if (!initialized_) return 0.0f;
    return std::atan2(-filteredDownX_, filteredDownY_);
  }

  bool initialized() const { return initialized_; }

  static bool panelToContent(float angle, int size, int16_t panelX, int16_t panelY,
                             int16_t& contentX, int16_t& contentY) {
    const float center = (size - 1) * 0.5f;
    const float dx = panelX - center;
    const float dy = panelY - center;
    const float cosine = std::cos(angle);
    const float sine = std::sin(angle);
    const int x = static_cast<int>(std::lround(center + cosine * dx + sine * dy));
    const int y = static_cast<int>(std::lround(center - sine * dx + cosine * dy));
    if (x < 0 || x >= size || y < 0 || y >= size) return false;
    contentX = static_cast<int16_t>(x);
    contentY = static_cast<int16_t>(y);
    return true;
  }

 private:
  static float shortestAngle(float angle) {
    while (angle > kOrientationPi) angle -= 2.0f * kOrientationPi;
    while (angle < -kOrientationPi) angle += 2.0f * kOrientationPi;
    return angle;
  }

  static constexpr float kMinimumInPlaneGravity = 0.22f;
  static constexpr float kSmoothing = 0.16f;
  static constexpr float kMinimumAngleChange = 0.002f;
  float filteredDownX_ = 0.0f;
  float filteredDownY_ = 1.0f;
  bool initialized_ = false;
};
}

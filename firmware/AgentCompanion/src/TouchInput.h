#pragma once
#include "Config.h"
#include <cstdint>

namespace copilot {
enum class TouchGestureKind : uint8_t { None, Tap, SwipeUp, SwipeDown };
struct TouchGesture {
  TouchGestureKind kind = TouchGestureKind::None;
  int16_t startX = 0, startY = 0, endX = 0, endY = 0;
};

class TouchGestureTracker {
 public:
  bool sample(bool pressed, int16_t x, int16_t y, uint64_t milliseconds,
              TouchGesture& gesture) {
    gesture = {};
    if (pressed) {
      if (!active_) {
        if (completed_ && milliseconds - completedAt_ < kTouchDebounceMs) return false;
        active_ = true;
        startedAt_ = milliseconds;
        startX_ = lastX_ = x;
        startY_ = lastY_ = y;
      } else {
        lastX_ = x;
        lastY_ = y;
      }
      return false;
    }
    if (!active_) return false;
    active_ = false;
    completed_ = true;
    completedAt_ = milliseconds;
    const int dx = lastX_ - startX_;
    const int dy = lastY_ - startY_;
    const int horizontal = dx < 0 ? -dx : dx;
    const int vertical = dy < 0 ? -dy : dy;
    const uint64_t duration = milliseconds - startedAt_;
    TouchGestureKind kind = TouchGestureKind::None;
    if (duration <= kTouchSwipeMaxMs && vertical >= kTouchSwipePixels
        && vertical * 4 >= horizontal * 5) {
      kind = dy < 0 ? TouchGestureKind::SwipeUp : TouchGestureKind::SwipeDown;
    } else if (duration <= kTouchTapMaxMs
               && horizontal <= kTouchTapTravelPixels
               && vertical <= kTouchTapTravelPixels) {
      kind = TouchGestureKind::Tap;
    }
    if (kind == TouchGestureKind::None) return false;
    gesture = {kind, startX_, startY_, lastX_, lastY_};
    return true;
  }

  bool active() const { return active_; }

 private:
  int16_t startX_ = 0, startY_ = 0, lastX_ = 0, lastY_ = 0;
  uint64_t startedAt_ = 0, completedAt_ = 0;
  bool active_ = false, completed_ = false;
};

bool initializeTouchInput();
bool pollTouchGesture(TouchGesture& gesture);
const char* touchInputError();
}

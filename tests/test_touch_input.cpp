#include "../firmware/AgentCompanion/src/TouchInput.h"
#include <cassert>
#include <iostream>

int main() {
  using copilot::TouchGestureKind;
  copilot::TouchGestureTracker touch;
  copilot::TouchGesture gesture;
  assert(!touch.sample(true, 200, 300, 1, gesture));
  assert(!touch.sample(true, 204, 295, 80, gesture));
  assert(touch.sample(false, 0, 0, 120, gesture));
  assert(gesture.kind == TouchGestureKind::Tap);
  assert(gesture.startX == 200 && gesture.startY == 300);
  assert(gesture.endX == 204 && gesture.endY == 295);

  assert(!touch.sample(true, 200, 300, 121, gesture));
  assert(!touch.active());
  assert(!touch.sample(true, 210, 380, 301, gesture));
  assert(!touch.sample(true, 214, 290, 500, gesture));
  assert(touch.sample(false, 0, 0, 540, gesture));
  assert(gesture.kind == TouchGestureKind::SwipeUp);
  assert(!touch.sample(true, 180, 100, 800, gesture));
  assert(!touch.sample(true, 170, 190, 900, gesture));
  assert(touch.sample(false, 0, 0, 950, gesture));
  assert(gesture.kind == TouchGestureKind::SwipeDown);

  assert(!touch.sample(true, 50, 50, 1200, gesture));
  assert(!touch.sample(true, 130, 20, 1300, gesture));
  assert(!touch.sample(false, 0, 0, 1400, gesture));
  assert(gesture.kind == TouchGestureKind::None);
  assert(!touch.sample(true, 100, 100, UINT64_C(5000000000), gesture));
  assert(touch.sample(false, 0, 0, UINT64_C(5000000010), gesture));
  assert(gesture.kind == TouchGestureKind::Tap);
  std::cout << "PASS: release-time taps, vertical swipes, diagonal rejection, debounce and long uptime\n";
}

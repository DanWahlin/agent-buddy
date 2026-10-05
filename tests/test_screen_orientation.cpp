#include "../firmware/AgentCompanion/src/ScreenOrientation.h"
#include "../firmware/AgentCompanion/src/TouchInput.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <limits>

namespace {
bool near(float actual, float expected, float tolerance = 0.02f) {
  return std::fabs(actual - expected) <= tolerance;
}
}

int main() {
  copilot::ScreenOrientation orientation;
  assert(orientation.update(1.0f, 0.0f));
  assert(near(orientation.angle(), 0.0f));

  copilot::ScreenOrientation quarterTurn;
  assert(quarterTurn.update(0.0f, 1.0f));
  assert(near(quarterTurn.angle(), copilot::kOrientationPi / 2.0f));

  copilot::ScreenOrientation flat;
  assert(!flat.update(0.05f, 0.05f));
  assert(!flat.initialized());

  copilot::ScreenOrientation slow;
  assert(slow.update(1.0f, 0.0f));
  unsigned updates = 0;
  for (int sample = 1; sample <= 1500; ++sample) {
    const float angle = sample * 0.001f;
    const float reported = slow.angle();
    if (slow.update(std::cos(angle), std::sin(angle))) ++updates;
    else assert(slow.angle() == reported);
  }
  assert(updates > 400);
  assert(near(slow.angle(), 1.5f));
  const float held = slow.angle();
  assert(!slow.update(0.05f, 0.05f));
  assert(slow.angle() == held);
  assert(!slow.update(std::numeric_limits<float>::quiet_NaN(), 1.0f));
  assert(!slow.update(1.0f, std::numeric_limits<float>::infinity()));
  assert(slow.angle() == held);

  copilot::ScreenOrientation upsideDown;
  assert(upsideDown.update(1.0f, 0.0f));
  for (int sample = 0; sample < 100; ++sample) upsideDown.update(-1.0f, 0.0f);
  assert(near(std::fabs(upsideDown.angle()), copilot::kOrientationPi));

  copilot::ScreenOrientation wrap;
  constexpr float degree = copilot::kOrientationPi / 180.0f;
  assert(wrap.update(std::cos(179 * degree), std::sin(179 * degree)));
  for (int sample = 0; sample < 100; ++sample) {
    const float previous = wrap.angle();
    wrap.update(std::cos(-179 * degree), std::sin(-179 * degree));
    assert(std::fabs(copilot::ScreenOrientation::shortestAngle(wrap.angle() - previous)) < degree);
  }
  assert(std::fabs(copilot::ScreenOrientation::shortestAngle(wrap.angle() + 179 * degree)) < 0.003f);

  copilot::DisplayOrientation display;
  assert(!display.update(degree));
  assert(display.angle() == 0.0f);
  assert(!display.update(4 * degree));
  assert(display.update(6 * degree));
  assert(near(display.angle(), 6 * degree));
  assert(display.update(degree));
  assert(display.angle() == 0.0f);
  for (float cardinal : {copilot::kOrientationPi / 2, copilot::kOrientationPi,
                         -copilot::kOrientationPi / 2, 0.0f}) {
    display.update(cardinal + degree);
    assert(std::fabs(copilot::ScreenOrientation::shortestAngle(display.angle() - cardinal)) < 0.00001f);
    assert(!display.update(cardinal - 4 * degree));
    assert(std::fabs(copilot::ScreenOrientation::shortestAngle(display.angle() - cardinal)) < 0.00001f);
  }

  int16_t x, y;
  assert(copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 2.0f, 466, 333, 233, x, y));
  assert(std::abs(x - 233) <= 1);
  assert(std::abs(y - 132) <= 1);
  assert(!copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 4.0f, 466, 0, 0, x, y));

  copilot::TouchGestureTracker touch;
  copilot::TouchGesture gesture;
  assert(copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 2, 466, 100, 233, x, y));
  assert(!touch.sample(true, x, y, 1, gesture));
  assert(copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 2, 466, 200, 233, x, y));
  assert(!touch.sample(true, x, y, 100, gesture));
  assert(touch.sample(false, 0, 0, 200, gesture));
  assert(gesture.kind == copilot::TouchGestureKind::SwipeUp);

  std::cout << "PASS: slow rotation, upside down, angle wrap, flat hold, cardinal snap and rotated touch\n";
}

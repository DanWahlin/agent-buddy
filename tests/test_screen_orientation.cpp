#include "../firmware/AgentCompanion/src/ScreenOrientation.h"
#include <cassert>
#include <cmath>
#include <iostream>

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

  int16_t x, y;
  assert(copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 2.0f, 466, 333, 233, x, y));
  assert(std::abs(x - 233) <= 1);
  assert(std::abs(y - 132) <= 1);
  assert(!copilot::ScreenOrientation::panelToContent(
      copilot::kOrientationPi / 4.0f, 466, 0, 0, x, y));

  std::cout << "PASS: gravity angle, flat freeze and inverse touch rotation\n";
}

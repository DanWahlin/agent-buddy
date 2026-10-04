#pragma once
#include "Config.h"
#include <cstdint>

namespace copilot {
// Reports one press when the button goes down and stays down for the debounce time. It starts as
// if the button were held, so a button that is down at startup counts only after a release.
class ButtonPressTracker {
 public:
  bool sample(bool pressed, uint32_t milliseconds) {
    if (pressed != raw_) {
      raw_ = pressed;
      changedAt_ = milliseconds;
    }
    if (pressed == stable_ || milliseconds - changedAt_ < kButtonDebounceMs) return false;
    stable_ = pressed;
    return pressed;
  }

 private:
  bool raw_ = true, stable_ = true;
  uint32_t changedAt_ = 0;
};
}

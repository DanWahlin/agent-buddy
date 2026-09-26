#pragma once
#include "Config.h"
#include <algorithm>
#include <cstdint>

namespace copilot {
class AnimationClock {
 public:
  double advance(int64_t wallUs) {
    if (!started_) {
      started_ = true;
      lastWallUs_ = wallUs;
      return 0;
    }
    const int64_t elapsed = std::max<int64_t>(0, wallUs - lastWallUs_);
    lastWallUs_ = wallUs;
    // A paused USB capture or late frame must not fast-forward a head turn.
    time_ += std::min(elapsed / 1000000.0, 1.0 / kTargetFps);
    return time_;
  }

 private:
  bool started_ = false;
  int64_t lastWallUs_ = 0;
  double time_ = 0;
};
}

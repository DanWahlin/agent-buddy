#pragma once
#include <cstdint>

namespace copilot {
struct Pose {
  int direction = 0;
  float turn = 0;
  float eyeX = 0;
  float eyeY = 0;
  float openness = 1;
};

class Motion {
 public:
  explicit Motion(uint32_t seed);
  Pose sample(double seconds);
  bool requestLook(int direction, double seconds);
  void setAutomatic(bool enabled, double seconds);

 private:
  float random(float low, float high);
  void chooseTarget(double now);
  uint32_t rng_;
  float fromTurn_ = 0, toTurn_ = 0;
  int direction_ = 0;
  int pendingDirection_ = -1;
  bool automatic_ = true;
  double moveStart_ = 0, nextMove_ = 1.3;
  float moveDuration_ = 0.8f;
  double nextBlink_ = 2.8, blinkStart_ = -10;
  bool doubleBlink_ = false;
};
float smoother(float value);
}

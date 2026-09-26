#include "Motion.h"
#include "Config.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace copilot {
float smoother(float t) {
  t = std::max(0.0f, std::min(1.0f, t));
  return std::max(0.0f, std::min(1.0f,
      t * t * t * (t * (t * 6 - 15) + 10)));
}

Motion::Motion(uint32_t seed) : rng_(seed ? seed : 0xC0F1107u) {
  nextBlink_ = random(kBlinkMin, kBlinkMax);
}

float Motion::random(float low, float high) {
  rng_ ^= rng_ << 13;
  rng_ ^= rng_ >> 17;
  rng_ ^= rng_ << 5;
  return low + (high - low) * (rng_ >> 8) / 16777216.0f;
}

void Motion::chooseTarget(double now) {
  fromTurn_ = toTurn_;
  if (toTurn_ > 0) {
    toTurn_ = 0;
  } else {
    if (!automatic_ && pendingDirection_ < 0) {
      nextMove_ = std::numeric_limits<double>::infinity();
      return;
    }
    direction_ = pendingDirection_ >= 0 ? pendingDirection_ : static_cast<int>(random(0, 8));
    pendingDirection_ = -1;
    toTurn_ = random(0.88f, 1.0f);
  }
  moveStart_ = now;
  moveDuration_ = random(kMoveMin, kMoveMax);
  const float hold = toTurn_ == 0 && pendingDirection_ >= 0 ? 0.2f
      : random(0, 1) < 0.12f ? random(0.3f, 0.6f) : random(kHoldMin, kHoldMax);
  nextMove_ = now + moveDuration_ + kHeadDelay + hold;
  if (random(0, 1) < 0.28f && nextBlink_ > now + 0.8
      && now > blinkStart_ + kBlinkDuration + 1.0) {
    nextBlink_ = now + random(0.12f, 0.28f);
  }
}

bool Motion::requestLook(int direction, double seconds) {
  if (direction < 0 || direction >= 8 || !std::isfinite(seconds)) return false;
  const Pose current = sample(seconds);
  pendingDirection_ = direction;
  const bool settled = seconds >= moveStart_ + moveDuration_ + kHeadDelay;
  if (settled || (fromTurn_ == 0 && toTurn_ == 0 && current.turn == 0)) {
    nextMove_ = std::min(nextMove_, seconds + 0.12);
  }
  return true;
}

void Motion::setAutomatic(bool enabled, double seconds) {
  sample(seconds);
  automatic_ = enabled;
  if (!enabled) pendingDirection_ = -1;
  if (enabled && !std::isfinite(nextMove_)) nextMove_ = seconds + 0.25;
}

Pose Motion::sample(double now) {
  // Advance scheduled events at their timestamps, not at the arriving frame.
  // Dropped frames therefore do not change the personality or animation speed.
  while (now >= nextMove_ || now >= nextBlink_) {
    if (nextMove_ <= nextBlink_) {
      chooseTarget(nextMove_);
    } else {
      blinkStart_ = nextBlink_;
      if (doubleBlink_) {
        doubleBlink_ = false;
        nextBlink_ += random(kBlinkMin, kBlinkMax);
      } else {
        doubleBlink_ = random(0, 1) < 0.13f;
        nextBlink_ += doubleBlink_ ? kBlinkDuration + 0.12
                                  : random(kBlinkMin, kBlinkMax);
      }
    }
  }
  const float elapsed = static_cast<float>(now - moveStart_);
  const float head = smoother((elapsed - kHeadDelay) / moveDuration_);
  const float eyes = smoother(elapsed / (moveDuration_ * 0.54f));
  constexpr float directions[][2] = {
      {1, 0}, {-1, 0}, {0, -1}, {0, 1},
      {0.8f, -0.65f}, {-0.8f, -0.65f}, {0.8f, 0.65f}, {-0.8f, 0.65f}};
  const float turn = fromTurn_ + (toTurn_ - fromTurn_) * head;
  const float eyeTurn = fromTurn_ + (toTurn_ - fromTurn_) * eyes;
  Pose pose;
  pose.direction = direction_;
  pose.turn = turn;
  pose.eyeX = directions[direction_][0] * (eyeTurn - turn) * 7.5f;
  pose.eyeY = directions[direction_][1] * (eyeTurn - turn) * 4.5f;
  const float blink = static_cast<float>(now - blinkStart_);
  if (blink >= 0 && blink < kBlinkClose) {
    pose.openness = 1 - smoother(blink / kBlinkClose);
  } else if (blink >= kBlinkClose && blink < kBlinkClose + kBlinkHold) {
    pose.openness = 0;
  } else if (blink >= kBlinkClose + kBlinkHold && blink < kBlinkDuration) {
    pose.openness = smoother((blink - kBlinkClose - kBlinkHold) / kBlinkOpen);
  }
  return pose;
}
}

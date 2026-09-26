#include "SpriteMotion.h"
#include <algorithm>
#include <cmath>

namespace copilot {
namespace {
constexpr double kMaxDelta = 1.0 / 30;
constexpr const char* kInvalidCount = "At least two sprite frames are required.";

double quintic(double t) {
  return t * t * t * (t * (6 * t - 15) + 10);
}

double inverseQuintic(double value) {
  if (value <= 0 || value >= 1) return std::max(0.0, std::min(1.0, value));
  double low = 0, high = 1;
  for (int i = 0; i < 30; ++i) {
    const double middle = (low + high) / 2;
    if (quintic(middle) < value) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
}

SpriteMotion::SpriteMotion(uint32_t seed, uint8_t frameCount)
    : rng_(seed ? seed : 0x6d2b79f5u), count_(frameCount),
      target_(frameCount >= 2 ? frameCount - 1 : 0), blinkWait_(range(3, 7)) {
  if (!valid()) error_ = kInvalidCount;
}

double SpriteMotion::random() {
  rng_ ^= rng_ << 13;
  rng_ ^= rng_ >> 17;
  rng_ ^= rng_ << 5;
  return static_cast<double>(rng_) / 4294967296.0;
}

double SpriteMotion::range(double low, double high) {
  return low + random() * (high - low);
}

bool SpriteMotion::fail(const char* message) {
  error_ = message;
  return false;
}

void SpriteMotion::clearError() {
  error_ = valid() ? nullptr : kInvalidCount;
}

void SpriteMotion::setAutomatic(bool value) {
  automatic_ = value;
  if (value) cycling_ = false;
}

void SpriteMotion::setCycle(bool value) {
  cycling_ = value;
  if (value) {
    automatic_ = false;
    cycleIndex_ = 0;
  }
}

void SpriteMotion::setBlinks(bool value) {
  blinks_ = value;
  if (!value) doublePending_ = false;
}

bool SpriteMotion::setDuration(double value) {
  if (!std::isfinite(value) || value <= 0) return fail("Turn duration must be positive.");
  duration_ = value;
  clearError();
  return valid();
}

bool SpriteMotion::setSpeed(double value) {
  if (!std::isfinite(value) || value <= 0) return fail("Playback speed must be positive.");
  speed_ = value;
  clearError();
  return valid();
}

bool SpriteMotion::request(int direction, double depth) {
  if (!valid()) return fail(kInvalidCount);
  if (direction < 0 || direction >= 8) return fail("Unknown sprite direction.");
  if (!std::isfinite(depth) || depth <= 0 || depth > 1)
    return fail("Sprite direction depth must be between zero and one.");
  if (queueSize_ == kQueueCapacity) return fail("Sprite direction queue is full.");
  queue_[(queueHead_ + queueSize_) % kQueueCapacity] = {
      static_cast<uint8_t>(direction), depth};
  ++queueSize_;
  if (phase_ == Phase::Center && !pose_.index) hold_ = 0;
  clearError();
  return true;
}

bool SpriteMotion::returnToCenter(double duration) {
  if (!setDuration(duration)) return false;
  automatic_ = cycling_ = false;
  queueHead_ = queueSize_ = 0;
  if (phase_ == Phase::Return || (phase_ == Phase::Center && !pose_.index)) return true;
  target_ = std::max<uint8_t>(1, pose_.index);
  phase_ = pose_.index ? Phase::Return : Phase::Center;
  progress_ = 0;
  return true;
}

void SpriteMotion::startTurn() {
  uint8_t direction;
  double depth = 1;
  if (queueSize_) {
    const Request request = queue_[queueHead_];
    direction = request.direction;
    depth = request.depth;
    queueHead_ = (queueHead_ + 1) % kQueueCapacity;
    --queueSize_;
  } else if (cycling_) {
    direction = cycleIndex_;
    cycleIndex_ = (cycleIndex_ + 1) % 8;
  } else if (automatic_) {
    direction = static_cast<uint8_t>(std::floor(random() * 7));
    if (direction >= pose_.direction) ++direction;
    depth = range(.55, 1);
  } else {
    return;
  }
  pose_.direction = direction;
  const int limit = std::max(1, (direction == 2 || direction == 3)
      ? (count_ - 1) / 2 : count_ - 1);
  target_ = static_cast<uint8_t>(std::max(1.0, std::round(depth * limit)));
  phase_ = Phase::Out;
  progress_ = 0;
}

double SpriteMotion::edgeDuration() {
  const int travelled = phase_ == Phase::Out ? pose_.index : target_ - pose_.index;
  const bool eased = eased_ && pose_.direction != 0;
  if (edgeCache_.target == target_ && edgeCache_.travelled == travelled
      && edgeCache_.eased == eased && edgeCache_.duration == duration_) {
    return edgeCache_.interval;
  }
  const double before = static_cast<double>(travelled) / target_;
  const double after = static_cast<double>(travelled + 1) / target_;
  const double turnDuration = duration_ * std::sqrt(static_cast<double>(target_) / (count_ - 1));
  const double interval = turnDuration
      * (eased ? inverseQuintic(after) - inverseQuintic(before) : after - before);
  edgeCache_ = {duration_, interval, target_, static_cast<uint8_t>(travelled), eased};
  return interval;
}

void SpriteMotion::updateBlink(double dt) {
  if (blinkPhase_ == BlinkPhase::Idle) {
    if (blinks_ || doublePending_) blinkWait_ -= dt;
    if (blinkQueued_ || ((blinks_ || doublePending_) && blinkWait_ <= 0)) {
      const bool second = doublePending_;
      doublePending_ = !second && blinks_ && random() < .15;
      blinkPhase_ = BlinkPhase::Closing;
      blinkElapsed_ = 0;
      blinkQueued_ = false;
    }
    return;
  }
  blinkElapsed_ += dt;
  const double interval = blinkPhase_ == BlinkPhase::Closing ? .09 / 4
      : blinkPhase_ == BlinkPhase::Closed ? .04 : .14 / 4;
  if (blinkElapsed_ < interval) return;
  blinkElapsed_ = std::min(blinkElapsed_ - interval, interval);
  if (blinkPhase_ == BlinkPhase::Closing) {
    ++pose_.blinkLevel;
    if (pose_.blinkLevel == 4) {
      blinkPhase_ = BlinkPhase::Closed;
      blinkElapsed_ = 0;
    }
  } else if (blinkPhase_ == BlinkPhase::Closed) {
    blinkPhase_ = BlinkPhase::Opening;
    blinkElapsed_ = 0;
  } else {
    --pose_.blinkLevel;
    if (pose_.blinkLevel == 0) {
      blinkPhase_ = BlinkPhase::Idle;
      blinkWait_ = doublePending_ ? range(.16, .28) : range(3, 7);
    }
  }
}

void SpriteMotion::update(double deltaSeconds) {
  if (!valid() || !playing_ || !std::isfinite(deltaSeconds) || deltaSeconds <= 0) return;
  const double dt = std::min(deltaSeconds, kMaxDelta) * speed_;
  // Blinking is independent: it must never add a dwell to the head timeline.
  updateBlink(std::min(dt, kMaxDelta));
  if (phase_ == Phase::Center || phase_ == Phase::Endpoint) {
    progress_ += dt / hold_;
    if (progress_ < 1) return;
    progress_ = 0;
    if (phase_ == Phase::Center) startTurn();
    else phase_ = Phase::Return;
    return;
  }
  const double interval = edgeDuration();
  progress_ += dt / interval;
  if (progress_ < 1) return;
  const double remainder = interval > 0 ? (progress_ - 1) * interval : 0;
  progress_ = 0;
  if (phase_ == Phase::Out) ++pose_.index;
  else --pose_.index;
  if (pose_.index == target_ && phase_ == Phase::Out) {
    phase_ = Phase::Endpoint;
    hold_ = pose_.direction == 0 ? .001 : cycling_ ? .6 : range(.35, 1.4);
  } else if (pose_.index == 0 && phase_ == Phase::Return) {
    phase_ = Phase::Center;
    hold_ = cycling_ ? .6 : range(.35, 1.6);
  } else {
    // Keep ordinary fractional timing, but never queue more than one edge.
    const double next = edgeDuration();
    progress_ = next > 0 ? std::min(remainder / next, 1.0) : 1;
  }
}
}

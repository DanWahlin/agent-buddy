#pragma once
#include <cstddef>
#include <cstdint>

namespace copilot {
struct SpritePose {
  uint8_t direction = 0;
  uint8_t index = 0;
  uint8_t blinkLevel = 0;
  uint8_t blinkBlend = 0;
};

// Tracks: right, left, up, down, up_right, up_left, down_right, down_left.
// Zero is the shared center; queued changes are applied only there.
class SpriteMotion {
 public:
  enum class Phase { Center, Out, Endpoint, Return };
  enum class BlinkPhase { Idle, Closing, Closed, Opening };
  static constexpr size_t kQueueCapacity = 16;

  // Zero seeds use 0x6d2b79f5 to avoid xorshift's absorbing state.
  // Counts below two leave an inert instance with valid() == false.
  explicit SpriteMotion(uint32_t seed, uint8_t frameCount = 24);
  void update(double deltaSeconds);
  const SpritePose& pose() const { return pose_; }
  const char* error() const { return error_; }
  bool valid() const { return count_ >= 2; }

  void setPlaying(bool value) { playing_ = value; }
  void setAutomatic(bool value);
  void setCycle(bool value);
  void setBlinks(bool value);
  void setEased(bool value) { eased_ = value; }
  bool setDuration(double value);
  bool setSpeed(double value);
  // Fixed FIFO: invalid directions/full queues return false without dropping work.
  // Failed controls set error(); a successful bool control clears it.
  bool request(int direction, double depth = 1);
  bool returnToCenter(double duration = .65);
  void requestBlink() { blinkQueued_ = true; }

  bool playing() const { return playing_; }
  bool automatic() const { return automatic_; }
  bool cycling() const { return cycling_; }
  uint8_t frameCount() const { return count_; }
  uint8_t target() const { return target_; }
  Phase phase() const { return phase_; }
  BlinkPhase blinkPhase() const { return blinkPhase_; }
  double progress() const { return progress_; }
  double hold() const { return hold_; }
  double blinkElapsed() const { return blinkElapsed_; }
  double blinkWait() const { return blinkWait_; }
  bool doublePending() const { return doublePending_; }
  size_t queued() const { return queueSize_; }

 private:
  double random();
  double range(double low, double high);
  double edgeDuration();
  void startTurn();
  void updateBlink(double dt);
  bool fail(const char* message);
  void clearError();

  SpritePose pose_;
  uint32_t rng_;
  uint8_t count_;
  uint8_t target_;
  Phase phase_ = Phase::Center;
  BlinkPhase blinkPhase_ = BlinkPhase::Idle;
  double progress_ = 0;
  double hold_ = .7;
  double duration_ = 1.8;
  double speed_ = 1;
  double blinkElapsed_ = 0;
  double blinkWait_;
  bool playing_ = true;
  bool automatic_ = true;
  bool cycling_ = false;
  bool eased_ = true;
  bool blinks_ = true;
  bool blinkQueued_ = false;
  bool doublePending_ = false;
  uint8_t cycleIndex_ = 0;
  struct Request {
    uint8_t direction = 0;
    double depth = 1;
  };
  Request queue_[kQueueCapacity] = {};
  size_t queueHead_ = 0;
  size_t queueSize_ = 0;
  const char* error_ = nullptr;
  // One lazy entry avoids repeated inverse easing while dwelling on an edge.
  // target == 0 marks an empty cache; count_ never changes after construction.
  struct EdgeCache {
    double duration = 0;
    double interval = 0;
    uint8_t target = 0;
    uint8_t travelled = 0;
    bool eased = false;
  } edgeCache_;
};
}

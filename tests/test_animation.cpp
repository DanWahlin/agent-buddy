#include "../characters/copilot/legacy-atlas/src/AtlasRenderer.h"
#include "../firmware/AgentCompanion/src/AnimationClock.h"
#include "../tools/HostInflate.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

using namespace copilot;

void checkPose(const Pose& p) {
  assert(p.direction >= 0 && p.direction < 8);
  assert(std::isfinite(p.turn) && p.turn >= 0 && p.turn <= 1);
  assert(p.openness >= 0 && p.openness <= 1);
  assert(std::abs(p.eyeX) <= 7.51f && std::abs(p.eyeY) <= 4.51f);
}

int main() {
  assert(smoother(-1) == 0 && smoother(2) == 1);
  AnimationClock clock;
  assert(clock.advance(1000000) == 0);
  const double beforePause = clock.advance(1010000);
  assert(std::abs(beforePause - 0.01) < 1e-9);
  const double afterPause = clock.advance(11010000);
  assert(afterPause - beforePause <= 1.0 / kTargetFps + 1e-9);
  assert(std::abs(clock.advance(11020000) - afterPause - 0.01) < 1e-9);
  Motion motion(42);
  Pose previous = motion.sample(0);
  bool left = false, right = false, up = false, down = false;
  int blinks = 0;
  for (int i = 1; i < 180000; ++i) {
    const Pose current = motion.sample(i * 0.001);
    checkPose(current);
    assert(std::abs(current.turn - previous.turn) < 0.002f);
    assert(std::abs(current.openness - previous.openness) < 0.04f);
    if (current.direction != previous.direction) {
      assert(current.turn == 0 && previous.turn == 0);
    }
    left |= current.direction == 1 && current.turn > 0.87f;
    right |= current.direction == 0 && current.turn > 0.87f;
    up |= current.direction == 2 && current.turn > 0.87f;
    down |= current.direction == 3 && current.turn > 0.87f;
    blinks += current.openness == 0 && previous.openness > 0;
    previous = current;
  }
  assert(left && right && up && down);
  assert(blinks >= 20 && blinks <= 85);
  std::cout << "Deep side and vertical targets, "
            << blinks << " blinks in three minutes, continuous center returns\n";
  for (uint32_t seed = 0; seed < 20; ++seed) {
    Motion sparse(seed), dense(seed);
    for (int i = 0; i <= 6000; ++i) {
      const Pose p = dense.sample(i / 100.0);
      if (i % 100 == 0) {
        const Pose q = sparse.sample(i / 100.0);
        assert(p.direction == q.direction && std::abs(p.turn - q.turn) < 1e-6f);
        assert(std::abs(p.openness - q.openness) < 1e-6f);
      }
    }
    checkPose(sparse.sample(3600 * 24 * 7));
  }
  AnimationClock playback;
  Motion pausedMotion(42);
  Pose prior;
  int64_t wallUs = 0;
  for (int frame = 0; frame < 20000; ++frame) {
    wallUs += frame % 73 == 0 ? 3000000 : 33333;
    const Pose current = pausedMotion.sample(playback.advance(wallUs));
    assert(std::abs(current.turn - prior.turn) < 0.055f);
    if (current.direction != prior.direction) assert(current.turn == 0 && prior.turn == 0);
    prior = current;
  }
  std::cout << "20,000 frames with repeated 3-second stalls: no catch-up snap\n";
  Motion directed(123);
  directed.setAutomatic(false, 0);
  assert(directed.requestLook(1, 0));
  assert(!directed.requestLook(8, 0));
  prior = directed.sample(0);
  bool sawLeft = false, sawRight = false;
  for (int frame = 1; frame < 600; ++frame) {
    const double seconds = frame / 30.0;
    if (frame == 21) assert(directed.requestLook(0, seconds));
    const Pose current = directed.sample(seconds);
    assert(std::abs(current.turn - prior.turn) < 0.055f);
    if (current.direction != prior.direction) assert(current.turn == 0 && prior.turn == 0);
    sawLeft |= current.direction == 1 && current.turn > 0.7f;
    sawRight |= current.direction == 0 && current.turn > 0.7f;
    prior = current;
  }
  assert(sawLeft && sawRight);
  std::cout << "Mid-turn look requests: complete outbound/return before changing direction\n";
  std::vector<uint8_t> first(kAtlasWidth * kAtlasHeight), second(first.size());
  std::vector<uint16_t> frame(kFrameWidth * kFrameHeight);
  AtlasRenderer renderer(first.data(), second.data(), inflateAtlasHost);
  assert(renderer.render(Pose{}, frame.data()));
  const auto neutral = frame;
  for (int direction = 0; direction < kAtlasDirections; ++direction) {
    Pose pose;
    pose.direction = direction;
    assert(renderer.render(pose, frame.data()));
    assert(frame == neutral);
    for (int step = 0; step < kAtlasSteps; ++step) {
      pose.turn = static_cast<float>(step) / (kAtlasSteps - 1);
      assert(renderer.render(pose, frame.data()));
      for (const auto& eye : kAtlasFrames[direction * kAtlasSteps + step].eyes) {
        assert(std::isfinite(eye.x) && std::isfinite(eye.y) && std::isfinite(eye.angle));
        assert(eye.visibility >= 0 && eye.visibility <= 1);
        assert(eye.rx > 0 && eye.ry > 0);
      }
      for (int y = 0; y < kFrameHeight; ++y) {
        for (int x = 0; x < kFrameWidth; ++x) {
          const uint16_t color = __builtin_bswap16(frame[y * kFrameWidth + x]);
          if (((color >> 5) & 63) > 22 || (color >> 11) > 12) {
            const int dx = x + kFrameX - 233, dy = y + kFrameY - 233;
            assert(dx * dx + dy * dy < 231 * 231);
          }
        }
      }
    }
    int changed = 0;
    for (size_t i = 0; i < frame.size(); ++i) changed += frame[i] != neutral[i];
    assert(changed > 15000);
    const auto open = frame;
    pose.openness = 0;
    assert(renderer.render(pose, frame.data()));
    assert(frame != open);
    pose.openness = 1;
    assert(renderer.render(pose, frame.data()));
    assert(frame == open);
    pose.turn = 10.0f / (kAtlasSteps - 1);
    assert(renderer.render(pose, frame.data()));
    const auto before = frame;
    pose.turn = 11.0f / (kAtlasSteps - 1);
    assert(renderer.render(pose, frame.data()));
    const auto after = frame;
    pose.turn = 10.5f / (kAtlasSteps - 1);
    assert(renderer.render(pose, frame.data()));
    assert(frame != before && frame != after);
  }
  Pose invalid;
  invalid.direction = -1;
  assert(!renderer.render(invalid, frame.data()) && renderer.error());
  AtlasRenderer corrupt(first.data(), second.data(),
      [](uint8_t*, size_t, const uint8_t*, size_t) { return false; });
  assert(!corrupt.render(Pose{}, frame.data()) && corrupt.error());
  std::cout << kAtlasFrameCount << " poses: decompression, bounds, deep-view differences, blinks and errors OK\n";
}

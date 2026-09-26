#include "../firmware/AgentCompanion/src/SpriteMotion.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <new>
#include <set>
#include <string>
#include <vector>

using copilot::SpriteMotion;
using Phase = SpriteMotion::Phase;
using BlinkPhase = SpriteMotion::BlinkPhase;

static bool forbidAllocations = false;
void* operator new(std::size_t size) {
  assert(!forbidAllocations);
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
#if defined(__cpp_sized_deallocation)
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
#endif

static int limit(const SpriteMotion& p) {
  return std::max(1, (p.pose().direction == 2 || p.pose().direction == 3)
      ? (p.frameCount() - 1) / 2 : p.frameCount() - 1);
}

static void step(SpriteMotion& p, double dt) {
  const auto old = p.pose();
  p.update(dt);
  const auto now = p.pose();
  assert(now.direction < 8);
  assert(now.index <= limit(p));
  assert(now.blinkLevel <= 4);
  assert(std::abs(int(now.index) - old.index) <= 1);
  assert(std::abs(int(now.blinkLevel) - old.blinkLevel) <= 1);
  if (now.direction != old.direction) assert(now.index == 0 && old.index == 0);
  assert(std::isfinite(p.progress()) && p.progress() >= 0 && p.progress() <= 1);
  assert(!p.error());
}

template<class Predicate>
static void until(SpriteMotion& p, Predicate predicate, double dt = 1.0 / 60) {
  for (int i = 0; i < 30000; ++i) {
    if (predicate(p)) return;
    step(p, dt);
  }
  assert(false && "Motion did not reach requested state");
}

static SpriteMotion manual(uint8_t count = 24) {
  SpriteMotion p(42, count);
  p.setAutomatic(false);
  p.setBlinks(false);
  return p;
}

static double inverse(double value) {
  if (value <= 0 || value >= 1) return value;
  double low = 0, high = 1;
  for (int i = 0; i < 30; ++i) {
    const double m = (low + high) / 2;
    if (m * m * m * (m * (6 * m - 15) + 10) < value) low = m;
    else high = m;
  }
  return (low + high) / 2;
}

static void tracksAndTiming() {
  for (const uint8_t count : {2, 24, 33, 255}) {
    for (int direction = 0; direction < 8; ++direction) {
      auto p = manual(count);
      assert(p.request(direction));
      until(p, [](const auto& q) { return q.phase() == Phase::Out; });
      assert(p.target() == limit(p));
      std::vector<int> outward{0}, inward;
      until(p, [&](const auto& q) {
        if (outward.back() != q.pose().index) outward.push_back(q.pose().index);
        return q.phase() == Phase::Endpoint;
      });
      assert(outward.size() == size_t(limit(p) + 1));
      for (size_t i = 0; i < outward.size(); ++i) assert(outward[i] == int(i));
      until(p, [](const auto& q) { return q.phase() == Phase::Return; });
      inward.push_back(p.pose().index);
      until(p, [&](const auto& q) {
        if (inward.back() != q.pose().index) inward.push_back(q.pose().index);
        return q.phase() == Phase::Center;
      });
      std::reverse(outward.begin(), outward.end());
      assert(inward == outward);
    }
  }
  for (int direction = 0; direction < 8; ++direction) {
    for (int fps : {30, 60, 120, 0}) {
      auto p = manual();
      assert(p.request(direction));
      const double refresh = fps ? 1.0 / fps : 1.0 / 60;
      until(p, [](const auto& q) { return q.phase() == Phase::Out; }, refresh);
      const double duration = 1.8 * std::sqrt(p.target() / 23.0);
      const double irregular[] = {1.0 / 60, 1.0 / 90, 1.0 / 45, 1.0 / 120};
      for (Phase phase : {Phase::Out, Phase::Return}) {
        if (phase == Phase::Return)
          until(p, [](const auto& q) { return q.phase() == Phase::Return; }, refresh);
        double elapsed = 0;
        int tick = 0;
        while (p.phase() == phase) {
          const auto old = p.pose().index;
          const double dt = fps ? refresh : irregular[tick++ % 4];
          step(p, dt);
          elapsed += dt;
          if (old != p.pose().index) {
            const int travelled = phase == Phase::Out ? p.pose().index : p.target() - p.pose().index;
            const double position = double(travelled) / p.target();
            const double expected = duration * (direction == 0 ? position : inverse(position));
            assert(elapsed >= expected - 1e-9);
            assert(elapsed - expected <= (fps ? refresh : 1.0 / 45) + 1e-9);
          }
        }
        assert(std::abs(elapsed - duration) <= (fps ? refresh : 1.0 / 45) + 1e-9);
      }
    }
  }
}

static void queueCycleAndControls() {
  auto p = manual();
  assert(p.request(0));
  until(p, [](const auto& q) { return q.pose().index == 8; });
  for (int dir : {2, 1, 3}) assert(p.request(dir));
  until(p, [](const auto& q) { return q.phase() == Phase::Endpoint; });
  assert(p.pose().index == 23);
  for (int dir : {2, 1, 3}) {
    until(p, [&](const auto& q) { return q.pose().direction == dir && q.phase() == Phase::Out; });
    assert(p.pose().index == 0);
    until(p, [](const auto& q) { return q.phase() == Phase::Center; });
  }
  assert(p.queued() == 0);
  p.setCycle(true);
  for (int i = 0; i < 24; ++i) {
    until(p, [](const auto& q) { return q.phase() == Phase::Out; });
    assert(p.pose().direction == i % 8 && p.target() == limit(p));
    until(p, [](const auto& q) { return q.phase() == Phase::Endpoint; });
    assert(p.hold() == (p.pose().direction == 0 ? .001 : .6));
    until(p, [](const auto& q) { return q.phase() == Phase::Center; });
    assert(p.hold() == .6);
  }
  p.setCycle(false);
  for (int i = 0; i < 1000; ++i) step(p, 1.0 / 30);
  assert(p.phase() == Phase::Center);
  p.setAutomatic(true);
  assert(!p.cycling() && p.automatic());

  assert(!p.request(-1) && p.error());
  assert(!p.request(8) && p.error());
  assert(p.request(7) && !p.error());
  for (size_t i = 1; i < SpriteMotion::kQueueCapacity; ++i) assert(p.request(int(i % 8)));
  assert(!p.request(0) && p.error());
  assert(p.queued() == SpriteMotion::kQueueCapacity);
  for (double value : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                       std::numeric_limits<double>::quiet_NaN()}) {
    assert(!p.setDuration(value) && p.error());
    assert(!p.setSpeed(value) && p.error());
  }
  assert(p.setSpeed(1) && !p.error());
  assert(p.setDuration(1.8) && !p.error());
  for (uint8_t count : {0, 1}) {
    SpriteMotion invalid(0, count);
    assert(!invalid.valid() && invalid.error());
    assert(!invalid.request(0));
    invalid.update(100);
    assert(invalid.pose().index == 0);
  }
}

static std::array<double, 11> state(const SpriteMotion& p) {
  return {double(p.pose().direction), double(p.pose().index), double(p.pose().blinkLevel),
          double(p.phase()), p.progress(), double(p.target()), p.hold(), double(p.blinkPhase()),
          p.blinkElapsed(), p.blinkWait(), double(p.doublePending())};
}

static void edgeCacheInputs() {
  auto p = manual();
  p.setCycle(true);
  for (int direction = 0; direction < 16; ++direction) {
    until(p, [](const auto& q) { return q.phase() == Phase::Out; });
    assert(p.pose().direction == direction % 8);
    for (Phase phase : {Phase::Out, Phase::Return}) {
      if (phase == Phase::Return)
        until(p, [](const auto& q) { return q.phase() == Phase::Return; });
      // Prime each edge, then change a single cache input without changing pose.
      for (double duration : {1.8, .8, 2.4, 1.8}) {
        assert(p.setDuration(duration));
        for (bool eased : {true, false, true}) {
          p.setEased(eased);
          const int travelled = phase == Phase::Out ? p.pose().index : p.target() - p.pose().index;
          const double before = double(travelled) / p.target();
          const double after = double(travelled + 1) / p.target();
          const bool usesEasing = eased && p.pose().direction != 0;
          const double interval = duration * std::sqrt(double(p.target()) / (p.frameCount() - 1))
              * (usesEasing ? inverse(after) - inverse(before) : after - before);
          for (int i = 0; i < 3; ++i) {
            const auto oldIndex = p.pose().index;
            const double expected = p.progress() + .000001 / interval;
            step(p, .000001);
            assert(p.pose().index == oldIndex && p.phase() == phase);
            assert(p.progress() == expected);
          }
        }
      }
      until(p, [&](const auto& q) { return q.phase() != phase; });
    }
  }
}

static void stallsAndPause() {
  SpriteMotion normal(17), stalled(17);
  for (int i = 0; i < 10000; ++i) {
    step(normal, 1.0 / 30);
    step(stalled, 3600);
    assert(state(normal) == state(stalled));
  }
  for (double dt : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                    std::numeric_limits<double>::quiet_NaN()}) {
    const auto before = state(normal);
    normal.update(dt);
    assert(state(normal) == before);
  }
  auto p = manual();
  assert(p.request(2));
  until(p, [](const auto& q) { return q.pose().index == 8; });
  p.requestBlink();
  until(p, [](const auto& q) { return q.pose().blinkLevel == 2; });
  p.setPlaying(false);
  const auto before = state(p);
  assert(p.request(1));
  assert(p.setDuration(.8) && p.setSpeed(.25));
  p.setEased(false);
  p.setBlinks(false);
  p.update(800);
  assert(state(p) == before);
  p.setPlaying(true);
  assert(state(p) == before);
  until(p, [](const auto& q) { return q.pose().direction == 1; });
  assert(p.setDuration(.001) && p.setSpeed(100));
  for (int i = 0; i < 1000; ++i) step(p, 3600);
}

static void blinking() {
  auto p = manual();
  p.setPlaying(false);
  p.requestBlink();
  p.update(100);
  assert(p.blinkPhase() == BlinkPhase::Idle);
  p.setPlaying(true);
  until(p, [](const auto& q) { return q.blinkPhase() == BlinkPhase::Closing; });
  std::vector<int> levels{0};
  until(p, [&](const auto& q) {
    if (levels.back() != q.pose().blinkLevel) levels.push_back(q.pose().blinkLevel);
    assert(q.pose().index == 0);
    return q.blinkPhase() == BlinkPhase::Idle;
  }, 1.0 / 120);
  assert((levels == std::vector<int>{0, 1, 2, 3, 4, 3, 2, 1, 0}));

  // Cycling uses constant holds, so independent RNG consumption cannot change head timing.
  auto normal = manual(), blink = manual();
  normal.setCycle(true);
  blink.setCycle(true);
  bool movedDuringBlink = false;
  for (int i = 0; i < 10000; ++i) {
    if (i % 53 == 0) blink.requestBlink();
    const auto previous = blink.pose().index;
    const double dt = i % 17 == 0 ? 30 : 1.0 / 60;
    step(normal, dt);
    step(blink, dt);
    assert(normal.pose().index == blink.pose().index);
    assert(normal.pose().direction == blink.pose().direction);
    assert(normal.phase() == blink.phase() && normal.progress() == blink.progress());
    movedDuringBlink |= blink.pose().blinkLevel > 0 && previous != blink.pose().index;
  }
  assert(movedDuringBlink);

  SpriteMotion automaticBlink(42);
  automaticBlink.setAutomatic(false);
  bool sawDouble = false, awaitingSecond = false;
  int normalIntervals = 0, doubleIntervals = 0;
  for (int i = 0; i < 100000; ++i) {
    const auto phase = automaticBlink.blinkPhase();
    step(automaticBlink, 1.0 / 120);
    if (phase != BlinkPhase::Idle && automaticBlink.blinkPhase() == BlinkPhase::Idle) {
      if (automaticBlink.doublePending()) {
        assert(!awaitingSecond);
        awaitingSecond = sawDouble = true;
        ++doubleIntervals;
        assert(automaticBlink.blinkWait() >= .16 && automaticBlink.blinkWait() <= .28);
      } else {
        awaitingSecond = false;
        ++normalIntervals;
        assert(automaticBlink.blinkWait() >= 3 && automaticBlink.blinkWait() <= 7);
      }
    }
  }
  assert(sawDouble && doubleIntervals > 5 && normalIntervals > 50);
}

static void randomnessAndNoHeap() {
  std::set<int> directions, targets;
  std::set<double> holds;
  SpriteMotion p(42);
  assert(p.automatic() && p.playing() && p.hold() == .7);
  for (int i = 0; i < 80; ++i) {
    const auto previous = p.pose().direction;
    until(p, [](const auto& q) { return q.phase() == Phase::Out; });
    assert(p.pose().direction != previous);
    assert(p.target() >= std::round(.55 * limit(p)) && p.target() <= limit(p));
    directions.insert(p.pose().direction);
    targets.insert(p.target());
    until(p, [](const auto& q) { return q.phase() == Phase::Endpoint; });
    if (p.pose().direction == 0) {
      assert(p.hold() == .001);
    } else {
      assert(p.hold() >= .35 && p.hold() <= 1.4);
      holds.insert(p.hold());
    }
    until(p, [](const auto& q) { return q.phase() == Phase::Center; });
    assert(p.hold() >= .35 && p.hold() <= 1.6);
    holds.insert(p.hold());
  }
  assert(directions.size() == 8 && targets.size() > 5 && holds.size() > 100);
  forbidAllocations = true;
  for (uint32_t seed = 0; seed < 128; ++seed) {
    SpriteMotion motion(seed, seed % 4 == 0 ? 255 : 24);
    for (int i = 0; i < 20000; ++i) {
      if (i % 521 == 0) assert(motion.request(int((seed + i) % 8)));
      if (i % 631 == 0) motion.requestBlink();
      step(motion, i % 73 == 0 ? 1000 : 1.0 / (30 << (i % 3)));
    }
  }
  forbidAllocations = false;
}

static void trace(int argc, char** argv) {
  assert(argc == 8);
  SpriteMotion p(static_cast<uint32_t>(std::stoul(argv[2])),
                 static_cast<uint8_t>(std::stoi(argv[3])));
  const int fps = std::stoi(argv[4]), ticks = std::stoi(argv[5]);
  const int scenario = std::stoi(argv[6]);
  const bool eased = std::stoi(argv[7]) != 0;
  p.setEased(eased);
  if (scenario == 1) p.setCycle(true);
  std::cout << std::setprecision(17);
  for (int i = 0; i < ticks; ++i) {
    if (scenario == 2) {
      if (i == 50 || i == 1500) p.setPlaying(false);
      if (i == 70 || i == 1520) p.setPlaying(true);
      if (i % 337 == 0) assert(p.request((i / 337) % 8));
      if (i % 113 == 0) p.requestBlink();
      if (i == 1000) p.setBlinks(false);
      if (i == 2000) p.setBlinks(true);
      if (i == 3000) { assert(p.setSpeed(3)); assert(p.setDuration(.4)); }
      if (i == 4000) { assert(p.setSpeed(.75)); assert(p.setDuration(2.4)); }
      if (i % 71 == 0) p.setEased((i / 71) % 2 == 0);
    }
    const double irregular[] = {1.0 / 60, 1.0 / 90, 1.0 / 45, 1.0 / 120};
    const double dt = i % 97 == 0 ? 999 : fps ? 1.0 / fps : irregular[i % 4];
    step(p, dt);
    const auto snapshot = state(p);
    for (size_t j = 0; j < snapshot.size(); ++j)
      std::cout << (j ? "," : "") << snapshot[j];
    std::cout << '\n';
  }
}

static void benchmark() {
  constexpr int updates = 1000000;
  std::array<double, 5> timings;
  uint64_t checksum = 0;
  for (double& elapsed : timings) {
    SpriteMotion p(42);
    const auto start = std::chrono::steady_clock::now();
    forbidAllocations = true;
    for (int i = 0; i < updates; ++i) {
      p.update(1.0 / 30);
      checksum += p.pose().index + p.pose().direction + p.pose().blinkLevel;
    }
    forbidAllocations = false;
    elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  }
  std::sort(timings.begin(), timings.end());
  std::cout << "Median " << timings[2] * 1000 << " ms / " << updates
            << " updates; checksum " << checksum << "; object " << sizeof(SpriteMotion) << " bytes\n";
}

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--benchmark") {
    benchmark();
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--trace") {
    trace(argc, argv);
    return 0;
  }
  tracksAndTiming();
  queueCycleAndControls();
  edgeCacheInputs();
  stallsAndPause();
  blinking();
  randomnessAndNoHeap();
  std::cout << "SpriteMotion: all tracks, timing, queue, stalls, pause, blinks, "
               "randomness and 2,560,000 allocation-free updates passed\n";
}

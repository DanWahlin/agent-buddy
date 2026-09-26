#include "../firmware/AgentCompanion/src/CharacterEffects.h"
#include "../firmware/AgentCompanion/src/CharacterModel.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <new>
#include <vector>

using namespace copilot;
using Mode = CharacterMode;
static bool noAllocations = false;
void* operator new(size_t size) {
  assert(!noAllocations);
  if (void* result = std::malloc(size ? size : 1)) return result;
  throw std::bad_alloc();
}
void* operator new[](size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
#if defined(__cpp_sized_deallocation)
void operator delete(void* p, size_t) noexcept { std::free(p); }
void operator delete[](void* p, size_t) noexcept { std::free(p); }
#endif

static bool same(const CharacterState& a, const CharacterState& b) {
  return a.pose.direction == b.pose.direction && a.pose.index == b.pose.index
      && a.pose.blinkLevel == b.pose.blinkLevel && a.mode == b.mode
      && a.pose.blinkBlend == b.pose.blinkBlend
      && a.requestedMode == b.requestedMode && a.effectSeconds == b.effectSeconds && a.eventId == b.eventId;
}

static void step(CharacterMotion& motion, double dt = 1.0 / 30) {
  const auto before = motion.state();
  motion.update(dt);
  const auto after = motion.state();
  assert(after.pose.direction < 13 && after.pose.index < 24 && after.pose.blinkLevel < 5);
  assert(after.pose.index < kSpriteTrackSteps[after.pose.direction]);
  const bool springHandoff = before.mode == Mode::Surprise && before.pose.direction == 8
      && before.pose.index == 23 && after.pose.index == 0;
  assert(springHandoff || std::abs(int(after.pose.index) - before.pose.index) <= 1);
  assert(std::abs(int(after.pose.blinkLevel) - before.pose.blinkLevel) <= 1);
  if (after.pose.direction != before.pose.direction)
    assert((before.pose.index == 0 || springHandoff) && after.pose.index == 0);
  if (after.mode != before.mode) assert((before.pose.index == 0 || springHandoff) && after.pose.index == 0);
  assert(std::isfinite(after.effectSeconds) && after.effectSeconds >= 0 && after.effectSeconds <= 12);
}

template<class Predicate> static void until(CharacterMotion& motion, Predicate predicate, double dt = 1.0 / 30) {
  for (int i = 0; i < 20000; ++i) {
    if (predicate(motion.state())) return;
    step(motion, dt);
  }
  assert(false && "Character did not reach requested state");
}

static void idleParityAndCentering() {
  for (uint32_t seed = 0; seed < 12; ++seed) {
    CharacterMotion character(seed, 13);
    SpriteMotion sprite(seed);
    for (int i = 0; i < 3500; ++i) {
      const double dt = i % 87 == 0 ? 1000 : 1.0 / (30 << (i % 3));
      character.update(dt);
      sprite.update(dt);
      const auto pose = character.state().pose;
      assert(pose.index < kSpriteTrackSteps[pose.direction]);
      assert(pose.direction == sprite.pose().direction && pose.index == sprite.pose().index
             && pose.blinkLevel == sprite.pose().blinkLevel);
    }
  }
  for (int direction = 0; direction < 8; ++direction) {
    SpriteMotion sprite(42);
    sprite.setAutomatic(false);
    assert(sprite.request(direction));
    for (int i = 0; i < 400 && sprite.pose().index < 8; ++i) sprite.update(1.0 / 30);
    assert(sprite.pose().index == 8);
    assert(sprite.returnToCenter());
    for (int expected = 8; expected > 0;) {
      const int old = sprite.pose().index;
      sprite.update(1.0 / 30);
      assert(sprite.pose().index == old || sprite.pose().index == old - 1);
      if (sprite.pose().index != old) assert(sprite.pose().index == --expected);
    }
    assert(!sprite.automatic());
  }
}

static void modesAndInterruptions() {
  for (int fps : {30, 60, 120}) {
    const double dt = 1.0 / fps;
    for (Mode mode : {Mode::Surprise, Mode::Working, Mode::Complete, Mode::Attention}) {
      CharacterMotion p(42, 13);
      until(p, [](const auto& s) { return s.pose.index >= 7; }, dt);
      assert(p.setMode(mode));
      const uint32_t event = p.state().eventId;
      until(p, [&](const auto& s) { return s.mode == mode; }, dt);
      assert(p.state().pose.index == 0 && p.state().pose.direction == 7 + unsigned(mode));
      for (int pose = 1; pose <= 23; ++pose) {
        until(p, [&](const auto& s) { return s.pose.index == pose; }, dt);
        assert(p.state().mode == mode);
      }
      if (mode == Mode::Working || mode == Mode::Attention) {
        for (int i = 0; i < 1000; ++i) {
          assert(p.setMode(mode));
          step(p, dt);
          assert(p.state().mode == mode);
          if (mode == Mode::Attention) assert(p.state().pose.direction == 11 || p.state().pose.direction == 12);
          else assert(p.state().pose.direction == 9 || p.state().pose.direction < 2);
          assert(p.state().eventId == event);
        }
        p.surprise();
        until(p, [](const auto& s) { return s.mode == Mode::Surprise; }, dt);
        until(p, [&](const auto& s) { return s.mode == mode; }, dt);
        assert(p.state().requestedMode == mode);
        assert(p.setMode(Mode::Complete));
      }
      until(p, [](const auto& s) { return s.mode == Mode::Idle && s.requestedMode == Mode::Idle; }, dt);
      for (int i = 0; i < 500; ++i) { step(p, dt); assert(p.state().mode == Mode::Idle); }
    }
  }
  // Every old/new signal combination, including same-mode transients, at every source pose.
  for (int old = 0; old < 5; ++old) {
    for (int next = 0; next < 5; ++next) {
      for (int pose : {0, 1, 8, 21, 23}) {
        CharacterMotion p(7, 13);
        assert(p.setMode(static_cast<Mode>(old)));
        if (old) {
          until(p, [&](const auto& s) { return int(s.mode) == old && s.pose.index == pose; });
        }
        assert(p.setMode(static_cast<Mode>(next)));
        for (int i = 0; i < 300; ++i) step(p, i % 17 == 0 ? 300 : 1.0 / 30);
      }
    }
  }
  CharacterMotion p(42, 13);
  assert(p.setMode(Mode::Attention));
  until(p, [](const auto& s) { return s.pose.index == 23; });
  p.surprise();
  assert(p.setMode(Mode::Working));  // Explicit signal cancels the transient.
  until(p, [](const auto& s) { return s.mode == Mode::Working; });
  for (int i = 0; i < 400; ++i) { step(p); assert(p.state().mode != Mode::Surprise); }
}

static void pauseErrorsAndLongRun() {
  CharacterMotion unavailable(0, 8);
  assert(!unavailable.setMode(Mode::Attention) && unavailable.error());
  unavailable.surprise();
  assert(unavailable.error() && unavailable.state().mode == Mode::Idle);
  assert(unavailable.setMode(Mode::Idle) && !unavailable.error());
  assert(!unavailable.setMode(static_cast<Mode>(255)) && unavailable.error());
  for (uint32_t seed = 0; seed < 24; ++seed) {
    CharacterMotion p(seed, 13), stalled(seed, 13);
    noAllocations = true;
    for (int i = 0; i < 20000; ++i) {
      if (i % 223 == 0) {
        const Mode mode = static_cast<Mode>((i / 223 + seed) % 5);
        assert(p.setMode(mode) && stalled.setMode(mode));
      }

      step(p, 1.0 / 30);
      step(stalled, 500);
      assert(same(p.state(), stalled.state()));
      if (i % 197 == 0) {
        p.setPlaying(false);
        const auto frozen = p.state();
        p.update(300);
        assert(same(frozen, p.state()));
        p.setPlaying(true);
      }
      const auto before = p.state();
      p.update(0);
      p.update(-1);
      p.update(std::numeric_limits<double>::infinity());
      p.update(std::numeric_limits<double>::quiet_NaN());
      assert(same(before, p.state()));
    }
    noAllocations = false;
  }
}

static void blinkSafeExpressionEntry() {
  for (Mode mode : {Mode::Surprise, Mode::Complete}) {
    CharacterMotion motion(42, 13);
    until(motion, [](const auto& state) {
      return state.pose.index == 0 && state.pose.blinkLevel == 2;
    });
    assert(motion.setMode(mode));
    until(motion, [&](const auto& state) { return state.mode == mode; });
    assert(motion.state().pose.blinkLevel == 0);
    while (motion.state().mode == mode) {
      assert(motion.state().pose.blinkLevel == 0);
      step(motion);
    }
  }
}

static void workingLooksStayBusy() {
  CharacterMotion motion(27, 13);
  assert(motion.setMode(Mode::Working));
  until(motion, [](const auto& state) { return state.mode == Mode::Working; });
  bool left = false, right = false, focused = false, returned = false;
  int lookStarted = -1, previousLook = -1000;
  noAllocations = true;
  for (int tick = 0; tick < 6000; ++tick) {
    const auto before = motion.state();
    step(motion);
    const auto state = motion.state();
    assert(state.mode == Mode::Working && state.requestedMode == Mode::Working);
    if (state.pose.direction < 2) {
      assert(state.pose.index <= 13);
      left |= state.pose.direction == 1 && state.pose.index > 0;
      right |= state.pose.direction == 0 && state.pose.index > 0;
      if (before.pose.direction == 9) {
        assert(tick-previousLook >= 270);
        previousLook = lookStarted = tick;
      }
    } else {
      assert(state.pose.direction == 9);
      if (before.pose.direction < 2) {
        assert(lookStarted >= 0 && tick-lookStarted >= 105);
      }
      focused |= state.pose.index == 23;
      returned |= (left || right) && state.pose.index == 23;
    }
    noAllocations = false;
  }
  assert(left && right && focused && returned);
}

static void attentionAlternatesWithoutDismissing() {
  for (int fps : {30, 60, 120}) {
    CharacterMotion motion(27, 13);
    assert(motion.setMode(Mode::Attention));
    const auto event = motion.state().eventId;
    until(motion, [](const auto& state) { return state.mode == Mode::Attention; }, 1.0 / fps);
    bool original = false, alternate = false, returned = false, blinked = false;
    int previousSwitch = -20 * fps, switches = 0;
    noAllocations = true;
    for (int tick = 0; tick < 40 * fps; ++tick) {
      const auto before = motion.state();
      assert(motion.setMode(Mode::Attention));
      step(motion, 1.0 / fps);
      const auto state = motion.state();
      assert(state.mode == Mode::Attention && state.requestedMode == Mode::Attention);
      assert(state.eventId == event);
      assert(state.pose.direction == 11 || state.pose.direction == 12);
      if (before.pose.direction != state.pose.direction) {
        assert(tick-previousSwitch >= 5 * fps);
        previousSwitch = tick;
        ++switches;
      }
      original |= state.pose.direction == 11 && state.pose.index == 23;
      alternate |= state.pose.direction == 12 && state.pose.index == 23;
      returned |= alternate && state.pose.direction == 11 && state.pose.index == 23;
      blinked |= state.pose.blinkLevel > 0;
    }
    noAllocations = false;
    assert(original && alternate && returned && blinked && switches >= 4);
    for (Mode next : {Mode::Surprise, Mode::Working, Mode::Complete, Mode::Idle}) {
      assert(motion.setMode(Mode::Attention));
      until(motion, [](const auto& state) { return state.pose.direction == 12 && state.pose.index == 23; });
      assert(motion.setMode(next));
      until(motion, [&](const auto& state) { return state.mode == next; });
      if (next == Mode::Surprise) {
        until(motion, [](const auto& state) { return state.mode == Mode::Attention; });
        assert(motion.state().requestedMode == Mode::Attention);
      }
    }
  }
}

static void sleepsAfterSustainedIdleAndWakes() {
  CharacterMotion motion(42, 13);
  constexpr double dt = 1.0 / 30;
  const int idleTicks = static_cast<int>(CharacterMotion::kIdleBeforeSleepSeconds / dt);
  for (int tick = 0; tick < idleTicks - 1; ++tick) {
    step(motion, dt);
    assert(motion.state().mode == Mode::Idle);
  }
  until(motion, [](const auto& state) { return state.mode == Mode::Sleep; }, dt);
  assert(motion.state().pose.index == 0);
  bool peeked = false, blended = false, fullyClosed = false, moved = false;
  for (int tick = 0; tick < 12 / dt; ++tick) {
    step(motion, dt);
    const auto state = motion.state();
    assert(state.mode == Mode::Sleep && state.pose.index <= 5);
    if (tick >= 4) {
      assert(state.pose.blinkLevel >= 3);
      peeked |= state.pose.blinkLevel == 3 && state.pose.blinkBlend == 255;
      blended |= state.pose.blinkLevel == 3
          && state.pose.blinkBlend > 0 && state.pose.blinkBlend < 255;
      fullyClosed |= state.pose.blinkLevel == 4;
    }
    moved |= state.pose.index > 0;
  }
  assert(peeked && blended && fullyClosed && moved);
  until(motion, [](const auto& state) { return state.mode == Mode::Idle; }, dt);
  assert(motion.state().pose.index == 0 && motion.state().pose.blinkLevel == 0);

  const int partialIdleTicks = static_cast<int>(CharacterMotion::kIdleBeforeSleepSeconds / (2 * dt));
  for (int tick = 0; tick < partialIdleTicks; ++tick) step(motion, dt);
  assert(motion.setMode(Mode::Working));
  until(motion, [](const auto& state) { return state.mode == Mode::Working; }, dt);
  assert(motion.setMode(Mode::Idle));
  until(motion, [](const auto& state) { return state.mode == Mode::Idle; }, dt);
  for (int tick = 0; tick < partialIdleTicks; ++tick) step(motion, dt);
  assert(motion.state().mode == Mode::Idle);
}

static void springSurprise() {
  for (int fps : {30, 60, 120}) {
    for (Mode resume : {Mode::Idle, Mode::Working, Mode::Attention}) {
      for (uint32_t seed = 1; seed <= 8; ++seed) {
        CharacterMotion motion(seed * 0x9e3779b9u, 13);
        assert(motion.setMode(resume));
        if (resume != Mode::Idle)
          until(motion, [&](const auto& s) { return s.mode == resume && s.pose.index >= 7; });
        motion.surprise();
        until(motion, [](const auto& s) { return s.mode == Mode::Surprise; }, 1.0 / fps);
        const uint32_t event = motion.state().eventId;
        std::array<bool, 24> visited{};
        int tick = 0;
        noAllocations = true;
        while (motion.state().mode == Mode::Surprise) {
          assert(tick < .85 * fps);
          const auto before = motion.state();
          visited[before.pose.index] = true;
          step(motion, 1.0 / fps);
          const auto state = motion.state();
          assert(state.eventId == event);
          if (state.mode == Mode::Surprise) {
            assert(state.requestedMode == Mode::Surprise && state.pose.blinkLevel == 0);
            assert(state.pose.direction == 8 && state.pose.index >= before.pose.index);
          }
          ++tick;
        }
        noAllocations = false;
        assert(std::all_of(visited.begin(), visited.end(), [](bool value) { return value; }));
        assert(tick >= 24);
        assert(motion.state().mode == resume && motion.state().requestedMode == resume);
      }
    }
    CharacterMotion tapped(42, 13);
    assert(tapped.setMode(Mode::Attention));
    until(tapped, [](const auto& s) { return s.mode == Mode::Attention && s.pose.index == 23; });
    tapped.surpriseToIdle();
    until(tapped, [](const auto& s) { return s.mode == Mode::Surprise; });
    until(tapped, [](const auto& s) { return s.mode == Mode::Idle; });
    assert(tapped.state().requestedMode == Mode::Idle);
  }
    for (int index : {0, 1, 4, 8, 16, 22, 23}) {
      for (Mode next : {Mode::Idle, Mode::Surprise, Mode::Working, Mode::Complete, Mode::Attention}) {
        CharacterMotion motion(42, 13);
        motion.surprise();
        until(motion, [&](const auto& s) {
          return s.mode == Mode::Surprise && s.pose.direction == 8 && s.pose.index == index;
        });
        assert(motion.setMode(next));
        do {
          const auto before = motion.state();
          step(motion);
          const auto after = motion.state();
          if (before.pose.index != 23) assert(after.pose.index >= before.pose.index);
        } while (motion.state().mode == Mode::Surprise && motion.state().pose.index != 0);
        until(motion, [&](const auto& s) {
          return s.mode == next && s.pose.index == 0
              && (next == Mode::Idle || s.pose.direction == 7 + unsigned(next));
        });
    }
  }
}

static void effectRestoration() {
  constexpr size_t pixels = kCharacterFrameWidth * kCharacterFrameHeight;
  std::vector<uint16_t> first(pixels + 2), second(pixels + 2), baseline(pixels);
  first.front() = first.back() = second.front() = second.back() = 0xbeef;
  for (size_t i = 0; i < pixels; ++i) {
    // Artwork includes bright body pixels and a completely black facial interior.
    const int x = static_cast<int>(i % kCharacterFrameWidth) - kCharacterArtX, y = i / kCharacterFrameWidth;
    baseline[i] = (x > 80 && x < 320 && y > 90 && y < 330 && !(x > 160 && x < 240 && y < 220))
        ? 0xabcd : (i % 97 == 0 ? 0x1234 : 0);
  }
  std::copy(baseline.begin(), baseline.end(), first.begin() + 1);
  std::copy(baseline.begin(), baseline.end(), second.begin() + 1);
  auto effects = std::make_unique<CharacterEffects>(first.data() + 1, second.data() + 1);
  CharacterState state{};
  bool sawEffect = false;
  noAllocations = true;
  for (int tick = 0; tick < 1500; ++tick) {
    uint16_t* frame = (tick % 2 ? first.data() : second.data()) + 1;
    assert(effects->restore(frame));
    assert(std::equal(baseline.begin(), baseline.end(), frame));
    state.mode = static_cast<Mode>((tick / 300) % 5);
    state.requestedMode = state.mode;
    state.effectSeconds = float(tick % 90) / 30;
    state.eventId = 77;
    assert(effects->render(state, frame));
    size_t damage = 0;
    for (size_t i = 0; i < pixels; ++i) {
      if (baseline[i]) assert(frame[i] == baseline[i]);
      if (frame[i] != baseline[i]) ++damage;
    }
    assert(damage <= CharacterEffects::kDamageBudget);
    assert(frame[176 * kCharacterFrameWidth + 200 + kCharacterArtX] == 0);
    sawEffect |= damage > 0;
    assert(first.front() == 0xbeef && first.back() == 0xbeef);
    assert(second.front() == 0xbeef && second.back() == 0xbeef);
  }
  noAllocations = false;
  assert(sawEffect);
  for (uint16_t* frame : {first.data() + 1, second.data() + 1}) {
    assert(effects->restore(frame));
    assert(std::equal(baseline.begin(), baseline.end(), frame));
  }
  assert(!effects->restore(nullptr) && effects->error());
  assert(!effects->render(state, baseline.data()) && effects->error());
  state.effectSeconds = std::numeric_limits<float>::quiet_NaN();
  assert(!effects->render(state, first.data() + 1) && effects->error());
  state.effectSeconds = 0;
  state.mode = state.requestedMode = Mode::Attention;
  state.pose.direction = 12;
  assert(effects->render(state, first.data() + 1));
  const auto* bytes = reinterpret_cast<const uint8_t*>(first.data() + 1);
  const size_t amber = ((44 + kFrameY) * kCharacterFrameWidth + 344 + kCharacterArtX) * 2;
  assert(bytes[amber] == 0xc4 && bytes[amber + 1] == 0xa8);
  assert(!effects->render(state, first.data() + 1) && effects->error());
  assert(effects->restore(first.data() + 1));
  state.mode = state.requestedMode = Mode::Sleep;
  state.pose = {0, 0, 4};
  state.effectSeconds = 1;
  assert(effects->render(state, first.data() + 1));
  size_t sleepDamage = 0;
  for (size_t i = 0; i < pixels; ++i) sleepDamage += first[i + 1] != baseline[i];
  assert(sleepDamage > 0 && sleepDamage <= CharacterEffects::kDamageBudget);
  assert(effects->restore(first.data() + 1));
  state.pose.direction = 13;
  assert(!effects->render(state, first.data() + 1) && effects->error());
  state.pose.direction = 12;
  for (Mode mode : {Mode::Working, Mode::Attention}) {
    state.mode = state.requestedMode = mode;
    state.effectSeconds = 0;
    assert(effects->render(state, first.data() + 1));
    state.effectSeconds = 12;
    assert(effects->render(state, second.data() + 1));
    assert(std::equal(first.begin(), first.end(), second.begin()));
    assert(effects->restore(first.data() + 1) && effects->restore(second.data() + 1));
  }
  CharacterEffects invalid(first.data(), first.data());
  assert(!invalid.restore(first.data()));
}

static void agentBadgeLayoutAndRestoration() {
  const auto mask = std::string(96, '/');
  AgentBadges badges;
  for (const char* id : {"copilot", "claude", "codex", "grok"}) {
    const std::string packet = std::string(id) + ":6F7CFF:" + mask;
    assert(badges.setIconPacket(packet.c_str()));
  }
  const std::string badPacket = std::string("Bad:6F7CFF:") + mask;
  assert(!badges.setIconPacket(badPacket.c_str()));
  assert(!badges.setActivePacket("copilot=w,claude=x"));
  // Attention badges start opposite the "?" and fan out without leaving the round display.
  const auto attentionStart = CharacterEffects::badgeAnchor(Mode::Attention, AgentBadgeRole::Attention, 0, 4, 0);
  // Opposite the "?" (-141 degrees), 200 px from the display center.
  assert(std::abs(attentionStart.x - 45) <= 1 && std::abs(attentionStart.y - 50) <= 1);
  for (int i = 0; i < 4; ++i) {
    const auto point = CharacterEffects::badgeAnchor(Mode::Attention, AgentBadgeRole::Attention, i, 4, 0);
    const int dx = point.x + kCharacterFrameX + kCharacterArtX - kDisplaySize / 2;
    const int dy = point.y + kFrameY - kDisplaySize / 2;
    assert(point.visible && dx * dx + dy * dy <= (kDisplaySize / 2 - 21) * (kDisplaySize / 2 - 21));
    for (int j = 0; j < i; ++j) {
      const auto other = CharacterEffects::badgeAnchor(Mode::Attention, AgentBadgeRole::Attention, j, 4, 0);
      assert((point.x - other.x) * (point.x - other.x) + (point.y - other.y) * (point.y - other.y) >= 44 * 44);
    }
  }
  // The lead badge replaces the head of the orbiting dot trail at every point of the lap.
  for (double seconds = 0; seconds < 12; seconds += .25) {
    const auto lead = CharacterEffects::badgeAnchor(Mode::Working, AgentBadgeRole::Working, 0, 1, seconds);
    const double angle = seconds * 3.14159265358979323846 / 6 + 6 * .16;
    const int headX = kFrameWidth / 2 + int(std::lround(186 * std::cos(angle)));
    const int headY = kFrameHeight / 2 + int(std::lround(186 * std::sin(angle)));
    assert(lead.x == headX && lead.y == headY);
    assert(lead.x - 19 + kCharacterArtX >= 0 && lead.x + 19 + kCharacterArtX < kCharacterFrameWidth);
  }
  for (int count = 1; count <= 4; ++count) {
    std::vector<AgentBadgePoint> points;
    for (int i = 0; i < count; ++i) {
      const auto point = CharacterEffects::badgeAnchor(Mode::Working, AgentBadgeRole::Working, i, count, 0);
      assert(point.visible);
      const int dx = point.x - kFrameWidth / 2, dy = point.y - kFrameHeight / 2;
      // Badges ride the dot orbit on a true circle that fits entirely inside the frame.
      const long radius = std::lround(std::sqrt(dx * dx + dy * dy));
      assert(std::abs(radius - 186) <= 1);
      assert(point.x - 19 + kCharacterArtX >= 0 && point.x + 19 + kCharacterArtX < kCharacterFrameWidth);
      for (const auto& previous : points) {
        const int pdx = point.x - previous.x, pdy = point.y - previous.y;
        assert(pdx * pdx + pdy * pdy > 60 * 60);
      }
      points.push_back(point);
    }
  }

  constexpr size_t pixels = kCharacterFrameWidth * kCharacterFrameHeight;
  std::vector<uint16_t> first(pixels + 2), second(pixels + 2), baseline(pixels);
  first.front() = first.back() = second.front() = second.back() = 0xbeef;
  std::copy(baseline.begin(), baseline.end(), first.begin() + 1);
  std::copy(baseline.begin(), baseline.end(), second.begin() + 1);
  CharacterEffects effects(first.data() + 1, second.data() + 1, &badges);
  CharacterState state{};
  state.requestedMode = state.mode = Mode::Working;
  state.effectSeconds = 0;
  assert(badges.setActivePacket("copilot=w,claude=w,codex=w,grok=w"));
  noAllocations = true;
  assert(effects.restore(first.data() + 1));
  assert(effects.render(state, first.data() + 1));
  noAllocations = false;
  size_t damage = 0;
  for (size_t i = 0; i < pixels; ++i) damage += first[i + 1] != baseline[i];
  assert(damage > 3000 && damage <= CharacterEffects::kDamageBudget);
  assert(first.front() == 0xbeef && first.back() == 0xbeef);
  assert(effects.restore(first.data() + 1));
  assert(std::equal(baseline.begin(), baseline.end(), first.begin() + 1));

  state.requestedMode = state.mode = Mode::Attention;
  assert(badges.setActivePacket("copilot=a"));
  assert(effects.restore(second.data() + 1));
  assert(effects.render(state, second.data() + 1));
  assert(effects.restore(second.data() + 1));
  state.requestedMode = state.mode = Mode::Complete;
  assert(badges.setActivePacket("copilot=c"));
  assert(effects.render(state, second.data() + 1));
  assert(effects.restore(second.data() + 1));

  // With overlay scratch, badges paint over character art and restore it exactly.
  std::vector<uint16_t> art(pixels), overArt(pixels + 2), otherArt(pixels);
  for (size_t i = 0; i < pixels; ++i) art[i] = static_cast<uint16_t>(0x1000 + i % 977);
  overArt.front() = overArt.back() = 0xbeef;
  std::copy(art.begin(), art.end(), overArt.begin() + 1);
  std::copy(art.begin(), art.end(), otherArt.begin());
  std::vector<uint16_t> scratch(CharacterEffects::kOverlayScratchPixels);
  CharacterEffects above(overArt.data() + 1, otherArt.data(), &badges, scratch.data());
  for (Mode mode : {Mode::Working, Mode::Attention, Mode::Complete}) {
    state.requestedMode = state.mode = mode;
    assert(badges.setActivePacket(mode == Mode::Working ? "copilot=w,claude=w,codex=w,grok=w"
                                  : mode == Mode::Attention ? "copilot=a,claude=a,codex=a,grok=a" : "copilot=c"));
    noAllocations = true;
    assert(above.restore(overArt.data() + 1));
    assert(above.render(state, overArt.data() + 1));
    noAllocations = false;
    size_t covered = 0;
    for (size_t i = 0; i < pixels; ++i) covered += overArt[i + 1] != art[i];
    assert(covered > 500);
    assert(overArt.front() == 0xbeef && overArt.back() == 0xbeef);
    assert(above.restore(overArt.data() + 1));
    assert(std::equal(art.begin(), art.end(), overArt.begin() + 1));
  }
}

static void benchmarkEffects() {
  constexpr int frames = 100000;
  std::vector<uint16_t> first(kCharacterFrameWidth * kCharacterFrameHeight), second(first.size());
  auto effects = std::make_unique<CharacterEffects>(first.data(), second.data());
  for (Mode mode : {Mode::Surprise, Mode::Working, Mode::Complete, Mode::Attention}) {
    CharacterState state{};
    state.mode = state.requestedMode = mode;
    state.eventId = 42;
    const auto start = std::chrono::steady_clock::now();
    noAllocations = true;
    for (int i = 0; i < frames; ++i) {
      state.effectSeconds = float(i % 72) / 30;
      auto* frame = i % 2 ? first.data() : second.data();
      assert(effects->restore(frame));
      assert(effects->render(state, frame));
    }
    noAllocations = false;
    const double micros = std::chrono::duration<double, std::micro>(
        std::chrono::steady_clock::now() - start).count() / frames;
    std::cout << "Effects mode " << unsigned(mode) << ": " << micros << " us/frame (host)\n";
  }
  std::cout << "Effects object: " << sizeof(CharacterEffects) << " bytes\n";
}

int main(int argc, char**) {
  if (argc > 1) { benchmarkEffects(); return 0; }
  idleParityAndCentering();
  modesAndInterruptions();
  pauseErrorsAndLongRun();
  blinkSafeExpressionEntry();
  workingLooksStayBusy();
  attentionAlternatesWithoutDismissing();
  sleepsAfterSustainedIdleAndWakes();
  springSurprise();
  effectRestoration();
  agentBadgeLayoutAndRestoration();
  std::cout << "Character tests passed: idle parity; center-only handoffs; all modes/interruptions; "
               "sleep cycle; pause/stalls; allocation-free updates; dual-buffer effects/canaries/body preservation; agent badges\n";
}

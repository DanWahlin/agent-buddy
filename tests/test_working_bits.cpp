#include "../firmware/AgentCompanion/src/CharacterEffects.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>
#include <utility>

using namespace copilot;
namespace {
constexpr size_t kPixels = kCharacterFrameWidth * kCharacterFrameHeight;
std::array<uint16_t, kPixels + 2> first{}, second{};
bool forbidAllocations = false;
constexpr uint8_t zero[] = {14, 17, 17, 17, 17, 17, 17, 17, 14};
constexpr uint8_t one[] = {4, 12, 4, 4, 4, 4, 4, 4, 14};
}

void* operator new(size_t size) {
  assert(!forbidAllocations);
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
#if defined(__cpp_sized_deallocation)
void operator delete(void* p, size_t) noexcept { std::free(p); }
void operator delete[](void* p, size_t) noexcept { std::free(p); }
#endif

namespace {
CharacterState working(float seconds, uint8_t direction = 9, uint8_t index = 23) {
  return {{direction, index, 0}, CharacterMode::Working, CharacterMode::Working, seconds, 42};
}

CharacterState sleeping(float seconds) {
  return {{0, 0, 4}, CharacterMode::Sleep, CharacterMode::Sleep, seconds, 42};
}

void draw(CharacterEffects& effects, CharacterState state, uint16_t* frame) {
  assert(effects.restore(frame));
  assert(effects.render(state, frame));
  assert(!effects.error());
}

void glyph(const uint16_t* frame, int x, int y, const uint8_t* rows) {
  x += kCharacterArtX;
  for (int row = 0; row < 9; ++row) {
    for (int column = 0; column < 5; ++column) {
      if (bool(frame[(y + row) * kCharacterFrameWidth + x + column])
          != bool(rows[row] & (1 << (4 - column)))) {
        std::cerr << "Glyph mismatch at " << x << ',' << y << " cell " << column << ',' << row << '\n';
        assert(false);
      }
    }
  }
}

uint64_t checksum(const uint16_t* frame) {
  uint64_t result = 14695981039346656037ull;
  for (size_t i = 0; i < kFrameWidth * kFrameHeight; ++i) {
    result ^= frame[(kFrameY + i / kFrameWidth) * kCharacterFrameWidth + kCharacterArtX + i % kFrameWidth];
    result *= 1099511628211ull;
  }
  return result;
}

void otherModes(bool print) {
  constexpr uint64_t expected[] = {
    10789368490682096421ull, 10789368490682096421ull, 10789368490682096421ull,
    10789368490682096421ull, 10789368490682096421ull, 10165471195723006773ull,
    2875214265913098837ull, 10789368490682096421ull, 10789368490682096421ull,
    10789368490682096421ull, 10789368490682096421ull, 3143469265638171115ull,
    9483303231247693677ull, 2634939458136737533ull, 10789368490682096421ull,
    14108009930531596155ull, 14367857870770044755ull, 1713394645811753611ull,
    14367857870770044755ull, 14108009930531596155ull,
  };
  first.fill(0);
  second.fill(0);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  size_t sample = 0;
  for (CharacterMode mode : {CharacterMode::Idle, CharacterMode::Surprise,
                              CharacterMode::Complete, CharacterMode::Attention}) {
    for (float seconds : {0.f, .3f, .9f, 1.7f, 11.999f}) {
      CharacterState state{{0, 0, 0}, mode, mode, seconds, 42};
      draw(effects, state, first.data() + 1);
      if (print) std::cout << checksum(first.data() + 1) << "ull,\n";
      else assert(checksum(first.data() + 1) == expected[sample]);
      ++sample;
    }
  }
}

void visibleShapesAndDirection() {
  first.fill(0);
  second.fill(0);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  draw(effects, working(1.f), first.data() + 1);
  // Two independent incoming digits, and a zero travelling in the opposite direction.
  glyph(first.data() + 1, 176, 16, zero);
  glyph(first.data() + 1, 176, 66, one);
  glyph(first.data() + 1, 210, 41, zero);
  glyph(first.data() + 1, 222, 28, one);
  draw(effects, working(1.2f), second.data() + 1);
  glyph(second.data() + 1, 176, 21, zero);
  glyph(second.data() + 1, 176, 71, one);
  glyph(second.data() + 1, 210, 36, zero);
  glyph(second.data() + 1, 222, 23, one);
  auto brightness = [&](float seconds, int y) {
    draw(effects, working(seconds), first.data() + 1);
    const uint16_t stored = first[1 + y * kCharacterFrameWidth + 176 + kCharacterArtX];
    const uint16_t rgb = static_cast<uint16_t>((stored << 8) | (stored >> 8));
    return (rgb >> 11) + ((rgb >> 5) & 63) + (rgb & 31);
  };
  const int entering = brightness(.4f, 3), middle = brightness(1.f, 18);
  const int leaving = brightness(3.8f, 88);
  assert(entering == middle && leaving > 0 && leaving < middle);
  for (const auto& sample : {std::pair<float, int>{.2f, 176}, {2.8f, 210}}) {
    draw(effects, working(sample.first), first.data() + 1);
    bool reachesEdge = false;
    for (int x = sample.second; x < sample.second + 5; ++x)
      reachesEdge |= first[1 + x + kCharacterArtX] != 0;
    assert(reachesEdge);
  }
}

void continuityAndPoseIndependence() {
  first.fill(0);
  second.fill(0);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  for (uint8_t direction : {0, 1, 9}) {
    for (uint8_t index : {0, 4, 12, 21, 23}) {
      draw(effects, working(2.25f), first.data() + 1);
      draw(effects, working(2.25f, direction, index), second.data() + 1);
      assert(first == second);
    }
  }
  draw(effects, working(0), first.data() + 1);
  draw(effects, working(12), second.data() + 1);
  assert(first == second);
  for (int tick = 0; tick < 360; ++tick) {
    draw(effects, working(tick / 30.f), first.data() + 1);
    for (int y = 330 + kFrameY; y <= 335 + kFrameY; ++y)
      for (int x = 177; x <= 223; ++x)
        assert(first[1 + y * kCharacterFrameWidth + x + kCharacterArtX] == 0);
  }
  // During an interior transit, each digit's top moves by at most one raster row
  // per refresh, without changing the glyph's zero/one identity.
  int priorTop = -1;
  for (int tick = 90; tick <= 150; ++tick) {
    draw(effects, working(tick / 120.f), first.data() + 1);
    int top = -1;
    for (int y = 0; y <= 40; ++y) {
      if (first[1 + y * kCharacterFrameWidth + 177 + kCharacterArtX]) { top = y; break; }
    }
    assert(top >= 0);
    if (priorTop >= 0) assert(top >= priorTop && top - priorTop <= 1);
    glyph(first.data() + 1, 176, top, zero);
    priorTop = top;
  }
  // The wrapping particle is entirely dark on both sides of its teleport.
  for (float seconds : {3.9999f, 4.f, 4.0001f}) {
    draw(effects, working(seconds), first.data() + 1);
    for (int x = 176; x < 181; ++x) {
      for (int y = 0; y <= 5; ++y) assert(first[1 + y * kCharacterFrameWidth + x + kCharacterArtX] == 0);
      for (int y = 91; y <= 97; ++y) assert(first[1 + y * kCharacterFrameWidth + x + kCharacterArtX] == 0);
    }
  }
}

void circularOrbitHasClearance() {
  first.fill(0);
  second.fill(0);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  constexpr uint16_t leadingColor = 0x5c4e;
  double minX = kCharacterFrameWidth, maxX = 0, minY = kCharacterFrameHeight, maxY = 0;
  for (int tick = 0; tick < 360; ++tick) {
    draw(effects, working(tick / 30.f), first.data() + 1);
    double x = 0, y = 0;
    int count = 0;
    for (size_t pixel = 0; pixel < kPixels; ++pixel) {
      if (first[pixel + 1] != leadingColor) continue;
      x += pixel % kCharacterFrameWidth;
      y += pixel / kCharacterFrameWidth;
      ++count;
    }
    assert(count == 81);  // The leading five-pixel-radius ball is never clipped.
    x /= count;
    y /= count;
    assert(std::abs(std::hypot(x - kCharacterFrameWidth / 2, y - 233) - 200) < .8);
    minX = std::min(minX, x); maxX = std::max(maxX, x);
    minY = std::min(minY, y); maxY = std::max(maxY, y);
  }
  assert(maxX-minX == 400 && maxY-minY == 400);
}

void sleepingZsAlternateSides() {
  first.fill(0);
  second.fill(0);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  bool left = false, right = false;
  for (int tick = 0; tick < 30 * 30; ++tick) {
    draw(effects, sleeping(std::fmod(tick / 30.f, 12.f)), first.data() + 1);
    for (int y = 0; y < 80; ++y) {
      for (int x = 0; x < kCharacterFrameWidth; ++x) {
        if (!first[1 + y * kCharacterFrameWidth + x]) continue;
        left |= x < kCharacterFrameWidth / 2;
        right |= x > kCharacterFrameWidth / 2;
      }
    }
  }
  assert(left && right);
}

void protectionRestorationAndBudget() {
  static_assert(CharacterEffects::kDamageBudget == 4096);
  static_assert(sizeof(CharacterEffects) <= 2 * CharacterEffects::kDamageBudget * sizeof(uint32_t) + 64);
  std::array<uint16_t, kPixels> original{};
  for (size_t i = 0; i < kPixels; ++i) {
    const int x = i % kCharacterFrameWidth, y = i / kCharacterFrameWidth;
    original[i] = i % 97 == 0 || (x > 75 && x < 325 && y > 65 && y < 310
        && !(x > 150 && x < 250 && y > 120 && y < 230)) ? 0xa5a5 : 0;
  }
  first.front() = first.back() = second.front() = second.back() = 0xbeef;
  std::copy(original.begin(), original.end(), first.begin() + 1);
  std::copy(original.begin(), original.end(), second.begin() + 1);
  CharacterEffects effects(first.data() + 1, second.data() + 1);
  size_t mostDamage = 0;
  forbidAllocations = true;
  for (int tick = 0; tick < 1440; ++tick) {
    uint16_t* frame = (tick % 2 ? first.data() : second.data()) + 1;
    assert(effects.restore(frame));
    assert(std::equal(original.begin(), original.end(), frame));
    assert(effects.render(working((tick % 1440) / 120.f, tick % 3 == 0 ? 9 : tick % 2,
                                  tick % 24), frame));
    size_t changed = 0, aboveHead = 0;
    for (size_t i = 0; i < kPixels; ++i) {
      if (original[i]) assert(frame[i] == original[i]);
      if (frame[i] == original[i]) continue;
      const int x = i % kCharacterFrameWidth, y = i / kCharacterFrameWidth;
      const int dx = x - kCharacterFrameWidth / 2, dy = y - kDisplaySize / 2;
      assert(int64_t(dx) * dx * 135 * 135 + int64_t(dy) * dy * 160 * 160
          >= int64_t(160) * 160 * 135 * 135);
      ++changed;
      aboveHead += y < kFrameY + 41 && x >= 176 + kCharacterArtX && x <= 225 + kCharacterArtX;
    }
    assert(aboveHead > 0);
    assert(changed <= CharacterEffects::kDamageBudget);
    mostDamage = std::max(mostDamage, changed);
    assert(first.front() == 0xbeef && first.back() == 0xbeef
        && second.front() == 0xbeef && second.back() == 0xbeef);
  }
  forbidAllocations = false;
  for (auto* frame : {first.data() + 1, second.data() + 1}) {
    assert(effects.restore(frame));
    assert(std::equal(original.begin(), original.end(), frame));
  }
  std::cout << "Working bits: maximum damage " << mostDamage << " / "
            << CharacterEffects::kDamageBudget << " pixels; object " << sizeof(CharacterEffects) << " bytes\n";
}
}

int main(int argc, char**) {
  if (argc > 1) { otherModes(true); return 0; }
  otherModes(false);
  visibleShapesAndDirection();
  continuityAndPoseIndependence();
  circularOrbitHasClearance();
  sleepingZsAlternateSides();
  protectionRestorationAndBudget();
  std::cout << "Character effects: working bits and alternating sleeping Zs; opposing motion, "
               "wrap/pose continuity, body protection, restoration, canaries and allocation guard passed\n";
}

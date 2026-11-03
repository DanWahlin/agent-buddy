#include "../firmware/AgentCompanion/src/CharacterScaler.h"
#include "../firmware/AgentCompanion/src/CharacterEffects.h"
#include "../firmware/AgentCompanion/src/SpriteStorage.h"
#include "../tools/HostSpriteInflate.h"
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <random>
#include <vector>

extern "C" const uint8_t kCopilotPack[], kCopilotPackEnd[];

using namespace copilot;
namespace {
constexpr size_t kFramePixels = static_cast<size_t>(kCharacterFrameWidth) * kCharacterFrameHeight;
constexpr int kVisibleLeft = std::max(kCharacterFrameX, -kPanelContentX);
constexpr int kVisibleRight = std::min(kCharacterFrameX + kCharacterFrameWidth, kPanelWidth - kPanelContentX);

// As the firmware inflates into the art (inflatePose): pixels that didn't change aren't written,
// and the scaler hears which rows did change.
std::vector<uint16_t>* artBuffer = nullptr;
CharacterScaler* artScaler = nullptr;
SpriteRowChange rowChanges[CharacterScaler::kArtHeight];
bool inflate(uint8_t* output, size_t size, const uint8_t* input, size_t compressed, size_t width, size_t stride) {
  const auto* art = reinterpret_cast<const uint8_t*>(artBuffer->data());
  const bool skip = output >= art && output < art + artBuffer->size() * sizeof(uint16_t);
  if (!inflateSpriteHostChanges(output, size, input, compressed, width, stride, skip ? rowChanges : nullptr))
    return false;
  if (skip) {
    const size_t offset = (output - art) / sizeof(uint16_t);
    const int x = int(offset % CharacterScaler::kArtWidth), y = int(offset / CharacterScaler::kArtWidth);
    for (size_t row = 0; row < size / 2 / width; ++row)
      artScaler->changed(y + int(row), x + rowChanges[row].begin, x + rowChanges[row].end);
  }
  return true;
}

uint16_t swapped(uint16_t rgb) { return static_cast<uint16_t>((rgb >> 8) | (rgb << 8)); }

// A frame with a guard word on each side.
struct Guarded {
  std::vector<uint16_t> pixels = std::vector<uint16_t>(kFramePixels + 2, 0);
  Guarded() { pixels.front() = pixels.back() = 0xa55a; }
  uint16_t* data() { return pixels.data() + 1; }
  bool intact() const { return pixels.front() == 0xa55a && pixels.back() == 0xa55a; }
  bool operator==(const Guarded& other) const { return pixels == other.pixels; }
};

// The frame as a fresh scaler draws the whole art into a black frame.
Guarded reference(const CharacterPlacement& placement, const uint16_t* art) {
  Guarded frame;
  auto scaler = std::make_unique<CharacterScaler>(placement);
  scaler->draw(art, frame.data(), 0);
  return frame;
}

// Content column and row where an art pixel's center lands.
double placedX(const CharacterPlacement& placement, double x) {
  return kCharacterFrameWidth / 2.0 + placement.scale * (x + .5 - kCharacterFrameWidth / 2.0);
}
double placedY(const CharacterPlacement& placement, double y) {
  return kDisplaySize / 2.0 + placement.offsetY + placement.scale * (y + .5 - kFrameHeight / 2.0);
}

void placements() {
  struct Bounds {
    const char* name;
    int x, y, width, height;
  };
  // Base bounds of the built-in and some custom packs (header baseX, baseY, baseWidth, baseHeight).
  constexpr Bounds packs[] = {
    {"copilot", 32, 23, 348, 304}, {"claude", 50, 11, 312, 332}, {"grok", 53, 9, 306, 319},
    {"santa", 80, 4, 277, 315}, {"dog", 58, 0, 296, 340}, {"ghost", 75, 23, 241, 306},
    {"small", 180, 150, 40, 40},
  };
  // A full-frame pack's art can fill its whole frame, so it never grows.
  assert(!fitCharacter(0, 0, kCharacterFrameWidth, kFrameHeight).scaled());
  assert(!fitCharacter(0, 0, 0, 0).scaled());
  for (const Bounds& pack : packs) {
    const CharacterPlacement placement = fitCharacter(pack.x, pack.y, pack.width, pack.height);
    if (kCharacterMaxScale == 1) {
      assert(!placement.scaled());
      continue;
    }
    assert(placement.scale > 1 && placement.scale <= kCharacterMaxScale);
    // The scaled bounds stay on the panel and above the usage lines (to under a pixel).
    const double left = placedX(placement, pack.x - .5) + kCharacterFrameX;
    const double right = placedX(placement, pack.x + pack.width - .5) + kCharacterFrameX;
    const double top = placedY(placement, pack.y - .5), bottom = placedY(placement, pack.y + pack.height - .5);
    assert(left >= kVisibleLeft - 1e-6 && right <= kVisibleRight + 1e-6);
    assert(top > kCharacterTop - 1 && bottom <= kCharacterBottom + 1e-6);
    // As big as one of the limits allows.
    const bool limited = placement.scale == kCharacterMaxScale || left < kVisibleLeft + 1
        || right > kVisibleRight - 1 || bottom - top > kCharacterBottom - kCharacterTop - 1;
    assert(limited);
    std::cout << "  " << pack.name << ": scale " << placement.scale << ", offset " << placement.offsetY << '\n';
  }
  if (kCharacterMaxScale > 1) {
    // Santa grows about 1.29 times, as tall as fits above the usage lines.
    const CharacterPlacement santa = fitCharacter(80, 4, 277, 315);
    assert(std::fabs(santa.scale - 406.0 / 315) < 1e-4 && santa.offsetY == -12);
    // Copilot's widest poses use most of the frame, so it grows only as much as the panel is wide.
    const CharacterPlacement copilot = fitCharacter(32, 23, 348, 304);
    assert(std::fabs(copilot.scale - 205.0 / 174) < 1e-4);
  }
}

void identityScale() {
  std::vector<uint16_t> art(CharacterScaler::kArtPixels);
  std::mt19937 random(7);
  for (auto& pixel : art) pixel = static_cast<uint16_t>(random());
  const Guarded frame = reference({}, art.data());
  assert(frame.intact());
  for (int y = 0; y < kCharacterFrameHeight; ++y) {
    for (int x = 0; x < kCharacterFrameWidth; ++x) {
      const uint16_t pixel = frame.pixels[1 + y * kCharacterFrameWidth + x];
      const int row = y - kFrameY;
      assert(pixel == (row >= 0 && row < kFrameHeight ? art[row * kCharacterFrameWidth + x] : 0));
    }
  }
}

void blackAndSolid(const CharacterPlacement& placement) {
  std::vector<uint16_t> art(CharacterScaler::kArtPixels, 0);
  Guarded black = reference(placement, art.data());
  for (size_t i = 1; i <= kFramePixels; ++i) assert(black.pixels[i] == 0);
  // A solid block: inside it the color is exact, and only pixels next to it are not black, so a tap
  // on a frame pixel that isn't black is a tap on the art.
  const uint16_t color = swapped(0xA2C5);
  constexpr int x0 = 150, y0 = 100, x1 = 250, y1 = 200;
  for (int y = y0; y < y1; ++y)
    for (int x = x0; x < x1; ++x) art[y * kCharacterFrameWidth + x] = color;
  const Guarded frame = reference(placement, art.data());
  assert(frame.intact());
  const double left = placedX(placement, x0 - .5), right = placedX(placement, x1 - .5);
  const double top = placedY(placement, y0 - .5), bottom = placedY(placement, y1 - .5);
  for (int y = 0; y < kCharacterFrameHeight; ++y) {
    for (int x = 0; x < kCharacterFrameWidth; ++x) {
      const uint16_t pixel = frame.pixels[1 + y * kCharacterFrameWidth + x];
      const bool inside = x + .5 >= left + 1 && x + .5 <= right - 1 && y + .5 >= top + 1 && y + .5 <= bottom - 1;
      const bool near = x + .5 > left - 1 && x + .5 < right + 1 && y + .5 > top - 1 && y + .5 < bottom + 1;
      if (inside) assert(pixel == color);
      if (!near) assert(pixel == 0);
    }
  }
  // Every art pixel's center lands on a frame pixel that shows it.
  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) {
      const int frameX = static_cast<int>(placedX(placement, x)), frameY = static_cast<int>(placedY(placement, y));
      if (frameY >= 0 && frameY < kCharacterFrameHeight)
        assert(frame.pixels[1 + frameY * kCharacterFrameWidth + frameX] != 0);
    }
  }
}

// Only what changed is drawn again, and each frame catches up with every change it missed.
void incremental(const CharacterPlacement& placement) {
  std::vector<uint16_t> art(CharacterScaler::kArtPixels);
  std::mt19937 random(11);
  for (auto& pixel : art) pixel = static_cast<uint16_t>(random());
  auto scaler = std::make_unique<CharacterScaler>(placement);
  Guarded frames[2];
  for (int index : {0, 1}) {
    assert(!scaler->upToDate(index) && scaler->pendingPixels(index) == CharacterScaler::kArtPixels);
    scaler->draw(art.data(), frames[index].data(), index);
    assert(scaler->upToDate(index) && scaler->pendingPixels(index) == 0);
  }
  for (int index : {0, 1}) assert(frames[index] == reference(placement, art.data()));
  // Overlapping changes in a row count once.
  scaler->changed(10, 5, 20);
  scaler->changed(10, 15, 30);
  scaler->changed({100, 20, 4, 3});
  for (int index : {0, 1}) assert(!scaler->upToDate(index) && scaler->pendingPixels(index) == 25 + 12);
  for (int step = 0; step < 40; ++step) {
    const int width = 1 + random() % 120, height = 1 + random() % 120;
    const int x = static_cast<int>(random() % (CharacterScaler::kArtWidth - width + 1));
    const int y = static_cast<int>(random() % (CharacterScaler::kArtHeight - height + 1));
    for (int row = y; row < y + height; ++row)
      for (int column = x; column < x + width; ++column)
        art[row * CharacterScaler::kArtWidth + column] = static_cast<uint16_t>(random());
    // Areas may reach outside the art; the scaler clips them.
    const int extra = step % 3 == 0 ? 5 : 0;
    scaler->changed({x - extra, y, width + extra, height + (step % 5 == 0 ? 400 : 0)});
    // Sometimes a frame misses a change and catches up later.
    const int index = step % 2;
    if (step % 7 == 3) continue;
    scaler->draw(art.data(), frames[index].data(), index);
    assert(frames[index] == reference(placement, art.data()));
    scaler->draw(art.data(), frames[index].data(), index);
    assert(frames[index] == reference(placement, art.data()));
  }
  scaler->changed({});
  scaler->changed({-50, -50, 10, 10});
  for (int index : {0, 1}) {
    scaler->draw(art.data(), frames[index].data(), index);
    assert(frames[index] == reference(placement, art.data()) && frames[index].intact());
  }
}

// The firmware's path: a single-output patch renderer draws into the art, and the scaler keeps
// both frames equal to the whole art drawn again.
void withRenderer(const CharacterPlacement& placement) {
  const CharacterPack& pack = *characterPack();
  const size_t patchPixels = pack.header.maxPatchPixels;
  std::vector<uint16_t> firstOpen(patchPixels), secondOpen(patchPixels), patch(patchPixels);
  std::vector<uint16_t> art(CharacterScaler::kArtPixels, 0);
  auto scaler = std::make_unique<CharacterScaler>(placement);
  artBuffer = &art;
  artScaler = scaler.get();
  SpriteRenderer renderer(firstOpen.data(), secondOpen.data(), patch.data(), patchPixels, art.data(), nullptr,
                          inflate, CharacterScaler::kArtWidth, CharacterScaler::kArtHeight);

  Guarded frames[2];
  std::mt19937 random(5);
  uint8_t direction = 0, index = 0, blink = 0;
  for (int step = 0; step < 160; ++step) {
    switch (random() % 4) {
      case 0: index = static_cast<uint8_t>(random() % kSpriteTrackSteps[direction]); break;
      case 1:
        direction = static_cast<uint8_t>(random() % kSpriteDirections);
        index = static_cast<uint8_t>(std::min<int>(index, kSpriteTrackSteps[direction] - 1));
        break;
      case 2: blink = static_cast<uint8_t>(random() % kSpriteBlinkLevels); break;
      default: break;
    }
    const uint8_t blend = blink + 1 < kSpriteBlinkLevels && random() % 3 == 0 ? static_cast<uint8_t>(random()) : 0;
    const std::vector<uint16_t> before = art;
    assert(renderer.render({direction, index, blink, blend}, art.data()));
    // The renderer's changed area covers every pixel that changed, and the eyes are part of it.
    const SpriteArea area = renderer.changed, eyes = renderer.eyes;
    for (size_t i = 0; i < art.size(); ++i) {
      if (art[i] == before[i]) continue;
      const int x = int(i % CharacterScaler::kArtWidth), y = int(i / CharacterScaler::kArtWidth);
      assert(x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height);
    }
    assert(eyes.empty() || (eyes.x >= area.x && eyes.y >= area.y && eyes.x + eyes.width <= area.x + area.width
                            && eyes.y + eyes.height <= area.y + area.height));
    scaler->changed(eyes);
    Guarded& frame = frames[step % 2];
    scaler->draw(art.data(), frame.data(), step % 2);
    assert(frame == reference(placement, art.data()));
  }
  assert(frames[0].intact() && frames[1].intact());
}
}  // namespace

int main() {
  assert(loadCharacterPack(kCopilotPack, kCopilotPackEnd - kCopilotPack));
  assert(initializeSpriteStorage());
  std::cout << "Board " << board::kId << " (largest character scale " << kCharacterMaxScale << ")\n";
  placements();
  identityScale();
  const CharacterPack& pack = *characterPack();
  const CharacterPlacement copilot = fitCharacter(pack.header.baseX, pack.header.baseY,
                                                  pack.header.baseWidth, pack.header.baseHeight);
  for (const CharacterPlacement& placement : {CharacterPlacement{1.2889f, -12}, CharacterPlacement{1.3f, 0},
                                              CharacterPlacement{1.05f, 7}, copilot}) {
    blackAndSolid(placement);
    incremental(placement);
    withRenderer(placement);
  }
  // Effects and badges keep their places; only the art grows. Whole badges (19 pixels from their
  // centers; 22 with the attention ring) stay on a panel that shows the content at full size.
  if (kShownContentSize == kDisplaySize)
  for (CharacterMode mode : {CharacterMode::Working, CharacterMode::Attention, CharacterMode::Complete}) {
    const AgentBadgeRole role = mode == CharacterMode::Attention ? AgentBadgeRole::Attention
        : mode == CharacterMode::Complete ? AgentBadgeRole::Complete : AgentBadgeRole::Working;
    for (int count = 1; count <= 4; ++count) {
      for (int index = 0; index < count; ++index) {
        for (int step = 0; step < 1200; step += 7) {
          const AgentBadgePoint point = CharacterEffects::badgeAnchor(mode, role, index, count, step / 100.0);
          assert(point.visible);
          const int x = point.x + kCharacterFrameX + kCharacterArtX, y = point.y + kFrameY;
          const int reach = role == AgentBadgeRole::Attention ? 22 : 19;
          assert(x - reach >= kVisibleLeft && x + reach <= kVisibleRight);
          assert(y - reach >= std::max(-kPanelContentY, 0) && y + reach <= std::min(kPanelHeight - kPanelContentY, kDisplaySize));
        }
      }
    }
  }
  std::cout << "PASS: character placement, identity, exact solids and black, incremental areas, "
               "renderer path, and badges on the panel\n";
}

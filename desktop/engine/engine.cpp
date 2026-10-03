// The device's animation engine, compiled for the desktop.
//
// Everything that decides what the character looks like - the motion, the
// sprite decoding, the effects and the agent badges - is the firmware's own
// code, compiled unchanged from firmware/AgentCompanion/src. This file only
// owns the frame buffers and calls the same per-frame steps AgentCompanion.ino
// does (CharacterFrame.h: apply a request, step the motion, draw the sprite,
// then the effects). It then turns the device's RGB565 frame into RGBA.
//
// The device draws on black. A desktop window is not black, so a frame can be
// keyed: black that connects to the edge of the display is background, black
// enclosed by the art (inside a face) is kept, and effect pixels, which the
// device blends against black, get their brightness back as alpha.

#include "../../firmware/AgentCompanion/src/AgentBadges.h"
#include "../../firmware/AgentCompanion/src/CharacterEffects.h"
#include "../../firmware/AgentCompanion/src/CharacterFrame.h"
#include "../../firmware/AgentCompanion/src/CharacterMotion.h"
#include "../../firmware/AgentCompanion/src/FullFrameRenderer.h"
#include "../../firmware/AgentCompanion/src/SpriteRenderer.h"
#include "../../firmware/AgentCompanion/src/SpriteStorage.h"
#include "../../tools/HostSpriteInflate.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define AC_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define AC_EXPORT extern "C"
#endif

using namespace copilot;

namespace {
constexpr int kWidth = kCharacterFrameWidth;
constexpr int kHeight = kCharacterFrameHeight;
constexpr int kPixels = kWidth * kHeight;
// A pixel at or below this on its brightest channel can be backdrop.
constexpr int kKeyThreshold = 24;
// The badge disc's fill, color(17, 20, 27) in CharacterEffects.cpp, as the
// byte-swapped RGB565 the frame holds. Drawn opaque on the device, so kept opaque.
constexpr uint16_t kBadgeFillRgb = ((17 >> 3) << 11) | ((20 >> 2) << 5) | (27 >> 3);
constexpr uint16_t kBadgeFill = static_cast<uint16_t>((kBadgeFillRgb << 8) | (kBadgeFillRgb >> 8));

struct Engine {
  std::vector<uint32_t> packWords;
  std::vector<uint16_t> frames[2];
  std::vector<uint16_t> openPatch[2];
  std::vector<uint16_t> patch;
  std::vector<uint16_t> fullFrameScratch;
  std::vector<uint16_t> fullFrameCached;
  std::vector<uint16_t> overlay;
  std::vector<uint16_t> base;
  std::vector<uint8_t> rgba;
  std::vector<uint8_t> background;
  std::vector<float> softened;
  std::vector<int32_t> queue;
  // The last frame shown, to tell whether the next one differs at all.
  std::vector<uint16_t> shown;
  // What changed in the last frame, as x, y, width, height rectangles.
  std::vector<int32_t> dirty;
  // The character-only frame the cut-out was last worked out for.
  std::vector<uint16_t> keyedBase;
  bool keyed = false;
  int shownKey = -1;
  bool changed = true;
  AgentBadges badges;
  std::unique_ptr<SpriteRenderer> renderer;
  std::unique_ptr<FullFrameRenderer> fullFrame;
  std::unique_ptr<CharacterSprite> sprite;
  std::unique_ptr<CharacterEffects> effects;
  std::unique_ptr<CharacterMotion> motion;
  bool useFirst = true;
  bool cleared[2] = {false, false};
  CharacterState state;
};

Engine* engine = nullptr;
const char* lastError = nullptr;
// Where the page writes a pack before loading it, so it is not copied twice.
std::vector<uint32_t> staged;
size_t stagedBytes = 0;

void unpack(uint16_t swapped, uint8_t& r, uint8_t& g, uint8_t& b) {
  const uint16_t rgb = static_cast<uint16_t>((swapped << 8) | (swapped >> 8));
  r = static_cast<uint8_t>(((rgb >> 11) & 31) * 255 / 31);
  g = static_cast<uint8_t>(((rgb >> 5) & 63) * 255 / 63);
  b = static_cast<uint8_t>((rgb & 31) * 255 / 31);
}

// The display is a circle; the character frame sits centred inside it.
bool insideDisplay(int x, int y) {
  const int dx = 2 * (x + kCharacterFrameX) + 1 - kDisplaySize;
  const int dy = 2 * y + 1 - kDisplaySize;
  return dx * dx + dy * dy <= kDisplaySize * kDisplaySize;
}

// Finds the backdrop in the character-only frame: dark pixels reachable from
// outside the art, so dark seams and shadowed interiors survive however dark.
void findBackground(Engine& e) {
  std::fill(e.background.begin(), e.background.end(), 0);
  int head = 0, tail = 0;
  auto push = [&](int index) {
    if (e.background[index]) return;
    uint8_t r, g, b;
    unpack(e.base[index], r, g, b);
    if (std::max({r, g, b}) > kKeyThreshold) return;
    e.background[index] = 1;
    e.queue[tail++] = index;
  };
  for (int y = 0; y < kHeight; ++y) {
    for (int x = 0; x < kWidth; ++x) {
      const int index = y * kWidth + x;
      if (!insideDisplay(x, y)) {
        e.background[index] = 1;
        e.queue[tail++] = index;
      } else if (x == 0 || y == 0 || x == kWidth - 1 || y == kHeight - 1) {
        push(index);
      }
    }
  }
  while (head < tail) {
    const int index = e.queue[head++];
    const int x = index % kWidth, y = index / kWidth;
    if (x > 0) push(index - 1);
    if (x < kWidth - 1) push(index + 1);
    if (y > 0) push(index - kWidth);
    if (y < kHeight - 1) push(index + kWidth);
  }
  // Soften the silhouette by a pixel, as the art is anti-aliased against black.
  // Only backdrop pixels use this, and only those touching the art get more
  // than nothing, so the rest are skipped.
  for (int y = 0; y < kHeight; ++y) {
    for (int x = 0; x < kWidth; ++x) {
      const int index = y * kWidth + x;
      if (!e.background[index]) continue;
      int art = 0, count = 0;
      for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          const int nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= kWidth || ny >= kHeight) continue;
          art += !e.background[ny * kWidth + nx];
          ++count;
        }
      }
      e.softened[index] = static_cast<float>(art) / count;
    }
  }
}

// The frame is converted, compared and uploaded in tiles, so a frame where only
// the orbiting dots moved costs a few tiles rather than the whole frame.
constexpr int kTile = 32;
constexpr int kTilesX = (kWidth + kTile - 1) / kTile;
constexpr int kTilesY = (kHeight + kTile - 1) / kTile;

// One pixel, as premultiplied RGBA: what a canvas composites, so the browser
// does not convert every upload (measured as WebKit's hottest path).
void writePixel(Engine& e, const uint16_t* frame, int x, int y, bool key) {
  const int index = y * kWidth + x;
  uint8_t* out = &e.rgba[index * 4];
  uint8_t r, g, b;
  unpack(frame[index], r, g, b);
  float alpha = insideDisplay(x, y) ? 1.f : 0.f;
  if (key && alpha > 0 && e.background[index]) {
    alpha = e.softened[index];
    if (frame[index] != e.base[index]) {
      // An effect over backdrop. The device blends effects against black,
      // so brightness is coverage: give it back as alpha, at full colour.
      const uint8_t peak = std::max({r, g, b});
      const bool fill = frame[index] == kBadgeFill;
      if (!fill && peak > 0) {
        const float scale = 255.f / peak;
        r = static_cast<uint8_t>(std::min(255.f, r * scale));
        g = static_cast<uint8_t>(std::min(255.f, g * scale));
        b = static_cast<uint8_t>(std::min(255.f, b * scale));
      }
      alpha = std::max(alpha, fill ? 1.f : peak / 255.f);
    }
  }
  const int a = static_cast<int>(std::lround(std::clamp(alpha, 0.f, 1.f) * 255));
  out[0] = static_cast<uint8_t>((r * a + 127) / 255);
  out[1] = static_cast<uint8_t>((g * a + 127) / 255);
  out[2] = static_cast<uint8_t>((b * a + 127) / 255);
  out[3] = static_cast<uint8_t>(a);
}

// Converts the tiles that changed since the last frame shown, and records them
// as rectangles (runs of changed tiles merged along each row) for the page.
void writeRgba(Engine& e, const uint16_t* frame, bool key, bool everything) {
  // The cut-out depends only on the character, not the effects; while the
  // pose holds and only the effects move, the last one still stands.
  if (key && (!e.keyed || std::memcmp(e.base.data(), e.keyedBase.data(), kPixels * sizeof(uint16_t)) != 0)) {
    findBackground(e);
    std::memcpy(e.keyedBase.data(), e.base.data(), kPixels * sizeof(uint16_t));
    e.keyed = true;
    everything = true;  // The rim's alpha may have moved where the pixels did not.
  }
  e.dirty.clear();
  for (int ty = 0; ty < kTilesY; ++ty) {
    const int top = ty * kTile, bottom = std::min(kHeight, top + kTile);
    int runStart = -1;
    for (int tx = 0; tx <= kTilesX; ++tx) {
      bool changed = false;
      if (tx < kTilesX) {
        const int left = tx * kTile, width = std::min(kWidth, left + kTile) - left;
        for (int y = top; y < bottom && !changed; ++y) {
          const size_t offset = static_cast<size_t>(y) * kWidth + left;
          changed = everything
              || std::memcmp(frame + offset, e.shown.data() + offset, width * sizeof(uint16_t)) != 0;
        }
        if (changed) {
          for (int y = top; y < bottom; ++y) {
            const size_t offset = static_cast<size_t>(y) * kWidth + left;
            std::memcpy(e.shown.data() + offset, frame + offset, width * sizeof(uint16_t));
            for (int x = left; x < left + width; ++x) writePixel(e, frame, x, y, key);
          }
        }
      }
      if (changed && runStart < 0) runStart = tx;
      if (!changed && runStart >= 0) {
        const int left = runStart * kTile;
        e.dirty.insert(e.dirty.end(), {left, top, std::min(kWidth, tx * kTile) - left, bottom - top});
        runStart = -1;
      }
    }
  }
}
}  // namespace

AC_EXPORT const char* ac_error() { return lastError ? lastError : ""; }
AC_EXPORT int ac_width() { return kWidth; }
AC_EXPORT int ac_height() { return kHeight; }
AC_EXPORT int ac_display() { return kDisplaySize; }
AC_EXPORT int ac_frame_x() { return kCharacterFrameX; }

namespace {
int bind(std::vector<uint32_t>&& words, size_t size, uint32_t seed) {
  lastError = nullptr;
  auto next = std::make_unique<Engine>();
  next->packWords = std::move(words);
  if (!loadCharacterPack(reinterpret_cast<const uint8_t*>(next->packWords.data()), size)) {
    lastError = spriteStorageError();
    // The previous pack's bytes are still bound to storage; keep showing it.
    if (engine) loadCharacterPack(reinterpret_cast<const uint8_t*>(engine->packWords.data()),
                                  engine->packWords.size() * sizeof(uint32_t));
    return 0;
  }
  const size_t patchPixels = std::max<size_t>(1, characterPack()->header.maxPatchPixels);
  for (auto& frame : next->frames) frame.assign(kPixels, 0);
  for (auto& open : next->openPatch) open.assign(patchPixels, 0);
  next->patch.assign(patchPixels, 0);
  next->fullFrameScratch.assign(kWidth * kFrameHeight, 0);
  next->fullFrameCached.assign(kPixels, 0);
  next->overlay.assign(CharacterEffects::kOverlayScratchPixels, 0);
  next->base.assign(kPixels, 0);
  next->rgba.assign(kPixels * 4, 0);
  next->background.assign(kPixels, 0);
  next->softened.assign(kPixels, 0);
  next->queue.assign(kPixels, 0);
  next->shown.assign(kPixels, 0);
  next->dirty.reserve(kTilesX * kTilesY * 4);
  next->keyedBase.assign(kPixels, 0);
  next->renderer = std::make_unique<SpriteRenderer>(
      next->openPatch[0].data(), next->openPatch[1].data(), next->patch.data(), patchPixels,
      next->frames[0].data(), next->frames[1].data(), inflateSpriteHost, kWidth, kHeight);
  next->fullFrame = std::make_unique<FullFrameRenderer>(
      next->fullFrameScratch.data(), next->fullFrameCached.data(), inflateSpriteHost);
  next->sprite = std::make_unique<CharacterSprite>(next->renderer.get(), next->fullFrame.get());
  next->effects = std::make_unique<CharacterEffects>(
      next->frames[0].data(), next->frames[1].data(), &next->badges, next->overlay.data());
  next->motion = std::make_unique<CharacterMotion>(seed);
  if (next->motion->error()) {
    lastError = next->motion->error();
    return 0;
  }
  // The agents' badges outlive a character change, as they do on the device.
  if (engine) next->badges = engine->badges;
  delete engine;
  engine = next.release();
  return 1;
}
}  // namespace

// A buffer the page fills with a pack, then loads with ac_load_reserved. The
// engine keeps it as the pack itself, so a 10 MB pack is held once, not twice.
AC_EXPORT uint8_t* ac_reserve(size_t size) {
  staged.assign((size + sizeof(uint32_t) - 1) / sizeof(uint32_t), 0);
  staged.shrink_to_fit();
  stagedBytes = size;
  return reinterpret_cast<uint8_t*>(staged.data());
}

AC_EXPORT int ac_load_reserved(uint32_t seed) {
  const size_t size = stagedBytes;
  stagedBytes = 0;
  return bind(std::move(staged), size, seed);
}

// A mode change, as the device's command queue applies one. `touch` is a poke:
// a surprise that settles back to idle, as a tap on the device's screen does.
AC_EXPORT int ac_mode(int mode, int touch) {
  if (!engine || mode < 0 || mode > static_cast<int>(CharacterMode::Attention)) return 0;
  if (applyModeRequest(*engine->motion, {static_cast<CharacterMode>(mode), touch != 0})) return 1;
  lastError = engine->motion->error();
  return 0;
}

// The daemon's badge packets, exactly as it sends them to the device, without
// their leading '%' or '&'. Returns 1 when the packet was accepted.
AC_EXPORT int ac_badge_icon(const char* packet) {
  if (!engine) return 0;
  if (engine->badges.setIconPacket(packet)) return 1;
  lastError = engine->badges.error();
  return 0;
}
AC_EXPORT int ac_badge_active(const char* packet) {
  if (!engine) return 0;
  if (engine->badges.setActivePacket(packet)) return 1;
  lastError = engine->badges.error();
  return 0;
}

// Steps the engine by `seconds` and renders a frame. Returns a pointer to
// width x height RGBA pixels, or null on error. `key` asks for transparency
// in place of the device's black.
AC_EXPORT const uint8_t* ac_frame(double seconds, int key) {
  if (!engine) return nullptr;
  Engine& e = *engine;
  lastError = nullptr;
  stepCharacterMotion(*e.motion, std::clamp(seconds, 0.0, .25), characterPack()->header);
  e.state = e.motion->state();
  const int index = e.useFirst ? 0 : 1;
  uint16_t* frame = e.frames[index].data();
  if (!e.effects->restore(frame)) {
    lastError = e.effects->error();
    return nullptr;
  }
  if (!e.cleared[index]) {
    std::fill(e.frames[index].begin(), e.frames[index].end(), 0);
    e.cleared[index] = true;
  }
  if (!e.sprite->render(e.state, frame)) {
    lastError = e.sprite->error();
    return nullptr;
  }
  if (key) std::memcpy(e.base.data(), frame, kPixels * sizeof(uint16_t));
  if (!e.effects->render(e.state, frame)) {
    lastError = e.effects->error();
    return nullptr;
  }
  // Most frames of an idle character are the same as the last one; then no
  // tile changed, and the page uploads and draws nothing.
  writeRgba(e, frame, key != 0, key != e.shownKey);
  e.shownKey = key;
  e.changed = !e.dirty.empty();
  e.useFirst = !e.useFirst;
  return e.rgba.data();
}

// For tests: forget the cached cut-out, so the next frame works it out afresh.
AC_EXPORT void ac_forget() {
  if (!engine) return;
  engine->keyed = false;
  engine->shownKey = -1;
}

// Whether the last ac_frame differed from the one before it.
AC_EXPORT int ac_changed() { return engine && engine->changed ? 1 : 0; }

// The rectangles the last ac_frame changed: ac_dirty_count() of them, each
// four int32 (x, y, width, height) at ac_dirty_rects().
AC_EXPORT int ac_dirty_count() { return engine ? static_cast<int>(engine->dirty.size() / 4) : 0; }
AC_EXPORT const int32_t* ac_dirty_rects() { return engine ? engine->dirty.data() : nullptr; }

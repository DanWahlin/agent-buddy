// The device's animation engine, compiled for the desktop.
//
// Everything that decides what the character looks like - the motion, the
// sprite decoding, the effects and the agent badges - is the firmware's own
// code, compiled unchanged from firmware/AgentCompanion/src. This file only
// does what AgentCompanion.ino does around it on the device: owns the frame
// buffers, applies mode changes, and steps the engine once per frame. It then
// turns the device's RGB565 frame into RGBA for a canvas.
//
// The device draws on black. A desktop window is not black, so a frame can be
// keyed: black that connects to the edge of the display is background, black
// enclosed by the art (inside a face) is kept, and effect pixels, which the
// device blends against black, get their brightness back as alpha.

#include "../../firmware/AgentCompanion/src/AgentBadges.h"
#include "../../firmware/AgentCompanion/src/CharacterEffects.h"
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
  std::vector<float> coverage;
  std::vector<float> softened;
  std::vector<int32_t> queue;
  AgentBadges badges;
  std::unique_ptr<SpriteRenderer> renderer;
  std::unique_ptr<FullFrameRenderer> fullFrame;
  std::unique_ptr<CharacterEffects> effects;
  std::unique_ptr<CharacterMotion> motion;
  bool useFirst = true;
  bool cleared[2] = {false, false};
  CharacterState state;
};

Engine* engine = nullptr;
const char* lastError = nullptr;

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
  for (int i = 0; i < kPixels; ++i) e.coverage[i] = e.background[i] ? 0.f : 1.f;
  for (int y = 0; y < kHeight; ++y) {
    for (int x = 0; x < kWidth; ++x) {
      float sum = 0;
      int count = 0;
      for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          const int nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= kWidth || ny >= kHeight) continue;
          sum += e.coverage[ny * kWidth + nx];
          ++count;
        }
      }
      e.softened[y * kWidth + x] = sum / count;
    }
  }
}

void writeRgba(Engine& e, const uint16_t* frame, bool key) {
  if (key) findBackground(e);
  for (int y = 0; y < kHeight; ++y) {
    for (int x = 0; x < kWidth; ++x) {
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
      out[0] = r;
      out[1] = g;
      out[2] = b;
      out[3] = static_cast<uint8_t>(std::lround(std::clamp(alpha, 0.f, 1.f) * 255));
    }
  }
}
}  // namespace

AC_EXPORT void* ac_alloc(size_t bytes) { return std::malloc(bytes); }
AC_EXPORT void ac_free(void* pointer) { std::free(pointer); }
AC_EXPORT const char* ac_error() { return lastError ? lastError : ""; }
AC_EXPORT int ac_width() { return kWidth; }
AC_EXPORT int ac_height() { return kHeight; }
AC_EXPORT int ac_display() { return kDisplaySize; }
AC_EXPORT int ac_frame_x() { return kCharacterFrameX; }

// Loads a character pack (.acpk), the same file the device installs. The bytes
// are copied, so the caller may free them afterwards. Returns 1 on success.
AC_EXPORT int ac_load(const uint8_t* bytes, size_t size, uint32_t seed) {
  lastError = nullptr;
  auto next = std::make_unique<Engine>();
  next->packWords.assign((size + sizeof(uint32_t) - 1) / sizeof(uint32_t), 0);
  std::memcpy(next->packWords.data(), bytes, size);
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
  next->coverage.assign(kPixels, 0);
  next->softened.assign(kPixels, 0);
  next->queue.assign(kPixels, 0);
  next->renderer = std::make_unique<SpriteRenderer>(
      next->openPatch[0].data(), next->openPatch[1].data(), next->patch.data(), patchPixels,
      next->frames[0].data(), next->frames[1].data(), inflateSpriteHost, kWidth, kHeight);
  next->fullFrame = std::make_unique<FullFrameRenderer>(
      next->fullFrameScratch.data(), next->fullFrameCached.data(), inflateSpriteHost);
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

// A mode change, as the device's command queue applies one. `touch` is a poke:
// a surprise that settles back to idle, as a tap on the device's screen does.
AC_EXPORT int ac_mode(int mode, int touch) {
  if (!engine || mode < 0 || mode > static_cast<int>(CharacterMode::Attention)) return 0;
  const auto requested = static_cast<CharacterMode>(mode);
  if (requested == CharacterMode::Surprise) {
    if (touch) engine->motion->surpriseToIdle();
    else engine->motion->surprise();
  } else if (!engine->motion->setMode(requested)) {
    lastError = engine->motion->error();
    return 0;
  }
  return engine->motion->error() ? 0 : 1;
}

AC_EXPORT int ac_look(int direction) {
  return engine && engine->motion->requestIdleDirection(direction) ? 1 : 0;
}

AC_EXPORT void ac_playing(int playing) {
  if (engine) engine->motion->setPlaying(playing != 0);
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
  const PackHeader& header = characterPack()->header;
  e.motion->update(std::clamp(seconds, 0.0, .25) * header.motionSpeed);
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
  const bool full = header.layout == PackLayout::FullFrame;
  const bool rendered = full ? e.fullFrame->render(e.state.pose, e.state.effectSeconds, frame)
                             : e.renderer->render(e.state.pose, frame);
  if (!rendered) {
    lastError = full ? e.fullFrame->error() : e.renderer->error();
    return nullptr;
  }
  if (key) std::memcpy(e.base.data(), frame, kPixels * sizeof(uint16_t));
  if (!e.effects->render(e.state, frame)) {
    lastError = e.effects->error();
    return nullptr;
  }
  writeRgba(e, frame, key != 0);
  e.useFirst = !e.useFirst;
  return e.rgba.data();
}

AC_EXPORT int ac_state_mode() { return engine ? static_cast<int>(engine->state.mode) : 0; }
AC_EXPORT double ac_state_seconds() { return engine ? engine->state.effectSeconds : 0; }

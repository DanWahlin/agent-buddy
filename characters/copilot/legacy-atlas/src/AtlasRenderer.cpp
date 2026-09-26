#include "AtlasRenderer.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#ifdef ARDUINO_ARCH_ESP32
#include <esp_timer.h>
#endif

namespace copilot {
namespace {
constexpr int kSpriteX = (kFrameWidth - kAtlasWidth) / 2;
constexpr int kSpriteY = (kFrameHeight - kAtlasHeight) / 2;
static_assert(kSpriteX >= 0 && kSpriteY >= 0, "Atlas must fit inside output frame.");

uint64_t microsNow() {
#ifdef ARDUINO_ARCH_ESP32
  return esp_timer_get_time();
#else
  return 0;
#endif
}

uint32_t expand(uint16_t c) {
  return (static_cast<uint32_t>(c) | (static_cast<uint32_t>(c) << 16)) & 0x07e0f81f;
}

uint32_t blend(uint32_t a, uint32_t b, unsigned fraction) {
  return ((a * (32 - fraction) + b * fraction) >> 5) & 0x07e0f81f;
}

AtlasEye interpolate(const AtlasEye& a, const AtlasEye& b, float t) {
  return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
          a.rx + (b.rx - a.rx) * t, a.ry + (b.ry - a.ry) * t,
          a.angle + (b.angle - a.angle) * t,
          a.visibility + (b.visibility - a.visibility) * t};
}
}

AtlasRenderer::AtlasRenderer(uint8_t* first, uint8_t* second, InflateAtlas inflate)
    : inflate_(inflate) {
  cache_[0].pixels = first;
  cache_[1].pixels = second;
}

bool AtlasRenderer::load(int index, CachedFrame& slot) {
  if (slot.index == index) return true;
  const AtlasFrame& entry = kAtlasFrames[index];
  if (entry.offset > kAtlasDataSize || entry.size < 512
      || entry.size > kAtlasDataSize - entry.offset) {
    error_ = "Pose atlas record lies outside the embedded data.";
    return false;
  }
  const uint8_t* source = kAtlasData + entry.offset;
  if (!inflate_(slot.pixels, kAtlasWidth * kAtlasHeight, source + 512, entry.size - 512)) {
    error_ = "Pose atlas decompression failed.";
    return false;
  }
  for (int i = 0; i < 256; ++i) {
    slot.palette[i] = expand(source[i * 2] | (source[i * 2 + 1] << 8));
  }
  slot.index = index;
  return true;
}

bool AtlasRenderer::render(const Pose& pose, uint16_t* frame) {
  if (pose.direction < 0 || pose.direction >= kAtlasDirections
      || !std::isfinite(pose.turn) || pose.turn < 0 || pose.turn > 1
      || !std::isfinite(pose.openness) || pose.openness < 0 || pose.openness > 1
      || !std::isfinite(pose.eyeX) || !std::isfinite(pose.eyeY)) {
    error_ = "Invalid pose supplied to atlas renderer.";
    return false;
  }
  error_ = nullptr;
  const float position = pose.turn * (kAtlasSteps - 1);
  const int low = static_cast<int>(position);
  const int high = std::min(kAtlasSteps - 1, low + 1);
  const float fraction = position - low;
  const int first = pose.direction * kAtlasSteps + low;
  const int second = pose.direction * kAtlasSteps + high;
  // Reuse a decoded neighboring frame in either travel direction.
  if (cache_[1].index == first || (first != second && cache_[0].index == second)) {
    std::swap(cache_[0], cache_[1]);
  }
  uint64_t start = microsNow();
  if (!load(first, cache_[0])) return false;
  if (second != first && !load(second, cache_[1])) return false;
  const CachedFrame& a = cache_[0];
  const CachedFrame& b = second == first ? a : cache_[1];
  decodeUs = microsNow() - start;
  start = microsNow();
  const unsigned weight = static_cast<unsigned>(fraction * 32);
  for (int y = 0; y < kAtlasHeight; ++y) {
    const int offset = y * kAtlasWidth;
    for (int x = 0; x < kAtlasWidth; ++x) {
      const uint32_t color = blend(a.palette[a.pixels[offset + x]],
                                   b.palette[b.pixels[offset + x]], weight);
      row_[x] = __builtin_bswap16(static_cast<uint16_t>(color | (color >> 16)));
    }
    std::memcpy(frame + (y + kSpriteY) * kFrameWidth + kSpriteX, row_, sizeof(row_));
  }
  compositeUs = microsNow() - start;
  start = microsNow();
  for (int i = 0; i < 2; ++i) {
    drawEye(interpolate(kAtlasFrames[first].eyes[i], kAtlasFrames[second].eyes[i], fraction),
            pose, frame);
  }
  eyesUs = microsNow() - start;
  return true;
}

void AtlasRenderer::drawEye(const AtlasEye& eye, const Pose& pose, uint16_t* frame) {
  if (eye.visibility <= 0.005f) return;
  const float cx = kSpriteX + eye.x + pose.eyeX * std::min(1.0f, eye.rx * 0.1f);
  const float cy = kSpriteY + eye.y + pose.eyeY;
  const float rx = std::max(0.5f, eye.rx);
  const float ry = 0.8f + std::max(0.0f, eye.ry - 0.8f) * pose.openness;
  const float radius = std::min(rx, ry);
  const float inverseDiameter = 0.5f / radius;
  const float ca = std::cos(eye.angle), sa = std::sin(eye.angle);
  const int extent = static_cast<int>(rx + ry + 7);
  const int top = std::max(kSpriteY, static_cast<int>(cy) - extent);
  const int bottom = std::min(kSpriteY + kAtlasHeight, static_cast<int>(cy) + extent + 1);
  const int left = std::max(kSpriteX, static_cast<int>(cx) - extent);
  const int right = std::min(kSpriteX + kAtlasWidth, static_cast<int>(cx) + extent + 1);
  for (int y = top; y < bottom; ++y) {
    for (int x = left; x < right; ++x) {
      const float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
      const float lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
      const float qx = std::abs(lx) - rx + radius;
      const float qy = std::abs(ly) - ry + radius;
      const float ox = std::max(0.0f, qx), oy = std::max(0.0f, qy);
      // First-order capsule distance keeps antialiasing without per-pixel sqrt.
      const float distance = qx <= 0 && qy <= 0 ? std::max(qx, qy) - radius
          : (ox * ox + oy * oy - radius * radius) * inverseDiameter;
      if (distance > 4) continue;
      const float glow = std::max(0.0f, 1 - std::max(0.0f, distance) * 0.25f);
      const float coverage = std::max(glow * glow * 0.12f,
                                      std::max(0.0f, std::min(1.0f, 0.5f - distance)));
      const unsigned opacity = static_cast<unsigned>(coverage * eye.visibility * 32);
      const uint16_t old = __builtin_bswap16(frame[y * kFrameWidth + x]);
      const uint16_t cyan = (static_cast<int>(ly + 1000) % 3 == 0 && pose.openness > 0.3f)
          ? 0x663b : 0x87bf;
      const uint32_t color = blend(expand(old), expand(cyan), opacity);
      frame[y * kFrameWidth + x] = __builtin_bswap16(static_cast<uint16_t>(color | (color >> 16)));
    }
  }
}
}

#include "FullFrameRenderer.h"
#include "Config.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace copilot {
namespace {
constexpr size_t kPixels = static_cast<size_t>(kCharacterFrameWidth) * kFrameHeight;
}

bool FullFrameRenderer::decode(const CharacterPack& pack, unsigned blockIndex, uint16_t* output) {
  if (blockIndex >= pack.header.frameCount) {
    error_ = "Full-frame sprite block index is invalid.";
    return false;
  }
  constexpr SpriteBlockErrors kErrors{
      "Full-frame sprite block lies outside the installed character pack.",
      "Full-frame sprite decompression failed."};
  error_ = inflateSpriteBlock(inflate_, pack.blocks[blockIndex], output, kPixels,
                              kCharacterFrameWidth, kCharacterFrameWidth, kErrors);
  return !error_;
}

bool FullFrameRenderer::render(const SpritePose& pose, float effectSeconds, uint16_t* frame) {
  error_ = nullptr;
  const CharacterPack* pack = characterPack();
  if (!pack || pack->header.layout != PackLayout::FullFrame) {
    error_ = "Installed character pack does not use the full-frame layout.";
    return false;
  }
  if (!scratch_ || !cached_ || !inflate_ || !frame) {
    error_ = "Full-frame renderer requires initialized buffers.";
    return false;
  }
  if (pose.direction >= kSpriteDirections || pose.index >= kSpriteSteps
      || pose.blinkLevel >= kSpriteBlinkLevels
      || (pose.blinkBlend && pose.blinkLevel + 1 >= kSpriteBlinkLevels)
      || !std::isfinite(effectSeconds) || effectSeconds < 0) {
    error_ = "Invalid full-frame sprite pose.";
    return false;
  }
  const PackHeader& header = pack->header;
  constexpr int top = (kCharacterFrameHeight - kFrameHeight) / 2;
  const unsigned index = walkIndex(header, pose.direction, pose.index, effectSeconds);
  const unsigned frameIndex = pose.direction * kSpriteSteps + index;
  const unsigned blockIndex = frameIndex * kSpriteBlinkLevels + pose.blinkLevel;
  const uint32_t key = blockIndex * 256 + pose.blinkBlend;
  if (cacheKey_ == key) {
    std::memcpy(frame, cached_,
                kCharacterFrameWidth * kCharacterFrameHeight * sizeof(uint16_t));
    return true;
  }
  cacheKey_ = UINT32_MAX;
  uint16_t* cachedArt = cached_ + top * kCharacterFrameWidth;
  if (!decode(*pack, blockIndex, cachedArt)) return false;
  std::memset(cached_, 0, top * kCharacterFrameWidth * sizeof(uint16_t));
  std::memset(cached_ + (top + kFrameHeight) * kCharacterFrameWidth, 0,
              top * kCharacterFrameWidth * sizeof(uint16_t));
  if (pose.blinkBlend) {
    if (!decode(*pack, blockIndex + 1, scratch_)) return false;

    int first = kFrameHeight, last = -1;
    for (int y = 0; y < kFrameHeight; ++y) {
      if (std::memcmp(cachedArt + y * kCharacterFrameWidth,
                      scratch_ + y * kCharacterFrameWidth,
                      kCharacterFrameWidth * sizeof(uint16_t)) != 0) {
        first = std::min(first, y);
        last = y;
      }
    }
    if (last >= first) {
      const int height = last - first + 1;
      const int revealHalfHeight = blinkRevealHalfHeight(pose.blinkBlend, height);
      const int center = (first + last) / 2;
      for (int y = first; y <= last; ++y) {
        if (std::abs(y - center) >= revealHalfHeight)
          std::memcpy(cachedArt + y * kCharacterFrameWidth,
                      scratch_ + y * kCharacterFrameWidth,
                      kCharacterFrameWidth * sizeof(uint16_t));
      }
    }
  }
  cacheKey_ = key;
  std::memcpy(frame, cached_,
              kCharacterFrameWidth * kCharacterFrameHeight * sizeof(uint16_t));
  return true;
}
}

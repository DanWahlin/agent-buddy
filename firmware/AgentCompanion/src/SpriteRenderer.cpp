#include "SpriteRenderer.h"
#include "SpriteStorage.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#ifdef ARDUINO_ARCH_ESP32
#include <esp_timer.h>
#endif

namespace copilot {
static_assert(kSpriteWidth == kCharacterFrameWidth && kSpriteHeight == kFrameHeight,
              "Character packs must match the display frame.");
namespace {
uint64_t microsNow() {
#ifdef ARDUINO_ARCH_ESP32
  return esp_timer_get_time();
#else
  return 0;
#endif
}

}

SpriteRenderer::SpriteRenderer(uint16_t* firstOpenPatch, uint16_t* secondOpenPatch, uint16_t* patch,
                               size_t patchCapacity, uint16_t* firstOutput, uint16_t* secondOutput,
                               InflateSprite inflate, int outputWidth, int outputHeight)
    : openPatches_{firstOpenPatch, secondOpenPatch}, patch_(patch), patchCapacity_(patchCapacity),
      outputs_{firstOutput, secondOutput}, outputWidth_(outputWidth), outputHeight_(outputHeight), inflate_(inflate) {}

void SpriteRenderer::invalidate() {
  for (unsigned i = 0; i < 2; ++i) {
    baseKeys_[i] = UINT32_MAX;
    outputKeys_[i] = UINT32_MAX;
  }
}

bool SpriteRenderer::decode(const SpriteBlock& block, uint16_t* output, size_t pixels, size_t width, size_t stride) {
  const uint8_t* source = spriteBlock(block);
  if (!source) {
    error_ = "Sprite block lies outside the installed character pack.";
    return false;
  }
  if (!inflate_(reinterpret_cast<uint8_t*>(output), pixels * sizeof(uint16_t),
                source, block.size, width, stride)) {
    error_ = "Sprite asset decompression failed.";
    return false;
  }
  return true;
}

bool SpriteRenderer::render(const SpritePose& pose, uint16_t* frame) {
  error_ = nullptr;
  decodeUs = compositeUs = eyesUs = 0;
  const CharacterPack* pack = characterPack();
  if (!pack || pack->header.layout != PackLayout::BasePatch) {
    error_ = "Installed character pack does not use the base/patch layout.";
    return false;
  }
  const PackHeader& header = pack->header;
  if (!openPatches_[0] || !openPatches_[1] || !patch_ || !outputs_[0] || !outputs_[1]
      || outputs_[0] == outputs_[1] || openPatches_[0] == openPatches_[1]
      || patch_ == openPatches_[0] || patch_ == openPatches_[1] || !inflate_ || !frame) {
    error_ = "Sprite renderer requires distinct persistent buffers.";
    return false;
  }
  if (header.maxPatchPixels > patchCapacity_) {
    error_ = "Character pack blink patches exceed the allocated patch buffers.";
    return false;
  }
  if (pose.direction >= kSpriteDirections || pose.index >= kSpriteTrackSteps[pose.direction]
      || pose.blinkLevel >= kSpriteBlinkLevels
      || (pose.blinkBlend && pose.blinkLevel + 1 >= kSpriteBlinkLevels)) {
    error_ = "Invalid discrete sprite pose.";
    return false;
  }
  if (outputWidth_ != kSpriteWidth || outputHeight_ < kSpriteHeight
      || outputWidth_ > kDisplaySize || outputHeight_ > kDisplaySize) {
    error_ = "Sprite output must match the exported stride and fit the artwork and display.";
    return false;
  }
  const int outputIndex = frame == outputs_[0] ? 0 : frame == outputs_[1] ? 1 : -1;
  if (outputIndex < 0) {
    error_ = "Sprite output buffer is not registered.";
    return false;
  }
  const unsigned index = kSpriteTrackOffsets[pose.direction] + pose.index;
  const uint32_t key = (index * kSpriteBlinkLevels + pose.blinkLevel) * 256
      + pose.blinkBlend;
  if (outputKeys_[outputIndex] == key) return true;
  const SpriteFrame& entry = pack->frames[index];
  const int top = (outputHeight_ - kSpriteHeight) / 2;
  uint16_t* art = frame + top * outputWidth_;
  const size_t patchPixels = static_cast<size_t>(entry.patchWidth) * entry.patchHeight;
  if ((entry.patchWidth == 0) != (entry.patchHeight == 0)
      || entry.patchX > kSpriteWidth || entry.patchY > kSpriteHeight
      || entry.patchWidth > kSpriteWidth - entry.patchX
      || entry.patchHeight > kSpriteHeight - entry.patchY
      || patchPixels > header.maxPatchPixels) {
    error_ = "Sprite blink patch lies outside its frame or buffer.";
    return false;
  }

  // Each physical framebuffer owns its cache; the other core may be transmitting the other one.
  outputKeys_[outputIndex] = UINT32_MAX;
  bool sameBase = baseKeys_[outputIndex] != UINT32_MAX;
  if (sameBase) {
    const SpriteFrame& cached = pack->frames[baseKeys_[outputIndex]];
    sameBase = cached.base.offset == entry.base.offset && cached.base.size == entry.base.size
        && cached.patchX == entry.patchX && cached.patchY == entry.patchY
        && cached.patchWidth == entry.patchWidth && cached.patchHeight == entry.patchHeight;
  }
  if (!sameBase) {
    const bool initializePadding = baseKeys_[outputIndex] == UINT32_MAX;
    baseKeys_[outputIndex] = UINT32_MAX;
    uint64_t started = microsNow();
    if (!decode(entry.base, art + header.baseY * outputWidth_ + header.baseX,
                header.baseWidth * header.baseHeight, header.baseWidth, outputWidth_)) return false;
    decodeUs = microsNow() - started;
    started = microsNow();
    if (initializePadding) {
      const int baseTop = top + header.baseY;
      std::memset(frame, 0, baseTop * outputWidth_ * sizeof(uint16_t));
      std::memset(frame + (baseTop + header.baseHeight) * outputWidth_, 0,
                  (outputHeight_ - baseTop - header.baseHeight) * outputWidth_ * sizeof(uint16_t));
      for (int y = baseTop; y < baseTop + header.baseHeight; ++y) {
        std::memset(frame + y * outputWidth_, 0, header.baseX * sizeof(uint16_t));
        std::memset(frame + y * outputWidth_ + header.baseX + header.baseWidth, 0,
                    (outputWidth_ - header.baseX - header.baseWidth) * sizeof(uint16_t));
      }
    }
    for (int y = 0; y < entry.patchHeight; ++y) {
      std::memcpy(openPatches_[outputIndex] + y * entry.patchWidth,
                  art + (entry.patchY + y) * outputWidth_ + entry.patchX,
                  entry.patchWidth * sizeof(uint16_t));
    }
    compositeUs = microsNow() - started;
  }
  baseKeys_[outputIndex] = index;

  const uint64_t started = microsNow();
  if (patchPixels) {
    const uint16_t* pixels = openPatches_[outputIndex];
    if (pose.blinkLevel) {
      if (!decode(entry.blinks[pose.blinkLevel - 1], patch_, patchPixels, entry.patchWidth, entry.patchWidth)) return false;
      pixels = patch_;
    }
    for (int y = 0; y < entry.patchHeight; ++y) {
      std::memcpy(art + (entry.patchY + y) * outputWidth_ + entry.patchX,
                  pixels + y * entry.patchWidth, entry.patchWidth * sizeof(uint16_t));
    }
    if (pose.blinkBlend) {
      if (!decode(entry.blinks[pose.blinkLevel], patch_, patchPixels,
                  entry.patchWidth, entry.patchWidth)) return false;
      const int revealHalfHeight = std::max(
          1, static_cast<int>((static_cast<unsigned>(pose.blinkBlend)
              * (entry.patchHeight + 1) / 2 + 254) / 255));
      const int center = entry.patchHeight / 2;
      for (int y = 0; y < entry.patchHeight; ++y) {
        uint16_t* output = art + (entry.patchY + y) * outputWidth_ + entry.patchX;
        const uint16_t* next = patch_ + y * entry.patchWidth;
        if (std::abs(y - center) >= revealHalfHeight)
          std::memcpy(output, next, entry.patchWidth * sizeof(uint16_t));
      }
    }
  }
  eyesUs = microsNow() - started;
  outputKeys_[outputIndex] = key;
  return true;
}
}

#pragma once
#include <cstdint>

namespace copilot {
// Animation model shared by the motion engine and every installable character pack.
constexpr int kSpriteWidth = 412;
constexpr int kSpriteHeight = 352;
constexpr int kSpriteDirections = 13;
constexpr int kSpriteSteps = 24;
constexpr int kSpriteBlinkLevels = 5;
constexpr int kSpriteFrameCount = 288;
constexpr uint8_t kSpriteTrackSteps[kSpriteDirections] = {
    24, 24, 12, 12, 24, 24, 24, 24, 24, 24, 24, 24, 24};
constexpr uint16_t kSpriteTrackOffsets[kSpriteDirections] = {
    0, 24, 48, 60, 72, 96, 120, 144, 168, 192, 216, 240, 264};
}

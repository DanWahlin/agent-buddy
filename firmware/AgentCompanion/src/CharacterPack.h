#pragma once
#include "CharacterModel.h"
#include <cstddef>
#include <cstdint>

namespace copilot {
// Binary layout is documented in tools/character_pack.py.
constexpr size_t kPackHeaderBytes = 256;
constexpr size_t kPackShaOffset = 160;
constexpr uint8_t kNoWalkDirection = 255;

enum class PackLayout : uint8_t { BasePatch = 1, FullFrame = 2 };

struct SpriteBlock {
  uint32_t offset;
  uint32_t size;
};
struct SpriteFrame {
  SpriteBlock base;
  uint16_t patchX, patchY, patchWidth, patchHeight;
  SpriteBlock blinks[4];
};
static_assert(sizeof(SpriteBlock) == 8 && sizeof(SpriteFrame) == 48,
              "Pack table records must match the packer.");
static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__,
              "Pack tables are read in place as little-endian records.");

struct PackHeader {
  PackLayout layout;
  char id[17];
  char name[25];
  uint32_t totalBytes, frameCount, tableOffset, tableBytes, dataOffset, dataBytes;
  uint16_t baseX, baseY, baseWidth, baseHeight;
  uint32_t maxPatchPixels;
  float motionSpeed;
  uint8_t walkDirection, walkFrames, walkFirst;
  float walkFps;
  uint8_t sha256[32];
};

struct CharacterPack {
  PackHeader header;
  const SpriteFrame* frames;  // PackLayout::BasePatch
  const SpriteBlock* blocks;  // PackLayout::FullFrame
  const uint8_t* data;
};

// Validates the header against this firmware's animation model.
const char* parsePackHeader(const uint8_t* bytes, size_t available, size_t maxBytes,
                            PackHeader& header);
// Validates a complete in-memory pack's tables; the caller verifies SHA-256.
const char* bindCharacterPack(const uint8_t* bytes, size_t size, size_t maxBytes,
                              CharacterPack& pack);
// The pose to draw on a track: the pack's walk cycle (the Working loop) replaces the
// motion's index on its track with a looping one, in both layouts. Older firmware
// loops only full-frame packs and plays a base-patch pack's walk track as posed.
uint8_t walkIndex(const PackHeader& header, uint8_t direction, uint8_t index, float effectSeconds);
}

#include "CharacterPack.h"
#include <cstring>

namespace copilot {
namespace {
constexpr char kMagic[4] = {'A', 'C', 'P', 'K'};
constexpr uint16_t kFormatVersion = 1;

uint16_t read16(const uint8_t* bytes, size_t offset) {
  return static_cast<uint16_t>(bytes[offset] | bytes[offset + 1] << 8);
}

uint32_t read32(const uint8_t* bytes, size_t offset) {
  return static_cast<uint32_t>(read16(bytes, offset))
      | static_cast<uint32_t>(read16(bytes, offset + 2)) << 16;
}

bool readText(const uint8_t* source, size_t capacity, char* output, bool identifier) {
  size_t length = 0;
  while (length < capacity && source[length]) ++length;
  if (!length) return false;
  for (size_t i = 0; i < capacity; ++i) {
    const uint8_t value = source[i];
    if (i >= length) {
      if (value) return false;
      continue;
    }
    const bool allowed = identifier
        ? (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9')
          || (value == '-' && i > 0)
        : value >= 32 && value < 127;
    if (!allowed) return false;
    output[i] = static_cast<char>(value);
  }
  output[length] = '\0';
  return true;
}

bool within(const SpriteBlock& block, uint32_t dataBytes, bool required) {
  if (required && !block.size) return false;
  return block.offset <= dataBytes && block.size <= dataBytes - block.offset;
}
}

const char* parsePackHeader(const uint8_t* bytes, size_t available, size_t maxBytes,
                            PackHeader& header) {
  if (!bytes || available < kPackHeaderBytes) return "Character pack header is incomplete.";
  if (std::memcmp(bytes, kMagic, sizeof(kMagic)) != 0) return "No character pack is installed.";
  if (read16(bytes, 4) != kFormatVersion || read16(bytes, 6) != kPackHeaderBytes)
    return "Character pack format is not supported by this firmware.";
  header = {};
  header.totalBytes = read32(bytes, 8);
  if (header.totalBytes <= kPackHeaderBytes || header.totalBytes > maxBytes)
    return "Character pack size is invalid or exceeds the assets partition.";
  if (bytes[13] != kSpriteDirections || bytes[14] != kSpriteSteps
      || bytes[15] != kSpriteBlinkLevels || read16(bytes, 56) != kSpriteWidth
      || read16(bytes, 58) != kSpriteHeight)
    return "Character pack does not match the firmware animation model.";
  const uint8_t layout = bytes[12];
  if (layout != static_cast<uint8_t>(PackLayout::BasePatch)
      && layout != static_cast<uint8_t>(PackLayout::FullFrame))
    return "Character pack layout is not supported by this firmware.";
  header.layout = static_cast<PackLayout>(layout);
  if (!readText(bytes + 16, 16, header.id, true) || !readText(bytes + 32, 24, header.name, false))
    return "Character pack id or name is invalid.";
  header.baseX = read16(bytes, 60);
  header.baseY = read16(bytes, 62);
  header.baseWidth = read16(bytes, 64);
  header.baseHeight = read16(bytes, 66);
  header.maxPatchPixels = read32(bytes, 68);
  const uint16_t motion = read16(bytes, 72);
  if (motion < 100 || motion > 4000) return "Character pack motion speed is out of range.";
  header.motionSpeed = motion / 1000.0f;
  header.walkDirection = bytes[74];
  header.walkFrames = bytes[75];
  header.walkFirst = bytes[78];
  const uint16_t walkFps = read16(bytes, 76);
  header.walkFps = walkFps / 100.0f;
  if (header.walkDirection != kNoWalkDirection
      && (header.walkDirection >= kSpriteDirections || header.walkFrames < 1
          || header.walkFrames > kSpriteSteps
          || header.walkFirst + header.walkFrames > kSpriteSteps
          || walkFps < 1 || walkFps > 6000))
    return "Character pack walk cycle is invalid.";
  const bool basePatch = header.layout == PackLayout::BasePatch;
  uint16_t expectedOffset = 0;
  for (int direction = 0; direction < 16; ++direction) {
    const uint8_t steps = bytes[80 + direction];
    const uint16_t offset = read16(bytes, 96 + direction * 2);
    const uint8_t expected = direction >= kSpriteDirections ? 0
        : basePatch ? kSpriteTrackSteps[direction] : kSpriteSteps;
    if (steps != expected || offset != (direction < kSpriteDirections ? expectedOffset : 0))
      return "Character pack track layout is not supported by this firmware.";
    expectedOffset = static_cast<uint16_t>(expectedOffset + steps);
  }
  header.frameCount = read32(bytes, 128);
  header.tableOffset = read32(bytes, 132);
  header.tableBytes = read32(bytes, 136);
  header.dataOffset = read32(bytes, 140);
  header.dataBytes = read32(bytes, 144);
  if (header.tableOffset != kPackHeaderBytes || header.dataOffset % 4 || !header.dataBytes
      || header.dataOffset < header.tableOffset
      || header.tableBytes > header.dataOffset - header.tableOffset
      || header.dataOffset > header.totalBytes
      || header.dataBytes != header.totalBytes - header.dataOffset)
    return "Character pack sections are misaligned or overlap.";
  if (basePatch) {
    if (header.frameCount != kSpriteFrameCount
        || header.tableBytes != header.frameCount * sizeof(SpriteFrame))
      return "Base/patch frame table has the wrong size.";
    if (!header.baseWidth || !header.baseHeight || !header.maxPatchPixels
        || header.baseX + header.baseWidth > kSpriteWidth
        || header.baseY + header.baseHeight > kSpriteHeight)
      return "Base/patch frame bounds are invalid.";
  } else if (header.frameCount != kSpriteDirections * kSpriteSteps * kSpriteBlinkLevels
             || header.tableBytes != header.frameCount * sizeof(SpriteBlock)) {
    return "Full-frame block table has the wrong size.";
  }
  std::memcpy(header.sha256, bytes + kPackShaOffset, sizeof(header.sha256));
  return nullptr;
}

const char* bindCharacterPack(const uint8_t* bytes, size_t size, size_t maxBytes,
                              CharacterPack& pack) {
  pack = {};
  if (const char* error = parsePackHeader(bytes, size, maxBytes, pack.header)) return error;
  const PackHeader& header = pack.header;
  if (header.totalBytes != size) return "Character pack is truncated.";
  if (reinterpret_cast<uintptr_t>(bytes) % 4) return "Character pack is not 4-byte aligned.";
  pack.data = bytes + header.dataOffset;
  if (header.layout == PackLayout::BasePatch) {
    pack.frames = reinterpret_cast<const SpriteFrame*>(bytes + header.tableOffset);
    for (uint32_t i = 0; i < header.frameCount; ++i) {
      const SpriteFrame& frame = pack.frames[i];
      const bool patched = frame.patchWidth != 0;
      if ((frame.patchWidth == 0) != (frame.patchHeight == 0)
          || frame.patchX + frame.patchWidth > kSpriteWidth
          || frame.patchY + frame.patchHeight > kSpriteHeight
          || static_cast<uint32_t>(frame.patchWidth) * frame.patchHeight > header.maxPatchPixels
          || !within(frame.base, header.dataBytes, true))
        return "Character pack frame bounds are invalid.";
      for (const SpriteBlock& blink : frame.blinks) {
        if (!within(blink, header.dataBytes, patched))
          return "Character pack blink data is out of bounds.";
      }
    }
  } else {
    pack.blocks = reinterpret_cast<const SpriteBlock*>(bytes + header.tableOffset);
    for (uint32_t i = 0; i < header.frameCount; ++i) {
      if (!within(pack.blocks[i], header.dataBytes, true))
        return "Character pack frame data is out of bounds.";
    }
  }
  return nullptr;
}
}

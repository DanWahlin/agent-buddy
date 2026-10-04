#include "../firmware/AgentCompanion/src/CharacterPack.h"
#include "../firmware/AgentCompanion/src/SpriteStorage.h"

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

extern "C" const uint8_t kCopilotPack[], kCopilotPackEnd[];
extern "C" const uint8_t kOpenClawPack[], kOpenClawPackEnd[];

namespace {
using namespace copilot;
constexpr size_t kPartitionBytes = 0xBE0000;

struct Pack {
  std::vector<uint32_t> words;
  size_t size;
  explicit Pack(const uint8_t* begin, const uint8_t* end)
      : words((end - begin + 3) / 4), size(end - begin) {
    std::memcpy(words.data(), begin, size);
  }
  uint8_t* bytes() { return reinterpret_cast<uint8_t*>(words.data()); }
  void put16(size_t offset, uint16_t value) { std::memcpy(bytes() + offset, &value, 2); }
  void put32(size_t offset, uint32_t value) { std::memcpy(bytes() + offset, &value, 4); }
};

std::string bind(Pack& pack, size_t maxBytes = kPartitionBytes) {
  CharacterPack bound;
  const char* error = bindCharacterPack(pack.bytes(), pack.size, maxBytes, bound);
  return error ? error : "";
}

template <typename Change>
void rejects(const uint8_t* begin, const uint8_t* end, Change change, const char* expected) {
  Pack pack(begin, end);
  change(pack);
  const std::string error = bind(pack);
  if (error.find(expected) == std::string::npos) {
    std::fprintf(stderr, "expected '%s', got '%s'\n", expected, error.c_str());
    assert(false);
  }
}
}

int main() {
  Pack copilot(kCopilotPack, kCopilotPackEnd);
  Pack openclaw(kOpenClawPack, kOpenClawPackEnd);
  assert(bind(copilot).empty() && bind(openclaw).empty());

  CharacterPack bound;
  assert(!bindCharacterPack(copilot.bytes(), copilot.size, kPartitionBytes, bound));
  assert(std::string(bound.header.id) == "copilot" && std::string(bound.header.name) == "Copilot");
  assert(bound.header.frameCount == kSpriteFrameCount && bound.frames && !bound.blocks);
  assert(bound.header.walkDirection == kNoWalkDirection);

  const uint8_t* begin = kCopilotPack;
  const uint8_t* end = kCopilotPackEnd;
  rejects(begin, end, [](Pack& p) { p.bytes()[0] = 'X'; }, "No character pack");
  rejects(begin, end, [](Pack& p) { p.put16(4, 2); }, "format");
  rejects(begin, end, [](Pack& p) { p.bytes()[13] = 12; }, "animation model");
  rejects(begin, end, [](Pack& p) { p.put16(56, 400); }, "animation model");
  rejects(begin, end, [](Pack& p) { p.bytes()[12] = 3; }, "layout");
  rejects(begin, end, [](Pack& p) { p.bytes()[16] = 'A'; }, "id or name");
  rejects(begin, end, [](Pack& p) { p.bytes()[32] = 0; }, "id or name");
  rejects(begin, end, [](Pack& p) { p.put16(72, 50); }, "motion speed");
  rejects(begin, end, [](Pack& p) { p.bytes()[74] = 13; p.bytes()[75] = 1; p.put16(76, 100); },
          "walk cycle");
  rejects(begin, end, [](Pack& p) { p.bytes()[82] = 24; }, "track layout");
  rejects(begin, end, [](Pack& p) { p.size -= 1; }, "truncated");
  rejects(begin, end, [](Pack& p) { p.put32(140, 250); }, "sections");
  rejects(begin, end, [](Pack& p) { p.put32(128, 287); }, "frame table");
  rejects(begin, end, [](Pack& p) { p.put16(64, 0); }, "bounds");
  rejects(begin, end, [](Pack& p) { p.put32(256 + 4, 0); }, "frame bounds");
  rejects(begin, end, [](Pack& p) { p.put32(256, 0xFFFFFFF0u); }, "frame bounds");
  rejects(begin, end, [](Pack& p) { p.put32(256 + 24 + 4, 0x7FFFFFFFu); }, "blink data");
  rejects(begin, end, [](Pack& p) { p.put16(256 + 12, 0xFFFF); }, "frame bounds");
  rejects(kOpenClawPack, kOpenClawPackEnd, [](Pack& p) { p.put32(256 + 8 * 7 + 4, 0); },
          "frame data");
  assert(bind(copilot, copilot.size - 1).find("exceeds") != std::string::npos);

  CharacterPack misaligned;
  std::vector<uint8_t> shifted(copilot.size + 1);
  std::memcpy(shifted.data() + 1, copilot.bytes(), copilot.size);
  assert(bindCharacterPack(shifted.data() + 1, copilot.size, kPartitionBytes, misaligned));

  assert(!loadCharacterPack(copilot.bytes(), copilot.size - 1) && !characterPack());
  assert(loadCharacterPack(openclaw.bytes(), openclaw.size) && characterPack());
  std::puts("PASS: character packs validate model, layout, sections and every table reference");
}

#include "../firmware/AgentCompanion/src/FullFrameRenderer.h"
#include "../firmware/AgentCompanion/src/SpriteStorage.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

extern "C" const uint8_t kCopilotPack[], kCopilotPackEnd[];
extern "C" const uint8_t kOpenClawPack[], kOpenClawPackEnd[];

namespace {
std::vector<const uint8_t*> sources;

bool inflate(uint8_t* output, size_t outputSize, const uint8_t* input, size_t inputSize,
             size_t, size_t) {
  if (!inputSize) return false;
  sources.push_back(input);
  // Tag each decode with its source so blends can be told apart.
  std::memset(output, static_cast<int>(sources.size() & 0x7f), outputSize);
  return true;
}

const uint8_t* block(unsigned direction, unsigned index, unsigned blink) {
  const copilot::CharacterPack& pack = *copilot::characterPack();
  const unsigned number = (direction * copilot::kSpriteSteps + index) * copilot::kSpriteBlinkLevels + blink;
  return pack.data + pack.blocks[number].offset;
}
}

int main() {
  using namespace copilot;
  std::vector<uint16_t> scratch(kCharacterFrameWidth * kFrameHeight);
  std::vector<uint16_t> cached(kCharacterFrameWidth * kCharacterFrameHeight);
  std::vector<uint16_t> frame(kCharacterFrameWidth * kCharacterFrameHeight);
  FullFrameRenderer renderer(scratch.data(), cached.data(), inflate);

  assert(loadCharacterPack(kCopilotPack, kCopilotPackEnd - kCopilotPack));
  assert(!renderer.render({}, 0, frame.data()) && renderer.error());

  assert(loadCharacterPack(kOpenClawPack, kOpenClawPackEnd - kOpenClawPack));
  const PackHeader& header = characterPack()->header;
  assert(header.layout == PackLayout::FullFrame && std::strcmp(header.id, "openclaw") == 0);
  assert(header.walkDirection == 9 && header.walkFirst == 1 && header.walkFrames == 23);
  assert(std::fabs(header.walkFps - 12.0f) < 1e-6f && std::fabs(header.motionSpeed - 1.3f) < 1e-6f);

  assert(renderer.render({}, 0, frame.data()));
  assert(sources.size() == 1 && sources[0] == block(0, 0, 0));
  assert(renderer.render({}, 0, frame.data()) && sources.size() == 1);

  sources.clear();
  assert(renderer.render({0, 0, 1, 128}, 0, frame.data()));
  assert(sources.size() == 2 && sources[0] == block(0, 0, 1) && sources[1] == block(0, 0, 2));

  sources.clear();
  assert(renderer.render({9, 0, 0}, 0.5f, frame.data()));
  assert(sources.size() == 1 && sources[0] == block(9, 7, 0));
  sources.clear();
  assert(renderer.render({9, 0, 0}, 23.0f / 12.0f + 0.01f, frame.data()));
  assert(sources.size() == 1 && sources[0] == block(9, 1, 0));

  assert(!renderer.render({13, 0, 0}, 0, frame.data()) && renderer.error());
  assert(!renderer.render({0, 24, 0}, 0, frame.data()) && renderer.error());
  assert(!renderer.render({0, 0, 4, 1}, 0, frame.data()) && renderer.error());
  assert(!renderer.render({0, 0, 0}, -1, frame.data()) && renderer.error());
  std::puts("PASS: full-frame packs select blocks, blend blinks, walk and cache from the pack");
}

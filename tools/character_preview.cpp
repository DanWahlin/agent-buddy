#include "../firmware/AgentCompanion/src/CharacterEffects.h"
#include "../firmware/AgentCompanion/src/CharacterFrame.h"
#include "../firmware/AgentCompanion/src/CharacterMotion.h"
#include "../firmware/AgentCompanion/src/FullFrameRenderer.h"
#include "../firmware/AgentCompanion/src/SpriteRenderer.h"
#include "../firmware/AgentCompanion/src/SpriteStorage.h"
#include "HostSpriteInflate.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace copilot;

namespace {
struct PackBuffer {
  std::vector<uint32_t> words;
  size_t bytes = 0;
};

std::map<std::string, PackBuffer> packs;

bool validId(const std::string& id) {
  if (id.empty() || id.size() > 16) return false;
  if (id[0] < 'a' || id[0] > 'z') return false;
  for (char ch : id) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-') continue;
    return false;
  }
  return true;
}

bool hasSuffix(const std::string& value, const char* suffix) {
  const size_t length = std::strlen(suffix);
  return value.size() >= length && value.compare(value.size() - length, length, suffix) == 0;
}

bool readPackFile(const std::string& path, PackBuffer& output) {
  std::ifstream stream(path, std::ios::binary | std::ios::ate);
  if (!stream) return false;
  const std::streamoff size = stream.tellg();
  if (size <= 0) return false;
  output.bytes = static_cast<size_t>(size);
  output.words.assign((output.bytes + sizeof(uint32_t) - 1) / sizeof(uint32_t), 0);
  stream.seekg(0);
  stream.read(reinterpret_cast<char*>(output.words.data()), static_cast<std::streamsize>(output.bytes));
  return static_cast<size_t>(stream.gcount()) == output.bytes;
}

bool selectPack(const std::string& character) {
  const auto found = packs.find(character);
  if (found == packs.end()) return false;
  return loadCharacterPack(reinterpret_cast<const uint8_t*>(found->second.words.data()), found->second.bytes);
}

bool loadPacks() {
  DIR* directory = opendir("build/characters");
  if (!directory) {
    std::cerr << "Cannot open build/characters. Run python3 tools/character_pack.py build.\n";
    return false;
  }
  std::vector<std::string> names;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (hasSuffix(name, ".acpk")) names.push_back(name);
  }
  closedir(directory);
  std::sort(names.begin(), names.end());
  for (const std::string& name : names) {
    const std::string id = name.substr(0, name.size() - 5);
    if (!validId(id)) continue;
    PackBuffer buffer;
    if (!readPackFile("build/characters/" + name, buffer)) {
      std::cerr << "Cannot read character pack: " << name << '\n';
      return false;
    }
    packs[id] = std::move(buffer);
    if (!selectPack(id)) {
      std::cerr << name << ": " << spriteStorageError() << '\n';
      return false;
    }
  }
  if (packs.empty()) {
    std::cerr << "No character packs found in build/characters.\n";
    return false;
  }
  return true;
}
}  // namespace

int main() {
  if (!loadPacks() || !selectPack("copilot")) {
    std::cerr << (spriteStorageError() ? spriteStorageError() : "Copilot pack is missing.") << '\n';
    return 1;
  }
  size_t patchPixels = 1;
  for (const auto& item : packs) {
    if (!selectPack(item.first)) {
      std::cerr << spriteStorageError() << '\n';
      return 1;
    }
    patchPixels = std::max(patchPixels, static_cast<size_t>(characterPack()->header.maxPatchPixels));
  }
  if (!selectPack("copilot")) return 1;
  std::vector<uint16_t> first(kCharacterFrameWidth * kCharacterFrameHeight), second(first.size());
  std::vector<uint16_t> openFirst(patchPixels), openSecond(patchPixels), patch(patchPixels);
  std::vector<uint16_t> fullFrameScratch(kCharacterFrameWidth * kFrameHeight);
  std::vector<uint16_t> fullFrameCached(kCharacterFrameWidth * kCharacterFrameHeight);
  SpriteRenderer renderer(openFirst.data(), openSecond.data(), patch.data(), patchPixels,
                          first.data(), second.data(), inflateSpriteHost,
                          kCharacterFrameWidth, kCharacterFrameHeight);
  std::vector<uint16_t> badgeOverlay(CharacterEffects::kOverlayScratchPixels);
  CharacterEffects effects(first.data(), second.data(), nullptr, badgeOverlay.data());
  FullFrameRenderer fullFrame(
      fullFrameScratch.data(), fullFrameCached.data(), inflateSpriteHost);
  CharacterSprite sprite(&renderer, &fullFrame);
  CharacterMotion motion(20260911);
  if (motion.error()) {
    std::cerr << motion.error() << '\n';
    return 1;
  }
  bool useFirst = true;
  std::string activeCharacter = "copilot";
  std::string renderedCharacters[2];
  char line[256];
  while (std::cin.getline(line, sizeof(line))) {
    double dt;
    double requestedMode, requestedPlaying, requestedDirection;
    std::string character;
    std::string extra;
    std::istringstream input(line);
    if (!(input >> dt >> requestedMode >> requestedPlaying >> character >> requestedDirection)
        || (input >> extra) || !std::isfinite(dt) || dt < 0 || dt > 86400
        || !std::isfinite(requestedMode) || requestedMode < -1 || requestedMode > 5
        || std::floor(requestedMode) != requestedMode
        || !std::isfinite(requestedPlaying) || (requestedPlaying != 0 && requestedPlaying != 1)
        || !validId(character) || packs.find(character) == packs.end()
        || !std::isfinite(requestedDirection) || requestedDirection < -1 || requestedDirection > 7
        || std::floor(requestedDirection) != requestedDirection) {
      std::cout << "ERR Invalid character command\n" << std::flush;
      continue;
    }
    const int mode = static_cast<int>(requestedMode), playing = static_cast<int>(requestedPlaying);
    if (mode >= 0 && !applyModeRequest(motion, {static_cast<CharacterMode>(mode), false})) {
      std::cout << "ERR " << motion.error() << '\n' << std::flush;
      continue;
    }
    if (requestedDirection >= 0
        && !motion.requestIdleDirection(static_cast<int>(requestedDirection))) {
      std::cout << "ERR " << motion.error() << '\n' << std::flush;
      continue;
    }
    motion.setPlaying(playing != 0);
    if (character != activeCharacter) {
      if (!selectPack(character)) {
        std::cout << "ERR " << spriteStorageError() << '\n' << std::flush;
        continue;
      }
      sprite.invalidate();
      activeCharacter = character;
    }
    stepCharacterMotion(motion, dt, characterPack()->header);
    const CharacterState state = motion.state();
    uint16_t* frame = useFirst ? first.data() : second.data();
    const int frameIndex = useFirst ? 0 : 1;
    const auto start = std::chrono::steady_clock::now();
    const bool restored = effects.restore(frame);
    if (renderedCharacters[frameIndex] != character)
      std::memset(frame, 0, first.size() * sizeof(uint16_t));
    const bool rendered = sprite.render(state, frame);
    if (!restored || !rendered || !effects.render(state, frame)) {
      const char* renderError = sprite.error();
      std::cout << "ERR " << (effects.error() ? effects.error() : renderError) << '\n' << std::flush;
      continue;
    }
    renderedCharacters[frameIndex] = character;
    const double renderMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start).count();
    std::cout << std::setprecision(9) << "OK " << first.size() * 2 << ' '
              << unsigned(state.pose.direction) << ' ' << unsigned(state.pose.index) << ' '
              << unsigned(state.pose.blinkLevel) << ' ' << unsigned(state.mode) << ' '
              << unsigned(state.requestedMode) << ' ' << state.effectSeconds << ' '
              << state.eventId << ' ' << renderMs << ' ' << kSpriteDirections << ' ' << playing << '\n';
    std::cout.write(reinterpret_cast<const char*>(frame), first.size() * 2);
    std::cout.flush();
    if (!std::cout) return 1;
    useFirst = !useFirst;
  }
  if (!std::cin.eof()) {
    std::cout << "ERR Character command exceeds 255 bytes\n" << std::flush;
    return 1;
  }
}

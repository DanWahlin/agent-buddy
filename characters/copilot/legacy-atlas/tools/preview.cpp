#include "../src/AtlasRenderer.h"
#include "../../../../tools/HostInflate.h"
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using namespace copilot;

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "Usage: preview output.rgb565\n";
    return 1;
  }
  std::ofstream stream(argv[1], std::ios::binary);
  if (!stream) {
    std::cerr << "Cannot open output file\n";
    return 1;
  }
  std::vector<uint16_t> frame(kFrameWidth * kFrameHeight);
  std::vector<uint8_t> first(kAtlasWidth * kAtlasHeight), second(first.size());
  AtlasRenderer renderer(first.data(), second.data(), inflateAtlasHost);
  Motion motion(0xC0F1107);
  constexpr int fps = kTargetFps;
  constexpr int seconds = 18;
  for (int i = 0; i < fps * seconds; ++i) {
    if (!renderer.render(motion.sample(i / static_cast<double>(fps)), frame.data())) {
      std::cerr << renderer.error() << "\n";
      return 1;
    }
    stream.write(reinterpret_cast<const char*>(frame.data()), frame.size() * 2);
  }
  if (!stream) {
    std::cerr << "Preview write failed\n";
    return 1;
  }
  std::cout << "Rendered " << seconds * fps << " frames at " << fps << " fps\n";
}

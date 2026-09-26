#include "../src/AtlasRenderer.h"
#include "../../../../tools/HostInflate.h"
#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace copilot;

int main() {
  std::vector<uint8_t> first(kAtlasWidth * kAtlasHeight), second(first.size());
  std::vector<uint16_t> frame(kFrameWidth * kFrameHeight);
  AtlasRenderer renderer(first.data(), second.data(), inflateAtlasHost);
  uint32_t seed = 0xC0F1107;
  Motion motion(seed);
  double lastTime = 0;
  bool automatic = true;
  std::string line;
  while (std::getline(std::cin, line)) {
    double time = 0;
    int command = 0, direction = 0;
    float turn = 0, openness = 1;
    uint32_t requestedSeed = seed;
    std::istringstream request(line);
    if (!(request >> time >> command >> direction >> turn >> openness >> requestedSeed)
        || !std::isfinite(time) || time < 0 || command < 0 || command > 4) {
      std::cout << "ERR Invalid preview command\n" << std::flush;
      continue;
    }
    if (command == 3 || time < lastTime) {
      seed = requestedSeed;
      motion = Motion(seed);
      automatic = true;
      lastTime = 0;
    }
    if (command == 1) {
      automatic = false;
      motion.setAutomatic(false, time);
      if (!motion.requestLook(direction, time)) {
        std::cout << "ERR Invalid direction\n" << std::flush;
        continue;
      }
    } else if (command == 2) {
      automatic = direction != 0;
      motion.setAutomatic(automatic, time);
    }
    Pose pose;
    if (command == 4) {
      pose.direction = direction;
      pose.turn = turn;
      pose.openness = openness;
    } else {
      pose = motion.sample(time);
      lastTime = time;
    }
    const auto start = std::chrono::steady_clock::now();
    if (!renderer.render(pose, frame.data())) {
      std::cout << "ERR " << renderer.error() << "\n" << std::flush;
      continue;
    }
    const double renderMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start).count();
    std::cout << std::setprecision(8) << "OK " << frame.size() * 2 << " "
              << pose.direction << " " << pose.turn << " " << pose.openness << " "
              << renderMs << " " << (automatic ? 1 : 0) << "\n";
    std::cout.write(reinterpret_cast<const char*>(frame.data()), frame.size() * 2);
    std::cout.flush();
    if (!std::cout) return 1;
  }
}

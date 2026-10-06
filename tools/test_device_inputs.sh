#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
for TEST in touch_input button_input settings_menu device_commands screen_orientation screen_transform speech_wire; do
  clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    "tests/test_${TEST}.cpp" -o "build/test-${TEST}"
  "build/test-${TEST}"
done
clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer -Itests/display_stubs -DARDUINO_ARCH_ESP32 \
  tests/test_oriented_display.cpp firmware/AgentCompanion/src/OrientedDisplay.cpp \
  firmware/AgentCompanion/src/DisplayDma.cpp \
  -o build/test-oriented_display
build/test-oriented_display

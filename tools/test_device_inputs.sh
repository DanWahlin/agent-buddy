#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
for TEST in deadline touch_input button_input settings_menu device_commands screen_orientation screen_transform usb_serial_watchdog board_variant; do
  clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    "tests/test_${TEST}.cpp" -o "build/test-${TEST}"
  "build/test-${TEST}"
done
# The display scanout differs by board, so it is tested once for each board.
for BOARD_ID in $(python3 tools/boards.py list); do
  BOARD_DEFINE="$(python3 tools/boards.py field define --board "$BOARD_ID")"
  clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer -Itests/display_stubs -DARDUINO_ARCH_ESP32 \
    "-D$BOARD_DEFINE" tests/test_oriented_display.cpp firmware/AgentCompanion/src/OrientedDisplay.cpp \
    firmware/AgentCompanion/src/DisplayDma.cpp \
    -o "build/test-oriented_display-$BOARD_ID"
  "build/test-oriented_display-$BOARD_ID"
done

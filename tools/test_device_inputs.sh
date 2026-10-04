#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
for TEST in touch_input button_input settings_menu device_commands; do
  clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    "tests/test_${TEST}.cpp" -o "build/test-${TEST}"
  "build/test-${TEST}"
done

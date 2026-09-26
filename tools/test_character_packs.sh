#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p build
python3 tools/character_pack.py build
for TEST in character_pack full_frame_renderer; do
  "${CXX:-clang++}" -std=c++17 -O1 -g -Wall -Wextra -Werror \
    -fsanitize=address,undefined -fno-omit-frame-pointer \
    "tests/test_${TEST}.cpp" firmware/AgentCompanion/src/FullFrameRenderer.cpp \
    firmware/AgentCompanion/src/CharacterPack.cpp firmware/AgentCompanion/src/SpriteStorage.cpp \
    build/character_packs_host.S -o "build/test-${TEST}"
  "build/test-${TEST}"
done

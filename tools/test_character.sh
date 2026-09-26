#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p build
"${CXX:-clang++}" -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/test_character.cpp firmware/AgentCompanion/src/CharacterMotion.cpp \
  firmware/AgentCompanion/src/AgentBadges.cpp \
  firmware/AgentCompanion/src/CharacterEffects.cpp firmware/AgentCompanion/src/SpriteMotion.cpp \
  -o build/test-character
build/test-character

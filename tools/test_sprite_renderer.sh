#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 tools/character_pack.py build
clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/test_sprite_predictor.cpp -lz -o build/test-sprite-predictor
build/test-sprite-predictor
clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/test_sprite_renderer.cpp firmware/AgentCompanion/src/SpriteRenderer.cpp \
  firmware/AgentCompanion/src/CharacterPack.cpp firmware/AgentCompanion/src/SpriteStorage.cpp \
  build/character_packs_host.S -lz \
  -o build/test-sprite-renderer
build/test-sprite-renderer

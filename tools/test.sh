#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"
python3 "$ROOT/characters/copilot/legacy-atlas/tools/embed_atlas.py"
clang++ -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  "$ROOT/tests/test_animation.cpp" \
  "$ROOT/firmware/AgentCompanion/src/Motion.cpp" \
  "$ROOT/characters/copilot/legacy-atlas/src/AtlasRenderer.cpp" \
  "$ROOT/characters/copilot/legacy-atlas/src/turn_atlas.cpp" \
  "$ROOT/build/atlas_host.S" -lz \
  -o "$ROOT/build/test-animation"
"$ROOT/build/test-animation"

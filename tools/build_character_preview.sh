#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p build
# The existing validator rejects stale art/metadata; never substitute preview PNGs.
python3 characters/copilot/legacy-atlas/tools/embed_atlas.py
python3 tools/character_pack.py build
"${CXX:-clang++}" -std=c++17 -O3 -Wall -Wextra -Werror \
  characters/copilot/legacy-atlas/tools/live_preview.cpp characters/copilot/legacy-atlas/src/AtlasRenderer.cpp \
  firmware/AgentCompanion/src/Motion.cpp characters/copilot/legacy-atlas/src/turn_atlas.cpp \
  build/atlas_host.S -lz -o build/live-preview
"${CXX:-clang++}" -std=c++17 -O2 -Wall -Wextra -Werror \
  tools/character_preview.cpp firmware/AgentCompanion/src/CharacterMotion.cpp \
  firmware/AgentCompanion/src/CharacterFrame.cpp \
  firmware/AgentCompanion/src/FullFrameRenderer.cpp firmware/AgentCompanion/src/CharacterPack.cpp \
  firmware/AgentCompanion/src/AgentBadges.cpp \
  firmware/AgentCompanion/src/CharacterEffects.cpp firmware/AgentCompanion/src/SpriteMotion.cpp \
  firmware/AgentCompanion/src/SpriteRenderer.cpp firmware/AgentCompanion/src/SpriteStorage.cpp \
  -lz -o build/character-preview

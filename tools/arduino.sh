#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARDUINO_CLI:-/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli}"
CONFIG="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
# BOARD selects a build target in firmware/boards.json. The default is the boards.json default.
BOARD="${BOARD:-$(python3 "$ROOT/tools/boards.py" default)}"
export BOARD
FQBN="$(python3 "$ROOT/tools/boards.py" field fqbn)"
BOARD_DEFINE="$(python3 "$ROOT/tools/boards.py" field define)"
# The default board builds in build/firmware; other boards build in build/firmware-<board>.
BUILD_DIR="$(python3 "$ROOT/tools/firmware_artifacts.py" build-dir)"
# The ESP32 core stamps __DATE__ and __TIME__ into the firmware. A fixed time makes a release
# build of the same sources byte-identical, so its firmware ID changes only with the firmware.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
ACTION="${1:-build}"
if [[ ! -x "$CLI" ]]; then
  echo "Arduino CLI not found. Set ARDUINO_CLI to its executable path." >&2
  exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "Arduino configuration not found. Set ARDUINO_CONFIG." >&2
  exit 1
fi
case "$ACTION" in
  build)
    python3 "$ROOT/tools/character_pack.py" build
    python3 "$ROOT/tools/embed_audio.py"
    python3 "$ROOT/tools/boards.py" check-vendor
    LIBRARY_ARGS=()
    while IFS= read -r library; do
      LIBRARY_ARGS+=(--library "$library")
    done < <(python3 "$ROOT/tools/boards.py" libraries)
    echo "Building firmware for board $BOARD"
    "$CLI" --config-file "$CONFIG" core list --format json |
      python3 -c 'import json,sys; d=json.load(sys.stdin); platforms=d.get("platforms",d) if isinstance(d,dict) else d; assert any(p["id"]=="esp32:esp32" and p.get("installed_version")=="3.3.10" for p in platforms), "Install esp32:esp32@3.3.10 (see README)"'
    mkdir -p "$BUILD_DIR"
    python3 "$ROOT/tools/firmware_artifacts.py" snapshot
    APP_SIZE="$(python3 "$ROOT/tools/firmware_artifacts.py" app-size)"
    "$CLI" --config-file "$CONFIG" compile --fqbn "$FQBN" \
      --build-property "upload.maximum_size=$APP_SIZE" \
      --build-property "compiler.c.extra_flags=-D$BOARD_DEFINE" \
      --build-property "compiler.cpp.extra_flags=-D$BOARD_DEFINE" \
      "${LIBRARY_ARGS[@]}" --warnings default \
      --build-path "$BUILD_DIR" "$ROOT/firmware/AgentCompanion"
    python3 "$ROOT/tools/firmware_artifacts.py" record
    ;;
  upload|upload-code)
    PORT="${2:-/dev/cu.usbmodem2101}"
    if [[ ! -f "$BUILD_DIR/AgentCompanion.ino.bin" ]]; then
      echo "Build first: BOARD=$BOARD bash tools/arduino.sh build" >&2
      exit 1
    fi
    python3 "$ROOT/tools/character_pack.py" build
    python3 "$ROOT/tools/embed_audio.py"
    python3 "$ROOT/tools/firmware_artifacts.py" check
    ASSET_OFFSET="$(python3 "$ROOT/tools/firmware_artifacts.py" asset-offset)"
    EXTRA_FILES=""
    if [[ "$ACTION" == "upload" ]]; then
      # A complete upload also installs the default Copilot character pack.
      EXTRA_FILES="$ASSET_OFFSET \"$ROOT/build/characters/copilot.acpk\""
    fi
    "$CLI" --config-file "$CONFIG" upload --fqbn "$FQBN" \
      --upload-property "upload.extra_flags=$EXTRA_FILES" \
      --port "$PORT" --input-dir "$BUILD_DIR" "$ROOT/firmware/AgentCompanion"
    sleep 2
    ;;
  monitor)
    PYTHON=python3
    if [[ -x "$ROOT/.venv/bin/python" ]]; then PYTHON="$ROOT/.venv/bin/python"; fi
    "$PYTHON" "$ROOT/tools/device.py" --port "${2:-/dev/cu.usbmodem2101}" --seconds "${3:-30}"
    ;;
  *)
    echo "Usage: [BOARD=<id>] bash tools/arduino.sh {build|upload [port]|upload-code [port]|monitor [port] [seconds]}" >&2
    echo "Boards: $(python3 "$ROOT/tools/boards.py" list | tr '\n' ' ')" >&2
    exit 2
    ;;
esac

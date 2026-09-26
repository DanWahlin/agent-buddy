#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ARDUINO_CLI:-/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli}"
CONFIG="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
WAVESHARE="${WAVESHARE_DIR:-$HOME/Documents/Arduino/ESP32-S3-Touch-AMOLED-1.75}"
FQBN="esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=custom,PSRAM=opi,LoopCore=1,EventsCore=1,DebugLevel=error"
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
    GFX="$WAVESHARE/examples/arduino/libraries/GFX_Library_for_Arduino"
    SENSORS="$WAVESHARE/examples/arduino/libraries/SensorLib"
    if [[ ! -f "$GFX/src/display/Arduino_CO5300.cpp" ]]; then
      echo "Waveshare's CO5300-capable GFX library is missing. See README.md." >&2
      exit 1
    fi
    if [[ ! -f "$SENSORS/src/touch/TouchDrvCST92xx.h" ]]; then
      echo "Waveshare's CST9217 SensorLib is missing. See README.md." >&2
      exit 1
    fi
    "$CLI" --config-file "$CONFIG" core list --format json |
      python3 -c 'import json,sys; d=json.load(sys.stdin); platforms=d.get("platforms",d) if isinstance(d,dict) else d; assert any(p["id"]=="esp32:esp32" and p.get("installed_version")=="3.3.10" for p in platforms), "Install esp32:esp32@3.3.10 (see README)"'
    mkdir -p "$ROOT/build/firmware"
    python3 "$ROOT/tools/firmware_artifacts.py" snapshot
    APP_SIZE="$(python3 "$ROOT/tools/firmware_artifacts.py" app-size)"
    "$CLI" --config-file "$CONFIG" compile --fqbn "$FQBN" \
      --build-property "upload.maximum_size=$APP_SIZE" \
      --library "$GFX" --library "$SENSORS" --warnings default \
      --build-path "$ROOT/build/firmware" "$ROOT/firmware/AgentCompanion"
    python3 "$ROOT/tools/firmware_artifacts.py" record
    ;;
  upload|upload-code)
    PORT="${2:-/dev/cu.usbmodem2101}"
    if [[ ! -f "$ROOT/build/firmware/AgentCompanion.ino.bin" ]]; then
      echo "Build first: bash tools/arduino.sh build" >&2
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
      --port "$PORT" --input-dir "$ROOT/build/firmware" "$ROOT/firmware/AgentCompanion"
    sleep 2
    ;;
  monitor)
    PYTHON=python3
    if [[ -x "$ROOT/.venv/bin/python" ]]; then PYTHON="$ROOT/.venv/bin/python"; fi
    "$PYTHON" "$ROOT/tools/device.py" --port "${2:-/dev/cu.usbmodem2101}" --seconds "${3:-30}"
    ;;
  *)
    echo "Usage: bash tools/arduino.sh {build|upload [port]|upload-code [port]|monitor [port] [seconds]}" >&2
    exit 2
    ;;
esac

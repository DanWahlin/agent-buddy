# Build from source

Prebuilt [release bundles](../README.md#install) are the simplest installation path.
The source-build scripts support macOS and Linux; Windows users can use a release
bundle or a suitable Linux/WSL development environment.

## Prerequisites

- Git and Python 3.10+.
- [Arduino CLI](https://arduino.github.io/arduino-cli/installation/), version **1.5.1**.
- A USB data cable and the supported Waveshare board.

Clone this repository and run the following from its root. The `.deps` and `.venv`
directories are local development files and are not committed.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-flash.txt

mkdir -p .deps/arduino
arduino-cli config init --dest-dir .deps/arduino
export ARDUINO_CLI="$(command -v arduino-cli)"
export ARDUINO_CONFIG="$PWD/.deps/arduino/arduino-cli.yaml"
export WAVESHARE_DIR="$PWD/.deps/waveshare"

arduino-cli --config-file "$ARDUINO_CONFIG" config add board_manager.additional_urls \
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli --config-file "$ARDUINO_CONFIG" core update-index
arduino-cli --config-file "$ARDUINO_CONFIG" core install esp32:esp32@3.3.10

git clone https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75.git "$WAVESHARE_DIR"
git -C "$WAVESHARE_DIR" checkout --detach e4344e70c2fa78a13e8a06566507f1ba8af6672a

bash tools/arduino.sh build
.venv/bin/python tools/package_release.py --version "$(cat VERSION)"
```

The resulting ZIP files are in `build/release/`. Extract the firmware ZIP and
follow the [installation steps](../README.md#install). Alternatively, from the same
configured shell:

```bash
bash tools/arduino.sh upload /dev/cu.usbmodem2101
```

Replace the example port with your device's port. Use a complete `upload` when
sprites change; `upload-code` is only for application changes with identical
sprite data and partition layout.

On Dan's original Mac, `tools/arduino.sh` also supports the existing Arduino IDE
CLI/configuration and Waveshare checkout as defaults. The explicit environment
variables above avoid depending on those machine-specific paths.

## Regenerate graphics or run the native preview

Ordinary builds wrap the checked-in `.bin` exports into character packs. Re-exporting sprites
requires the art dependencies, but does **not** call an AI service. Use Python
3.11 for this separate environment, matching CI and the pinned NumPy/SciPy wheels:

```bash
python3.11 -m venv build/art-venv
build/art-venv/bin/python -m pip install -r requirements-art.txt
build/art-venv/bin/python characters/copilot/tools/export_sprite_firmware.py
build/art-venv/bin/python tools/character_pack.py build
```

Keep the source PNGs, manifests, and exported binary/JSON together in the same
commit. CI re-exports them and rejects mismatches.
New image generation is a separate, optional paid operation using locally
configured Azure credentials; release workflows never need those credentials.

The preview and native tests additionally require `clang++` and zlib development
headers (Xcode Command Line Tools on macOS, or `clang` and `zlib1g-dev` on Ubuntu):

```bash
.venv/bin/python tools/serve_preview.py
```

Open <http://127.0.0.1:8765>. See [development details](development.md) for the
motion tests, serial controls, artwork pipeline, and measured hardware behavior.

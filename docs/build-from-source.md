# Build from source

Prebuilt [release bundles](../README.md#step-1-flash-the-firmware) are the simplest installation path.
The source-build scripts support macOS and Linux; Windows users can use a release
bundle or a suitable Linux/WSL development environment.

## Build from the Aspire dashboard

For the optional contributor path, install the
[dev-loop prerequisites](development.md#optional-one-command-contributor-loop)
and start from the repository root:

```bash
aspire run
```

Settings and Character Lab start without hardware. The desktop is an explicit
**Start** action after installing its Rust/Tauri prerequisites.
Firmware work is opt-in: install Arduino CLI **1.5.1**, then select a
`companion` action in the dashboard or run its CLI equivalent:

```bash
# Downloads only: pinned ESP32 core and vendor libraries into this checkout.
aspire resource companion firmware-setup --board waveshare-amoled-175

# Builds locally; never opens a USB device.
aspire resource companion firmware-build --board waveshare-amoled-175

# Packages existing build output in build/release; does not publish a release.
aspire resource companion package --board waveshare-amoled-175
```

Select `waveshare-lcd-154` instead when building that board. The dashboard offers
the same board choices from `firmware/boards.json`. Configuration and vendor
sources use `.deps/arduino/` and `.deps/waveshare/`, so the commands don't depend
on Dan's Arduino IDE paths. Set `ARDUINO_CLI` before starting Aspire if the
executable isn't on `PATH`. Toolchain setup downloads dependencies but does not
install an OS service, change hooks, pair a device, or flash anything.

**Flashing is a separate destructive action.** Check the physical board model
and selected USB port first. Stop any installed companion service or other app
using that port. The dev daemon starts with device use disabled. Flashing
requires all three arguments, including the literal confirmation `FLASH`:

```bash
aspire resource companion firmware-flash --board waveshare-amoled-175 \
  --port /dev/cu.usbmodem2101 --confirm FLASH
```

The dashboard also asks for confirmation. The command refuses an occupied port
(requires `lsof`) and delegates to the existing complete-upload script, replacing
both firmware and the default character. No upload ever runs on startup.
The existing artifact freshness and board checks still apply.

If a prerequisite is missing or a build fails, the command returns a failure and
its output is in the AppHost console/logs; long downloads and builds are not
background OS installations. The manual path below remains available without
Aspire.

## Prerequisites

- Git and Python 3.10+.
- [Arduino CLI](https://arduino.github.io/arduino-cli/installation/), version **1.5.1**.
- A USB data cable and a supported Waveshare board (see [Boards](development.md#boards)).

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

# Clones the vendor libraries at the revision pinned in firmware/boards.json.
python3 tools/boards.py fetch-vendor "$WAVESHARE_DIR"

bash tools/arduino.sh build
.venv/bin/python tools/package_release.py --version "$(cat VERSION)"
```

`tools/arduino.sh` builds the default board in `firmware/boards.json`. To select a
board, set `BOARD` (`python3 tools/boards.py list` shows the IDs). See
[Boards](development.md#boards) to add a board.

Each release has a firmware ZIP for every board; the desktop app installs the one
for your board. To build another board from source, such as the Waveshare
ESP32-S3-Touch-LCD-1.54, build and upload from the same configured shell; both
boards use the same `WAVESHARE_DIR`:

```bash
BOARD=waveshare-lcd-154 bash tools/arduino.sh build
BOARD=waveshare-lcd-154 bash tools/arduino.sh upload /dev/cu.usbmodem2101
```

The resulting ZIP files are in `build/release/`. Extract the firmware ZIP and
follow the [flashing steps](../README.md#step-1-flash-the-firmware). Alternatively, from the same
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

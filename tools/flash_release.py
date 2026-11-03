#!/usr/bin/env python3
"""Validate and install an extracted, matched ESP32-S3 firmware release."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ESPTOOL_VERSION = "5.3.0"
MIN_PYTHON = (3, 10)
# The marker lets pip skip esptool on older Pythons so require_python() can explain the fix.
REQUIREMENTS = f'esptool=={ESPTOOL_VERSION}; python_version >= "{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"\n'
FLASH_BYTES = 0x1000000
IMAGE_NAMES = (
    "bin/bootloader.bin", "bin/partitions.bin", "bin/boot_app0.bin",
    "bin/application.bin", "bin/character-copilot.acpk",
)
PAYLOAD_NAMES = (*IMAGE_NAMES, "flash.py", "requirements.txt", "manifest.json", "INSTALL.txt")
WARNING = (
    "WARNING: This replaces the current firmware, partition table, and installed character.\n"
    "NVS bytes at 0x9000..0xe000 are preserved, but settings from an existing layout may be "
    "incompatible. No erase-flash is performed."
)


def validate_identity(name, version):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name, flags=re.ASCII):
        raise ValueError("Name must be a lowercase ASCII slug (letters, digits, single hyphens).")
    if not isinstance(version, str) or not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version, flags=re.ASCII
    ):
        raise ValueError("Version must be stable SemVer MAJOR.MINOR.PATCH (no v prefix).")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _integer(value, label):
    if type(value) is not int or value < 0:
        raise ValueError(f"Invalid {label}: expected a nonnegative integer.")
    return value


def validate_manifest(manifest, files):
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be an object.")
    validate_identity(manifest.get("name"), manifest.get("version"))
    if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
        raise ValueError("Unsupported manifest schema.")
    if manifest.get("chip") != "esp32s3" or manifest.get("flash_size") != "16MB":
        raise ValueError("Unsupported chip or flash size; expected ESP32-S3 with 16MB.")
    # Releases before the board layer have no board field; they are for waveshare-amoled-175.
    board = manifest.get("board", "waveshare-amoled-175")
    if not isinstance(board, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", board, flags=re.ASCII):
        raise ValueError("Invalid board ID in the manifest.")
    images = manifest.get("images")
    if not isinstance(images, list) or len(images) != len(IMAGE_NAMES):
        raise ValueError("Manifest must contain exactly the five supported images.")
    limits = [(0, 0x8000), (0x8000, 0x1000), (0xe000, 0x2000)]
    end = 0
    for index, (image, filename) in enumerate(zip(images, IMAGE_NAMES)):
        if not isinstance(image, dict) or image.get("file") != filename:
            raise ValueError("Invalid image filename or order (unsafe paths are not allowed).")
        offset = _integer(image.get("offset"), "image offset")
        capacity = _integer(image.get("max_size"), "image budget")
        size = _integer(image.get("size"), "image size")
        if index < 3 and (offset, capacity) != limits[index]:
            raise ValueError(f"Unsafe offset or budget for {filename}.")
        if index == 3 and (offset != 0x10000 or capacity != 0x200000):
            raise ValueError("Unsafe application offset or budget; expected a 2 MiB app0 slot at 0x10000.")
        if index == 4 and (offset < end or offset % 0x10000):
            raise ValueError("Unsafe assets offset or partition overlap.")
        if capacity == 0 or size == 0 or size > capacity or offset + capacity > FLASH_BYTES:
            raise ValueError(f"Image exceeds its flash budget: {filename}.")
        if offset < end:
            raise ValueError("Image partitions overlap.")
        end = offset + capacity
        if len(files[filename]) != size or image.get("sha256") != sha256(files[filename]):
            raise ValueError(f"Image size or SHA256 mismatch: {filename}.")
    if manifest.get("asset_sha256") != images[-1]["sha256"]:
        raise ValueError("Asset SHA256 mismatch.")
    return manifest


def _read_file(root, filename):
    path = root / filename
    candidate = path
    while candidate != root:
        if candidate.is_symlink():
            raise ValueError(f"Symlink paths are not allowed: {filename}.")
        candidate = candidate.parent
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Missing or unsafe bundle file: {filename}.")
    # Bound reads even if a downloaded bundle was damaged or maliciously modified.
    limit = FLASH_BYTES if filename in IMAGE_NAMES else 1024 * 1024
    if path.stat().st_size > limit:
        raise ValueError(f"Bundle file exceeds size limit: {filename}.")
    return path.read_bytes()


def verify_bundle(root):
    root = Path(root).resolve()
    files = {name: _read_file(root, name) for name in PAYLOAD_NAMES}
    sums = _read_file(root, "SHA256SUMS").decode("ascii")
    checksums = {}
    for line in sums.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match or match[2] not in PAYLOAD_NAMES or match[2] in checksums:
            raise ValueError("Invalid SHA256SUMS entry (unsafe or duplicate filename).")
        checksums[match[2]] = match[1]
    if set(checksums) != set(PAYLOAD_NAMES):
        raise ValueError("SHA256SUMS must cover every bundle payload file.")
    for name, data in files.items():
        if sha256(data) != checksums[name]:
            raise ValueError(f"SHA256 mismatch: {name}.")
    if files["requirements.txt"] != REQUIREMENTS.encode():
        raise ValueError("Unsupported installer requirements.")
    return validate_manifest(json.loads(files["manifest.json"]), files)


def require_python(version_info=None):
    current = tuple((version_info or sys.version_info)[:2])
    if current >= MIN_PYTHON:
        return
    minimum = f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"
    raise ValueError(
        f"Python {minimum} or newer is required to flash, but this is Python "
        f"{current[0]}.{current[1]} ({sys.executable}).\n"
        f"Install a newer Python from https://www.python.org/downloads/, then recreate the "
        f"environment in this folder with it and reinstall the requirements, for example:\n"
        f"  python3.13 -m venv --clear .venv          (Windows: py -3.13 -m venv --clear .venv)\n"
        f"  .venv/bin/python -m pip install -r requirements.txt"
    )


def require_dependencies():
    require_python()
    command = f'"{sys.executable}" -m pip install esptool=={ESPTOOL_VERSION}'
    try:
        version = importlib.metadata.version("esptool")
    except importlib.metadata.PackageNotFoundError:
        raise ValueError(f"esptool is missing. Install with: {command}") from None
    if version != ESPTOOL_VERSION:
        raise ValueError(f"esptool {ESPTOOL_VERSION} is required (found {version}). Run: {command}")


BOARD_LINE = re.compile(r"BOARD id=([a-z0-9][a-z0-9-]{0,63})(?: |$)")


def open_without_reset(port):
    """Opens `port` without pulsing DTR or RTS, which reset the ESP32-S3. Windows asserts both together."""
    import serial
    if os.name != "posix":
        device = serial.Serial(port=None, baudrate=115200, timeout=0.2)
    else:
        import termios

        class NonResettingSerial(serial.Serial):
            def _update_dtr_state(self):
                pass

            def _update_rts_state(self):
                pass

            def _reconfigure_port(self, force_update=False):
                super()._reconfigure_port(force_update)
                attributes = termios.tcgetattr(self.fd)
                attributes[2] &= ~termios.HUPCL
                termios.tcsetattr(self.fd, termios.TCSANOW, attributes)

        device = NonResettingSerial(port=None, baudrate=115200, timeout=0.2)
    device.port = port
    device.open()
    return device


def read_board(device, seconds=2.0):
    """Asks an open device for its INFO reply and returns the board on its BOARD line, or None."""
    device.reset_input_buffer()
    device.write(b"i")
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        match = BOARD_LINE.match(device.readline().decode("utf-8", errors="replace").strip())
        if match:
            return match[1]
    return None


def reported_board(port, seconds=2.0):
    """The board that Agent Buddy firmware on `port` reports, or None when the device does not say:
    other or older firmware, a device that does not answer, or a port that cannot be opened."""
    try:
        import serial
    except ImportError:
        return None
    try:
        device = open_without_reset(port)
    except (OSError, ValueError, serial.SerialException):
        return None
    try:
        return read_board(device, seconds)
    except (OSError, serial.SerialException):
        return None
    finally:
        device.close()


def flash_command(root, manifest, port):
    command = [
        sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", port,
        "--baud", "460800", "write-flash", "--flash-mode", "keep",
        "--flash-freq", "keep", "--flash-size", "16MB",
    ]
    for image in manifest["images"]:
        command.extend((hex(image["offset"]), str(Path(root) / image["file"])))
    return command


def main(argv=None, root=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Serial port, for example COM3 or /dev/ttyACM0")
    parser.add_argument("--yes", action="store_true", help="Explicitly confirm replacement without prompting")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--verify-only", action="store_true", help="Validate offline; no dependencies or hardware needed")
    actions.add_argument("--list-ports", action="store_true", help="List serial ports without flashing")
    args = parser.parse_args(argv)
    root = Path(root) if root is not None else Path(__file__).resolve().parent
    try:
        if args.list_ports:
            require_dependencies()
            try:
                from serial.tools import list_ports
            except ImportError:
                raise ValueError(
                    f'pyserial is missing. Run: "{sys.executable}" -m pip install '
                    f'--force-reinstall esptool=={ESPTOOL_VERSION}'
                ) from None
            ports = list(list_ports.comports())
            for port in ports:
                print(f"{port.device}: {port.description}")
            if not ports:
                print("No serial ports found. Connect the device with a USB data cable.")
            return 0
        manifest = verify_bundle(root)
        print(f"Verified {manifest['name']} v{manifest['version']} and all five images.")
        print(f"Board: {manifest.get('board', 'waveshare-amoled-175')}. Flash it only to that board.")
        if args.verify_only:
            return 0
        if not args.port:
            raise ValueError("--port is required to flash. Use --list-ports to find your device.")
        require_dependencies()
        # A device that runs Agent Buddy firmware names its board. Firmware for another board can stop
        # it, so a different board is refused. A device that does not say is never assumed to match.
        board = manifest.get("board", "waveshare-amoled-175")
        reported = reported_board(args.port)
        if reported is not None and reported != board:
            raise ValueError(f"The device on {args.port} reports that it is a {reported} board, but this firmware "
                             f"is for {board}. Download the firmware ZIP for {reported} instead.")
        print(f"The device on {args.port} reports that it is a {board} board." if reported is not None
              else f"The device on {args.port} does not report its board. Check that it is a {board} board.")
        print(WARNING)
        if not args.yes and input("Type FLASH to replace the device firmware: ").strip() != "FLASH":
            raise ValueError("Flash cancelled; confirmation was not FLASH.")
        subprocess.run(flash_command(root, manifest, args.port), check=True)
        return 0
    except (OSError, ValueError, KeyError, TypeError, EOFError, KeyboardInterrupt, subprocess.CalledProcessError) as error:
        print(f"Installer error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

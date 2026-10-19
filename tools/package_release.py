#!/usr/bin/env python3
"""Package fresh matched firmware and character packs without rebuilding or exporting."""
import argparse
import json
from pathlib import Path
import re
import sys
import zipfile

if __package__:
    from . import character_pack, firmware_artifacts
    from .flash_release import IMAGE_NAMES, REQUIREMENTS, WARNING, sha256, validate_identity, validate_manifest
else:
    import character_pack
    import firmware_artifacts
    from flash_release import IMAGE_NAMES, REQUIREMENTS, WARNING, sha256, validate_identity, validate_manifest

ROOT = Path(__file__).resolve().parents[1]
# The desktop daemon downloads <RELEASE_NAME>-v<version>-firmware.zip from RELEASE_REPOSITORY.
# Keep these the same as releaseName and releaseRepository in daemon/src/firmware-release.ts.
RELEASE_NAME = "agent-buddy"
RELEASE_REPOSITORY = "DanWahlin/agent-buddy"

def checksum_file(files):
    return "".join(f"{sha256(data)}  {name}\n" for name, data in sorted(files.items())).encode("ascii")


def write_zip(path, files):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, data)


def package(root, version, name=RELEASE_NAME, output=None, repository=RELEASE_REPOSITORY, board=None):
    """Packages one board's firmware ZIP, the characters ZIP, and the release's SHA256SUMS.

    The board is the selected one (BOARD, else the default). Each board's ZIP is named for it, so
    packaging every board into one folder gives a release with a firmware ZIP for each board.
    """
    root = Path(root)
    validate_identity(name, version)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository, flags=re.ASCII):
        raise ValueError("Repository must be an owner/repository pair.")
    board_id = board or firmware_artifacts.selected_board()
    build, _, bundle_path = firmware_artifacts.artifacts(board_id)
    firmware_artifacts.check(root, board_id)
    if json.loads((root / bundle_path).read_text())["inputs"]["board"] != board_id:
        raise ValueError(f"The firmware in {build.as_posix()} is not for {board_id}.")
    board_data = firmware_artifacts.boards.load()
    board_entry = board_data["boards"][board_id]
    app, assets = firmware_artifacts.layout(root)
    if not (root / character_pack.CHARACTERS / "built-in.json").is_file():
        raise ValueError("characters/built-in.json is required for release packaging.")
    characters = {}
    for source in character_pack.discover_characters(root):
        pack_id = source.name
        path = root / character_pack.OUTPUT / f"{pack_id}.acpk"
        data = path.read_bytes()
        if character_pack.decode(data, assets["size"])["id"] != pack_id:
            raise ValueError(f"Character pack {pack_id}.acpk has a different id.")
        characters[f"{pack_id}.acpk"] = data
    if not characters:
        raise ValueError("No character packs found in build/characters.")
    sources = (
        (build / "AgentCompanion.ino.bootloader.bin").as_posix(),
        (build / "AgentCompanion.ino.partitions.bin").as_posix(),
        (build / "boot_app0.bin").as_posix(),
        (build / "AgentCompanion.ino.bin").as_posix(),
        str(firmware_artifacts.DEFAULT_PACK),
    )
    regions = [(0, 0x8000), (0x8000, 0x1000), (0xe000, 0x2000),
               (app["offset"], app["size"]), (assets["offset"], assets["size"])]
    files = {}
    images = []
    for filename, source, (offset, budget) in zip(IMAGE_NAMES, sources, regions):
        path = root / source
        if not 0 < path.stat().st_size <= budget:
            raise ValueError(f"Image exceeds its partition budget or is empty: {source}.")
        data = path.read_bytes()
        files[filename] = data
        images.append(dict(file=filename, offset=offset, max_size=budget, size=len(data), sha256=sha256(data)))
    manifest = dict(schema_version=1, name=name, version=version, board=board_id,
                    chip=board_entry["chip"], flash_size=board_entry["flash_size"], asset_sha256=images[-1]["sha256"],
                    images=images)
    validate_manifest(manifest, files)
    files["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    files["flash.py"] = (root / "tools/flash_release.py").read_bytes()
    files["requirements.txt"] = (root / "requirements-flash.txt").read_bytes()
    if files["requirements.txt"] != REQUIREMENTS.encode():
        raise ValueError(f"requirements-flash.txt must be exactly: {REQUIREMENTS.strip()}")
    files["INSTALL.txt"] = (
        f"{name} v{version} — {board_entry['name']} ({board_id})\n"
        f"Chip: {board_entry['chip']} / {board_entry['flash_size']} flash\n"
        f"Flash this firmware only to: {board_entry.get('models') or board_entry['name']}.\n"
        "Firmware for a different board does not work and can stop the device until it is flashed again.\n\n"
        "Download both ZIPs and SHA256SUMS from a trusted release:\n"
        f"https://github.com/{repository}/releases/tag/v{version}\n"
        "Compare the ZIP SHA256 hashes with that release's SHA256SUMS before extracting.\n"
        "Checksums detect corruption; they are not signatures or proof of publisher identity.\n\n"
        "Extract the firmware ZIP into its own directory. Use Python 3.10 or newer.\n"
        "Open a terminal in the extracted directory (use python3 if needed):\n"
        "  python flash.py --verify-only\n"
        "  python -m venv .venv\n"
        "Activate: Windows: .venv\\Scripts\\activate\n"
        "          macOS/Linux: source .venv/bin/activate\n"
        "  python -m pip install -r requirements.txt\n"
        "  python flash.py --list-ports\n"
        "  python flash.py --port COM3\n"
        "Replace COM3 with your actual port, for example /dev/ttyACM0.\n"
        "Use a USB data cable. Type FLASH when prompted; --yes skips only this prompt.\n\n"
        f"{WARNING}\n\n"
        "The device starts with the Copilot character. The characters ZIP holds every built-in\n"
        "pack; install one with the companion daemon from a source checkout:\n"
        "  npm run character path/to/openclaw.acpk\n"
    ).encode("utf-8")
    # Recheck after reading so changes during packaging cannot create a mismatched release.
    firmware_artifacts.check(root, board_id)
    recorded = json.loads((root / bundle_path).read_text())
    expected = dict(recorded["binaries"])
    expected.update(recorded["inputs"]["files"])
    for filename, source in zip(IMAGE_NAMES, sources):
        if sha256(files[filename]) != expected[source]:
            raise ValueError(f"Firmware changed while packaging: {source}.")
    for filename, data in characters.items():
        if (root / character_pack.OUTPUT / filename).read_bytes() != data:
            raise ValueError(f"Character pack {filename} changed while packaging.")
    files["SHA256SUMS"] = checksum_file(files)
    output = Path(output) if output is not None else root / "build/release"
    output.mkdir(parents=True, exist_ok=True)
    # The default board keeps the original name, which earlier companion daemons download.
    firmware_zip = output / firmware_zip_name(name, version, board_id, board_data["default"])
    characters_zip = output / f"{name}-v{version}-characters.zip"
    write_zip(firmware_zip, files)
    write_zip(characters_zip, characters)
    # Every board's firmware ZIP of this version that is in the folder, so packaging the boards one
    # after another gives one SHA256SUMS for the release.
    released = sorted(output.glob(f"{name}-v{version}-*firmware.zip")) + [characters_zip]
    (output / "SHA256SUMS").write_bytes(checksum_file({path.name: path.read_bytes() for path in released}))
    return firmware_zip, characters_zip


def firmware_zip_name(name, version, board_id, default_board):
    """The release asset with a board's firmware. Keep this the same as firmwareAssetName in
    daemon/src/firmware-release.ts."""
    suffix = "" if board_id == default_board else f"-{board_id}"
    return f"{name}-v{version}{suffix}-firmware.zip"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default=RELEASE_NAME, help="Lowercase ASCII release slug")
    parser.add_argument("--version", required=True, help="Stable SemVer without a v prefix")
    parser.add_argument("--output", type=Path, default=ROOT / "build/release")
    parser.add_argument("--repository", default=RELEASE_REPOSITORY,
                        help="Owner/repository for INSTALL links")
    parser.add_argument("--all-boards", action="store_true",
                        help="Package the firmware of every board in firmware/boards.json; each must be built")
    args = parser.parse_args(argv)
    try:
        board_ids = list(firmware_artifacts.boards.load()["boards"]) if args.all_boards else [None]
        for board_id in board_ids:
            for path in package(ROOT, args.version, args.name, args.output, args.repository, board_id):
                print(path)
        print(args.output / "SHA256SUMS")
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Release packaging error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

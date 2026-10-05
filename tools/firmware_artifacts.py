#!/usr/bin/env python3
"""Keep firmware, partition table, and the default character pack a matched set."""
import argparse
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = Path("build/firmware-inputs.json")
BUNDLE = Path("build/firmware-bundle.json")
DEFAULT_PACK = Path("build/characters/copilot.acpk")
BINARIES = tuple(Path("build/firmware") / f"AgentCompanion.ino{suffix}.bin"
                 for suffix in ("", ".bootloader", ".partitions")) + (Path("build/firmware/boot_app0.bin"),)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def layout(root):
    with (root / "firmware/AgentCompanion/partitions.csv").open() as source:
        rows = [row for row in csv.reader(line for line in source if line.strip() and not line.lstrip().startswith("#"))]
    partitions = {}
    for row in rows:
        if len(row) < 5:
            raise ValueError("Invalid partition CSV row.")
        name, kind, subtype, offset, size = (field.strip() for field in row[:5])
        if name in partitions:
            raise ValueError(f"Duplicate partition: {name}")
        partitions[name] = dict(kind=kind, subtype=subtype, offset=int(offset, 0), size=int(size, 0))
    if not {"otadata", "app0", "app1", "assets"} <= partitions.keys():
        raise ValueError("The otadata, app0, app1 and assets partitions are required.")
    regions = sorted(partitions.values(), key=lambda item: item["offset"])
    end = 0x9000
    for item in regions:
        if item["offset"] < end or item["size"] <= 0 or item["offset"] + item["size"] > 0x1000000:
            raise ValueError("Partition overlap or invalid 16 MiB flash bounds.")
        end = item["offset"] + item["size"]
    app, spare, assets = partitions["app0"], partitions["app1"], partitions["assets"]
    if app["kind"] != "app" or app["subtype"] != "ota_0" or app["offset"] != 0x10000:
        raise ValueError("Application slot app0 (ota_0) must start at 0x10000.")
    # Updates over Wi-Fi write the other slot, so it must hold the same application.
    if spare["kind"] != "app" or spare["subtype"] != "ota_1" or spare["size"] != app["size"]:
        raise ValueError("Application slot app1 (ota_1) must match app0's size.")
    if partitions["otadata"]["offset"] != 0xE000:
        raise ValueError("otadata must be at 0xE000, where boot_app0.bin is written.")
    if assets["kind"] != "data" or int(assets["subtype"], 0) != 0x40 or assets["offset"] % 0x10000:
        raise ValueError("Assets require a 64 KiB-aligned data partition with subtype 0x40.")
    return app, assets


def fingerprint(root):
    app, assets = layout(root)
    pack = root / DEFAULT_PACK
    if not 0 < pack.stat().st_size <= assets["size"]:
        raise ValueError("Default character pack is empty or exceeds the assets partition.")
    paths = sorted(path for path in (root / "firmware/AgentCompanion").rglob("*")
                   if path.is_file() and path.suffix in (".ino", ".h", ".cpp", ".S", ".csv"))
    paths.append(pack)
    return dict(app=app, assets=assets, files={path.relative_to(root).as_posix(): digest(path) for path in paths})


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def snapshot(root):
    write_json(root / INPUTS, fingerprint(root))


def record(root):
    inputs = fingerprint(root)
    if inputs != json.loads((root / INPUTS).read_text()):
        raise ValueError("Firmware inputs changed during compilation. Build again before uploading.")
    if (root / BINARIES[0]).stat().st_size > inputs["app"]["size"]:
        raise ValueError("Compiled application exceeds its partition.")
    write_json(root / BUNDLE, dict(inputs=inputs, binaries={path.as_posix(): digest(root / path) for path in BINARIES}))


def check(root):
    bundle = json.loads((root / BUNDLE).read_text())
    if bundle["inputs"] != fingerprint(root):
        raise ValueError("Firmware or the default character changed since compilation. Run tools/arduino.sh build first.")
    if bundle["binaries"] != {path.as_posix(): digest(root / path) for path in BINARIES}:
        raise ValueError("Compiled firmware artifacts changed. Build again before uploading.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("snapshot", "record", "check", "app-size", "asset-offset"))
    args = parser.parse_args()
    try:
        if args.action == "app-size":
            print(layout(ROOT)[0]["size"])
        elif args.action == "asset-offset":
            print(hex(layout(ROOT)[1]["offset"]))
        else:
            {"snapshot": snapshot, "record": record, "check": check}[args.action](ROOT)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Firmware bundle error: {error}\n")


if __name__ == "__main__":
    main()

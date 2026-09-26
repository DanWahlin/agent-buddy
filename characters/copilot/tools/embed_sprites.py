#!/usr/bin/env python3
"""Validate the Copilot sprite export used to build its character pack.

Run characters/copilot/tools/export_sprite_firmware.py first. tools/character_pack.py wraps the
validated payload and frame table into build/characters/copilot.acpk.
Validation needs only the standard library. Input manifest and PNG hashes are
checked on every build to reject stale committed exports.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REGENERATE = "Regenerate with: python3 characters/copilot/tools/export_sprite_firmware.py"
IDLE_MANIFEST = "characters/copilot/sprites/animation.json"
EXPRESSION_MANIFEST = "characters/copilot/expressions/animation.json"
IDLE_DIRECTIONS = ("right", "left", "up", "down", "up_right", "up_left",
                   "down_right", "down_left")
EXPRESSION_DIRECTIONS = ("surprise", "working", "complete", "attention", "attention_alternate")
SPRITE_STEPS = 24


def track_layout(directions):
    counts = [((SPRITE_STEPS - 1) // 2 + 1) if direction in ("up", "down") else SPRITE_STEPS
              for direction in directions]
    offsets = []
    offset = 0
    for count in counts:
        offsets.append(offset)
        offset += count
    return counts, offsets


def read_assets_partition(root=ROOT):
    path = root / "firmware/AgentCompanion/partitions.csv"
    raw = path.read_bytes()

    def number(value):
        value = value.strip()
        multiplier = 1
        if value[-1:].upper() in ("K", "M"):
            multiplier = 1024 if value[-1:].upper() == "K" else 1024 * 1024
            value = value[:-1]
        return int(value, 16 if value.lower().startswith("0x") else 10) * multiplier

    rows = [[cell.strip() for cell in row] for row in
            csv.reader(line for line in raw.decode("utf-8").splitlines()
                       if line.strip() and not line.lstrip().startswith("#"))]
    matches = [row for row in rows if row and row[0] == "assets"]
    if len(matches) != 1 or len(matches[0]) < 5:
        raise ValueError("partitions.csv must contain exactly one named assets partition.")
    name, kind, subtype, offset_text, size_text = matches[0][:5]
    try:
        offset, size = number(offset_text), number(size_text)
        valid_type = kind == "data" or number(kind) == 1
        valid_subtype = number(subtype) == 0x40
    except ValueError as error:
        raise ValueError("Invalid assets partition type, subtype, offset, or size.") from error
    if (not valid_type or not valid_subtype or offset < 0x10000 or offset % 0x10000
            or size <= 0 or size % 4096 or offset + size > 16 * 1024 * 1024):
        raise ValueError("Invalid assets data partition bounds/type; require subtype 0x40 within 16 MiB flash.")
    for row in rows:
        if row[0] == name or len(row) < 5 or not row[3]:
            continue
        other_offset, other_size = number(row[3]), number(row[4])
        if offset < other_offset + other_size and other_offset < offset + size:
            raise ValueError(f"Assets partition overlaps {row[0]}.")
    return {"name": name, "type": "data", "subtype": 0x40, "offset": offset, "size": size,
            "manifest": path.relative_to(root).as_posix(),
            "manifestSha256": hashlib.sha256(raw).hexdigest()}


def validate_sources(root, metadata):
    def checked_path(directory, name):
        if not isinstance(name, str) or not name or Path(name).is_absolute():
            raise ValueError(f"Invalid sprite provenance path: {name!r}. {REGENERATE}")
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError(f"Sprite provenance path escapes its directory: {name!r}. {REGENERATE}")
        return path

    def check_hash(path, expected):
        try:
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise ValueError(f"Cannot verify sprite source {path}: {error}. {REGENERATE}") from error
        if actual != expected:
            raise ValueError(f"Stale sprite export: source hash mismatch for {path}. {REGENERATE}")

    manifests = metadata.get("sourceManifests")
    expected_manifests = {IDLE_MANIFEST}
    if (root / EXPRESSION_MANIFEST).exists():
        expected_manifests.add(EXPRESSION_MANIFEST)
    if not isinstance(manifests, dict) or set(manifests) != expected_manifests:
        raise ValueError(f"Stale sprite export: source manifest inventory changed. {REGENERATE}")
    for name, record in manifests.items():
        manifest = checked_path(root, name)
        check_hash(manifest, record.get("sha256"))
        inventory = record.get("sourcePngSha256")
        if not isinstance(inventory, dict) or not inventory:
            raise ValueError(f"Missing sprite source PNG hash inventory. {REGENERATE}")
        for png, digest in inventory.items():
            check_hash(checked_path(manifest.parent, png), digest)
    sources = metadata.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError(f"Missing sprite generation provenance. {REGENERATE}")
    for source in sources.values():
        if not isinstance(source, dict) or source.get("provider") != "Azure GPT Image":
            raise ValueError(f"Unsupported sprite source provider. {REGENERATE}")
        check_hash(checked_path(root, source.get("source")), source.get("sourceSha256"))
        if "generationManifest" in source:
            check_hash(checked_path(root, source["generationManifest"]),
                       source.get("generationManifestSha256"))


def embed(root=ROOT):
    source = root / "characters/copilot/frames.bin"
    data = source.read_bytes()
    partition = read_assets_partition(root)
    if not data or len(data) > partition["size"]:
        raise ValueError(f"Sprite assets are empty or exceed the assets partition budget. {REGENERATE}")
    digest = hashlib.sha256(data).hexdigest()
    metadata = json.loads((root / "characters/copilot/frames.json").read_text())
    if (metadata.get("formatVersion") != 4 or metadata.get("profile") != "display-ready"
            or metadata.get("storage") != "flash-partition"
            or metadata.get("encoding") != "zlib-rgb565-word-up-be"
            or metadata.get("displayReady") is not True
            or metadata.get("width") != 412 or metadata.get("height") != 352
            or metadata.get("resampling") != {
                "algorithm": "rgb565-bilinear-5bit-v1",
                "sourceWidth": 240, "sourceHeight": 224, "drawWidth": 396,
                "coordinatePrecision": "float32", "coordinateOrigin": "pixel-center",
                "weightRounding": "lround", "weightDenominator": 32,
                "channelRounding": "floor-horizontal-then-vertical",
            }):
        raise ValueError(f"Stale or unsupported sprite export profile/encoding. {REGENERATE}")
    directions = list(IDLE_DIRECTIONS)
    if (root / EXPRESSION_MANIFEST).exists():
        directions.extend(EXPRESSION_DIRECTIONS)
    bounds = metadata.get("baseBounds")
    if (not isinstance(bounds, list) or len(bounds) != 4 or any(type(n) is not int for n in bounds)
            or min(bounds[:2]) < 0 or min(bounds[2:]) <= 0
            or bounds[0] + bounds[2] > metadata["width"]
            or bounds[1] + bounds[3] > metadata["height"]):
        raise ValueError(f"Invalid sprite base bounds. {REGENERATE}")
    counts, offsets = track_layout(directions)
    metadata_bytes = sum(counts) * 48 + len(directions) * 3 + 4 + 32
    expected_frames = [(direction, step) for direction, count in zip(directions, counts)
                       for step in range(count)]
    actual_frames = [(frame.get("direction"), frame.get("step")) for frame in metadata.get("frames", [])]
    if (metadata.get("directions") != directions or metadata.get("frameCount") != sum(counts)
            or metadata.get("steps") != SPRITE_STEPS
            or metadata.get("trackSteps") != counts or metadata.get("trackOffsets") != offsets
            or actual_frames != expected_frames
            or metadata.get("dataSha256") != digest or metadata.get("dataBytes") != len(data)
            or metadata.get("metadataBytes") != metadata_bytes
            or metadata.get("totalAssetBytes") != len(data) + metadata_bytes):
        raise ValueError(f"Sprite binary/metadata mismatch. {REGENERATE}")
    if metadata.get("partition") != partition or metadata.get("assetBudgetBytes") != partition["size"]:
        raise ValueError(f"Stale sprite assets partition metadata. {REGENERATE}")
    validate_sources(root, metadata)
    for obsolete in ("firmware/AgentCompanion/generated/sprite_bytes.h", "build/sprite_host.S"):
        if (root / obsolete).exists():
            (root / obsolete).unlink()
    print(f"Sprite partition payload: {len(data):,} / {partition['size']:,} bytes, SHA256 {digest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        embed()
    except (ValueError, OSError) as error:
        parser.exit(1, f"Sprite embedding failed: {error}\n")


if __name__ == "__main__":
    main()

# Character pack validators expose validate(root) for the generic packer.
def validate(root=ROOT):
    return embed(root)

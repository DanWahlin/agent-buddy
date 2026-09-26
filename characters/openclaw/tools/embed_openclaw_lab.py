#!/usr/bin/env python3
"""Validate the committed OpenClaw lab export used to build its character pack."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = ROOT / "characters/openclaw"
TRACKS = (
    "right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left",
    "surprise", "working", "complete", "attention", "attention_alternate",
)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(root=ROOT):
    character = root / "characters/openclaw"
    data = (character / "frames.bin").read_bytes()
    metadata = json.loads((character / "frames.json").read_text())
    blocks = metadata.get("blocks")
    if (metadata.get("formatVersion") != 1
            or metadata.get("encoding") != "zlib-rgb565-word-up-be"
            or metadata.get("width") != 412 or metadata.get("height") != 352
            or metadata.get("steps") != 24 or tuple(metadata.get("directions", [])) != TRACKS
            or metadata.get("frameBlocks") != 13 * 24 * 5
            or not isinstance(blocks, list) or len(blocks) != 13 * 24 * 5
            or metadata.get("dataBytes") != len(data)
            or metadata.get("dataSha256") != hashlib.sha256(data).hexdigest()):
        raise ValueError("OpenClaw lab pack metadata is stale or invalid.")
    for index, block in enumerate(blocks):
        if (not isinstance(block, list) or len(block) != 2
                or any(type(value) is not int or value < 0 for value in block)
                or block[1] == 0 or block[0] + block[1] > len(data)):
            raise ValueError(f"OpenClaw block {index} is invalid.")
    checks = {
        "modelSha256": character / "model/model.js",
        "exporterSha256": character / "model/export-sprites.mjs",
        "packExporterSha256": character / "tools/export_openclaw_lab.py",
        "packageLockSha256": character / "model/package-lock.json",
        "referenceSvgSha256": character / "reference/reference.svg",
        "manifestSha256": character / "renders/animation.json",
    }
    for field, path in checks.items():
        if metadata.get(field) != sha(path):
            raise ValueError(f"OpenClaw lab pack is stale for {path}.")
    png_hashes = metadata.get("sourcePngSha256")
    if not isinstance(png_hashes, dict) or not png_hashes:
        raise ValueError("OpenClaw source PNG inventory is missing.")
    for name, expected in png_hashes.items():
        path = character / "renders" / name
        if expected != sha(path):
            raise ValueError(f"OpenClaw lab pack is stale for {path}.")
    print(f"OpenClaw lab payload: {len(data):,} bytes, SHA256 {metadata['dataSha256']}")


if __name__ == "__main__":
    validate()

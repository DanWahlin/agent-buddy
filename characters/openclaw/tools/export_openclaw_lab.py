#!/usr/bin/env python3
"""Export deterministic OpenClaw Three.js renders as a host RGB565 sprite pack."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))

from sprite_export import BlockStore, display_pixels, read_png, rgb565, write_if_changed

CHARACTER = ROOT / "characters/openclaw"
SOURCE = CHARACTER / "renders"
OUTPUT = CHARACTER / "frames.bin"
METADATA = CHARACTER / "frames.json"
TRACKS = (
    "right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left",
    "surprise", "working", "complete", "attention", "attention_alternate",
)
STEPS = 24
BLINKS = 5


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest_path = SOURCE / "animation.json"
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("width"), manifest.get("height"), manifest.get("count")) != (240, 224, STEPS):
        raise ValueError("OpenClaw sprite manifest dimensions or step count are invalid.")
    if tuple(manifest.get("directions", {}).keys()) != TRACKS:
        raise ValueError("OpenClaw sprite manifest must contain the canonical thirteen tracks.")
    store = BlockStore(ROOT / "build/openclaw-compression")
    packed_frames = []
    png_hashes = {}
    for track in TRACKS:
        frames = manifest["directions"][track].get("frames")
        if not isinstance(frames, list) or len(frames) != STEPS:
            raise ValueError(f"OpenClaw track {track} must contain 24 frames.")
        for step, frame in enumerate(frames):
            names = [frame.get("file"), *frame.get("blinks", [])]
            if len(names) != BLINKS:
                raise ValueError(f"OpenClaw track {track} frame {step} must contain five blink levels.")
            packed = []
            for name in names:
                path = SOURCE / name
                pixels, png_hash = read_png(path, (240, 224))
                png_hashes[name] = png_hash
                packed.append(display_pixels(rgb565(pixels)).tobytes())
            packed_frames.append(packed)
    frame_blocks = [[None] * BLINKS for _ in packed_frames]
    group_ends = []
    # Keep normal open-eye playback contiguous; blink variants are colder data.
    for blink in range(BLINKS):
        for index, packed in enumerate(packed_frames):
            frame_blocks[index][blink] = store.add(packed[blink], 412)
        group_ends.append(len(store.data))
    blocks = [block for frame in frame_blocks for block in frame]
    if len(blocks) != len(TRACKS) * STEPS * BLINKS:
        raise ValueError("OpenClaw block count is invalid.")
    write_if_changed(OUTPUT, bytes(store.data))
    metadata = {
        "formatVersion": 1,
        "encoding": "zlib-rgb565-word-up-be",
        "width": 412,
        "height": 352,
        "sourceWidth": 240,
        "sourceHeight": 224,
        "steps": STEPS,
        "blinkLevels": [1, .75, .5, .25, 0],
        "directions": list(TRACKS),
        "frameBlocks": len(blocks),
        "blocks": [[block["offset"], block["size"]] for block in blocks],
        "openDataBytes": group_ends[0],
        "dataBytes": len(store.data),
        "dataSha256": hashlib.sha256(store.data).hexdigest(),
        "uniqueBlocks": len(store.blocks),
        "modelSha256": digest(CHARACTER / "model/model.js"),
        "exporterSha256": digest(CHARACTER / "model/export-sprites.mjs"),
        "packExporterSha256": digest(CHARACTER / "tools/export_openclaw_lab.py"),
        "packageLockSha256": digest(CHARACTER / "model/package-lock.json"),
        "referenceSvgSha256": digest(CHARACTER / "reference/reference.svg"),
        "manifestSha256": digest(manifest_path),
        "sourcePngSha256": png_hashes,
    }
    write_if_changed(METADATA, json.dumps(metadata, indent=2) + "\n")
    print(f"OpenClaw sprite pack: {len(store.data):,} bytes, {len(store.blocks)} unique blocks")


if __name__ == "__main__":
    main()

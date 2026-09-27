#!/usr/bin/env python3
"""Export Claude's rendered cells as a base-patch character pack payload.

Reads sprites/animation.json (13 tracks x 24 poses x 5 blink levels, 240x224 cells)
and writes frames.bin and frames.json beside character.json, in the same base-patch
format Copilot uses: one shared nonblack crop per open pose, plus one rectangle per
pose holding only what the four blink levels change. Run it after
render_claude_sheet.py and build_claude_animation.py, then run
tools/character_pack.py build. Outputs are deterministic; validate_frames.py is the
pack builder's check that they still match the committed cells.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "tools"), str(CHARACTER / "tools")]

from character_pack import MODEL_TRACK_STEPS, read_assets_partition, track_offsets
from sprite_export import (BlockStore, DISPLAY_HEIGHT, DISPLAY_WIDTH, HEIGHT, WIDTH,
                           contained_path, display_pixels, read_png, rgb565, sha256,
                           write_if_changed)
from validate_frames import (BLINK_LEVELS, DIRECTIONS, FRAMES, MANIFEST, METADATA, REGENERATE,
                             STEPS, manifest_path)

FRAME_RECORD_BYTES = 48


def load_tracks(manifest):
    if manifest.get("order") != list(DIRECTIONS):
        raise ValueError(f"animation.json must list the 13 tracks in canonical order. {REGENERATE}")
    if manifest.get("blinkLevels") != BLINK_LEVELS:
        raise ValueError(f"Expected blinkLevels={BLINK_LEVELS}.")
    tracks = {**manifest.get("directions", {}), **manifest.get("expressions", {})}
    if set(tracks) != set(DIRECTIONS):
        raise ValueError("animation.json must hold exactly the 8 idle and 5 expression tracks.")
    for direction in DIRECTIONS:
        track = tracks[direction]
        if (track.get("width"), track.get("height"), track.get("count")) != (WIDTH, HEIGHT, STEPS):
            raise ValueError(f"{direction} must be {STEPS} cells of {WIDTH}x{HEIGHT}.")
        frames = track.get("frames")
        if not isinstance(frames, list) or len(frames) != STEPS:
            raise ValueError(f"Expected {STEPS} frames for {direction}.")
        for step, frame in enumerate(frames):
            if not isinstance(frame.get("blinks"), list) or len(frame["blinks"]) != 4:
                raise ValueError(f"Expected four blink files for {direction}/{step}.")
    return [(direction, tracks[direction]["frames"]) for direction in DIRECTIONS]


def patch_bounds(base, blinks):
    changed = np.logical_or.reduce([blink != base for blink in blinks])
    rows, columns = np.nonzero(changed)
    if not len(columns):
        return 0, 0, 0, 0
    x, y = int(columns.min()), int(rows.min())
    return x, y, int(columns.max()) + 1 - x, int(rows.max()) + 1 - y


def build_assets(root=ROOT):
    partition = read_assets_partition(root)
    manifest_bytes = MANIFEST.read_bytes()
    tracks = load_tracks(json.loads(manifest_bytes))
    png_hashes = {}
    decoded = []
    for (direction, frames), count in zip(tracks, MODEL_TRACK_STEPS):
        poses = []
        for step, frame in enumerate(frames):
            levels = []
            for filename in [frame["file"], *frame["blinks"]]:
                pixels, digest = read_png(contained_path(MANIFEST.parent, filename), (WIDTH, HEIGHT))
                png_hashes[filename] = digest
                levels.append(display_pixels(rgb565(pixels)))
            poses.append(levels)
        decoded.append((direction, poses, count))

    # Every track starts on the same neutral pose, and surprise springs back to it; the
    # motion engine passes through that pose on every transition, so a mismatch pops.
    center = [level.tobytes() for level in decoded[0][1][0]]
    for direction, poses, _ in decoded:
        if [level.tobytes() for level in poses[0]] != center:
            raise ValueError(f"{direction} frame 0 differs from the shared neutral pose.")
    surprise = dict((direction, poses) for direction, poses, _ in decoded)["surprise"]
    if [level.tobytes() for level in surprise[-1]] != center:
        raise ValueError("surprise must end on the shared neutral pose in all five blink levels.")

    occupied = np.zeros((DISPLAY_HEIGHT, DISPLAY_WIDTH), dtype=bool)
    for _, poses, count in decoded:
        for levels in poses[:count]:
            for level in levels:
                occupied |= level != 0
    rows, columns = np.nonzero(occupied)
    base_x, base_y = int(columns.min()), int(rows.min())
    base_width, base_height = int(columns.max()) + 1 - base_x, int(rows.max()) + 1 - base_y

    store = BlockStore(root / "build/sprite-compression")
    frames, max_patch_pixels = [], 0
    for direction, poses, count in decoded:
        for step, (base, *blinks) in enumerate(poses[:count]):
            x, y, width, height = patch_bounds(base, blinks)
            max_patch_pixels = max(max_patch_pixels, width * height)
            frames.append({
                "direction": direction, "step": step,
                "base": store.add(base[base_y:base_y + base_height,
                                       base_x:base_x + base_width].tobytes(), base_width),
                "patchX": x, "patchY": y, "patchWidth": width, "patchHeight": height,
                "blinks": [store.add(blink[y:y + height, x:x + width].tobytes(), width)
                           for blink in blinks],
            })
    if len(store.data) > partition["size"]:
        raise ValueError(f"Claude's frames exceed the character partition: "
                         f"{len(store.data):,} > {partition['size']:,} bytes.")
    metadata_bytes = len(frames) * FRAME_RECORD_BYTES + len(DIRECTIONS) * 3 + 4 + 32
    metadata = {
        "layout": "base-patch", "encoding": "zlib-rgb565-word-up-be",
        "width": DISPLAY_WIDTH, "height": DISPLAY_HEIGHT,
        "baseBounds": [base_x, base_y, base_width, base_height],
        "steps": STEPS, "directions": list(DIRECTIONS),
        "trackSteps": MODEL_TRACK_STEPS, "trackOffsets": track_offsets(MODEL_TRACK_STEPS),
        "frameCount": len(frames), "blinkLevels": BLINK_LEVELS,
        "maxPatchPixels": max_patch_pixels, "maxPatchBytes": max_patch_pixels * 2,
        "dataBytes": len(store.data), "dataSha256": sha256(store.data),
        "metadataBytes": metadata_bytes, "partitionBytes": partition["size"],
        "uniqueBlocks": len(store.blocks), "blockReferences": store.references,
        "sourceManifest": {"path": manifest_path(root), "sha256": sha256(manifest_bytes),
                           "pngSha256": png_hashes},
        "frames": frames,
    }
    return bytes(store.data), metadata


def export(root=ROOT):
    data, metadata = build_assets(root)
    write_if_changed(FRAMES, data)
    write_if_changed(METADATA, json.dumps(metadata, indent=2) + "\n")
    print(f"Claude frames: {len(data):,} bytes ({len(data) / 1024**2:.3f} MiB) of "
          f"{metadata['partitionBytes']:,}; {metadata['uniqueBlocks']} unique blocks; "
          f"max patch {metadata['maxPatchPixels']:,} pixels")
    print(f"SHA256 {metadata['dataSha256']}\nNext: python3 tools/character_pack.py build")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.parse_args()
    try:
        export()
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"Claude export failed: {error}\n")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Export display-ready sprites as RGB565 word-Up Zopfli zlib blocks.

Run with the project's Python environment, then run tools/character_pack.py build.
Open poses share one global nonblack crop. Blink levels replace one shared rectangle,
the union of their changed RGB565 pixels; unchanged poses use no patch data.
Identical uncompressed blocks share storage, including every center pose.
The fixed 5-bit bilinear scaler reproduces the former firmware scaler exactly,
including RGB565 truncation before scaling and float32 pixel-center mapping.
Outputs are deterministic and unchanged files retain their modification times.
Prediction resets per block; cached offline compression lives under build/.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))

from embed_sprites import (EXPRESSION_DIRECTIONS, EXPRESSION_MANIFEST, SPRITE_STEPS,
                          read_assets_partition, track_layout)
from sprite_compression import ENCODING
from sprite_export import (BlockStore, contained_path, display_pixels, read_png, rgb565,
                           sha256, write_if_changed)

WIDTH, HEIGHT, STEPS = 240, 224, SPRITE_STEPS
DISPLAY_WIDTH, DISPLAY_HEIGHT, DRAW_WIDTH = 412, 352, 396
PROFILE = "display-ready"
RESAMPLING = {
    "algorithm": "rgb565-bilinear-5bit-v1",
    "sourceWidth": WIDTH, "sourceHeight": HEIGHT, "drawWidth": DRAW_WIDTH,
    "coordinatePrecision": "float32", "coordinateOrigin": "pixel-center",
    "weightRounding": "lround", "weightDenominator": 32,
    "channelRounding": "floor-horizontal-then-vertical",
}
DIRECTIONS = ("right", "left", "up", "down", "up_right", "up_left",
              "down_right", "down_left")
BLINK_LEVELS = [1, 0.75, 0.5, 0.25, 0]


def patch_bounds(base, blinks):
    changed = np.logical_or.reduce([blink != base for blink in blinks])
    yy, xx = np.nonzero(changed)
    if not len(xx):
        return 0, 0, 0, 0
    x, y = int(xx.min()), int(yy.min())
    return x, y, int(xx.max()) + 1 - x, int(yy.max()) + 1 - y


def validate_bounds(bounds, width, height, label):
    if (not isinstance(bounds, (list, tuple)) or len(bounds) != 4
            or any(type(value) is not int for value in bounds)):
        raise ValueError(f"Invalid {label} bounds: {bounds!r}")
    x0, y0, x1, y1 = bounds
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError(f"Out-of-range {label} bounds: {bounds!r}")


def validate_manifest(manifest, directions=DIRECTIONS, shared_center=True):
    if not isinstance(manifest, dict):
        raise ValueError("Animation metadata must be an object.")
    for key, expected in (("width", WIDTH), ("height", HEIGHT), ("count", STEPS)):
        if type(manifest.get(key)) is not int or manifest[key] != expected:
            raise ValueError(f"Expected animation {key}={expected}.")
    if manifest.get("blinkLevels") != BLINK_LEVELS:
        raise ValueError(f"Expected blinkLevels={BLINK_LEVELS}.")
    tracks = manifest.get("directions")
    if not isinstance(tracks, dict) or set(tracks) != set(directions):
        raise ValueError(f"Expected exactly these tracks: {', '.join(directions)}.")
    center = manifest.get("centerSha256")
    if ((shared_center or center is not None) and
            (not isinstance(center, str) or len(center) != 64
             or any(c not in "0123456789abcdef" for c in center))):
        raise ValueError("Expected a lowercase SHA256 centerSha256.")
    for direction in directions:
        track = tracks[direction]
        if not isinstance(track, dict) or track.get("provider") != "Azure GPT Image":
            raise ValueError(f"Unsupported provider for {direction}; require Azure GPT Image.")
        for key, expected in (("width", WIDTH), ("height", HEIGHT), ("count", STEPS)):
            if type(track.get(key)) is not int or track[key] != expected:
                raise ValueError(f"Invalid {direction} {key}; expected {expected}.")
        frames = track.get("frames")
        if not isinstance(frames, list) or len(frames) != STEPS:
            raise ValueError(f"Expected {STEPS} frames for {direction}.")
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict):
                raise ValueError(f"Invalid {direction} frame {index}.")
            if not isinstance(frame.get("blinks"), list) or len(frame["blinks"]) != 4:
                raise ValueError(f"Expected four blink files for {direction} frame {index}.")
            for filename in [frame.get("file"), *frame["blinks"]]:
                if not isinstance(filename, str) or not filename.endswith(".png"):
                    raise ValueError(f"Invalid PNG filename for {direction} frame {index}.")
            if not isinstance(frame.get("eyes"), list):
                raise ValueError(f"Invalid eye metadata for {direction} frame {index}.")
            for bounds in frame["eyes"]:
                validate_bounds(bounds, WIDTH, HEIGHT, "eye")


def enforce_budget(data_size, budget):
    if type(budget) is not int or budget <= 0:
        raise ValueError("Asset partition budget must be a positive integer.")
    if data_size > budget:
        raise ValueError(
            f"Sprite assets exceed partition budget: {data_size:,} compressed > {budget:,} bytes. "
            "Optimize compression/deduplication; do not reduce image quality."
        )


def load_manifests(manifest_path, root=ROOT):
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    validate_manifest(manifest)
    inputs = [(manifest_path, manifest_bytes, manifest, DIRECTIONS)]
    expression_path = root / EXPRESSION_MANIFEST
    if expression_path.exists():
        raw = expression_path.read_bytes()
        expressions = json.loads(raw)
        validate_manifest(expressions, EXPRESSION_DIRECTIONS)
        if expressions["centerSha256"] != manifest["centerSha256"]:
            raise ValueError("Expression tracks must share the approved idle center.")
        if ("approvedSpriteManifestSha256" in expressions
                and expressions["approvedSpriteManifestSha256"] != sha256(manifest_bytes)):
            raise ValueError("Expression tracks reference a stale approved idle manifest.")
        inputs.append((expression_path, raw, expressions, EXPRESSION_DIRECTIONS))
    return inputs


def derive_base_bounds(tracks, track_steps):
    """Prepass only reachable open poses, keeping the logical canvas unchanged."""
    occupied = np.zeros((DISPLAY_HEIGHT, DISPLAY_WIDTH), dtype=bool)
    for (direction, path, manifest), count in zip(tracks, track_steps):
        for frame in manifest["directions"][direction]["frames"][:count]:
            pixels, _ = read_png(contained_path(path.parent, frame["file"]), (WIDTH, HEIGHT))
            occupied |= display_pixels(rgb565(pixels)) != 0
    rows, columns = np.nonzero(occupied)
    if not len(rows):
        raise ValueError("Reachable open poses contain no nonblack pixels for a shared base crop.")
    x, y = int(columns.min()), int(rows.min())
    return [x, y, int(columns.max()) + 1 - x, int(rows.max()) + 1 - y]


def validate_black_padding(pixels, bounds, label):
    x, y, width, height = bounds
    if (pixels[:y].any() or pixels[y + height:].any()
            or pixels[y:y + height, :x].any() or pixels[y:y + height, x + width:].any()):
        raise ValueError(f"Nonblack pixels outside shared base crop for {label}; refusing to clip artwork.")


def build_assets(manifest_path, root=ROOT):
    partition = read_assets_partition(root)
    inputs = load_manifests(manifest_path, root)
    store = BlockStore(root / "build/sprite-compression")
    frames, sources, manifests = [], {}, {}
    centers = None
    source_centers = None
    max_patch_pixels = 0
    tracks = []
    for path, raw, manifest, directions in inputs:
        manifests[path.relative_to(root).as_posix()] = {
            "sha256": sha256(raw), "sourcePngSha256": {},
        }
        for direction in directions:
            tracks.append((direction, path, manifest))
    directions = [direction for direction, _, _ in tracks]
    track_steps, track_offsets = track_layout(directions)
    base_bounds = derive_base_bounds(tracks, track_steps)
    base_x, base_y, base_width, base_height = base_bounds
    for track_index, (direction, track_manifest_path, manifest) in enumerate(tracks):
        track = manifest["directions"][direction]
        source_directory = (track_manifest_path.parent if direction in EXPRESSION_DIRECTIONS
                            else root / "characters/copilot/source/generated-sprites")
        source = contained_path(source_directory, track.get("source"))
        sheet, source_hash = read_png(source)
        if "sourceSha256" in track and track["sourceSha256"] != source_hash:
            raise ValueError(f"Source PNG hash mismatch for {direction}.")
        provenance = {"provider": track["provider"], "source": source.relative_to(root).as_posix(),
                      "sourceSha256": source_hash}
        if "generationProvenance" in track:
            path = contained_path(root, track["generationProvenance"])
            raw = path.read_bytes()
            if json.loads(raw).get("sha256") != source_hash:
                raise ValueError(f"Generation provenance hash mismatch for {direction}.")
            provenance.update(generationManifest=path.relative_to(root).as_posix(),
                              generationManifestSha256=sha256(raw))
        sources[direction] = provenance
        png_hashes = manifests[track_manifest_path.relative_to(root).as_posix()]["sourcePngSha256"]
        for step, frame in enumerate(track["frames"]):
            validate_bounds(frame.get("sourceBounds"), sheet.shape[1], sheet.shape[0], "source")
            packed = []
            source_hashes = []
            for filename in [frame["file"], *frame["blinks"]]:
                path = contained_path(track_manifest_path.parent, filename)
                pixels, digest = read_png(path, (WIDTH, HEIGHT))
                png_hashes[filename] = digest
                if not packed and "sha256" in frame and frame["sha256"] != digest:
                    raise ValueError(f"Frame PNG hash mismatch for {direction}/{step}.")
                source_hashes.append(sha256(pixels.tobytes()))
                if (step == 0 and len(packed) == 0 and manifest.get("centerSha256") is not None
                        and sha256(pixels.tobytes()) != manifest["centerSha256"]):
                    raise ValueError(f"Center RGB hash mismatch for {direction}.")
                packed.append(display_pixels(rgb565(pixels)))
            if step == 0:
                hashes = [sha256(pixels.tobytes()) for pixels in packed]
                if centers is None:
                    centers = hashes
                    source_centers = source_hashes
                elif hashes != centers or source_hashes != source_centers:
                    raise ValueError(f"Center RGB565 blink levels differ for {direction}.")
            if direction == "surprise" and step == STEPS - 1:
                if source_hashes != source_centers or [sha256(p.tobytes()) for p in packed] != centers:
                    raise ValueError("Spring surprise must end at the shared neutral in all five blink states. "
                                     "Regenerate with: python3 characters/copilot/tools/spring_surprise.py")
            if step >= track_steps[track_index]:
                continue
            for level, pixels in enumerate(packed):
                validate_black_padding(pixels, base_bounds, f"{direction}/{step}/blink-{level}")
            base, *blinks = packed
            x, y, width, height = patch_bounds(base, blinks)
            if width and height:
                validate_bounds([x, y, x + width, y + height], DISPLAY_WIDTH, DISPLAY_HEIGHT, "patch")
                if width == DISPLAY_WIDTH and height == DISPLAY_HEIGHT:
                    raise ValueError(f"Blink patch cannot be a copied full image: {direction}/{step}.")
            max_patch_pixels = max(max_patch_pixels, width * height)
            frames.append({
                "direction": direction, "step": step,
                "base": store.add(base[base_y:base_y + base_height,
                                       base_x:base_x + base_width].tobytes(), base_width),
                "patchX": x, "patchY": y, "patchWidth": width, "patchHeight": height,
                "blinks": [store.add(blink[y:y + height, x:x + width].tobytes(), width) for blink in blinks],
            })
    enforce_budget(len(store.data), partition["size"])
    frame_table_bytes = len(frames) * 48
    metadata_bytes = frame_table_bytes + len(tracks) * 3 + 4 + 32
    metadata = {
        "formatVersion": 4, "profile": PROFILE, "encoding": ENCODING,
        "storage": "flash-partition", "partition": partition,
        "displayReady": True, "resampling": RESAMPLING,
        "width": DISPLAY_WIDTH, "height": DISPLAY_HEIGHT,
        "baseBounds": base_bounds,
        "steps": STEPS, "directions": directions,
        "trackSteps": track_steps, "trackOffsets": track_offsets,
        "frameCount": len(frames), "blinkLevels": BLINK_LEVELS,
        "patchBounds": "union of differences after exact RGB565 conversion and display resampling",
        "maxPatchPixels": max_patch_pixels, "maxPatchBytes": max_patch_pixels * 2,
        "assetBudgetBytes": partition["size"], "dataBytes": len(store.data),
        "frameTableBytes": frame_table_bytes, "metadataBytes": metadata_bytes,
        "metadataStorage": "character-pack", "totalAssetBytes": len(store.data) + metadata_bytes,
        "budgetRemainingBytes": partition["size"] - len(store.data),
        "uniqueBlocks": len(store.blocks), "blockReferences": store.references,
        "deduplicatedBytesSaved": store.referenced_compressed_bytes - len(store.data),
        "rawReferencedBytes": store.referenced_raw_bytes,
        "dataSha256": sha256(store.data),
        "sourceManifests": manifests,
        "centerRgbSha256": inputs[0][2]["centerSha256"], "centerRgb565Sha256": centers,
        "sources": sources, "frames": frames,
    }
    return bytes(store.data), metadata


def export(root=ROOT):
    data, metadata = build_assets(root / "characters/copilot/sprites/animation.json", root)
    write_if_changed(root / "characters/copilot/frames.bin", data)
    write_if_changed(root / "characters/copilot/frames.json", json.dumps(metadata, indent=2) + "\n")
    print(f"Sprite data: {len(data):,} bytes ({len(data) / 1024**2:.3f} MiB); "
          f"partition: {len(data):,} / {metadata['assetBudgetBytes']:,} bytes; "
          f"pack metadata: {metadata['metadataBytes']:,} bytes")
    print(f"Unique blocks: {metadata['uniqueBlocks']}; dedup saved: "
          f"{metadata['deduplicatedBytesSaved']:,} bytes; "
          f"max patch: {metadata['maxPatchPixels']:,} pixels / {metadata['maxPatchBytes']:,} bytes")
    print(f"SHA256 {metadata['dataSha256']}\nNext: python3 tools/character_pack.py build")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        export()
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"Sprite export failed: {error}\n")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Detect and rigidly register sprites with translation/uniform scale, never shape warping."""
import json
import argparse
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_fill_holes, label, find_objects

ROOT = Path(__file__).resolve().parents[3]


def prepare_track(source, direction="right", center=None, destination=None, prefix=None, isolate_colored_heads=False):
    sheet = Image.open(source).convert("RGB")
    if sheet.size != (1536, 1024):
        raise ValueError("Unexpected sprite-sheet dimensions.")
    destination = destination or ROOT / "characters/copilot/sprites"
    prefix = prefix or direction
    destination.mkdir(parents=True, exist_ok=True)
    frames = []
    cells = []
    pixels = np.asarray(sheet)
    foreground = pixels.max(axis=2) > 32
    if isolate_colored_heads:
        foreground &= pixels.max(axis=2).astype(int) - pixels.min(axis=2) > 20
    labels, _ = label(foreground)
    objects = []
    identities = {}
    for ident, box in enumerate(find_objects(labels), 1):
        if box and np.count_nonzero(labels[box] == ident) > 1500:
            yy, xx = box
            objects.append([xx.start, yy.start, xx.stop, yy.stop])
            identities[tuple(objects[-1])] = ident
    if len(objects) != 24:
        raise ValueError(f"Expected 24 complete heads, detected {len(objects)}. Inspect the sheet before cropping.")
    objects.sort(key=lambda box: (box[1] + box[3]) / 2)
    for row in range(4):
        row_objects = sorted(objects[row * 6:row * 6 + 6], key=lambda box: box[0])
        for bbox in row_objects:
            x0, y0, x1, y1 = bbox
            crop = sheet.crop((x0 - 2, y0 - 2, x1 + 2, y1 + 2))
            if isolate_colored_heads:
                if x0 < 2 or y0 < 2 or x1 + 2 > sheet.width or y1 + 2 > sheet.height:
                    raise ValueError("A head touches the sheet edge; inspect it before cropping.")
                local = labels[y0 - 2:y1 + 2, x0 - 2:x1 + 2]
                head = binary_fill_holes(local == identities[tuple(bbox)])
                values = np.asarray(crop)
                colored = values.max(axis=2).astype(int) - values.min(axis=2) > 5
                keep = head | (binary_dilation(head, iterations=2) & colored)
                crop = Image.fromarray(np.where(keep[:, :, None], values, 0).astype(np.uint8))
            if center is not None and direction in ("up", "down"):
                center_pixels = np.asarray(center)
                xs = np.nonzero(center_pixels.max(axis=2) > 32)[1]
                scale = (int(xs.max() - xs.min()) + 5) / crop.width
            else:
                scale = 164 / crop.height
            width = round(crop.width * scale)
            height = round(crop.height * scale)
            if width > 232 or height > 216:
                raise ValueError("A detected head has an implausible aspect ratio; inspect before registering it.")
            normalized = crop.resize((width, height), Image.Resampling.LANCZOS)
            cell = Image.new("RGB", (240, 224))
            cell.paste(normalized, ((240 - width) // 2, (224 - height) // 2))
            if center is not None and not frames:
                cell = center.copy()
            filename = f"{prefix}-{len(frames):02d}.png"
            cell.save(destination / filename)
            frames.append({"file": filename, "sourceBounds": bbox, "uniformScale": scale})
            cells.append(cell)
    manifest = {
        "title": f"GPT Image {direction}-turn sprite study",
        "provider": "Azure GPT Image",
        "source": source.name,
        "width": 240, "height": 224, "count": len(frames),
        "frames": frames, "sheet": f"{prefix}-turn-sheet.png",
        "playback": "Discrete frames only. Reverse reuses the identical frames in reverse order.",
        "processing": "Translation and uniform-scale registration only. No shape warping, morphing, or crossfades.",
        "status": "Generated prototype; visual and temporal consistency require review.",
    }
    shutil.copyfile(source, destination / manifest["sheet"])
    (destination / f"{prefix}-turn.json").write_text(json.dumps(manifest, indent=2) + "\n")
    contact = Image.new("RGB", (6 * 240, 4 * 224))
    for i, cell in enumerate(cells):
        contact.paste(cell, ((i % 6) * 240, (i // 6) * 224))
    contact.save(ROOT / f"characters/copilot/source/generated-sprites/{direction}-turn-crops.png")
    print(f"Prepared {len(frames)} rigidly registered {direction} sprite cells.")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "characters/copilot/source/generated-sprites/right-turn-sheet.png")
    parser.add_argument("--direction", choices=("right", "left", "up", "down"), default="right")
    args = parser.parse_args()
    prepare_track(args.source, args.direction)


if __name__ == "__main__":
    main()

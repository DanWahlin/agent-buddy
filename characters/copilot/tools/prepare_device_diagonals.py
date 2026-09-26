#!/usr/bin/env python3
"""Bake existing firmware diagonal poses and blinks for the mixed-source web review."""
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
from scipy.ndimage import find_objects, label

from serve_preview import NativeRenderer, build_renderer

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / "characters/copilot/sprites"
DIAGONALS = ("up_right", "up_left", "down_right", "down_left")


def unpack_frame(data):
    packed = np.frombuffer(data, dtype=">u2").reshape(352, 400).astype(np.uint32)
    rgb = np.stack((((packed >> 11) & 31) * 255 // 31,
                    ((packed >> 5) & 63) * 255 // 63,
                    (packed & 31) * 255 // 31), axis=2).astype(np.uint8)
    return Image.fromarray(rgb)


def bounds(image):
    yy, xx = np.nonzero(np.asarray(image).max(axis=2) > 32)
    if not len(xx):
        raise ValueError("Native renderer produced an empty character.")
    return int(xx.min()), int(yy.min()), int(xx.max() + 1), int(yy.max() + 1)


def append_diagonals(manifest):
    atlas = json.loads((ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.json").read_text())
    executable = build_renderer()
    native = NativeRenderer(executable)
    source_hash = hashlib.sha256((ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.bin").read_bytes()).hexdigest()
    center = manifest["directions"]["right"]["frames"][0]
    with Image.open(DESTINATION / center["file"]) as image:
        reference = image.convert("RGB")
    try:
        pixels, _ = native.frame({"command": 4, "direction": 0, "turn": 0, "openness": 1})
        neutral = unpack_frame(pixels)
        x0, y0, x1, y1 = bounds(neutral)
        a0, b0, a1, b1 = bounds(reference)
        scale = (b1 - b0) / (y1 - y0)
        size = (round(neutral.width * scale), round(neutral.height * scale))
        offset = (round((a0 + a1) / 2 - (x0 + x1) / 2 * scale),
                  round((b0 + b1) / 2 - (y0 + y1) / 2 * scale))

        def register(image):
            cell = Image.new("RGB", reference.size)
            cell.paste(image.resize(size, Image.Resampling.LANCZOS), offset)
            return cell

        for direction in DIAGONALS:
            frames = []
            contact = Image.new("RGB", (reference.width * 6, reference.height * 4))
            for index in range(manifest["count"]):
                images, names = [], []
                for level, openness in enumerate(manifest["blinkLevels"]):
                    name = f"{direction}-{index:02d}" + (f"-blink-{level}" if level else "") + ".png"
                    names.append(name)
                    if index == 0:
                        source = center["file"] if level == 0 else center["blinks"][level - 1]
                        shutil.copyfile(DESTINATION / source, DESTINATION / name)
                        with Image.open(DESTINATION / name) as image:
                            images.append(image.convert("RGB"))
                    else:
                        data, _ = native.frame({
                            "command": 4, "direction": atlas["directions"].index(direction),
                            "turn": index / (manifest["count"] - 1), "openness": openness,
                        })
                        image = register(unpack_frame(data))
                        image.save(DESTINATION / name)
                        images.append(image)
                changed = np.zeros((reference.height, reference.width), dtype=bool)
                for image in images[1:]:
                    changed |= np.any(np.asarray(images[0]) != np.asarray(image), axis=2)
                labels, _ = label(changed)
                eye_regions = [(box[1].start, box[0].start, box[1].stop, box[0].stop)
                               for box in find_objects(labels) if box is not None]
                frames.append({
                    "file": names[0], "blinks": names[1:], "eyes": eye_regions,
                    "blinkMaskState": "visible" if eye_regions else "occluded-or-rim-clipped",
                    "atlasTurn": index / (manifest["count"] - 1),
                    "centerOverride": index == 0,
                })
                contact.paste(images[0], ((index % 6) * reference.width, (index // 6) * reference.height))
            sheet = f"{direction}-turn-sheet.png"
            contact.save(DESTINATION / sheet)
            manifest["directions"][direction] = {
                "title": f"Device-style {direction.replace('_', '-')} turn",
                "provider": "Firmware atlas renderer",
                "source": "characters/copilot/legacy-atlas/assets/turn-atlas.bin", "sourceSha256": source_hash,
                "rendererSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                "sourceSteps": atlas["steps"], "count": len(frames),
                "width": reference.width, "height": reference.height,
                "frames": frames, "sheet": sheet,
                "processing": "Native firmware pose/eye rendering, fixed uniform registration, shared generated center.",
                "status": "Existing device-style artwork, not newly generated GPT sprites or a live device capture.",
            }
            print(f"Prepared {direction}: {len(frames)} device-style poses and their blink variants.")
    finally:
        native.close()
    manifest["status"] = "Four GPT Image cardinal tracks plus four device-style diagonal tracks; compare artwork and center transitions."
    manifest["blinkProcessing"] = "Localized eyelid sprites for cardinals; native firmware eye rendering for diagonals."
    return manifest


def main():
    path = DESTINATION / "animation.json"
    manifest = append_diagonals(json.loads(path.read_text()))
    path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()

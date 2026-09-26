#!/usr/bin/env python3
"""Stage and publish GPT-generated diagonal tracks without touching cardinal images."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
from scipy.ndimage import binary_opening, find_objects, label
from scipy.optimize import linear_sum_assignment

from create_diagonal_guides import DIAGONALS
from prepare_generated_sprites import prepare_track

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / "characters/copilot/sprites"
STAGING = ROOT / "build/generated-diagonals"


def diagonal_eye_bounds(image, direction, index, previous):
    pixels = np.asarray(image).astype(float)
    cyan = ((pixels[:, :, 1] > 110) & (pixels[:, :, 2] > 150)
            & (pixels[:, :, 1] > pixels[:, :, 0] * 1.15))
    labels, _ = label(binary_opening(cyan, structure=np.ones((5, 1))))
    vertical, horizontal = direction.split("_")
    minimum_y, maximum_y = (65, 155) if vertical == "up" else (120, 205)
    minimum_x, maximum_x = (80, 205) if horizontal == "right" else (35, 160)
    boxes = []
    for ident, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        yy, xx = box
        width, height = xx.stop - xx.start, yy.stop - yy.start
        area = np.count_nonzero(labels[box] == ident)
        if (2 <= width <= 24 and 7 <= height <= 34 and height >= width * .5
                and minimum_y <= (yy.start + yy.stop) / 2 <= maximum_y
                and minimum_x <= (xx.start + xx.stop) / 2 <= maximum_x
                and area / (width * height) > .35):
            boxes.append((xx.start, yy.start, xx.stop, yy.stop))
    if not boxes or not previous:
        raise ValueError(f"{direction} frame {index}: ambiguous eye detection {boxes}; review before publishing.")
    costs = np.full((len(previous), len(boxes)), 1e6)
    for row, (a0, b0, a1, b1) in enumerate(previous):
        for column, (x0, y0, x1, y1) in enumerate(boxes):
            distance = np.hypot((x0 + x1 - a0 - a1) / 2, (y0 + y1 - b0 - b1) / 2)
            shape_change = (abs(np.log((x1 - x0) / (a1 - a0)))
                            + abs(np.log((y1 - y0) / (b1 - b0))))
            if distance <= 24:
                costs[row, column] = distance + 8 * shape_change
    rows, columns = linear_sum_assignment(costs)
    matched = [boxes[column] for row, column in zip(rows, columns) if costs[row, column] <= 28]
    if not matched:
        raise ValueError(f"{direction} frame {index}: lost eye correspondence; review before publishing.")
    return matched


def append_generated_diagonals(manifest, make_blink):
    STAGING.mkdir(parents=True, exist_ok=True)
    for direction in ("right", "left", "up", "down"):
        track = manifest["directions"][direction]
        shutil.copyfile(DESTINATION / track["sheet"], STAGING / track["sheet"])
        for frame in track["frames"]:
            for name in (frame["file"], *frame["blinks"]):
                shutil.copyfile(DESTINATION / name, STAGING / name)
    center = manifest["directions"]["right"]["frames"][0]
    with Image.open(DESTINATION / center["file"]) as image:
        reference = image.convert("RGB")
    contacts = Image.new("RGB", (240 * 6, 224 * 4))
    for row, direction in enumerate(DIAGONALS):
        source = ROOT / f"characters/copilot/source/generated-sprites/{direction}-generated-sheet.png"
        provenance = json.loads(source.with_suffix(".json").read_text())
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != provenance["sha256"]:
            raise ValueError(f"{direction}: source image does not match its generation provenance.")
        track = prepare_track(source, direction, reference, STAGING, direction + "-generated",
                              isolate_colored_heads=True)
        track["processing"] += " Neutral sheet labels are excluded outside the character silhouette."
        track["sourceSha256"] = digest
        track["generationProvenance"] = str(source.with_suffix(".json").relative_to(ROOT))
        previous = center["eyes"]
        for index, frame in enumerate(track["frames"]):
            image = Image.open(STAGING / frame["file"]).convert("RGB")
            boxes = center["eyes"] if index == 0 else diagonal_eye_bounds(image, direction, index, previous)
            previous = boxes
            boxes = [(max(0, x0 - 1), max(0, y0 - 1), min(image.width, x1 + 1), min(image.height, y1 + 1))
                     for x0, y0, x1, y1 in boxes] if index else boxes
            frame["eyes"] = boxes
            frame["blinkMaskState"] = "visible"
            frame["blinks"] = []
            for level, openness in enumerate(manifest["blinkLevels"][1:], 1):
                name = f"{direction}-generated-{index:02d}-blink-{level}.png"
                if index == 0:
                    shutil.copyfile(DESTINATION / center["blinks"][level - 1], STAGING / name)
                else:
                    make_blink(image, boxes, openness).save(STAGING / name)
                frame["blinks"].append(name)
            if index in (0, 12, 23):
                column = (0, 12, 23).index(index) * 2
                contacts.paste(image, (column * 240, row * 224))
                contacts.paste(Image.open(STAGING / frame["blinks"][-1]), ((column + 1) * 240, row * 224))
        manifest["directions"][direction] = track
    contacts.save(ROOT / "characters/copilot/source/generated-sprites/generated-diagonal-blinks.png")
    manifest["status"] = "Eight GPT Image-generated tracks; no firmware-atlas diagonal artwork is used."
    manifest["blinkProcessing"] = "Localized pre-baked eyelid occlusion on generated poses; no head redrawing."
    (STAGING / "animation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def publish(manifest):
    for direction in DIAGONALS:
        track = manifest["directions"][direction]
        names = [track["sheet"]]
        for frame in track["frames"]:
            names.extend([frame["file"], *frame["blinks"]])
        for name in names:
            shutil.copyfile(STAGING / name, DESTINATION / name)
    temporary = DESTINATION / "animation.next.json"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(DESTINATION / "animation.json")
    print("Published all four GPT-generated diagonals; existing images remain untouched.")


def main():
    from prepare_sprite_animation import blink
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true", help="Publish after staging all four tracks successfully.")
    args = parser.parse_args()
    manifest = json.loads((DESTINATION / "animation.json").read_text())
    append_generated_diagonals(manifest, blink)
    if args.publish:
        publish(manifest)
    else:
        print("All four generated diagonal tracks are staged for review; live preview has not changed.")


if __name__ == "__main__":
    main()

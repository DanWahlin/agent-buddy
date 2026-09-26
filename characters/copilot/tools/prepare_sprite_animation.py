#!/usr/bin/env python3
"""Prepare shared-center directional sprites and localized, pre-baked eyelid frames."""
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_opening, distance_transform_edt, find_objects, label

from prepare_generated_sprites import prepare_track
from prepare_generated_diagonals import append_generated_diagonals, publish

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / "characters/copilot/sprites"
LEVELS = (0.75, 0.5, 0.25, 0)


def eye_bounds(image, direction="right", index=0):
    if direction not in ("right", "left", "up", "down") or not 0 <= index < 24:
        raise ValueError("Expected a supported direction and a frame index from zero through 23.")
    if direction == "down" and index >= 15:
        return []
    pixels = np.asarray(image).astype(float)
    mask = ((pixels[:, :, 1] > 110) & (pixels[:, :, 2] > 150)
            & (pixels[:, :, 1] > pixels[:, :, 0] * 1.15))
    mask = binary_opening(mask, structure=np.ones((5, 1)))
    labels, _ = label(mask)
    bounds = []
    for ident, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        yy, xx = box
        width, height = xx.stop - xx.start, yy.stop - yy.start
        area = np.count_nonzero(labels[box] == ident)
        center_x, center_y = (xx.start + xx.stop) / 2, (yy.start + yy.stop) / 2
        min_y, max_y = (55, 150) if direction == "up" else (120, 165)
        min_x, max_x = (80, 192) if direction == "right" else (48, 160)
        if direction == "up":
            min_x = 80
        min_width, min_height = 2, 12
        if direction in ("right", "left") and height < width * 1.3:
            continue
        if direction == "down":
            min_y, max_y = 120 + min(index * 4, 65), 210
            min_width, min_height = 7, 5
            if not (90 <= center_x <= 108 or 130 <= center_x <= 148):
                continue
        if (min_width <= width <= 24 and min_height <= height <= 34
                and min_x <= center_x <= max_x and min_y <= center_y <= max_y
                and area / (width * height) > 0.35):
            bounds.append((xx.start, yy.start, xx.stop, yy.stop))
    if not 1 <= len(bounds) <= 2:
        raise ValueError(f"Expected one or two visible eyes, found {bounds}; inspect before publishing.")
    return bounds


def blink(image, bounds, openness):
    """Occlude eye light only; the surrounding head geometry is never redrawn."""
    if not 0 <= openness <= 1:
        raise ValueError("Eye openness must be between zero and one.")
    if openness == 1:
        return image.copy()
    original = np.asarray(image).astype(float)
    result = original.copy()
    blue = ((original[:, :, 2] > 80) & (original[:, :, 2] > original[:, :, 1] * 1.45)
            & (original[:, :, 2] > original[:, :, 0] * 1.3))
    background_mask = blue.copy()
    for x0, y0, x1, y1 in bounds:
        background_mask[max(0, y0 - 4):y1 + 4, max(0, x0 - 4):x1 + 4] = False
    if bounds and not background_mask.any():
        raise ValueError("No blue visor pixels available for eyelid compositing.")
    nearest = distance_transform_edt(~background_mask, return_distances=False, return_indices=True)
    interior = distance_transform_edt(original.max(axis=2) > 32) > 2
    for x0, y0, x1, y1 in bounds:
        padding = 4
        left, right = max(0, x0 - padding), min(image.width, x1 + padding)
        top, bottom = max(0, y0 - padding), min(image.height, y1 + padding)
        yy, xx = np.mgrid[top:bottom, left:right]
        center = (y0 + y1 - 1) / 2
        aperture = (y1 - y0 + 2 * padding) * openness / 2
        cover = np.clip(np.abs(yy - center) - aperture + 0.5, 0, 1)
        if openness == 0:
            cover[:] = 1
        edge_x = np.clip(np.minimum(xx - left, right - 1 - xx) / padding, 0, 1)
        edge_y = np.clip(np.minimum(yy - top, bottom - 1 - yy) / padding, 0, 1)
        alpha = cover * edge_x * edge_y
        core = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
        alpha *= blue[top:bottom, left:right] | core
        alpha *= interior[top:bottom, left:right]
        a, b = [], []
        for y in range(top, bottom):
            positions = np.flatnonzero(background_mask[y])
            before = positions[(positions < left) & (positions >= left - 16)]
            after = positions[(positions >= right) & (positions < right + 16)]
            if len(before):
                color_a = original[y, before[-3:]].mean(axis=0)
            else:
                color_a = original[tuple(nearest[:, y, left])]
            if len(after):
                color_b = original[y, after[:3]].mean(axis=0)
            else:
                color_b = color_a
            if not len(before):
                color_a = color_b
            a.append(color_a)
            b.append(color_b)
        a, b = np.asarray(a), np.asarray(b)
        mix = ((xx - left) / max(1, right - left - 1))[:, :, None]
        background = a[:, None, :] * (1 - mix) + b[:, None, :] * mix
        result[top:bottom, left:right] = (original[top:bottom, left:right] * (1 - alpha[:, :, None])
                                        + background * alpha[:, :, None])
    return Image.fromarray(np.rint(result).clip(0, 255).astype(np.uint8))


def main():
    center = Image.open(ROOT / "characters/copilot/source/generated-sprites/approved-center.png").convert("RGB")
    directions = {}
    contact = Image.new("RGB", (240 * 6, 224 * 4))
    for row, direction in enumerate(("right", "left", "up", "down")):
        name = "right-turn-refined-sheet.png" if direction == "right" else f"{direction}-turn-sheet.png"
        manifest = prepare_track(ROOT / "characters/copilot/source/generated-sprites" / name, direction, center)
        for index, frame in enumerate(manifest["frames"]):
            image = Image.open(DESTINATION / frame["file"]).convert("RGB")
            try:
                bounds = eye_bounds(image, direction, index)
            except ValueError as error:
                raise ValueError(f"{direction} frame {index}: {error}") from error
            frame["eyes"] = bounds
            frame["blinkMaskState"] = "visible" if bounds else "occluded-or-rim-clipped"
            frame["blinks"] = []
            for level, openness in enumerate(LEVELS, 1):
                filename = f"{direction}-{index:02d}-blink-{level}.png"
                blink(image, bounds, openness).save(DESTINATION / filename)
                frame["blinks"].append(filename)
            if index in (0, 12, 23):
                column = (0, 12, 23).index(index) * 2
                contact.paste(image, (240 * column, 224 * row))
                contact.paste(blink(image, bounds, 0), (240 * (column + 1), 224 * row))
        directions[direction] = manifest
    result = {
        "width": 240, "height": 224, "count": 24,
        "directions": directions, "blinkLevels": [1, *LEVELS],
        "centerSha256": hashlib.sha256(center.tobytes()).hexdigest(),
        "status": "Generated directional sprites; visual angular consistency remains subject to review.",
        "blinkProcessing": "Pre-baked localized eyelid occlusion; head pixels outside eye neighborhoods are unchanged.",
    }
    contact.save(ROOT / "characters/copilot/source/generated-sprites/animation-blink-contact.png")
    append_generated_diagonals(result, blink)
    publish(result)
    print("Published eight shared-center sprite tracks with blink frames.")


if __name__ == "__main__":
    main()

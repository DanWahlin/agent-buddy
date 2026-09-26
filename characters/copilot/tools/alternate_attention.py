#!/usr/bin/env python3
"""Derive the opposite curious pose without changing approved attention artwork."""
import copy
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import map_coordinates

from prepare_sprite_animation import blink
from smooth_surprise import (
    APPROVED, OUTPUT, ROOT, digest, rigid_matrix, transform_bounds, transform_head,
)

COUNTER_ROLL_DEGREES = 10.0


def swap_eye_lights(image, eyes):
    """Move the two existing light layers, keeping their shapes and lower anchors."""
    original = np.asarray(image, dtype=float)
    clean = np.asarray(blink(image, eyes, 0), dtype=float)
    result = clean.copy()
    yy, xx = np.mgrid[:image.height, :image.width]
    bounds = []
    for source, destination in zip(eyes[::-1], eyes):
        x0, y0, x1, y1 = source
        dx0, _, dx1, dy1 = destination
        dx, dy = (dx0+dx1-x0-x1)/2, dy1-y1
        layer = np.zeros_like(original)
        layer[y0-4:y1+4, x0-4:x1+4] = (
            original[y0-4:y1+4, x0-4:x1+4] - clean[y0-4:y1+4, x0-4:x1+4])
        coordinates = np.array([yy-dy, xx-dx])
        result += np.stack([map_coordinates(layer[:, :, channel], coordinates, order=1,
                                           mode="constant", cval=0, prefilter=False)
                            for channel in range(3)], axis=-1)
        bounds.append([int(np.floor(x0+dx)), y0+dy, int(np.ceil(x1+dx)), y1+dy])
    return Image.fromarray(np.rint(result).clip(0, 255).astype(np.uint8)), bounds


def build_track():
    archived_path = OUTPUT / "animation.candidate.json"
    original = json.loads(archived_path.read_text())["directions"]["attention"]
    neutral = json.loads((APPROVED / "animation.json").read_text())["directions"]["right"]["frames"][0]
    recipe_path = OUTPUT / "review/alternate-attention-recipe.json"
    recipe_path.write_text(json.dumps(dict(
        algorithm="swapped-eye-light-rigid-counter-roll-v1",
        sha256=original["sourceSha256"],
        script=str(Path(__file__).resolve().relative_to(ROOT)), scriptSha256=digest(__file__),
        helpers="characters/copilot/tools/smooth_surprise.py", helpersSha256=digest(ROOT / "characters/copilot/tools/smooth_surprise.py"),
        originalManifestSha256=digest(archived_path),
        sourcePngSha256={frame["file"]: digest(OUTPUT / frame["file"]) for frame in original["frames"]},
        counterRollDegrees=COUNTER_ROLL_DEGREES,
        note="Original generated attention sprites remain unchanged. Only the eye-light layers trade places; a rigid counter-roll changes the tilt, never mirroring the head or its lighting.",
    ), indent=2) + "\n")
    frames = []
    contact = Image.new("RGB", (240*6, 248*4), (14, 18, 26))
    for index, source in enumerate(original["frames"]):
        strength = index / (len(original["frames"])-1)
        matrix = rigid_matrix((240, 224), COUNTER_ROLL_DEGREES * strength)
        image, eyes = swap_eye_lights(Image.open(OUTPUT / source["file"]).convert("RGB"), source["eyes"])
        filename = f"attention-alternate-{index:02d}.png"
        files = [filename, *[f"attention-alternate-{index:02d}-blink-{level}.png" for level in range(1, 5)]]
        if index == 0:
            eyes = neutral["eyes"]
            for target, reference in zip(files, [neutral["file"], *neutral["blinks"]]):
                shutil.copyfile(APPROVED / reference, OUTPUT / target)
        else:
            for target, openness in zip(files, (1, .75, .5, .25, 0)):
                transform_head(blink(image, eyes, openness), matrix).save(OUTPUT / target)
        frames.append(dict(file=filename, blinks=files[1:], eyes=[transform_bounds(b, matrix) for b in eyes],
                           sourceIndex=index, sourceBounds=source["sourceBounds"],
                           sha256=digest(OUTPUT / filename), strength=strength,
                           counterRollDegrees=COUNTER_ROLL_DEGREES * strength,
                           blinkMaskState="visible"))
        x, y = index % 6 * 240, index // 6 * 248
        contact.paste(Image.open(OUTPUT / filename), (x, y))
        ImageDraw.Draw(contact).text((x+8, y+228), f"Alternate attention {index:02d}", fill="white")
    contact.save(OUTPUT / "review/alternate-attention-contact.png")
    return dict(
        title="Needs attention / opposite curious tilt", provider="Azure GPT Image",
        source=original["source"], sourceSha256=original["sourceSha256"],
        generationProvenance=str(recipe_path.relative_to(ROOT)),
        width=240, height=224, count=24, frames=frames,
        sheet="review/alternate-attention-contact.png",
        rendering="swapped-eye-light-rigid-counter-roll", blinkPolicy="localized",
        recommendedPlaybackIndices=list(range(24)), recommendedLoopIndices=[23],
        recommendedLoopFrameMs=120,
        processing="Original approved attention head and eye-light shapes, locally swapped and rigidly counter-rotated. No mirrored head, scaling, morphing, or crossfade.",
        status="Web-review candidate; alternate with the unchanged attention track through shared center.",
    )


def publish():
    path = OUTPUT / "animation.json"
    manifest = json.loads(path.read_text())
    previous = copy.deepcopy(manifest["directions"])
    manifest["directions"]["attention_alternate"] = build_track()
    assert all(manifest["directions"][name] == track for name, track in previous.items()
               if name != "attention_alternate")
    manifest["status"] = "Web-review candidate: surprise recoil and alternating curious attention tilts."
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(path)
    print("Published alternate attention track; all original expression tracks retained.")


if __name__ == "__main__":
    publish()

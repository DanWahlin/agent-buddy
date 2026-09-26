#!/usr/bin/env python3
"""Build smooth surprise eye lights with a small rigid head recoil."""
import copy
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import map_coordinates

from prepare_sprite_animation import blink

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "characters/copilot/expressions"
APPROVED = ROOT / "characters/copilot/sprites"
COUNT = 24
RECOIL_DEGREES = 2.0
RECOIL_RISE = 4.0


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def eye_regions(eyes, targets):
    regions = []
    for (x0, y0, x1, y1), (tx0, ty0, tx1, ty1) in zip(eyes, targets):
        cx = (tx0 + tx1 - 1) / 2
        half = (x1 - x0 + 8) * ((tx1-tx0)/(x1-x0)) / 2
        regions.append([int(np.floor(cx - half)) - 2, 118,
                        int(np.ceil(cx + half)) + 3, 176])
    return regions


def render(neutral, eyes, targets, strength):
    if not 0 <= strength <= 1:
        raise ValueError("Surprise strength must be within zero and one.")
    original = np.asarray(neutral.convert("RGB"), dtype=np.float64)
    if strength == 0:
        return neutral.copy()
    clean = np.asarray(blink(neutral, eyes, 0), dtype=np.float64)
    light_layers = np.zeros_like(original)
    covered = np.zeros((*original.shape[:2], 1))
    for eye, target, region in zip(eyes, targets, eye_regions(eyes, targets)):
        x0, y0, x1, y1 = eye
        cx, cy = (x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2
        tx0, ty0, tx1, ty1 = target
        target_x, target_y = (tx0+tx1-1)/2, (ty0+ty1-1)/2
        sx = 1 + ((tx1-tx0)/(x1-x0) - 1) * strength
        sy = 1 + ((ty1-ty0)/(y1-y0) - 1) * strength
        current_x, current_y = cx + (target_x-cx)*strength, cy + (target_y-cy)*strength
        left, top, right, bottom = region
        residual = np.zeros_like(original)
        residual[y0-4:y1+4, x0-4:x1+4] = (
            original[y0-4:y1+4, x0-4:x1+4] - clean[y0-4:y1+4, x0-4:x1+4])
        yy, xx = np.mgrid[top:bottom, left:right]
        coordinates = np.array([cy + (yy - current_y) / sy, cx + (xx - current_x) / sx])
        light = np.stack([map_coordinates(residual[:, :, channel], coordinates,
                                         order=1, mode="constant", cval=0, prefilter=False)
                          for channel in range(3)], axis=-1)
        feather = np.clip(np.minimum.reduce(
            [xx-left, right-1-xx, yy-top, bottom-1-yy]) / 2, 0, 1)[:, :, None]
        light_layers[top:bottom, left:right] += light * feather
        covered[top:bottom, left:right] = np.maximum(covered[top:bottom, left:right], feather)
    result = original * (1-covered) + clean * covered + light_layers
    return Image.fromarray(np.rint(result).clip(0, 255).astype(np.uint8))


def rigid_matrix(size, degrees, translation=(0, 0)):
    angle = np.deg2rad(degrees)
    rotation = np.array([[np.cos(angle), np.sin(angle)],
                         [-np.sin(angle), np.cos(angle)]])
    center = np.asarray(size, dtype=float) / 2
    matrix = np.eye(3)
    matrix[:2, :2] = rotation
    matrix[:2, 2] = center - rotation @ center + translation
    return matrix


def recoil_matrix(size, strength):
    if not 0 <= strength <= 1:
        raise ValueError("Surprise strength must be within zero and one.")
    return rigid_matrix(size, RECOIL_DEGREES * strength, [0, -RECOIL_RISE * strength])


def transform_head(image, matrix):
    inverse = np.linalg.inv(matrix)
    return image.transform(image.size, Image.Transform.AFFINE, inverse[:2].ravel(),
                           resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0))


def recoil(image, strength):
    if strength == 0:
        return image.copy()
    return transform_head(image, recoil_matrix(image.size, strength))


def transform_bounds(bounds, matrix):
    x0, y0, x1, y1 = bounds
    corners = np.array([[x0, y0, 1], [x1, y0, 1], [x0, y1, 1], [x1, y1, 1]])
    points = (matrix @ corners.T).T[:, :2]
    return [*np.floor(points.min(axis=0)).astype(int).tolist(),
            *np.ceil(points.max(axis=0)).astype(int).tolist()]


def build_track():
    approved = json.loads((APPROVED / "animation.json").read_text())
    reference = approved["directions"]["right"]["frames"][0]
    neutral = Image.open(APPROVED / reference["file"]).convert("RGB")
    eyes = reference["eyes"]
    archived = json.loads((OUTPUT / "animation.candidate.json").read_text())["directions"]["surprise"]
    targets = archived["frames"][-1]["eyes"]
    reference_path = OUTPUT / "references/shared-neutral.png"
    shutil.copyfile(APPROVED / reference["file"], reference_path)
    recipe_path = OUTPUT / "review/smooth-surprise-recipe.json"
    recipe = dict(sha256=digest(reference_path), algorithm="localized-eye-light-rigid-recoil-v2",
                  source=str((APPROVED / reference["file"]).relative_to(ROOT)),
                  script=str(Path(__file__).resolve().relative_to(ROOT)), scriptSha256=digest(__file__),
                  eyeRegions=eye_regions(eyes, targets), targetEyes=targets,
                  recoilDegrees=RECOIL_DEGREES, recoilRise=RECOIL_RISE,
                  originalReactionManifestSha256=digest(OUTPUT / "animation.candidate.json"),
                  note="No new AI generation. Smooth eye lights are composited onto the unchanged GPT head, then the complete sprite is rigidly rotated and translated once. No scaling or warping.")
    recipe_path.write_text(json.dumps(recipe, indent=2) + "\n")
    frames, images = [], []
    contact = Image.new("RGB", (240 * 6, 248 * 4), (14, 18, 26))
    for index in range(COUNT):
        strength = index / (COUNT - 1)
        image = recoil(render(neutral, eyes, targets, strength), strength)
        filename = f"surprise-smooth-{index:02d}.png"
        if index == 0:
            shutil.copyfile(APPROVED / reference["file"], OUTPUT / filename)
        else:
            image.save(OUTPUT / filename)
        closure_files = []
        for level in range(1, 5):
            name = f"surprise-smooth-{index:02d}-blink-{level}.png"
            shutil.copyfile(APPROVED / reference["blinks"][level-1] if index == 0
                            else OUTPUT / filename, OUTPUT / name)
            closure_files.append(name)
        expanded = []
        scales = []
        for (x0, y0, x1, y1), (tx0, ty0, tx1, ty1) in zip(eyes, targets):
            sx = 1 + ((tx1-tx0)/(x1-x0)-1)*strength
            sy = 1 + ((ty1-ty0)/(y1-y0)-1)*strength
            cx, cy = (x0+x1-1)/2, (y0+y1-1)/2
            cx += ((tx0+tx1-1)/2-cx)*strength
            cy += ((ty0+ty1-1)/2-cy)*strength
            hx, hy = ((x1-x0)*sx-1)/2, ((y1-y0)*sy-1)/2
            expanded.append([int(np.floor(cx-hx)), int(np.floor(cy-hy)),
                             int(np.ceil(cx+hx))+1, int(np.ceil(cy+hy))+1])
            scales.append([sx, sy])
        matrix = recoil_matrix(neutral.size, strength)
        frames.append(dict(file=filename, blinks=closure_files,
                           eyes=[transform_bounds(bounds, matrix) for bounds in expanded],
                           headRotationDegrees=RECOIL_DEGREES * strength,
                           headTranslation=[0, -RECOIL_RISE * strength],
                           sourceBounds=[0, 0, 240, 224], sourceIndex=0, strength=strength,
                           eyeScale=scales, sha256=digest(OUTPUT / filename),
                           blinkMaskState="visible" if index == 0 else "expression-preserved"))
        images.append(image)
        x, y = index % 6 * 240, index // 6 * 248
        contact.paste(image, (x, y))
        ImageDraw.Draw(contact).text((x+8, y+228), f"Surprise {index:02d}", fill="white")
    contact.save(OUTPUT / "review/smooth-surprise-contact.png")
    track = dict(
        title="Smooth surprise / gentle recoil", provider="Azure GPT Image",
        source="references/shared-neutral.png", sourceSha256=digest(reference_path),
        generationProvenance=str(recipe_path.relative_to(ROOT)),
        width=240, height=224, count=COUNT, frames=frames, sheet="review/smooth-surprise-contact.png",
        rendering="localized-eye-light-rigid-recoil", eyeRegions=eye_regions(eyes, targets), targetEyes=targets,
        recoilDegrees=RECOIL_DEGREES, recoilRise=RECOIL_RISE,
        processing="Approved GPT head with monotonic subpixel eye lights, followed by a single rigid rotation and translation. No head morph, scaling, crossfade, or independently generated eye shapes.",
        status="Web-review candidate; replaces the rejected jittery surprise sequence.",
        blinkPolicy="expression-preserved", recommendedPlaybackIndices=list(range(COUNT)),
        recommendedLoopIndices=[23], recommendedLoopFrameMs=120,
        qualityNotes="Original endpoint eye geometry is preserved relative to the head. A two-degree tilt and four-source-pixel lift ease out with the widening eyes, then settle by retracing the exact frames. All original GPT surprise images remain untouched.",
    )
    (OUTPUT / "review/smooth-surprise.json").write_text(json.dumps(track, indent=2) + "\n")
    sequence = images + images[-2::-1]
    sequence[0].save(OUTPUT / "review/smooth-surprise-animation.webp", save_all=True,
                     append_images=sequence[1:], duration=40, loop=0, lossless=True)
    return track


def publish():
    path = OUTPUT / "animation.json"
    manifest = json.loads(path.read_text())
    before = copy.deepcopy(manifest["directions"])
    manifest["directions"]["surprise"] = build_track()
    assert all(before[name] == manifest["directions"][name] for name in ("working", "complete", "attention"))
    manifest["status"] = "Web-review candidate: smooth surprise eyes with gentle rigid head recoil; other expression tracks unchanged."
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(path)
    print("Published smooth surprise for web review; original sprites retained, other modes unchanged.")


if __name__ == "__main__":
    publish()

#!/usr/bin/env python3
"""Bake a one-way, equal-time surprise spring into approved source artwork.

Run --review-only to generate new PNGs/recipes/previews without publishing.
The default publishes ONLY the surprise entry. No cloud calls or binary export.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw

from smooth_surprise import (
    APPROVED, OUTPUT, ROOT, digest, eye_regions, render, transform_bounds, transform_head,
)


COUNT = 24
DURATION_MS = 800
COMPRESSION = 0.085
DAMPING = 5.0
ANGULAR_FREQUENCY = 3 * math.pi
RISE_PIXELS = 3.0
TAPER_START = 0.6
EYE_PEAK_TIME = 4 / (COUNT - 1)
PREFIX = "surprise-spring"
REVIEW = OUTPUT / "review"


def rest_envelope(t):
    u = min(1., max(0., (t - TAPER_START) / (1 - TAPER_START)))
    return 1 - (6*u**5 - 15*u**4 + 10*u**3)


def physics(t):
    """Sample displacement directly in time, not through a playback easing curve."""
    if not math.isfinite(t) or not 0 <= t <= 1:
        raise ValueError("Normalized sample time must be finite and within [0, 1].")
    if t in (0, 1):
        return dict(headScale=1., headTranslation=[0., 0.],
                    headRotationDegrees=0., strength=0., compression=0.)
    # Squaring the signed sine gives a finite-onset contact response with zero
    # initial velocity, avoiding the first-frame snap of an instantaneous kick.
    peak_time = math.atan(2 * ANGULAR_FREQUENCY / DAMPING) / ANGULAR_FREQUENCY
    peak = math.exp(-DAMPING * peak_time) * math.sin(ANGULAR_FREQUENCY * peak_time)**2
    sine = math.sin(ANGULAR_FREQUENCY * t)
    impulse = math.exp(-DAMPING * t) * sine * abs(sine) / peak
    impulse *= rest_envelope(t)
    ratio = t / EYE_PEAK_TIME
    eye_strength = ratio**2 * math.exp(2 * (1 - ratio)) * rest_envelope(t)
    return dict(
        headScale=1 - COMPRESSION * impulse,
        headTranslation=[0., -RISE_PIXELS * impulse],
        headRotationDegrees=0.,
        strength=min(1., max(0., eye_strength)),
        compression=COMPRESSION * impulse,
    )


def spring_matrix(size, t):
    sample = physics(t)
    center = np.asarray(size, dtype=float) / 2
    matrix = np.eye(3)
    matrix[:2, :2] *= sample["headScale"]
    matrix[:2, 2] = center - matrix[:2, :2] @ center + sample["headTranslation"]
    return matrix


def render_frame(neutral, eyes, targets, t):
    sample = physics(t)
    if t in (0, 1):
        return neutral.copy()
    eye_image = render(neutral, eyes, targets, sample["strength"])
    return transform_head(eye_image, spring_matrix(neutral.size, t))


def eye_geometry(eyes, targets, strength):
    if strength == 0:
        return copy.deepcopy(eyes), [[1., 1.] for _ in eyes]
    bounds, scales = [], []
    for (x0, y0, x1, y1), (tx0, ty0, tx1, ty1) in zip(eyes, targets):
        sx = 1 + ((tx1-tx0)/(x1-x0)-1) * strength
        sy = 1 + ((ty1-ty0)/(y1-y0)-1) * strength
        cx, cy = (x0+x1-1)/2, (y0+y1-1)/2
        cx += ((tx0+tx1-1)/2-cx) * strength
        cy += ((ty0+ty1-1)/2-cy) * strength
        hx, hy = ((x1-x0)*sx-1)/2, ((y1-y0)*sy-1)/2
        bounds.append([math.floor(cx-hx), math.floor(cy-hy),
                       math.ceil(cx+hx)+1, math.ceil(cy+hy)+1])
        scales.append([sx, sy])
    return bounds, scales


def retain_preservation_record():
    path = REVIEW / f"{PREFIX}-preservation.json"
    if path.exists():
        return
    manifest = json.loads((OUTPUT / "animation.json").read_text())
    record = {
        "otherTracks": {name: track for name, track in manifest["directions"].items()
                        if name != "surprise"},
        "approvedManifestSha256": digest(APPROVED / "animation.json"),
        "originalPngSha256": {
            path.name: digest(path) for path in sorted(OUTPUT.glob("*.png"))
            if not path.name.startswith(PREFIX + "-")
        },
    }
    path.write_text(json.dumps(record, indent=2) + "\n")


def curve_preview(samples):
    image = Image.new("RGB", (960, 420), (14, 18, 26))
    draw = ImageDraw.Draw(image)
    for title, key, low, high, color, top in (
        ("Uniform head scale", "headScale", .90, 1.03, (112, 202, 255), 32),
        ("Approved eye-light strength", "strength", 0., 1., (193, 148, 255), 235),
    ):
        draw.text((20, top-20), title, fill="white")
        draw.line((50, top, 50, top+135, 925, top+135), fill=(100, 110, 130))
        points = [(50+i*875/(COUNT-1), top+135*(1-(s[key]-low)/(high-low)))
                  for i, s in enumerate(samples)]
        draw.line(points, fill=color, width=2)
        for x, y in points:
            draw.ellipse((x-2,y-2,x+2,y+2), fill=color)
        for i in (0,3,11,23):
            draw.text((points[i][0]-8,top+142), f"{DURATION_MS*i/(COUNT-1):.0f}ms",
                      fill=(190,200,220))
        draw.text((5,top), str(high), fill=(190,200,220))
        draw.text((5,top+120), str(low), fill=(190,200,220))
    image.save(REVIEW / f"{PREFIX}-curves.png")


def motion_summary(samples):
    compression = min(range(COUNT), key=lambda i: samples[i]["headScale"])
    rebound = max(range(COUNT), key=lambda i: samples[i]["headScale"])
    eyes = max(range(COUNT), key=lambda i: samples[i]["strength"])
    return dict(
        maxCompressionPercent=round(100*(1-samples[compression]["headScale"]), 6),
        compressionPeakFrame=compression, compressionPeakMs=round(DURATION_MS*compression/(COUNT-1), 6),
        maxOversizePercent=round(100*(samples[rebound]["headScale"]-1), 6),
        reboundPeakFrame=rebound, reboundPeakMs=round(DURATION_MS*rebound/(COUNT-1), 6),
        eyePeakFrame=eyes, eyePeakMs=round(DURATION_MS*eyes/(COUNT-1), 6),
        maxUpwardRecoilPixels=round(-min(s["headTranslation"][1] for s in samples), 6),
        settledFrame=COUNT-1, settledAtMs=DURATION_MS,
    )


def build_track():
    REVIEW.mkdir(parents=True, exist_ok=True)
    retain_preservation_record()
    approved = json.loads((APPROVED / "animation.json").read_text())
    reference = approved["directions"]["right"]["frames"][0]
    neutral_path = APPROVED / reference["file"]
    neutral = Image.open(neutral_path).convert("RGB")
    eyes = reference["eyes"]
    original_manifest_path = OUTPUT / "animation.candidate.json"
    original = json.loads(original_manifest_path.read_text())["directions"]["surprise"]
    targets = original["frames"][-1]["eyes"]
    source = OUTPUT / "references/shared-neutral.png"
    if source.read_bytes() != neutral_path.read_bytes():
        raise ValueError("Existing shared-neutral reference is not the current approved PNG.")
    recipe_path = REVIEW / f"{PREFIX}-recipe.json"
    recipe = {
        "algorithm": "localized-approved-eye-light-uniform-spring-v1",
        "sha256": digest(source),
        "source": str(source.relative_to(ROOT)),
        "script": str(Path(__file__).resolve().relative_to(ROOT)),
        "scriptSha256": digest(__file__),
        "helperSha256": {
            name: digest(ROOT / name) for name in
            ("characters/copilot/tools/smooth_surprise.py", "characters/copilot/tools/prepare_sprite_animation.py")
        },
        "sourcePngSha256": {
            str((APPROVED / name).relative_to(ROOT)): digest(APPROVED / name)
            for name in (reference["file"], *reference["blinks"])
        },
        "originalReactionManifest": str(original_manifest_path.relative_to(ROOT)),
        "originalReactionManifestSha256": digest(original_manifest_path),
        "originalEndpointPngSha256": digest(OUTPUT / original["frames"][-1]["file"]),
        "targetEyes": targets,
        "eyeRegions": eye_regions(eyes, targets),
        "parameters": dict(
            count=COUNT, durationMs=DURATION_MS, compression=COMPRESSION,
            damping=DAMPING, angularFrequency=ANGULAR_FREQUENCY,
            signedSinePower=2, risePixels=RISE_PIXELS,
            taperStart=TAPER_START, eyePeakTime=EYE_PEAK_TIME, eyePulsePower=2,
        ),
        "sampling": "t=i/23. Equal-time physical samples; no additional playback easing or reversed return.",
        "displacement": "normalized exp(-5*t)*sin(3*pi*t)*abs(sin(3*pi*t)), with a C2 amplitude taper to rest",
        "note": ("Local deterministic derivative of approved artwork; no new AI generation. "
                 "Only approved eye-light layers change before one uniform whole-image transform. "
                 "Both endpoints copy the approved PNG and all four approved blink PNGs exactly. "
                 "Finish interruptions forward to neutral frame 23."),
    }
    width, height = neutral.size
    contact = Image.new("RGB", (width*6, (height+30)*4), (14,18,26))
    frames, images, samples = [], [], []
    for index in range(COUNT):
        t = index / (COUNT-1)
        sample = physics(t)
        matrix = spring_matrix(neutral.size, t)
        image = render_frame(neutral, eyes, targets, t)
        filename = f"{PREFIX}-{index:02d}.png"
        blinks = [f"{PREFIX}-{index:02d}-blink-{level}.png" for level in range(1,5)]
        at_rest = index in (0, COUNT-1)
        if at_rest:
            for destination, source_name in zip((filename, *blinks), (reference["file"], *reference["blinks"])):
                shutil.copyfile(APPROVED / source_name, OUTPUT / destination)
        else:
            image.save(OUTPUT / filename)
            for name in blinks:
                shutil.copyfile(OUTPUT / filename, OUTPUT / name)
        local_eyes, scales = eye_geometry(eyes, targets, sample["strength"])
        frames.append(dict(
            file=filename, blinks=blinks,
            eyes=copy.deepcopy(eyes) if at_rest else [transform_bounds(b, matrix) for b in local_eyes],
            eyeLocalBounds=local_eyes, eyeScale=scales,
            sourceBounds=[0,0,width,height], sourceIndex=0,
            sampleTime=t, sampleTimeMs=DURATION_MS*t,
            headTransform=matrix.tolist(), **sample,
            sha256=digest(OUTPUT / filename),
            blinkMaskState="visible" if at_rest else "expression-preserved",
            neutralOverride=at_rest,
        ))
        images.append(image)
        samples.append(sample)
        x, y = index % 6 * width, index // 6 * (height+30)
        contact.paste(image, (x,y))
        ImageDraw.Draw(contact).text(
            (x+7,y+height+5), f"{index:02d}  {DURATION_MS*t:.0f}ms   scale {sample['headScale']:.3f}",
            fill="white")
    contact.save(REVIEW / f"{PREFIX}-contact.png")
    curve_preview(samples)
    summary = motion_summary(samples)
    recipe["springMotion"] = summary
    recipe_path.write_text(json.dumps(recipe, indent=2) + "\n")
    # Preview-only rest hold separates repeated reactions. It is not a source
    # pose, extra physics sample, or part of the 800ms production trajectory.
    times = [round(DURATION_MS*i/(COUNT-1)) for i in range(COUNT)]
    durations = [b-a for a,b in zip(times,times[1:])] + [500]
    images[0].save(REVIEW / f"{PREFIX}-animation.webp", save_all=True,
                   append_images=images[1:], duration=durations, loop=0, lossless=True)
    track = dict(
        title="Surprise / quick spring recoil and settle", provider="Azure GPT Image",
        derivation="local-deterministic", source="references/shared-neutral.png",
        sourceSha256=digest(source), generationProvenance=str(recipe_path.relative_to(ROOT)),
        width=width, height=height, count=COUNT, frames=frames,
        sheet=f"review/{PREFIX}-contact.png",
        rendering="localized-eye-light-uniform-spring",
        eyeRegions=eye_regions(eyes, targets), targetEyes=targets,
        durationMs=DURATION_MS, sampleTimesMs=[DURATION_MS*i/(COUNT-1) for i in range(COUNT)],
        springMotion=summary,
        sampling="uniform-time", neutralFrames=[0,COUNT-1], terminalFrame=COUNT-1,
        interruptionPolicy="finish-forward-to-frame-23",
        playback="One-way samples 0..23, already timed by physics. No additional easing and no reversed return.",
        processing="Approved eye-light render followed by one whole-image uniform scale and translation. No nonuniform head warp, crossfade, mirrored head, or new image generation.",
        status="Web-only review candidate; no payload export or device upload performed.",
        blinkPolicy="expression-preserved-between-neutral-endpoints",
        recommendedPlaybackIndices=list(range(COUNT)), recommendedLoopIndices=[COUNT-1],
        recommendedLoopFrameMs=120,
        qualityNotes="Finite-onset 8.5% compression, one approximately 1.6% oversized rebound, and a tiny settling tail. Eye widening reaches the unchanged approved target geometry, then relaxes. Both endpoints and all five blink levels are exact shared neutral. All earlier surprise artwork is retained.",
    )
    (REVIEW / f"{PREFIX}.json").write_text(json.dumps(track, indent=2) + "\n")
    print(f"Generated {COUNT} equal-time spring poses; scale "
          f"{min(s['headScale'] for s in samples):.6f}..{max(s['headScale'] for s in samples):.6f}.")
    return track


def publish():
    track = build_track()
    path = OUTPUT / "animation.json"
    manifest = json.loads(path.read_text())
    before = copy.deepcopy(manifest)
    manifest["directions"]["surprise"] = track
    check = copy.deepcopy(manifest)
    check["directions"]["surprise"] = before["directions"]["surprise"]
    if check != before:
        raise AssertionError("Only the active surprise entry may change.")
    pending = REVIEW / f"{PREFIX}-manifest.pending.json"
    pending.write_text(json.dumps(manifest, indent=2) + "\n")
    pending.replace(path)
    print("Published only the active surprise entry; other tracks and all original PNGs are unchanged.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-only", action="store_true", help="Do not change animation.json.")
    args = parser.parse_args()
    build_track() if args.review_only else publish()


if __name__ == "__main__":
    main()

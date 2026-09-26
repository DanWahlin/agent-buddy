#!/usr/bin/env python3
"""Stage GPT expression sprites using rigid registration and localized eyelids.

Workflow: guides -> existing generate_sprite_sheet.py image-edit requests ->
prepare -> inspect review contact sheets -> publish-reviewed. Raw generations,
raw crops, prompts, and provenance are retained. Existing sprites are read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import (
    binary_dilation, binary_fill_holes, binary_opening, distance_transform_edt, find_objects, label,
    map_coordinates, gaussian_filter1d,
)
from scipy.optimize import least_squares

from prepare_sprite_animation import blink


ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "characters/copilot/expressions"
APPROVED = ROOT / "characters/copilot/sprites"
DIRECTIONS = ("surprise", "working", "complete", "attention")
WIDTH, HEIGHT, COUNT = 240, 224, 24
LEVELS = (1, 0.75, 0.5, 0.25, 0)
EXPRESSIONS = {
    "surprise": {
        "description": (
            "A friendly surprised reaction when the user touches the mascot. "
            "The TWO SMALL CYAN EYES IN THE LOWER FACEPLATE gradually widen from "
            "the reference's slim upright rounded bars into taller, wider, rounded "
            "capsules. Endpoint eyes are about 1.5 times their initial width and "
            "1.2 times their height. Add only a tiny startled recoil, at most "
            "2 degrees of backward pitch. Surprise is cute and delighted, not "
            "frightened, distressed, or alarmed. The goggles NEVER widen."
        ),
        "endpoint": "friendly wide cyan eyes; tiny recoil",
        "blinkPolicy": "expression-preserved",
        "playback": "Play 0..23 on touch, hold briefly, then reverse the identical frames to neutral.",
    },
    "working": {
        "description": (
            "A calm, focused thinking expression while a coding assistant works. "
            "The TWO SMALL CYAN EYES IN THE LOWER FACEPLATE gradually squint into "
            "shorter softly rounded horizontal capsules, about half their original "
            "height, without angry slanted eyebrows. Their cyan gaze shifts only "
            "2 pixels to the viewer's right. Add a gentle 3-degree clockwise rigid "
            "head roll and at most 2 degrees of downward pitch. This is absorbed, "
            "friendly concentration, not sadness, sleepiness, anger or stress."
        ),
        "endpoint": "focused short cyan eyes; subtle thinking tilt",
        "blinkPolicy": "localized",
        "playback": "Enter with 0..23; use a short endpoint ping-pong or hold with blinks while busy; reverse on exit.",
    },
    "complete": {
        "description": (
            "A joyful, proud success expression after completing the developer's "
            "task. The TWO SMALL CYAN EYES IN THE LOWER FACEPLATE gradually become "
            "two bright HAPPY CRESCENT EYES: softly curved inverted-U closed-eye "
            "arcs, like a warm smiling squint, not downward sad curves. They occupy "
            "the same two eye locations as the reference. Add at most 3 degrees "
            "of proud upward head pitch. The goggles remain entirely unchanged. "
            "The joyful expression must be clear without a mouth or accessories."
        ),
        "endpoint": "joyful closed crescent eyes; proud upbeat tilt",
        "blinkPolicy": "expression-preserved",
        "playback": "Play 0..23, hold or gently ping-pong the endpoint while external celebration effects run, then reverse.",
    },
    "attention": {
        "description": (
            "A friendly inquisitive expression asking the developer for input. "
            "The TWO SMALL CYAN EYES IN THE LOWER FACEPLATE become gently asymmetric: "
            "the viewer-left eye is slightly taller and wider, while the viewer-right "
            "eye narrows to about half its neutral height. Keep both eyes luminous, "
            "friendly and readable. Add a curious rigid 5-degree counterclockwise "
            "head roll, with no more than 1 degree of yaw. It must look interested "
            "and patient, never frightened, angry, sad, or alarmed. No eyebrow marks."
        ),
        "endpoint": "curious asymmetric cyan eyes; friendly questioning tilt",
        "blinkPolicy": "localized",
        "playback": "Enter with 0..23, hold the curious pose with occasional localized blinks while waiting, then reverse.",
    },
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def approved_manifest():
    return json.loads((APPROVED / "animation.json").read_text())


def create_guides():
    for name in ("references", "prompts", "guides", "sources", "raw-crops", "review"):
        (OUTPUT / name).mkdir(parents=True, exist_ok=True)
    original = approved_manifest()["directions"]["right"]["frames"][0]["file"]
    reference = OUTPUT / "references/shared-neutral.png"
    shutil.copyfile(APPROVED / original, reference)
    front = Image.open(reference).convert("RGB")
    font = ImageFont.load_default(size=13)
    for direction in DIRECTIONS:
        spec = EXPRESSIONS[direction]
        guide = Image.new("RGB", (1536, 1024))
        draw = ImageDraw.Draw(guide)
        draw.text((768, 25), f"{direction.upper()}: SAME HEAD, GRADUAL EXPRESSION",
                  fill="white", font=font, anchor="mm")
        for i in range(COUNT):
            row, column = divmod(i, 6)
            x, y = 48 + column * WIDTH, 64 + row * HEIGHT
            guide.paste(front, (x, y))
            draw.rectangle((x, y, x+WIDTH-1, y+HEIGHT-1), outline=(22, 22, 22))
            draw.text((x+120, y+210), f"{i:02d}: expression {i*100/23:.0f}%",
                      fill=(190, 190, 190), font=font, anchor="mm")
        guide.save(OUTPUT / f"guides/{direction}-layout.png")
        prompt = f"""Create one polished production sprite sheet for the expression '{direction}'.

Image 1 is the EXACT approved front-center character. Image 2 is a placement and
identity guide showing that same neutral head in all 24 slots. Edit those heads
into 24 successive rendered states of ONE identical rigid character. This is a
professional technical-animation asset sheet, not a collage of redesigned heads.

OUTPUT: 1536x1024 PNG, high quality. Exactly SIX columns and FOUR rows, 24 complete
separate heads in reading order. Keep the guide's exact centers and generous
proper margins. Each head is approximately 200 pixels wide and 158 pixels high,
with fixed camera scale. Solid pure BLACK background. Ensure all content is fully
visible. REMOVE ALL guide lines, captions, numbers and text in the final artwork.
No labels, letters, question marks, punctuation, icons, particles, confetti,
fireworks, stars, sparkles, hands, arms, body, pedestal, floor or cast shadows.

IDENTITY LOCK: preserve the reference's glossy blue/violet smooth helmet dome,
two thick cyan/cobalt rounded-square goggles perched ABOVE the faceplate, the
goggles' dark saturated-blue inset lenses, separate dark-blue faceplate below
them, pale blue/violet curved visor rim, and rounded blue/violet ear pods.
The goggles and shell are RIGID and IDENTICAL in every frame, with the same
proportions, silhouette, material, bevels, illumination and recessed lenses.
NEVER use the large goggle lenses as expressive eyes. The ONLY expressive eyes
are the TWO SMALL LUMINOUS CYAN MARKS in the LOWER FACEPLATE below the goggles.
Do not add a mouth, nose, eyebrows, hair, teeth or any facial feature.
Retain clean subtle glossy gradients without grain, stipple or texture changes.

EXPRESSION: {spec["description"]}

TEMPORAL PLAN: frame 00 is exactly the neutral reference. Progress steadily and
very gradually toward '{spec["endpoint"]}' at frame 23. The changes per adjacent
frame are tiny, with no jump at row boundaries. Row 1 covers expression strength
0-22%, row 2 26-48%, row 3 52-74%, row 4 78-100%. No animation restart in a new row.
Do not make all frames reach the final emotion immediately. No surprise extra
expressions between frames. Never rotate the head more than 6 degrees total.

Render each frame as a clean discrete view, NOT a blend or morph. No double
outlines, melting goggles, stretchy visor rims, squash/stretch, changes in ear
size, camera zoom, head shrinking or lighting changes. The head must remain
instantly recognizable as the exact approved mascot in image 1.
"""
        (OUTPUT / f"prompts/{direction}.txt").write_text(prompt)
    selection = OUTPUT / "source-selection.json"
    if not selection.exists():
        selection.write_text(json.dumps({d: f"{d}-sheet.png" for d in DIRECTIONS}, indent=2) + "\n")
    print("Created four prompts and fixed-camera guides; copied approved neutral byte-for-byte.")


def refine_attention_guide():
    reference = Image.open(OUTPUT / "references/shared-neutral.png").convert("RGB")
    endpoint = OUTPUT / "references/attention-endpoint-v1.png"
    if not endpoint.exists():
        shutil.copyfile(OUTPUT / "attention-23.png", endpoint)
    for source, target in (("review/attention.json", "review/attention-v1.json"),
                           ("review/attention-contact.png", "review/attention-v1-contact.png")):
        if not (OUTPUT / target).exists():
            shutil.copyfile(OUTPUT / source, OUTPUT / target)
    heights = [25,25,24,24,23,22,22,21,21,20,20,19,19,18,18,17,16,16,15,15,14,14,13,12]
    guide = Image.new("RGB", (1536, 1024))
    draw = ImageDraw.Draw(guide)
    font = ImageFont.load_default(size=12)
    for index, height in enumerate(heights):
        row, col = divmod(index, 6)
        x, y = 48+col*WIDTH, 64+row*HEIGHT
        guide.paste(reference, (x, y))
        draw.rectangle((x, y, x+239, y+223), outline=(22,22,22))
        draw.text((x+120, y+210), f"{index:02d}: right eye {height}px; roll {5*index/23:.1f}",
                  fill="white", font=font, anchor="mm")
    guide.save(OUTPUT / "guides/attention-refined-layout.png")
    prompt = (OUTPUT / "prompts/attention.txt").read_text()
    prompt = prompt.replace(
        "Image 2 is a placement and\nidentity guide showing that same neutral head in all 24 slots.",
        "Image 2 is the desired final curious expression, NOT the starting pose.\n"
        "Image 3 is a placement and identity guide showing the neutral head in all 24 slots.",
    )
    prompt += f"""

CRITICAL CORRECTION TO THE PREVIOUS ATTEMPT: do not make the first row already
curious. The first two heads MUST still have two equally open upright cyan eyes,
matching Image 1 exactly. Curiosity increases only gradually after those frames.
The FIRST ROW is almost neutral, NOT a line of already-half-closed right eyes.
Match the following approximate viewer-right eye heights in pixels in reading
order (one value per frame): {heights}.
The viewer-left eye stays 25 pixels tall until frame 8, then very gradually
increases to 27 pixels by frame 23. Both eye widths remain about 14-15 pixels.
Keep each eye's center in its normal faceplate location. Do not make the small
right eye a dot. Its final height is about HALF neutral, not nearly fully closed.
Rigid roll progresses evenly from zero to only 5 degrees counterclockwise.
Frame 00 and frame 01 should be visually almost identical to Image 1.
Again, the large goggles never change expression, size, lens shape, or design.
No text of any kind in the output. The guide's pixel values are instructions,
not labels to include in the generated image. Preserve generous black margins.
"""
    (OUTPUT / "prompts/attention-refined.txt").write_text(prompt)
    print("Prepared one bounded attention refinement; previous sheet/prompt/provenance are retained.")


def colored_heads(sheet):
    pixels = np.asarray(sheet).astype(np.int16)
    colored = ((pixels.max(axis=2) > 32)
               & (pixels.max(axis=2)-pixels.min(axis=2) > 18))
    labels, _ = label(colored)
    heads = []
    for ident, box in enumerate(find_objects(labels), 1):
        if box is not None and np.count_nonzero(labels[box] == ident) > 1500:
            yy, xx = box
            heads.append((ident, (xx.start, yy.start, xx.stop, yy.stop)))
    if len(heads) != COUNT:
        raise ValueError(f"Expected 24 complete isolated heads, found {len(heads)}; retain and inspect raw source.")
    heads.sort(key=lambda item: (item[1][1]+item[1][3])/2)
    ordered = []
    for row in range(4):
        ordered.extend(sorted(heads[row*6:row*6+6], key=lambda item: item[1][0]))
    return labels, ordered


def isolate_crop(sheet, labels, identity, bounds):
    x0, y0, x1, y1 = bounds
    if min(x0, y0) < 3 or x1+3 >= sheet.width or y1+3 >= sheet.height:
        raise ValueError("Generated head touches a sheet edge.")
    crop_bounds = (x0-3, y0-3, x1+3, y1+3)
    raw = sheet.crop(crop_bounds)
    component = binary_fill_holes(labels[y0-3:y1+3, x0-3:x1+3] == identity)
    values = np.asarray(raw).astype(np.int16)
    colored = values.max(axis=2)-values.min(axis=2) > 5
    keep = component | (binary_dilation(component, iterations=2) & colored)
    return raw, Image.fromarray(np.where(keep[..., None], values, 0).astype(np.uint8)), crop_bounds


def expression_eyes(image):
    pixels = np.asarray(image).astype(float)
    cyan = ((pixels[..., 1] > 115) & (pixels[..., 2] > 155)
            & (pixels[..., 1] > pixels[..., 0]*1.15))
    # Head rotation is small: the visor eyes remain below, separate from goggles.
    cyan[:118] = False
    cyan[165:] = False
    cyan[:, :78] = False
    cyan[:, 168:] = False
    labels, _ = label(cyan)
    candidates = []
    for ident, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        yy, xx = box
        width, height = xx.stop-xx.start, yy.stop-yy.start
        area = np.count_nonzero(labels[box] == ident)
        if 3 <= width <= 32 and 2 <= height <= 48 and area >= 12:
            candidates.append((area, (xx.start, yy.start, xx.stop, yy.stop)))
    candidates.sort(reverse=True)
    if len(candidates) < 2:
        raise ValueError(f"Ambiguous expression eyes: {candidates}; inspect before staging blink masks.")
    bounds = sorted([box for _, box in candidates[:2]])
    if bounds[0][2] >= bounds[1][0] or not (80 <= (bounds[0][0]+bounds[0][2])/2 < 125
                                           and 115 < (bounds[1][0]+bounds[1][2])/2 <= 165):
        raise ValueError(f"Expression eye localization is not a plausible pair: {bounds}")
    return bounds


def apparent_goggle_roll(image):
    """Measure visible lens-center roll, not an inferred 3-D pitch/yaw angle."""
    rgb = np.asarray(image).astype(float)
    centers = []
    for left, right in ((48,119), (122,192)):
        roi = rgb[40:110, left:right]
        dark_blue = ((roi[...,0] < 65) & (roi[...,1] < 70)
                     & (roi[...,2] > 50) & (roi[...,2] < 240))
        components, _ = label(binary_opening(dark_blue, structure=np.ones((3,3))))
        sizes = np.bincount(components.ravel())
        sizes[0] = 0
        if sizes.max() < 250:
            raise ValueError("Cannot identify a coherent dark goggle lens.")
        yy, xx = np.nonzero(components == sizes.argmax())
        centers.append((float(xx.mean()+left), float(yy.mean()+40)))
    a, b = centers
    return math.degrees(math.atan2(b[1]-a[1], b[0]-a[0]))


def reconstruct_frame(sheet, frame):
    labels, _ = colored_heads(sheet)
    x0, y0, x1, y1 = frame["sourceBounds"]
    local = labels[y0:y1, x0:x1]
    ids, counts = np.unique(local[local > 0], return_counts=True)
    identity = ids[np.argmax(counts)]
    _, isolated, _ = isolate_crop(sheet, labels, identity, frame["sourceBounds"])
    result = Image.new("RGB", (WIDTH, HEIGHT))
    normalized = isolated.resize(tuple(frame["registeredSize"]), Image.Resampling.LANCZOS)
    result.paste(normalized, tuple(frame["translation"]))
    return result


def rigid_registration(crop, reference, baseline_scale):
    """Keep the registered head width fixed; align the rigid shell by translation."""
    source = np.asarray(crop).astype(float)
    reference = np.asarray(reference).astype(float)
    yy, xx = np.mgrid[30:195:2, 20:221:2]
    selected = reference[yy, xx].max(axis=-1) > 45
    selected &= ~((yy >= 117) & (yy <= 166) & (xx >= 76) & (xx <= 170))
    x, y = xx[selected], yy[selected]
    target = reference[y, x]
    initial = np.array([(WIDTH-crop.width*baseline_scale)/2,
                        (HEIGHT-crop.height*baseline_scale)/2])

    def residual(parameters):
        left, top = parameters
        coordinates = [(y-top)/baseline_scale, (x-left)/baseline_scale]
        sample = np.stack([map_coordinates(source[..., c], coordinates, order=1,
                                          mode="constant") for c in range(3)], axis=-1)
        regularization = ((parameters-initial) / 0.7) * 12
        return np.r_[(sample-target).ravel(), regularization]

    fit = least_squares(residual, initial, bounds=(
        initial-3,
        initial+3,
    ), loss="soft_l1", f_scale=12, max_nfev=30)
    left, top = fit.x
    return float(baseline_scale), (float(left), float(top))


def prepare_track(direction, filename, approved):
    source = OUTPUT / "sources" / filename
    provenance_path = source.with_suffix(".json")
    provenance = json.loads(provenance_path.read_text())
    source_hash = digest(source)
    if provenance["sha256"] != source_hash:
        raise ValueError(f"{direction}: generated sheet and API provenance hash disagree.")
    sheet = Image.open(source).convert("RGB")
    if sheet.size != (1536, 1024):
        raise ValueError("Expected a 1536x1024 GPT source sheet.")
    labels, heads = colored_heads(sheet)
    reference = approved["directions"]["right"]["frames"][0]
    neutral = Image.open(APPROVED / reference["file"]).convert("RGB")
    yy, xx = np.nonzero(np.asarray(neutral).max(axis=2) > 32)
    target_width = int(xx.max()-xx.min()+1)
    contact = Image.new("RGB", (WIDTH*6, (HEIGHT+22)*4), (14, 18, 26))
    frames = []
    crops = [isolate_crop(sheet, labels, identity, bounds) for identity, bounds in heads]
    fits = [rigid_registration(crop, neutral, (target_width+6)/crop.width)
            for _, crop, _ in crops]
    widths = [scale*crop.width for (_, crop, _), (scale, _) in zip(crops, fits)]
    centers = [(left+crop.width*scale/2, top+crop.height*scale/2)
               for (_, crop, _), (scale, (left, top)) in zip(crops, fits)]
    # Stabilize registration parameters, never image pixels or pose geometry.
    widths = gaussian_filter1d(widths, 1.2, mode="nearest")
    centers = gaussian_filter1d(np.asarray(centers), 1.2, axis=0, mode="nearest")
    for index, ((identity, bounds), (raw, crop, crop_bounds)) in enumerate(zip(heads, crops)):
        raw_name = f"raw-crops/{source.stem}/{direction}-{index:02d}.png"
        (OUTPUT / raw_name).parent.mkdir(parents=True, exist_ok=True)
        raw.save(OUTPUT / raw_name)
        scale = float(widths[index]/crop.width)
        width, height = round(crop.width*scale), round(crop.height*scale)
        translation = (round(float(centers[index,0]-width/2)),
                       round(float(centers[index,1]-height/2)))
        if width > 226 or not 135 <= height <= 198:
            raise ValueError(f"{direction} {index}: implausible registered size {width}x{height}.")
        cell = Image.new("RGB", (WIDTH, HEIGHT))
        cell.paste(crop.resize((width, height), Image.Resampling.LANCZOS), translation)
        filename = f"{direction}-{index:02d}.png"
        if index == 0:
            shutil.copyfile(APPROVED / reference["file"], OUTPUT / filename)
            cell = neutral.copy()
        else:
            cell.save(OUTPUT / filename)
        try:
            eyes = reference["eyes"] if index == 0 else expression_eyes(cell)
        except ValueError as error:
            raise ValueError(f"{direction} frame {index}: {error}") from error
        preserve = EXPRESSIONS[direction]["blinkPolicy"] == "expression-preserved" and index != 0
        frame = {
            "file": filename, "sourceBounds": list(bounds), "uniformScale": scale,
            "eyes": eyes, "blinkMaskState": "expression-preserved" if preserve else "visible",
            "blinks": [], "rawCrop": raw_name, "cropBounds": list(crop_bounds),
            "registeredSize": [width, height], "translation": list(translation),
            "sourceIndex": index, "neutralOverride": index == 0,
            "sha256": digest(OUTPUT / filename),
        }
        for level, openness in enumerate(LEVELS[1:], 1):
            blink_name = f"{direction}-{index:02d}-blink-{level}.png"
            if index == 0:
                shutil.copyfile(APPROVED / reference["blinks"][level-1], OUTPUT / blink_name)
            elif preserve:
                shutil.copyfile(OUTPUT / filename, OUTPUT / blink_name)
            else:
                blink(cell, eyes, openness).save(OUTPUT / blink_name)
            frame["blinks"].append(blink_name)
        frames.append(frame)
        x, y = (index % 6)*WIDTH, (index // 6)*(HEIGHT+22)
        contact.paste(cell, (x, y))
        ImageDraw.Draw(contact).text((x+8, y+HEIGHT+4), f"{direction} {index:02d}", fill="white")
    contact.save(OUTPUT / f"review/{direction}-contact.png")
    track = {
        "title": f"GPT Image {direction} expression", "provider": "Azure GPT Image",
        "source": f"sources/{source.name}", "sourceSha256": source_hash,
        "generationProvenance": str(provenance_path.relative_to(ROOT)),
        "width": WIDTH, "height": HEIGHT, "count": COUNT, "frames": frames,
        "sheet": f"sources/{source.name}",
        "playback": EXPRESSIONS[direction]["playback"],
        "processing": ("Colored-head isolation, shell-aligned translation and uniform-scale registration only. "
                       "Temporal smoothing applies only to global registration parameters, never to image pixels. "
                       "No shape warping, rotation synthesis, morphing or crossfades. "
                       "Frame 00 is the exact approved neutral PNG; all raw crops are retained."),
        "status": "Staged for expression and temporal review; not integrated into the live player.",
        "blinkPolicy": EXPRESSIONS[direction]["blinkPolicy"],
        "recommendedPlaybackIndices": ([0,8,10,12,14,16,18,20,22,23]
                                       if direction == "surprise" else list(range(COUNT))),
        "recommendedLoopIndices": ([20,21,22,23,22,21] if direction == "working"
                                   else [21,22,23,22] if direction == "attention" else [23]),
        "recommendedLoopFrameMs": 120,
        "qualityNotes": (
            "All 24 generated source poses are retained. The optional surprise subset "
            "skips a redundant early narrow-eye phase and gives a quicker touch reaction."
            if direction == "surprise" else
            "Small independent-render shading/pose variations remain; use the short slow endpoint loop "
            "or hold the endpoint with localized blinks instead of repeatedly replaying the entire entrance."
        ),
    }
    (OUTPUT / f"review/{direction}.json").write_text(json.dumps(track, indent=2) + "\n")
    return track


def prepare():
    approved = approved_manifest()
    selection = json.loads((OUTPUT / "source-selection.json").read_text())
    tracks = {d: prepare_track(d, selection[d], approved) for d in DIRECTIONS}
    manifest = {
        "width": WIDTH, "height": HEIGHT, "count": COUNT, "directions": tracks,
        "blinkLevels": list(LEVELS), "centerSha256": approved["centerSha256"],
        "status": "Four staged GPT Image expression tracks; awaiting explicit visual review.",
        "blinkProcessing": ("Localized visor-eye occlusion for working/attention. "
                            "Expression-preserved blink entries reuse exact surprise/joy pixels. "
                            "Neutral and its four blink levels are copied from approved sprites."),
        "approvedSpriteManifestSha256": digest(APPROVED / "animation.json"),
    }
    (OUTPUT / "animation.candidate.json").write_text(json.dumps(manifest, indent=2) + "\n")
    overview = Image.new("RGB", (WIDTH*6, (HEIGHT+24)*4), (14, 18, 26))
    for row, direction in enumerate(DIRECTIONS):
        for col, index in enumerate((0, 4, 9, 14, 19, 23)):
            frame = tracks[direction]["frames"][index]
            image = Image.open(OUTPUT / frame["file"]).convert("RGB")
            overview.paste(image, (col*WIDTH, row*(HEIGHT+24)))
            ImageDraw.Draw(overview).text((col*WIDTH+8, row*(HEIGHT+24)+HEIGHT+5),
                                         f"{direction} {index:02d}", fill="white")
    overview.save(OUTPUT / "review/expressions-contact.png")
    prepare_review_material(manifest)
    print("Prepared four candidate tracks; inspect review/ before publishing animation.json.")


def prepare_review_material(manifest):
    neighbors = Image.new("RGB", (WIDTH*6, (HEIGHT+24)*4), (14,18,26))
    blink_contact = Image.new("RGB", (WIDTH*6, (HEIGHT+24)*4), (14,18,26))
    report = {"tracks": {}, "notes": [
        "All sprite poses come from GPT image-edit sheets; no interpolated poses were synthesized.",
        "Global registration fits only uniform scale and translation; independent rendered shading can still vary.",
        "Surprise and complete preserve expressive eye shapes during requested blinks.",
    ]}
    for row, direction in enumerate(DIRECTIONS):
        track = manifest["directions"][direction]
        images = [Image.open(OUTPUT / f["file"]).convert("RGB") for f in track["frames"]]
        values = [np.asarray(image).astype(float) for image in images]
        adjacent = []
        for a, b in zip(values, values[1:]):
            union = (a.max(axis=-1) > 32) | (b.max(axis=-1) > 32)
            adjacent.append(float(np.abs(a-b)[union].mean()))
        worst = int(np.argmax(adjacent))
        for col, index in enumerate((0,1,worst,worst+1,22,23)):
            x, y = col*WIDTH, row*(HEIGHT+24)
            neighbors.paste(images[index], (x,y))
            ImageDraw.Draw(neighbors).text((x+8,y+HEIGHT+5),
                                          f"{direction} {index:02d}", fill="white")
        for column, index in enumerate((0,12,23)):
            for closed in range(2):
                image = (Image.open(OUTPUT / track["frames"][index]["blinks"][-1]).convert("RGB")
                         if closed else images[index])
                x, y = (column*2+closed)*WIDTH, row*(HEIGHT+24)
                blink_contact.paste(image, (x,y))
                ImageDraw.Draw(blink_contact).text(
                    (x+8,y+HEIGHT+5), f"{direction} {index:02d} {'closed' if closed else 'open'}",
                    fill="white")
        sequence = list(range(COUNT)) + list(range(COUNT-2,-1,-1))
        animation = [images[index] for index in sequence]
        durations = [350 if index in (0,23) else 33 for index in sequence]
        animation[0].save(OUTPUT / f"review/{direction}-animation.webp",
                          save_all=True, append_images=animation[1:], duration=durations,
                          loop=0, lossless=True, method=4)
        report["tracks"][direction] = {
            "adjacentForegroundMAE": [round(v,4) for v in adjacent],
            "medianAdjacentForegroundMAE": round(float(np.median(adjacent)),4),
            "worstAdjacentPair": [worst,worst+1],
            "eyeWidthsHeights": [
                [[x1-x0,y1-y0] for x0,y0,x1,y1 in frame["eyes"]]
                for frame in track["frames"]
            ],
            "apparentGoggleRollDegrees": [round(apparent_goggle_roll(image),3) for image in images],
        }
    neighbors.save(OUTPUT / "review/neighbor-contact.png")
    blink_contact.save(OUTPUT / "review/blink-contact.png")
    (OUTPUT / "review/quality-report.json").write_text(json.dumps(report, indent=2) + "\n")


def publish_reviewed():
    from spring_surprise import build_track as spring_track
    from alternate_attention import build_track as build_alternate_attention
    candidate = json.loads((OUTPUT / "animation.candidate.json").read_text())
    if candidate["approvedSpriteManifestSha256"] != digest(APPROVED / "animation.json"):
        raise ValueError("Approved source manifest changed during preparation.")
    for track in candidate["directions"].values():
        for frame in track["frames"]:
            if digest(OUTPUT / frame["file"]) != frame["sha256"]:
                raise ValueError(f"Frame changed after preparation: {frame['file']}")
            for filename in frame["blinks"]:
                with Image.open(OUTPUT / filename) as image:
                    if image.size != (WIDTH, HEIGHT):
                        raise ValueError(f"Invalid blink dimensions: {filename}")
        track["status"] = "Visually reviewed staged expression track; small independent-render variations remain."
    candidate["directions"]["surprise"] = spring_track()
    candidate["directions"]["attention_alternate"] = build_alternate_attention()
    candidate["status"] = "GPT expression artwork with one-way spring surprise and alternating attention tilts."
    (OUTPUT / "animation.json").write_text(json.dumps(candidate, indent=2) + "\n")
    print("Published only characters/copilot/expressions/animation.json; existing sprites remain untouched.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("guides", "refine-attention-guide", "prepare", "publish-reviewed"))
    args = parser.parse_args()
    {"guides": create_guides, "refine-attention-guide": refine_attention_guide,
     "prepare": prepare, "publish-reviewed": publish_reviewed}[args.action]()


if __name__ == "__main__":
    main()

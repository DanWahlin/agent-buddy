#!/usr/bin/env python3
"""Render every Grok cell procedurally: a white ball with two black pill eyes, on black.

The ball is a sphere seen head-on, so turning it never changes the silhouette;
only the eyes move. Each eye is a decal on the sphere: a pill (stadium) drawn in
the tangent plane at its centre and projected back onto the surface, so it
foreshortens as it slides toward the edge. Every cell is drawn straight at the
device's 412x352 character size with 4x4 supersampling, so no resampling
softens the edges.

Writes sprites/<track>-NN.png and -blink-1..4.png, one manifest per track,
the merged sprites/animation.json, and contact sheets in preview/. The output
is deterministic. Then run export_frames.py and tools/character_pack.py build.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CHARACTER = Path(__file__).resolve().parents[1]
SPRITES = CHARACTER / "sprites"
PREVIEW = CHARACTER / "preview"

WIDTH, HEIGHT = 412, 352
CENTER_X, CENTER_Y = 206, 176
RADIUS = 146
SUPERSAMPLE = 4
BLINK_LEVELS = [1, 0.75, 0.5, 0.25, 0]
BACKGROUND = 0  # black, as for every character; the eyes are the same black, as if cut out of the ball
BODY = 255

IDLE = ("right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left")
EXPRESSIONS = ("surprise", "working", "complete", "attention", "attention_alternate")
ORDER = IDLE + EXPRESSIONS
STEPS = {name: 12 if name in ("up", "down") else 24 for name in ORDER}

# The resting face. Angles are degrees; eye sizes are half-extents in units of RADIUS. The eye
# line stays level: sleep peeks reveal the next blink level in rows from the middle of the eye
# patch, which cuts eyes at different heights unevenly. Each eye leans instead (EYE_SLANT).
EYE_LON, EYE_LAT, EYE_SLANT = 13.5, 7.0, 16.0
EYE_W, EYE_H = 0.088, 0.205
# A closed eye is a short dash along the eye line.
CLOSED_W, CLOSED_H = 0.125, 0.024
# Eyes stop short of the edge (view depth below this), so they never run into the background.
RIM_DEPTH = 0.30

# Idle look directions: (yaw, pitch) at the track's last pose. Positive yaw turns
# toward the viewer's right and positive pitch looks up.
LOOKS = {
    "right": (40, 0), "left": (-40, 0), "up": (0, 24), "down": (0, -24),
    "up_right": (30, 18), "up_left": (-30, 18), "down_right": (30, -18), "down_left": (-30, -18),
}

# Peaks of the surprise curves over [0, 1], so each one tops out at 1.
BOUNCE_PEAK = 0.6208
HOP_PEAK = 0.5273
COMPLETE_CLOSE = 0.45  # the share of the complete track spent closing into a dash before it bends


def lerp(a, b, t):
    return a + (b - a) * t


def pill(lon, *, lat=EYE_LAT, w=EYE_W, h=EYE_H, slant=EYE_SLANT, lid=None, opening=1.0):
    eye = {"kind": "pill", "lon": lon, "lat": lat, "w": w, "h": h, "slant": slant}
    if lid is not None:
        eye["lid"] = lid
    if opening != 1:
        eye["open"] = opening
    return eye


def happy_arc(lon, *, length, thick, curve):
    return {"kind": "arc", "lon": lon, "lat": EYE_LAT, "len": length, "thick": thick, "curve": curve}


def neutral():
    return {"yaw": 0.0, "pitch": 0.0, "roll": 0.0, "sx": 1.0, "sy": 1.0, "dx": 0.0, "dy": 0.0,
            "eyes": [pill(-EYE_LON), pill(EYE_LON)]}


def idle_pose(track, f):
    yaw, pitch = (value * f for value in LOOKS[track])
    pose = neutral()
    pose.update(yaw=yaw, pitch=pitch, roll=3 * yaw / 40, dx=7 * yaw / 40, dy=-6 * pitch / 24)
    return pose


def surprise_pose(f):
    """A startle that springs out and settles back to neutral by the last pose."""
    pop = math.sin(math.pi * f ** 0.55)
    bounce = math.exp(-3.2 * f) * math.sin(3 * math.pi * f) / BOUNCE_PEAK
    hop = math.sin(math.pi * f) * math.exp(-1.5 * f) / HOP_PEAK
    pose = neutral()
    pose.update(pitch=5 * pop, sx=1 - 0.055 * bounce, sy=1 + 0.075 * bounce, dy=-14 * hop,
                eyes=[pill(side * lerp(EYE_LON, 14.5, pop), w=lerp(EYE_W, 0.14, pop),
                           h=lerp(EYE_H, 0.18, pop), slant=lerp(EYE_SLANT, 6, pop)) for side in (-1, 1)])
    return pose


def working_pose(f):
    """Focused: flat upper lids come down as it looks a little lower."""
    pose = neutral()
    lid = None if f == 0 else (lerp(0.30, 0.04, f), 0.0)
    pose.update(pitch=-7 * f, eyes=[pill(side * EYE_LON, w=lerp(EYE_W, 0.1, f), h=lerp(EYE_H, 0.2, f),
                                         slant=lerp(EYE_SLANT, 10, f), lid=lid) for side in (-1, 1)])
    return pose


def complete_pose(f):
    """Happy: the eyes close to dashes, then bend into arcs as the head lifts."""
    pose = neutral()
    pose.update(pitch=6 * f, dy=-6 * f)
    if f <= COMPLETE_CLOSE:
        pose["eyes"] = [pill(side * EYE_LON, opening=1 - f / COMPLETE_CLOSE) for side in (-1, 1)]
    else:
        g = (f - COMPLETE_CLOSE) / (1 - COMPLETE_CLOSE)
        # At g = 0 an unbent arc is exactly the closed dash, so the switch is seamless.
        pose["eyes"] = [happy_arc(side * EYE_LON, length=lerp(CLOSED_W - CLOSED_H, 0.14, g),
                                  thick=lerp(CLOSED_H, 0.066, g), curve=5.2 * g) for side in (-1, 1)]
    return pose


def attention_pose(f, side):
    """A questioning tilt toward one side: the eye on that side shrinks and the other grows."""
    pose = neutral()
    grown = pill(-side * EYE_LON, w=lerp(EYE_W, 0.1, f), h=lerp(EYE_H, 0.26, f))
    shrunk = pill(side * EYE_LON, w=lerp(EYE_W, 0.078, f), h=lerp(EYE_H, 0.13, f))
    pose.update(roll=side * 12 * f, yaw=side * 12 * f, pitch=8 * f,
                eyes=sorted([grown, shrunk], key=lambda eye: eye["lon"]))
    return pose


def pose_for(track, index):
    count = STEPS[track]
    f = index / (count - 1)
    if track in LOOKS:
        return idle_pose(track, f)
    if track == "surprise":
        return neutral() if index in (0, count - 1) else surprise_pose(f)
    if track == "working":
        return working_pose(f)
    if track == "complete":
        return complete_pose(f)
    return attention_pose(f, 1 if track == "attention" else -1)


def rotation(yaw, pitch, roll):
    """Head-to-view rotation: yaw about the vertical axis, then pitch, then roll in the screen plane."""
    y, p, r = (math.radians(value) for value in (yaw, pitch, roll))
    turn = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    nod = np.array([[1, 0, 0], [0, math.cos(p), math.sin(p)], [0, -math.sin(p), math.cos(p)]])
    tilt = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return tilt @ nod @ turn


def stadium(a, b, half_w, half_h):
    """Signed distance to a pill with the given half extents, rounded along its short side."""
    radius = min(half_w, half_h)
    qa = np.maximum(np.abs(a) - (half_w - radius), 0)
    qb = np.maximum(np.abs(b) - (half_h - radius), 0)
    return np.hypot(qa, qb) - radius


def arc(a, b, half_len, half_thick, curve):
    """Signed distance to a pill bent upward along a circular centreline, centred on its own extent."""
    if curve < 1e-3:
        return stadium(a, b, half_len + half_thick, half_thick)
    rho = 1 / curve
    alpha = min(half_len * curve, math.pi * 0.9)
    s, c = math.sin(alpha), math.cos(alpha)
    x = np.abs(a)
    y = b + rho - rho * (1 - c) / 2
    beyond = c * x > s * y
    return np.where(beyond, np.hypot(x - s * rho, y - c * rho), np.abs(np.hypot(x, y) - rho)) - half_thick


def smooth_max(a, b, k):
    h = np.clip(0.5 - 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h + k * h * (1 - h)


def eye_distance(east, north, eye, openness):
    """Distance to one eye in its tangent plane (units of RADIUS); negative inside."""
    if eye["kind"] == "arc":
        thick = max(eye["thick"] * (0.35 + 0.65 * openness), 0.016)
        return arc(east, north, eye["len"], thick, eye["curve"])
    # Blinking interpolates the pill toward the closed dash: shorter, then round, then flat.
    o = openness * eye.get("open", 1)
    half_w = lerp(CLOSED_W, eye["w"], o)
    half_h = lerp(CLOSED_H, eye["h"], o)
    slant = math.radians(eye["slant"]) * o
    a = math.cos(slant) * east + math.sin(slant) * north
    b = -math.sin(slant) * east + math.cos(slant) * north
    distance = stadium(a, b, half_w, half_h)
    if eye.get("lid"):
        height, tilt = eye["lid"]
        tilt = math.radians(tilt)
        lid = math.cos(tilt) * north + math.sin(tilt) * east - lerp(CLOSED_H, height, o)
        distance = smooth_max(distance, lid, 0.03)
    return distance


def eye_frame(eye):
    """The eye's centre and its east/north tangent directions, in head space."""
    lon, lat = math.radians(eye["lon"]), math.radians(eye["lat"])
    centre = np.array([math.cos(lat) * math.sin(lon), math.sin(lat), math.cos(lat) * math.cos(lon)])
    east = np.array([math.cos(lon), 0.0, -math.sin(lon)])
    return centre, east, np.cross(centre, east)


def render(pose, openness=1.0):
    """One cell as an 8-bit grayscale array: black background, white ball, black eyes."""
    ss = SUPERSAMPLE
    rows, columns = np.mgrid[0:HEIGHT * ss, 0:WIDTH * ss]
    x = ((columns + 0.5) / ss - CENTER_X - pose["dx"]) / (RADIUS * pose["sx"])
    y = -((rows + 0.5) / ss - CENTER_Y - pose["dy"]) / (RADIUS * pose["sy"])
    radius2 = x * x + y * y
    inside = radius2 <= 1
    depth = np.sqrt(np.clip(1 - radius2, 0, 1))
    head = np.stack([x, y, depth], axis=-1) @ rotation(pose["yaw"], pose["pitch"], pose["roll"])
    eyes = np.zeros_like(inside)
    visible = inside & (depth > RIM_DEPTH)
    for eye in pose["eyes"]:
        centre, east, north = eye_frame(eye)
        along = head @ centre
        mask = visible & (along > 0.3)
        along = np.where(mask, along, 1)
        distance = eye_distance((head @ east) / along, (head @ north) / along, eye, openness)
        eyes |= mask & (distance <= 0)
    body = (inside & ~eyes).reshape(HEIGHT, ss, WIDTH, ss).mean(axis=(1, 3))
    return np.floor(BACKGROUND + (BODY - BACKGROUND) * body + 0.5).astype(np.uint8)


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def write_if_changed(path, data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    if path.exists() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def rounded(value):
    if isinstance(value, float):
        return round(value, 4) + 0.0  # + 0.0 turns -0.0 into 0.0
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [rounded(item) for item in value]
    return value


def render_track(track):
    frames, cells = [], {}
    for index in range(STEPS[track]):
        pose = pose_for(track, index)
        name = f"{track}-{index:02d}.png"
        blinks = []
        for level, openness in enumerate(BLINK_LEVELS):
            pixels = render(pose, openness)
            filename = name if level == 0 else f"{track}-{index:02d}-blink-{level}.png"
            cells[filename] = pixels
            write_if_changed(SPRITES / filename, png_bytes(Image.fromarray(pixels)))
            if level:
                blinks.append(filename)
        frames.append({"file": name, "pose": rounded(pose), "blinks": blinks})
    manifest = {
        "title": f"Grok {track} track",
        "provider": "procedural sphere model (characters/grok/tools/render_grok.py)",
        "width": WIDTH, "height": HEIGHT, "count": len(frames),
        "registration": "exact by construction; drawn at device size about a fixed centre",
        "blinkLevels": BLINK_LEVELS,
        "blinkProcessing": "Eyes re-rendered at each openness: pill, shorter pill, round, flat, closed dash.",
        "frames": frames,
    }
    write_if_changed(SPRITES / f"{track}-turn.json", json.dumps(manifest, indent=2) + "\n")
    print(f"{track}: {len(frames)} poses x {len(BLINK_LEVELS)} blink levels")
    return manifest, cells


def contact_sheet(title, images, columns=6, scale=2):
    width, height = WIDTH // scale, HEIGHT // scale
    rows = (len(images) + columns - 1) // columns
    sheet = Image.new("L", (columns * width, rows * height + 22), 214)
    draw = ImageDraw.Draw(sheet)
    draw.text((6, 5), title, fill=0)
    for index, pixels in enumerate(images):
        row, column = divmod(index, columns)
        tile = Image.fromarray(pixels).resize((width, height), Image.LANCZOS)
        sheet.paste(tile, (column * width, 22 + row * height))
        draw.text((column * width + 4, 22 + row * height + 2), f"{index:02d}", fill=120)
    return sheet


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.parse_args()
    tracks, centres, sheets = {}, {}, []
    for track in ORDER:
        manifest, cells = render_track(track)
        tracks[track] = manifest
        centres[track] = hashlib.sha256((SPRITES / manifest["frames"][0]["file"]).read_bytes()).hexdigest()
        sheets.append((track, contact_sheet(f"{track} ({manifest['count']} poses)",
                                            [cells[frame["file"]] for frame in manifest["frames"]])))
        if track == "right":
            ends = manifest["frames"][:1] + manifest["frames"][-1:]
            sheets.append(("blinks", contact_sheet("blink levels of right 00 and right 23",
                                                   [cells[name] for frame in ends
                                                    for name in [frame["file"], *frame["blinks"]]],
                                                   columns=5)))
    if len(set(centres.values())) != 1:
        raise SystemExit("Every track's first pose must be the same neutral image.")
    settle = SPRITES / tracks["surprise"]["frames"][-1]["file"]
    if hashlib.sha256(settle.read_bytes()).hexdigest() != centres["right"]:
        raise SystemExit("surprise must settle back on the neutral image.")
    animation = {
        "width": WIDTH, "height": HEIGHT,
        "order": list(ORDER),
        "directions": {name: tracks[name] for name in IDLE},
        "expressions": {name: tracks[name] for name in EXPRESSIONS},
        "blinkLevels": BLINK_LEVELS,
        "centerSha256": centres["right"],
        "provider": tracks["right"]["provider"],
        "status": "Thirteen procedurally rendered tracks; geometry exact by construction.",
    }
    write_if_changed(SPRITES / "animation.json", json.dumps(animation, indent=2) + "\n")
    for name, sheet in sheets:
        write_if_changed(PREVIEW / f"{name}.png", png_bytes(sheet))
    cells = sum(manifest["count"] for manifest in tracks.values()) * len(BLINK_LEVELS)
    print(f"Wrote {cells} cells, sprites/animation.json and {len(sheets)} contact sheets in preview/")


if __name__ == "__main__":
    main()

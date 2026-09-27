#!/usr/bin/env python3
"""Render a full 24-pose Claude turn sheet procedurally, with no cloud calls.

Same 1536x1024 / 6x4 / 240x224 layout the generated sheets use, so the output
drops straight into the same crop-and-register step and can be compared against
a generated sheet frame for frame.

This is the OpenClaw path applied to a character that happens to be built from
axis-aligned boxes: geometry is exact by construction, so height is constant
under pure yaw, depth is whatever the model says it is, and frame 0 matches the
reference art exactly. What it does not give you is the soft surface shading an
image model produces - see SHADE in render_claude_pose.py.
"""
import argparse
import json
import math
from pathlib import Path

from PIL import Image

from render_claude_pose import eye_boxes, render

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]
SHEET_W, SHEET_H = 1536, 1024
CELL_W, CELL_H = 240, 224
ORIGIN_X, ORIGIN_Y = 48, 64
COLUMNS, COUNT = 6, 24
BLINK_LEVELS = [1, 0.75, 0.5, 0.25, 0]   # matches the existing pipeline's manifest

# Matches the angle lists baked into the prompts and layout guides.
#
# Sign conventions, verified by rendering rather than assumed: POSITIVE yaw turns
# toward the viewer's right (the creature's left wall opens up on the image left).
# NEGATIVE pitch looks UP - it reveals the underside and foreshortens the legs
# toward the camera - so the "up" tracks carry negative pitch and "down" positive.
TRACKS = {
    "right": dict(yaw=lambda i: i * 3.0, pitch=lambda i: 0.0),
    "left": dict(yaw=lambda i: -i * 3.0, pitch=lambda i: 0.0),
    "up": dict(yaw=lambda i: 0.0, pitch=lambda i: -i * 2.0),
    "down": dict(yaw=lambda i: 0.0, pitch=lambda i: i * 2.0),
    "up_right": dict(yaw=lambda i: i * 2.0, pitch=lambda i: -i * 1.0),
    "up_left": dict(yaw=lambda i: -i * 2.0, pitch=lambda i: -i * 1.0),
    "down_right": dict(yaw=lambda i: i * 2.0, pitch=lambda i: i * 1.0),
    "down_left": dict(yaw=lambda i: -i * 2.0, pitch=lambda i: i * 1.0),
}


def _spring(t):
    """Out fast, settle back to rest by the final frame.

    `surprise` is a touch reaction, and the motion engine springs it out and
    lets it settle, so its LAST frame has to return to the shared centre just as
    its first does. A monotonic ramp leaves the character stuck wide-eyed. Peaks
    around frame 9 and is exactly zero at both ends.
    """
    return math.sin(math.pi * (t ** 0.7))


# The five expression tracks
# (signed off 2026-09-25). Strength ramps 0 -> 1 across the 24 frames; frame 0 is
# always the exact neutral pose, which is what keeps all 13 tracks agreeing there.
#
# attention_alternate is DERIVED from attention: swap which eye is the taller one
# and roll the other way. On a generated pipeline the roll sign does not transfer
# between characters and has to be found by trial; here it is simply the negative.
EXPRESSIONS = {
    "surprise": dict(
        curve=_spring,
        yaw=lambda s: 0.0, pitch=lambda s: -3.0 * s, roll=lambda s: 0.0,
        eyes=lambda s: [(1 + 0.2 * s, 1 + 0.6 * s, "rect")] * 2),
    "working": dict(
        yaw=lambda s: 0.0, pitch=lambda s: 3.0 * s, roll=lambda s: 0.0,
        eyes=lambda s: [(1 + 0.1 * s, 1 - 0.6 * s, "rect")] * 2),
    "complete": dict(
        yaw=lambda s: 0.0, pitch=lambda s: -3.0 * s, roll=lambda s: 0.0,
        # Multipliers ramp from 1.0, like every other track: a constant here made
        # frame 0 start with oversized eyes and broke the shared-centre invariant.
        eyes=lambda s: [(1 + 0.35 * s, 1 + 0.15 * s, "chevron", s)] * 2),
    "attention": dict(
        yaw=lambda s: 2.0 * s, pitch=lambda s: 0.0, roll=lambda s: 6.0 * s,
        eyes=lambda s: [(1.0, 1 + 0.3 * s, "rect"), (1.0, 1 - 0.5 * s, "rect")]),
    "attention_alternate": dict(
        yaw=lambda s: -2.0 * s, pitch=lambda s: 0.0, roll=lambda s: -6.0 * s,
        eyes=lambda s: [(1.0, 1 - 0.5 * s, "rect"), (1.0, 1 + 0.3 * s, "rect")]),
}


def pose_args(track, index):
    """(yaw, pitch, roll, eye_shapes) for one frame of any of the 13 tracks."""
    if track in TRACKS:
        spec = TRACKS[track]
        return spec["yaw"](index), spec["pitch"](index), 0.0, None
    spec = EXPRESSIONS[track]
    strength = spec.get("curve", lambda t: t)(index / (COUNT - 1))
    return (spec["yaw"](strength), spec["pitch"](strength),
            spec["roll"](strength), spec["eyes"](strength))


def build(track):
    sheet = Image.new("RGB", (SHEET_W, SHEET_H), (0, 0, 0))
    for index in range(COUNT):
        row, column = divmod(index, COLUMNS)
        yaw, pitch, roll, eyes = pose_args(track, index)
        pose = render(yaw, pitch, size=(CELL_W, CELL_H), roll_deg=roll, eye_shapes=eyes)
        sheet.paste(pose, (ORIGIN_X + column * CELL_W, ORIGIN_Y + row * CELL_H))
    return sheet


def build_cells(track, destination):
    """Write the 24 registered cells and a manifest, bypassing crop/register.

    A generated sheet has to be detected, scale-normalised and re-centred, which
    costs a resample. These poses are already drawn at a fixed scale about a fixed
    pivot, so they are registered by construction - and the eye boxes are read off
    the model rather than detected, so occlusion needs no heuristic.
    """
    destination.mkdir(parents=True, exist_ok=True)
    frames = []
    for index in range(COUNT):
        yaw, pitch, roll, eyes = pose_args(track, index)
        name = f"{track}-{index:02d}.png"
        blinks = []
        for level, openness in enumerate(BLINK_LEVELS):
            pose = render(yaw, pitch, size=(CELL_W, CELL_H), roll_deg=roll,
                          eye_shapes=eyes, eye_openness=openness)
            if level == 0:
                pose.save(destination / name)
            else:
                blink = f"{track}-{index:02d}-blink-{level}.png"
                pose.save(destination / blink)
                blinks.append(blink)
        frames.append({"file": name, "yaw": yaw, "pitch": pitch, "roll": roll,
                       "eyes": eye_boxes(yaw, pitch, size=(CELL_W, CELL_H),
                                         roll_deg=roll, eye_shapes=eyes),
                       "blinkMaskState": "rendered", "blinks": blinks})
    manifest = {
        "title": f"Claude {track} track",
        "provider": "procedural box model (characters/claude/tools/render_claude_pose.py)",
        "width": CELL_W, "height": CELL_H, "count": len(frames),
        "registration": "exact by construction; fixed scale about a fixed pivot",
        "blinkLevels": BLINK_LEVELS,
        "blinkProcessing": ("Eyes re-rendered at each openness, lower lid fixed. No eyelid "
                            "fill, paint mask or bloom compensation is needed: the eyes are "
                            "flat black on flat terracotta, so there is no glow to cover."),
        "frames": frames,
        "playback": "Discrete frames only. Reverse reuses the identical frames in reverse order.",
    }
    (destination / f"{track}-turn.json").write_text(
        json.dumps(manifest, indent=2) + "\n", newline="\n")
    counts = [len(f["eyes"]) for f in frames]
    print(f"{track}: {len(frames)} cells, eye boxes per frame {counts}")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--track", default="right",
                        choices=sorted(TRACKS) + sorted(EXPRESSIONS))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cells", action="store_true",
                        help="Write registered cells + manifest instead of a contact sheet.")
    parser.add_argument("--all", action="store_true",
                        help="All 8 idle tracks.")
    parser.add_argument("--expressions", action="store_true",
                        help="All 5 expression tracks.")
    args = parser.parse_args()
    tracks = []
    if args.all:
        tracks += sorted(TRACKS)
    if args.expressions:
        tracks += sorted(EXPRESSIONS)
    tracks = tracks or [args.track]
    for track in tracks:
        if args.cells:
            build_cells(track, CHARACTER / "sprites")
        else:
            output = args.output or ROOT / f"build/claude/{track}-turn-procedural.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            build(track).save(output)
            print(output)


if __name__ == "__main__":
    main()

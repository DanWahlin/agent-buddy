#!/usr/bin/env python3
"""Render the Claude creature as a rigid box model at an arbitrary yaw/pitch.

This is the character's production renderer, not a blocking aid. The image model
was tried first and could not hold the geometry: across eight diagonal
generations it hung the legs off the back face, off the front face, lost them
entirely, or rolled the body 75 degrees where 22 was correct. A character built
entirely from axis-aligned boxes is exactly the case docs recommend solving with
a model instead - geometry is then exact by construction, height is constant
under pure yaw, frame 0 matches the reference art, and a track re-renders in
seconds at no cost.

What the image model did better was surface, so three things here close that gap:

* CAMERA_LIFT. A generated turn reveals the creature's top face as it rotates,
  which a level camera never would under pure yaw. It is not physically right,
  but it reads better, so the camera sits slightly above the creature. The lift
  is CONSTANT, not proportional to yaw: tying it to yaw was tried first and
  reintroduced the very defect that made the generated sheets unusable, since a
  pitch that grows with yaw grows the silhouette too (154 -> 171px across a
  turn). Holding it constant keeps height exactly fixed under pure yaw, which is
  the invariant that matters, and costs only a slight top face at rest.
* Lambert shading off a fixed light rather than five discrete levels, normalised
  so the front face at rest is exactly the reference colour.
* Legs shaded marginally darker, sitting as they do under the body.

Eye boxes come from rendering the eye quads as marker colours through the same
z-buffer, so occlusion is handled for free and no detection heuristic is needed.
"""
import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]

BODY = (204, 120, 92)
EYE = (0, 0, 0)
BACKGROUND = (0, 0, 0)
EYE_MARKERS = ((255, 0, 255), (0, 255, 255))

# One unit is one eye-width. Measured from characters/claude/source/source-graphic.png:
# body 9 units wide and 149/23 units tall, eyes 1 unit wide inset 1 unit, ear-nubs
# 1 unit wide and 51/23 tall, legs 1 unit wide and 49/23 long on units 0/2/6/8.
BODY_W, BODY_H, BODY_D = 9.0, 149 / 23, 6.0
EYE_W, EYE_H, EYE_TOP, EYE_INSET = 1.0, 24 / 23, 50 / 23, 1.0
EAR_W, EAR_H, EAR_D, EAR_TOP = 1.0, 51 / 23, 2.0, 49 / 23
LEG_W, LEG_H, LEG_D = 1.0, 49 / 23, 2.0
LEG_UNITS = (0, 2, 6, 8)

LIGHT = (-0.35, 0.66, 0.66)
# Base shade per face ORIENTATION, with only a small Lambert term layered on top.
# Pure Lambert was tried and swung the front face 132..246 across the pitch range -
# a 56% shift in the character's own colour as it looks up and down, because at 52
# degrees of nod the front face genuinely turns away from an overhead light. Face
# orientation does not change as the body rotates, so basing the shade on it keeps
# the identity colour stable while LAMBERT_MIX still gives the surfaces some life.
SHADE = {"front": 1.00, "back": 0.72, "side": 0.78, "top": 1.10, "bottom": 0.60}
LAMBERT_MIX = 0.06
CAMERA_LIFT = 6.0        # degrees, CONSTANT - see note in the docstring
LEG_SHADE = 0.93
# A fully closed eye keeps a thin line rather than vanishing: on flat art an eye
# that disappears entirely reads as a blank face, not as a blink.
CLOSED_EYE_FRACTION = 0.12
GRADIENT = 0.035                          # subtle top-to-bottom ramp


def boxes():
    """Every solid, as (x0,y0,z0,x1,y1,z1, group) centred on the body."""
    hw, hh, hd = BODY_W / 2, BODY_H / 2, BODY_D / 2
    out = [(-hw, -hh, -hd, hw, hh, hd, "body")]
    for sign in (-1, 1):
        x0 = hw if sign > 0 else -hw - EAR_W
        out.append((x0, hh - EAR_TOP - EAR_H, -EAR_D / 2,
                    x0 + EAR_W, hh - EAR_TOP, EAR_D / 2, "ear"))
    for unit in LEG_UNITS:
        x0 = -hw + unit
        out.append((x0, -hh - LEG_H, -LEG_D / 2, x0 + LEG_W, -hh, LEG_D / 2, "leg"))
    return out


def faces_of(box):
    x0, y0, z0, x1, y1, z1, group = box
    return [
        ([(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)], group, "front"),
        ([(x1, y1, z0), (x0, y1, z0), (x0, y0, z0), (x1, y0, z0)], group, "back"),
        ([(x0, y1, z0), (x0, y1, z1), (x0, y0, z1), (x0, y0, z0)], group, "side"),
        ([(x1, y1, z1), (x1, y1, z0), (x1, y0, z0), (x1, y0, z1)], group, "side"),
        ([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], group, "top"),
        ([(x0, y0, z1), (x1, y0, z1), (x1, y0, z0), (x0, y0, z0)], group, "bottom"),
    ]


def eye_quads(shapes=None, openness=1.0):
    """The eyes, as flat quads a hair proud of the body's front face.

    Returns (quad, eye_index) pairs, because an expression eye may be several
    blocks: 'chevron' builds a stepped caret from three axis-aligned blocks, which
    is how this character says "happy" without ever leaving its shape family.
    `shapes` is one spec per eye: (width_mult, height_mult, style). `openness`
    drives the blink: the lower lid stays put and the upper edge descends, which
    is what an eyelid actually does. Because these eyes are re-rendered rather
    than painted over, blink synthesis needs none of the usual care about eyelid
    fill colour, bloom haloes or paint masks - there is no glow to cover.
    """
    hw, hh, hd = BODY_W / 2, BODY_H / 2, BODY_D / 2
    z = hd + 0.01
    shapes = shapes or [(1.0, 1.0, "rect"), (1.0, 1.0, "rect")]
    out = []
    for index, x0 in enumerate((-hw + EYE_INSET, hw - EYE_INSET - EYE_W)):
        wm, hm, style, *rest = shapes[index]
        step = rest[0] if rest else 1.0
        cx = x0 + EYE_W / 2
        cy = hh - EYE_TOP - EYE_H / 2
        w, h = EYE_W * wm, EYE_H * hm
        # Anchor the bottom edge, shrink from the top.
        visible = h * (CLOSED_EYE_FRACTION + (1.0 - CLOSED_EYE_FRACTION) * openness)
        cy = cy - h / 2.0 + visible / 2.0
        h = visible
        if style == "chevron":
            # Three blocks stepping up toward the middle. Hard 90-degree steps
            # only - never a smooth curve. `step` morphs it: at 0 all three blocks
            # span the full height and the eye IS the resting rectangle, so the
            # expression ramps in continuously instead of popping part-way.
            # Rise is 0.35h, not 0.5h: at 0.5 the middle block clears the outer
            # ones entirely and the eye reads as a cross rather than one arc. At
            # 0.35 they still overlap, so the three blocks stay a single shape.
            third = w / 3.0
            outer_h = h * (1.0 - step * 0.35)
            rise = h * step * 0.35
            blocks = [(cx - w / 2, cy - h / 2, third, outer_h),
                      (cx - third / 2, cy - h / 2 + rise, third, outer_h),
                      (cx + w / 2 - third, cy - h / 2, third, outer_h)]
        else:
            blocks = [(cx - w / 2, cy - h / 2, w, h)]
        for bx, by, bw, bh in blocks:
            out.append(([(bx, by + bh, z), (bx + bw, by + bh, z),
                         (bx + bw, by, z), (bx, by, z)], index))
    return out


def _normalised(v):
    length = math.sqrt(sum(c * c for c in v))
    return tuple(c / length for c in v)


_LIGHT = _normalised(LIGHT)
# Normalise so the RESTING front face lands on exactly the reference colour. The
# camera lift has to be folded in: at rest the front normal is already tilted by
# CAMERA_LIFT, so normalising against a flat (0,0,1) leaves the character about
# 4% dark everywhere.
_REST_NORMAL = (0.0, -math.sin(math.radians(CAMERA_LIFT)), math.cos(math.radians(CAMERA_LIFT)))


def _shade(kind, normal):
    """Orientation-stable base shade, nudged by a wrapped Lambert term."""
    wrap = 0.5 + 0.5 * sum(n * l for n, l in zip(normal, _LIGHT))
    return SHADE[kind] * (1.0 + LAMBERT_MIX * (wrap - 0.5) * 2.0)


_FRONT_REST = _shade("front", _REST_NORMAL)


# Calibrated against the extreme of all 192 idle poses, not the resting pose: the
# down diagonals reach 210px tall once the camera lift is applied, which clipped a
# 224px cell. 183/-9 leaves every frame at least 12px clear of every edge.
ART_WIDTH, PIVOT_DY = 183, -9


def render(yaw_deg, pitch_deg=0.0, size=(240, 224), art_width=ART_WIDTH,
           pivot_dy=PIVOT_DY, supersample=3, mark_eyes=False,
           roll_deg=0.0, eye_shapes=None, eye_openness=1.0):
    """One pose. Supersampled: these silhouettes are all hard edges, and aliasing
    on a 240x224 cell is most of what made procedural frames read as crude."""
    if supersample > 1:
        big = render(yaw_deg, pitch_deg,
                     size=(size[0] * supersample, size[1] * supersample),
                     art_width=art_width * supersample,
                     pivot_dy=pivot_dy * supersample,
                     supersample=1, mark_eyes=mark_eyes,
                     roll_deg=roll_deg, eye_shapes=eye_shapes,
                     eye_openness=eye_openness)
        resample = Image.Resampling.NEAREST if mark_eyes else Image.Resampling.LANCZOS
        return big.resize(size, resample)
    return _render(yaw_deg, pitch_deg, size, art_width, pivot_dy, mark_eyes,
                   roll_deg, eye_shapes, eye_openness)


def _render(yaw_deg, pitch_deg, size, art_width, pivot_dy, mark_eyes,
            roll_deg=0.0, eye_shapes=None, eye_openness=1.0):
    lift = CAMERA_LIFT
    ya, pa, ra = math.radians(yaw_deg), math.radians(pitch_deg + lift), math.radians(roll_deg)

    def transform(p):
        x, y, z = p
        x, z = x * math.cos(ya) + z * math.sin(ya), -x * math.sin(ya) + z * math.cos(ya)
        y, z = y * math.cos(pa) - z * math.sin(pa), y * math.sin(pa) + z * math.cos(pa)
        # Roll last: a rigid turn of the whole creature in the image plane.
        x, y = x * math.cos(ra) - y * math.sin(ra), x * math.sin(ra) + y * math.cos(ra)
        return x, y, z

    drawables = []
    for box in boxes():
        for corners, group, kind in faces_of(box):
            pts = [transform(c) for c in corners]
            area = 0.0
            for i in range(len(pts)):
                x1, y1, _ = pts[i]
                x2, y2, _ = pts[(i + 1) % len(pts)]
                area += x1 * y2 - x2 * y1
            if area >= 0:                       # cull the far side
                continue
            (ax, ay, az), (bx, by, bz), (cx_, cy_, cz) = pts[0], pts[1], pts[2]
            u = (bx - ax, by - ay, bz - az)
            v = (cx_ - bx, cy_ - by, cz - bz)
            # Negated: kept faces are wound so u x v points AWAY from the camera
            # (that is the same winding the cull above selects on). Without this
            # every face falls back to ambient and the whole creature renders dark.
            normal = _normalised((-(u[1] * v[2] - u[2] * v[1]),
                                  -(u[2] * v[0] - u[0] * v[2]),
                                  -(u[0] * v[1] - u[1] * v[0])))
            shade = _shade(kind, normal) / _FRONT_REST
            if group == "leg":
                shade *= LEG_SHADE
            drawables.append((pts, tuple(min(255, max(0, round(c * shade))) for c in BODY)))

    for corners, eye_index in eye_quads(eye_shapes, eye_openness):
        colour = EYE_MARKERS[eye_index] if mark_eyes else EYE
        drawables.append(([transform(c) for c in corners], colour))

    scale = art_width / (BODY_W + 2 * EAR_W)
    cx, cy = size[0] / 2, size[1] / 2 + pivot_dy
    width, height = size
    grid_x, grid_y = np.meshgrid(np.arange(width), np.arange(height))
    zbuf = np.full((height, width), -np.inf)
    canvas = np.zeros((height, width, 3), dtype=np.float64)
    painted = np.zeros((height, width), dtype=bool)

    for pts, fill in drawables:
        screen = [(cx + x * scale, cy - y * scale, z) for x, y, z in pts]
        mask_img = Image.new("L", size, 0)
        ImageDraw.Draw(mask_img).polygon([(sx, sy) for sx, sy, _ in screen], fill=255)
        mask = np.array(mask_img) > 0
        if not mask.any():
            continue
        (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = screen[0], screen[1], screen[2]
        det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(det) < 1e-9:
            depth = np.full((height, width), (z0 + z1 + z2) / 3.0)
        else:
            a = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) / det
            b = ((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) / det
            depth = z0 + a * (grid_x - x0) + b * (grid_y - y0)
        visible = mask & (depth > zbuf)
        zbuf[visible] = depth[visible]
        canvas[visible] = fill
        painted |= visible

    if GRADIENT and not mark_eyes and painted.any():
        rows = np.nonzero(painted.any(axis=1))[0]
        top, bottom = rows.min(), rows.max()
        span = max(bottom - top, 1)
        ramp = 1.0 + GRADIENT * (1.0 - 2.0 * (grid_y - top) / span)
        lit = painted & (canvas.sum(axis=2) > 24)      # never lift the black eyes
        canvas[lit] = np.clip(canvas[lit] * ramp[lit][:, None], 0, 255)

    return Image.fromarray(canvas.astype(np.uint8))


def eye_boxes(yaw_deg, pitch_deg=0.0, **kwargs):
    """Exact eye bounding boxes, with occlusion resolved by the same z-buffer."""
    marked = np.array(render(yaw_deg, pitch_deg, mark_eyes=True, **kwargs)).astype(int)
    found = []
    for colour in EYE_MARKERS:
        hit = (np.abs(marked - np.array(colour)).sum(axis=2) == 0)
        if not hit.any():
            continue                                   # fully occluded: valid
        ys, xs = np.nonzero(hit)
        found.append([int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1])
    return sorted(found, key=lambda b: b[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--yaw", type=float, default=0.0)
    parser.add_argument("--pitch", type=float, default=0.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    image = render(args.yaw, args.pitch)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output)
    print(args.output)


if __name__ == "__main__":
    main()

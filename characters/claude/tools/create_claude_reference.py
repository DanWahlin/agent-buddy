#!/usr/bin/env python3
"""Redraw the Claude character crisply from measured geometry, on the pipeline's black.

The supplied source graphic (characters/claude/source/source-graphic.png) is flat three-colour
pixel art on white, cropped flush to the silhouette. Rescaling it directly would
blur the hard edges the character is made of, so every rectangle is measured once
here and re-rendered at whatever size is asked for. Geometry below is in the
source's own pixels; nothing is invented or extrapolated.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]

BODY = (204, 120, 92)   # #CC785C
EYE = (0, 0, 0)
BACKGROUND = (0, 0, 0)

# Measured from characters/claude/source/source-graphic.png (253 x 198, silhouette-flush).
EAR_W, BODY_W, BODY_H = 23, 207, 149
EAR_TOP, EAR_H = 49, 51
EYE_TOP, EYE_W, EYE_H = 50, 23, 24
EYE_INSET = 23                      # from the body's own left/right edge
LEG_TOP, LEG_W, LEG_H = 149, 23, 49
LEG_OFFSETS = (0, 46, 138, 184)     # from the body's left edge
SOURCE_W, SOURCE_H = EAR_W * 2 + BODY_W, LEG_TOP + LEG_H

# Cell geometry shared with every sprite sheet in this repo.
CELL_W, CELL_H = 240, 224
ART_W = 196                         # leaves >= 20 px of black padding each side


def draw(canvas_w, canvas_h, art_w):
    """Render the creature centred on a black canvas, art_w pixels wide."""
    scale = art_w / SOURCE_W
    art_h = round(SOURCE_H * scale)
    ox, oy = (canvas_w - art_w) // 2, (canvas_h - art_h) // 2

    image = Image.new("RGB", (canvas_w, canvas_h), BACKGROUND)
    pen = ImageDraw.Draw(image)

    def box(x, y, w, h, colour):
        pen.rectangle(
            (ox + round(x * scale), oy + round(y * scale),
             ox + round((x + w) * scale) - 1, oy + round((y + h) * scale) - 1),
            fill=colour,
        )

    box(EAR_W, 0, BODY_W, BODY_H, BODY)
    box(0, EAR_TOP, EAR_W, EAR_H, BODY)
    box(EAR_W + BODY_W, EAR_TOP, EAR_W, EAR_H, BODY)
    for offset in LEG_OFFSETS:
        box(EAR_W + offset, LEG_TOP, LEG_W, LEG_H, BODY)
    box(EAR_W + EYE_INSET, EYE_TOP, EYE_W, EYE_H, EYE)
    box(EAR_W + BODY_W - EYE_INSET - EYE_W, EYE_TOP, EYE_W, EYE_H, EYE)

    # The design is symmetric; rounding is not. Mirror the left half over the right
    # so the two eyes, ears and leg pairs land on exactly matching pixel columns.
    left = image.crop((0, 0, canvas_w // 2, canvas_h))
    image.paste(left.transpose(Image.FLIP_LEFT_RIGHT), (canvas_w - canvas_w // 2, 0))
    return image


def main():
    destination = CHARACTER / "source"
    destination.mkdir(parents=True, exist_ok=True)
    draw(CELL_W * 2, CELL_H * 2, ART_W * 2).save(destination / "reference.png")
    draw(CELL_W, CELL_H, ART_W).save(destination / "reference-cell.png")
    print(destination / "reference.png")
    print(destination / "reference-cell.png")


if __name__ == "__main__":
    main()

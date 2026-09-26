#!/usr/bin/env python3
"""Build reproducible prompts and labeled grids for true generated diagonal turns."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
DIAGONALS = ("up_right", "up_left", "down_right", "down_left")
PROMPT = """Create a professional production sprite-animation sheet, exactly 1536x1024 PNG, on absolute black, with proper margins. Reference 1 is the EXACT approved front-facing Copilot character. Reference 2 is a layout/angle guide. This is a NEW coherent {title} head-turn animation, not image warping, not crossfading, not copies of another directional sheet.

Draw exactly 24 complete heads in SIX columns by FOUR rows, row-major, with 240x224 cells starting x=48,y=64. Keep every head fully visible inside its own cell. Frame zero must faithfully match reference 1: same rigid rounded helmet, raised cyan goggles, dark blue visor, violet dome, ear discs, and two small cyan luminous eyes. Preserve identical object dimensions, materials, studio lighting, camera distance and fixed head pivot. No body or background shadows.

The head simultaneously turns toward the VIEWER'S {horizontal} and looks {vertical}. The face/visor points toward the {vertical}-{horizontal} corner of the IMAGE. The {visible_ear} ear becomes more visible. This is combined YAW and PITCH, with ZERO ROLL. Do not simulate a diagonal look by rotating the flat image, tilting the head sideways, or translating its position. {pitch_cue}

Frame i (i=0..23) uses yaw i*2 degrees toward image {horizontal}, and pitch i*1 degrees {vertical}. Thus it progresses continuously from (0,0) through (2,1),(4,2),... to (46,23) degrees. Every next cell must be a SMALL angular advance of the SAME object. Do not restart on a new row. The last frame clearly looks {title}, NOT purely sideways and NOT purely vertical. Maintain head identity and goggle geometry across all 24 poses. Eyes stay open and move rigidly with the visor.

Style: polished blue/cyan/violet 3D mascot matching the approved reference exactly, with clean highlights and smooth gradients. Render each angle as an actual new view of one rigid model: no doubled rims, ghost goggles, melting ears, rubber stretching or shape changes. Labels may be tiny white yaw/pitch values BELOW heads only; ensure all text is spelled correctly and fully visible. No arrows, boxes, additional characters or decorations in the final sheet. Ensure all content is fully visible with proper margins.
"""


def main():
    front = Image.open(ROOT / "characters/copilot/source/generated-sprites/approved-center.png").convert("RGB")
    font = ImageFont.load_default(size=13)
    for direction in DIAGONALS:
        vertical, horizontal = direction.split("_")
        guide = Image.new("RGB", (1536, 1024))
        draw = ImageDraw.Draw(guide)
        draw.text((768, 24), f"{direction.replace('_', '-').upper()} / YAW + PITCH / NO ROLL",
                  fill="white", font=font, anchor="mm")
        for index in range(24):
            row, column = divmod(index, 6)
            x, y = 48 + column * 240, 64 + row * 224
            draw.rectangle((x, y, x + 239, y + 223), outline=(24, 24, 24))
            if index == 0:
                guide.paste(front, (x, y))
            draw.text((x + 120, y + 210), f"{index:02d}: {horizontal} {index * 2} / {vertical} {index}",
                      fill="white", font=font, anchor="mm")
        guide.save(ROOT / f"characters/copilot/source/generated-sprites/{direction}-generated-layout.png")
        prompt = PROMPT.format(
            title=direction.replace("_", "-"), horizontal=horizontal.upper(), vertical=vertical.upper(),
            visible_ear="RIGHT" if horizontal == "left" else "LEFT",
            pitch_cue=("As it looks UP, reveal more underside/chin and less top dome."
                       if vertical == "up" else
                       "As it looks DOWN, reveal more top dome and less underside; do not nod so far that the face disappears."),
        )
        (ROOT / f"characters/copilot/source/sprite-prompts/{direction}-generated.txt").write_text(prompt)


if __name__ == "__main__":
    main()

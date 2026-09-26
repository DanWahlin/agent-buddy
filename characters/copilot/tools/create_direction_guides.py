#!/usr/bin/env python3
"""Use the approved front sprite as a fixed-camera reference in labeled turn guides."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[3]


def main():
    front = Image.open(ROOT / "characters/copilot/sprites/right-00.png").convert("RGB")
    destination = ROOT / "characters/copilot/source/generated-sprites"
    front.save(destination / "approved-center.png")
    font = ImageFont.load_default(size=14)
    for direction, step in (("left", 3), ("up", 2), ("down", 2)):
        guide = Image.new("RGB", (1536, 1024))
        draw = ImageDraw.Draw(guide)
        draw.text((768, 24), f"{direction.upper()} TURN - FIXED CAMERA", fill="white", font=font, anchor="mm")
        for index in range(24):
            row, column = divmod(index, 6)
            x, y = 48 + column * 240, 64 + row * 224
            draw.rectangle((x, y, x + 239, y + 223), outline=(24, 24, 24))
            if index == 0:
                guide.paste(front, (x, y))
            elif direction == "left" and index == 23:
                profile = Image.open(ROOT / "characters/copilot/sprites/right-23.png").convert("RGB")
                guide.paste(ImageOps.mirror(profile), (x, y))
            draw.text((x + 120, y + 210), f"{index:02d}: {direction} {index * step:02d} degrees",
                      fill="white", font=font, anchor="mm")
        guide.save(destination / f"{direction}-turn-layout.png")


if __name__ == "__main__":
    main()

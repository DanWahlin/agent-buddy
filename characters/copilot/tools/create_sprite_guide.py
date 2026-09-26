#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
image = Image.new("RGB", (1536, 1024))
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=14)
draw.text((768, 24), "RIGHT TURN", fill="white", font=font, anchor="mm")
for index in range(24):
    row, column = divmod(index, 6)
    x, y = 48 + column * 240, 64 + row * 224
    draw.rectangle((x, y, x + 239, y + 223), outline=(24, 24, 24))
    draw.line((x + 105, y + 112, x + 135, y + 112), fill=(28, 28, 28))
    draw.line((x + 120, y + 97, x + 120, y + 127), fill=(28, 28, 28))
    draw.text((x + 120, y + 210), f"{index * 3:02d} degrees", fill="white", font=font, anchor="mm")
destination = root / "characters/copilot/source/generated-sprites/right-turn-layout.png"
destination.parent.mkdir(parents=True, exist_ok=True)
image.save(destination)
print(destination)

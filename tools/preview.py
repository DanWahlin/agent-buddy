#!/usr/bin/env python3
"""Build and run the exact firmware renderer, then package a browser preview."""
from pathlib import Path
import subprocess
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
CONFIG = (ROOT / "firmware/AgentCompanion/src/Config.h").read_text()


def constant(name):
    match = re.search(rf"constexpr int {name} = (\d+);", CONFIG)
    if not match:
        raise ValueError(f"Missing integer configuration constant: {name}")
    return int(match.group(1))


WIDTH, HEIGHT, FPS = map(constant, ("kFrameWidth", "kFrameHeight", "kTargetFps"))
FRAMES = FPS * 18


def main():
    BUILD.mkdir(exist_ok=True)
    subprocess.run([sys.executable, str(ROOT / "characters/copilot/legacy-atlas/tools/embed_atlas.py")], check=True)
    sources = ROOT / "firmware/AgentCompanion/src"
    subprocess.run([
        "clang++", "-std=c++17", "-O3", "-Wall", "-Wextra", "-Werror",
        str(ROOT / "characters/copilot/legacy-atlas/tools/preview.cpp"),
        *map(str, [ROOT / "characters/copilot/legacy-atlas/src/AtlasRenderer.cpp", sources / "Motion.cpp",
                   ROOT / "characters/copilot/legacy-atlas/src/turn_atlas.cpp", BUILD / "atlas_host.S"]),
        "-lz",
        "-o", str(BUILD / "preview-renderer"),
    ], check=True)
    raw = BUILD / "preview.rgb565"
    subprocess.run([str(BUILD / "preview-renderer"), str(raw)], check=True)
    pixels = np.memmap(raw, dtype=">u2", mode="r", shape=(FRAMES, HEIGHT, WIDTH))
    images = []
    circle = Image.new("L", (466, 466))
    ImageDraw.Draw(circle).ellipse((0, 0, 465, 465), fill=255)
    for frame in pixels:
        rgb = np.stack([
            ((frame >> 11).astype(np.uint32) * 255 // 31),
            (((frame >> 5) & 63).astype(np.uint32) * 255 // 63),
            ((frame & 31).astype(np.uint32) * 255 // 31),
        ], axis=-1).astype(np.uint8)
        image = Image.new("RGB", (466, 466))
        image.paste(Image.fromarray(rgb), (33, 57))
        image.putalpha(circle)
        images.append(image)
    destination = ROOT / "preview"
    destination.mkdir(exist_ok=True)
    images[0].save(destination / "still.png")
    images[0].save(destination / "animation.webp", save_all=True,
                   append_images=images[1:],
                   duration=[round((i + 1) * 1000 / FPS) - round(i * 1000 / FPS)
                             for i in range(FRAMES)], loop=0,
                   lossless=True, method=4)
    contact = Image.new("RGB", (466 * 4, 466 * 2), "#0d1117")
    for index, seconds in enumerate([0, 2, 3.4, 4.9, 7, 9.5, 12, 15.2]):
        number = round(seconds * FPS)
        contact.paste(images[number], (index % 4 * 466, index // 4 * 466),
                      images[number])
    contact.save(destination / "contact-sheet.png")
    del pixels
    raw.unlink()
    print(f"Preview: {destination / 'index.html'}")


if __name__ == "__main__":
    main()

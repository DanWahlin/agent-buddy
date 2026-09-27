#!/usr/bin/env python3
"""Contact sheets built FROM the live cells, so a preview cannot drift from the art.

Earlier previews were rendered separately and ad-hoc: only some tracks ever had
one, and the ones that existed predated several renderer fixes while still
looking plausible. Deriving them from the cells removes that failure mode.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]
SOURCE = CHARACTER / "sprites"
DESTINATION = CHARACTER / "preview"
CELL_W, CELL_H, COLUMNS, COUNT = 240, 224, 6, 24

TRACKS = ("right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left",
          "surprise", "working", "complete", "attention", "attention_alternate")


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for track in TRACKS:
        sheet = Image.new("RGB", (COLUMNS * CELL_W, (COUNT // COLUMNS) * CELL_H), (0, 0, 0))
        for index in range(COUNT):
            row, column = divmod(index, COLUMNS)
            sheet.paste(Image.open(SOURCE / f"{track}-{index:02d}.png"),
                        (column * CELL_W, row * CELL_H))
        sheet.save(DESTINATION / f"{track}.png")
    print(f"Wrote {len(TRACKS)} contact sheets to {DESTINATION}")


if __name__ == "__main__":
    main()

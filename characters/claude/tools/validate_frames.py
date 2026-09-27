"""Check that Claude's exported frames still match the committed cells.

tools/character_pack.py runs validate(root) before packing, including during daemon
setup with a plain python3, so this module uses only the standard library. The
exporter that writes frames.bin needs numpy and Pillow; see export_frames.py.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from character_pack import MODEL_TRACK_STEPS, read_assets_partition

CHARACTER = Path(__file__).resolve().parents[1]
MANIFEST = CHARACTER / "sprites/animation.json"
FRAMES = CHARACTER / "frames.bin"
METADATA = CHARACTER / "frames.json"
REGENERATE = "Regenerate with: python3 characters/claude/tools/export_frames.py"
IDLE = ("right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left")
EXPRESSIONS = ("surprise", "working", "complete", "attention", "attention_alternate")
DIRECTIONS = IDLE + EXPRESSIONS
STEPS = 24
BLINK_LEVELS = [1, 0.75, 0.5, 0.25, 0]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def manifest_path(root):
    return MANIFEST.relative_to(root).as_posix()


def validate(root):
    data = FRAMES.read_bytes()
    metadata = json.loads(METADATA.read_text())
    if metadata.get("dataSha256") != sha256(data) or metadata.get("dataBytes") != len(data):
        raise ValueError(f"Claude frames.bin does not match frames.json. {REGENERATE}")
    if not data or len(data) > read_assets_partition(root)["size"]:
        raise ValueError(f"Claude frames are empty or exceed the character partition. {REGENERATE}")
    expected = [(direction, step) for direction, count in zip(DIRECTIONS, MODEL_TRACK_STEPS)
                for step in range(count)]
    if ([(frame.get("direction"), frame.get("step")) for frame in metadata.get("frames", [])]
            != expected or metadata.get("trackSteps") != MODEL_TRACK_STEPS):
        raise ValueError(f"Claude frame table does not match the animation model. {REGENERATE}")
    source = metadata.get("sourceManifest", {})
    if source.get("path") != manifest_path(root) or source.get("sha256") != sha256(MANIFEST.read_bytes()):
        raise ValueError(f"Claude frames were exported from a different animation.json. {REGENERATE}")
    cells = source.get("pngSha256", {})
    if len(cells) != len(DIRECTIONS) * STEPS * len(BLINK_LEVELS):
        raise ValueError(f"Claude export does not cover every cell. {REGENERATE}")
    sprites = MANIFEST.parent.resolve()
    for filename, digest in cells.items():
        path = (sprites / filename).resolve()
        if not path.is_relative_to(sprites) or not path.is_file():
            raise ValueError(f"Claude cell {filename!r} is missing. {REGENERATE}")
        if sha256(path.read_bytes()) != digest:
            raise ValueError(f"Claude cell {filename} changed since export. {REGENERATE}")

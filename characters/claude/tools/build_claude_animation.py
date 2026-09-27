#!/usr/bin/env python3
"""Merge Claude's 13 per-track manifests into one animation.json.

This is the handoff into the firmware export pipeline, and MERGE ORDER MATTERS -
it has to match the canonical 13-track order the firmware indexes by, which is
the 8 idle look-directions followed by the 5 expression tracks. Getting the order
wrong does not fail loudly; the character just looks the wrong way.

Also checks the two invariants the flash exporter enforces, because they are
cheaper to catch here than on hardware:

* every track's frame 0 must be the identical image, since the motion engine
  walks back to index 0 before switching tracks, making frame 0 the hinge every
  direction change passes through;
* the surprise track's last frame must return to that same centre, because the
  touch reaction springs out and settles back to idle.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHARACTER = Path(__file__).resolve().parents[1]
SOURCE = CHARACTER / "sprites"

IDLE = ("right", "left", "up", "down", "up_right", "up_left", "down_right", "down_left")
EXPRESSIONS = ("surprise", "working", "complete", "attention", "attention_alternate")
ORDER = IDLE + EXPRESSIONS


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    tracks, centres = {}, {}
    for name in ORDER:
        manifest = json.loads((SOURCE / f"{name}-turn.json").read_text())
        tracks[name] = manifest
        centres[name] = digest(SOURCE / manifest["frames"][0]["file"])

    unique = set(centres.values())
    if len(unique) != 1:
        mismatched = [n for n, d in centres.items() if d != centres[ORDER[0]]]
        raise ValueError(
            "Every track's frame 0 must be identical; these differ: " + ", ".join(mismatched))

    centre = centres[ORDER[0]]
    settle = digest(SOURCE / tracks["surprise"]["frames"][-1]["file"])
    if settle != centre:
        raise ValueError("surprise must settle back to the shared centre on its last frame.")

    missing = [f["file"] for m in tracks.values() for f in m["frames"]
               if not (SOURCE / f["file"]).exists()] + \
              [b for m in tracks.values() for f in m["frames"] for b in f["blinks"]
               if not (SOURCE / b).exists()]
    if missing:
        raise ValueError(f"{len(missing)} referenced frames are missing, e.g. {missing[:3]}")

    first = tracks[ORDER[0]]
    animation = {
        "width": first["width"], "height": first["height"], "count": first["count"],
        "order": list(ORDER),
        "directions": {name: tracks[name] for name in IDLE},
        "expressions": {name: tracks[name] for name in EXPRESSIONS},
        "blinkLevels": first["blinkLevels"],
        "centerSha256": centre,
        "provider": first["provider"],
        "status": "Thirteen procedurally rendered tracks; geometry exact by construction.",
        "blinkProcessing": first["blinkProcessing"],
    }
    (SOURCE / "animation.json").write_text(json.dumps(animation, indent=2) + "\n", newline="\n")

    poses = sum(m["count"] for m in tracks.values())
    blinks = sum(len(f["blinks"]) for m in tracks.values() for f in m["frames"])
    print(f"Merged {len(ORDER)} tracks in canonical order -> {SOURCE / 'animation.json'}")
    print(f"  {poses} base poses + {blinks} blink frames = {poses + blinks} images")
    print(f"  shared centre sha256 {centre[:16]}; surprise settles back to it")


if __name__ == "__main__":
    main()

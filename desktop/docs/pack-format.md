# Character pack format, version 1

A character pack is a directory holding a `pack.json` and one or two WebP images
per track. It is the contract between whoever renders a character and the
extension that animates it, so anyone can bring their own agent avatar without
touching extension code.

## Layout

```
copilot/
  pack.json
  right.webp              base strip:  12 frames of 120x112, side by side
  right.blink.webp        blink strip: 12 columns x 4 rows of the eye rectangle
  left.webp
  left.blink.webp
  ...
```

## Tracks

Thirteen, and a pack may omit any of them.

| Group | Tracks |
| --- | --- |
| Gaze (8) | `right`, `left`, `up`, `down`, `up_right`, `up_left`, `down_right`, `down_left` |
| Expression (5) | `surprise`, `working`, `complete`, `attention`, `attention_alternate` |

Every track has the same number of `steps`. **Step 0 is the shared centre pose
and must be the same image in every track** - the motion engine walks back to
index 0 before switching tracks, so it is the hinge every direction change
passes through. A track that disagrees there shows a seam on every idle glance.

## Why blinks are stored as patches

Storing all five blink levels as whole frames makes the four closing levels
about 74% of the pack, to change a few hundred eye pixels. Storing only the eye
rectangle brings that to roughly 16%. Copilot's thirteen tracks come to about
**600 KB** packed this way, where flat storage of the same art runs to tens of
megabytes.

The rectangle is **per step**, not per track. The eyes travel as the head turns,
so one rect spanning a whole track covers that travel and ends up larger than
the frames it was meant to shrink - on the pitched `up` track, a per-track rect
produced a blink strip bigger than the base strip. Cell size is uniform, so the
strip stays a clean grid, and each step carries its own top-left corner.

Drawing frame `step` at blink level `n`:

```js
drawImage(base, step * frame.width, 0, frame.width, frame.height, 0, 0, w, h);
if (n > 0 && track.patch?.cells[step]) {
  const [pw, ph] = track.patch.size;
  const [dx, dy] = track.patch.cells[step];
  drawImage(blinks, step * pw, (n - 1) * ph, pw, ph, dx, dy, pw, ph);
}
```

## pack.json

```jsonc
{
  "format": 1,
  "id": "my-agent",
  "name": "My Agent",
  "author": "your-name",
  "license": "CC-BY-4.0",
  "description": "one line, shown when picking a pack",

  "frame": { "width": 120, "height": 112 },

  // Opaque card colour. Rigs are usually rendered on solid black with no alpha,
  // so a card is the default presentation. Omit it for packs with real alpha.
  "background": "#0e1013",

  "steps": 12,
  "blinkLevels": [1, 0.75, 0.5, 0.25, 0],

  "tracks": {
    "right": {
      "base": "right.webp",
      "blinks": "right.blink.webp",
      "patch": {
        "size": [66, 15],
        // One entry per step. null means the eyes are occluded at that angle
        // and nothing is composited - normal on the downward tracks.
        "cells": [[32, 54], [33, 54], null, [36, 55]]
      }
    },
    // A track with no `blinks` never blinks. `surprise` and `complete` are
    // "expression-preserved" in the source pipeline: their blink images are
    // byte-identical to the base, so no strip is written.
    "complete": { "base": "complete.webp" }
  },

  "states": {
    "idle": "gaze",                 // "gaze" means cycle the eight gaze tracks
    "working": "working",
    "complete": "complete",
    "surprise": "surprise",
    "attention": ["attention", "attention_alternate"]   // picked at random
  },

  // Sleep needs no art: hold the centre pose with the eyes fully closed.
  "sleep": { "track": "down", "step": 0, "blinkLevel": 4 }
}
```

## Validation

`validatePack(pack, probe)` in `@agent-companion/pack-format` returns a list of
problems, empty when the pack is good. With a `probe` it also checks that every
image exists and that:

- a base strip is exactly `steps x frame.width` by `frame.height`
- a blink strip is exactly `steps x patch.size[0]` by `(blinkLevels - 1) x patch.size[1]`
- every non-null patch cell plus `patch.size` stays inside the frame
- `states` and `sleep` only name tracks the pack actually contains

```
npx agent-pack validate packs/copilot
```

## Frame 0, in a lossy pack

Packs are lossy WebP, so the same source pixels encode slightly differently in
each track's strip and the centre pose is never byte-identical across tracks.
That is fine, and the test asserts a calibrated bound rather than equality:
the frame-0 difference must be comfortably inside a single motion step, which is
the largest change the eye already accepts as smooth. On a rig that needed
realigning it measured about 10% of a step - quantisation noise. Before realignment the geometric drift
was roughly twice a step, which is a visible jump.

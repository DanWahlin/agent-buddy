# Characters

Each lowercase folder is a self-contained character pack source. `character.json` tells the generic packer where to find the packed frame payload, metadata, and optional validator:

```json
{
  "id": "openclaw",
  "name": "OpenClaw",
  "layout": "full-frame",
  "frames": "frames.bin",
  "metadata": "frames.json",
  "motionSpeed": 1.3,
  "walk": {"track": 9, "first": 1, "frames": 23, "fps": 12.0},
  "validator": "tools/embed_openclaw_lab.py"
}
```

`layout` is either `base-patch` (metadata has `frames`, `baseBounds`, `maxPatchPixels`, and `trackSteps`) or `full-frame` (metadata has `blocks` as `[offset, size]` entries). Validators are loaded from the character folder and should expose `validate(root)`.

`walk` (optional) loops a track instead of posing it: the device shows poses `first` to `first + frames - 1` of track `track` (9 is Working) at `fps`, and the loop must fit the track (idle up and down hold 12 poses in a base-patch pack). It works in both layouts. Firmware up to v0.12.0 loops only full-frame packs and plays a base-patch pack's Working track as posed, so a looping base-patch pack still runs there. The firmware's effect clock wraps every 12 seconds; choose `fps` so that `12 * fps` is a multiple of `frames` (for example 11.5 FPS for 23 poses), or the loop skips once per wrap.

Keep `maxPatchPixels` small where you can: the firmware holds three buffers of that size. Packs above Copilot's 7,452 pixels, such as Claude, need firmware that reports `patch_ram=adaptive`, and the daemon won't install them on older firmware.

Each pack also carries a small PNG thumbnail for the settings page. By default
the packer renders it from the character's idle center pose; add
`"thumbnail": "thumbnail.png"` to the manifest to supply your own (PNG, up to
256 KiB). The firmware ignores the thumbnail.

To add a character, create a lowercase `characters/<id>/` folder with its manifest, deterministic `frames.bin` and `frames.json`, then run:

```bash
python3 tools/character_pack.py build
```

The daemon installs packs from `build/characters/<id>.acpk`; don't change that output path or the `.acpk` format.
The running daemon also runs this build when a character's top-level files change, before it lists or installs
characters, so a new folder shows up on the settings page without a restart.

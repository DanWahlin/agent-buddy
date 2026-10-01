# Making your own character pack

This guide is for anyone who wants to bring their own character to the Desktop
Agent Companion, either the VS Code extension or the desktop app. A character
pack is a folder you load from your own machine. Nothing has to be committed or
published, and your art stays yours.

The device and the desktop hosts start from the **same rig**, the rendered
frames the Character Lab produces. They then package it differently:

| | Device (ESP32) | Desktop and VS Code |
| --- | --- | --- |
| Package | `.acpk`, built by `tools/character_pack.py` | a folder of WebP strips and a `pack.json`, built by `agent-pack` |
| Frame | 412 x 352, 24 poses | 120 x 112, 12 poses by default (the rig, halved) |
| Format reference | [characters/README.md](../../characters/README.md) | [pack-format.md](pack-format.md) |

So one character can run on both.

## 1. Make the art

Use the **Character Lab** at the root of this repository. The
[root README](../../README.md#develop-and-customize) covers running it.
[docs/character-art-notes.md](../../docs/character-art-notes.md) walks through
drawing a character with AI image generation, from reference art through blink
synthesis.

What the packer needs from the Lab is a **rendered rig**:

- **Thirteen tracks:** eight gaze directions (`right`, `left`, `up`, `down`,
  `up_right`, `up_left`, `down_right`, `down_left`) and five expressions
  (`surprise`, `working`, `complete`, `attention`, `attention_alternate`).
- **Poses per track:** every track has the same number of poses, and pose 0 is
  the shared centre pose.
- **Blink levels:** each pose has four closing blink levels besides the open
  frame.
- **A manifest:** the `animation.json` the Lab writes, which records per-frame
  eye boxes and blink filenames.

The three characters that ship are worked examples of the shapes a rig can
take, and the packer accepts all of them:

| Character | Rig in this repo | Shape |
| --- | --- | --- |
| Copilot | `characters/copilot/sprites` + `characters/copilot/expressions` | two directories, one manifest each |
| Claude | `characters/claude/sprites` | one directory, one manifest split into `directions` and `expressions` |
| OpenClaw | rendered from `characters/openclaw/model` (see the root README) | one manifest with all thirteen under `directions` |

A folder of loose PNGs also works with no manifest, as long as they are named
`<track>-<NN>.png` and `<track>-<NN>-blink-<1..4>.png`.

## 2. Build the pack

From `desktop/`:

```bash
npm install
npm run build

npx agent-pack build <gaze-dir> <expression-dir> \
  --out ~/agent-packs/my-agent --id my-agent --name "My Agent" \
  --author "your-name" --description "One line, shown in the picker" \
  --anchor <approved-center.png>
```

A rig with all thirteen tracks in one directory needs just that one directory.
For example, to rebuild Copilot from its in-repo rig:

```bash
npx agent-pack build ../characters/copilot/sprites ../characters/copilot/expressions \
  --out /tmp/copilot --id copilot --name Copilot \
  --anchor ../characters/copilot/source/generated-sprites/approved-center.png
```

There are three things worth understanding before your first build.

**Frame 0 is the hinge.**
- The motion engine walks back to pose 0 before switching tracks. If your tracks
  disagree there, you'll see a seam on every idle glance.
- `--anchor` names the canonical centre image. The packer forces every track's
  frame 0 onto it, blink art included, and reports which tracks needed it.
- A rig that already agrees needs no anchor, and the packer stays silent about
  it.

**Backgrounds are cut out by default.**
- Rigs are rendered on a solid backdrop. The packer finds the backdrop by
  flooding inwards from the frame edges, not by thresholding brightness.
- That way a dark character on a black backdrop keeps its shadows.
- If you'd rather have an opaque card, pass `--background <hex>`.
- `agent-pack cutout <pack-dir>` does the same to a pack you have already built.

**Blinks are stored as eye patches, not whole frames.**
- This keeps a pack to a few hundred KB rather than tens of MB.
- Tracks whose blink images match their base (`expression-preserved`) get no
  blink strip at all.
- Poses where the eyes are hidden, which is normal on the steep downward tracks,
  get no patch and render as themselves.

`agent-pack build --help` lists the rest: `--steps`, `--scale`, `--quality`,
`--eye-margin`, `--license`.

## 3. Check it

```bash
npx agent-pack validate ~/agent-packs/my-agent
```

Validation checks strip sizes, patch bounds, and that `states` and `sleep` name
only tracks the pack contains.

Then look at it. Blink bugs are invisible at level 0 and only show once a
mostly-closed frame is drawn:

```bash
AGENT_COMPANION_PACK=~/agent-packs/my-agent npm run filmstrip --workspace @agent-companion/renderer
AGENT_COMPANION_PACK=~/agent-packs/my-agent npm run harness --workspace @agent-companion/renderer
```

`filmstrip` renders a scripted session to a PNG. `harness` serves a live page on
<http://localhost:4321> with buttons for every state, sleep and forced blinks.

## 4. Load it

Neither host needs your pack inside this repository.

- **VS Code:** add the folder to the `agentCompanion.packPaths` setting, then pick
  it with the `agentCompanion.pack` setting or from the view.
- **Desktop app:** choose **Open Characters Folder** from the tray, drop the pack
  folder in, and pick it from **Character** after a restart.
  `AGENT_COMPANION_PACKS` also works for extra folders.

The three characters that ship are a fixed list (`BUNDLED_PACKS` in
[extension/esbuild.mjs](../extension/esbuild.mjs) and its twin in
[apps/desktop/esbuild.mjs](../apps/desktop/esbuild.mjs)). A pack you drop into
`desktop/packs/` while working on it will not ship by accident.

## 5. Ownership

Record who the character belongs to in `pack.json`: use `author` and `license`,
and put any trademark note in `description`, as the shipped packs do. If your
character is your own and you'd rather keep it that way, keep its pack and rig
outside this repository and load them through the settings above.

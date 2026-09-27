# Notes on creating a new character's art

This is a working guide for producing a new AI-generated character's sprite set,
written from the experience of building a character beyond Copilot and OpenClaw.
It covers reference art through a finished, blink-animated 13-track manifest,
then how that becomes a `characters/<id>/` pack. No firmware changes are needed:
a character is data, as long as it fits the animation model described in
[characters/README.md](../characters/README.md).

## Two ways to build a character, and how to choose

- **AI image-generation pipeline** (Copilot): a single reference image is
  fed to an image-edit model (Azure GPT Image) with per-pose text prompts. Best
  when you already have 2D concept art or a mockup you like and want to preserve
  its exact style.
- **Procedural 3D model** (OpenClaw): a hand-built Three.js model is posed and
  rendered offline. Best when you want perfectly consistent geometry across every
  pose with no AI drift, and are willing to do real 3D-modeling work instead.

This guide covers the first path. If your character comes from a 2D mockup or
reference image, this is almost certainly the right pipeline.

## What you actually need to produce

Every character needs **13 tracks**, each **24 poses**, each pose with **5 blink
levels** (open + 4 closing stages) — 1,560 frames total, though only a handful
are ever hand-generated; the rest come from cropping/registration and blink
synthesis described below.

- 8 idle look-directions: `right, left, up, down, up_right, up_left, down_right, down_left`
- 5 expression tracks: `surprise, working, complete, attention, attention_alternate`

`attention_alternate` is **derived**, not generated — see the dedicated section
below. Sleep mode needs no new art at all; it's synthesized by driving the idle
center pose's blink curve to fully closed.

## Reference art

Start from one clean, front-facing, neutral pose image — no UI chrome (labels,
captions, badges), no text, ideally on a plain dark background. If your source
material is a multi-panel mockup (e.g., a grid of expression states from an
image-generation tool), crop the front-facing/idle panel out and remove any
overlaid text before using it as the reference. Keep the other panels around
only as *style reference for writing prompts* — they are not fed to the
generation pipeline directly; the pipeline works from one shared reference plus
per-pose text descriptions.

## Writing prompts

Every direction/expression prompt has the same three-part shape:

1. **Identity lock** — a paragraph describing exactly what must stay rigid across
   every frame: head shell material and color, seams, any distinguishing marks,
   ear/appendage shapes, and precisely which parts are allowed to move (usually
   just the eyes). Reuse the *same* identity-lock paragraph verbatim across all
   13 tracks — consistency here is what keeps the character recognizable.
2. **Pose/expression description** — what changes for this specific track:
   rotation angles for directions, or the emotional/eye-shape change for
   expressions. Keep this consistent with the *shape family* established in the
   reference (see "keep eye shape consistent" below).
3. **Technical/layout constraints** — grid layout (6 columns × 4 rows, 240×224
   cells), frame-zero-must-match-reference, no camera zoom, no restart at row
   boundaries, solid black background.

**Never ask the model to render any text, labels, numbers, or captions in the
output.** Early attempts at reusing older prompt templates that permitted "tiny
angle labels in the margin" produced no real benefit and only risk garbled text
artifacts bleeding into the art. State explicitly: *"Do not include any text,
labels, numbers, watermarks, or captions anywhere in the image."*

**Keep eye (or other expressive-feature) shape consistent across all 13
tracks.** If your reference has a distinctive eye shape (e.g., a flat wedge
rather than a round pupil), expression prompts that ask for a *dramatic* change
(especially "surprise") are the most likely to have the model drift into a
different, more generic shape (e.g., adding a round iris/pupil it wasn't asked
for). If you see this in a generated sheet, add an explicit negative
constraint — "must NEVER become circular/round, must NEVER show a visible pupil
or iris, remains the same flat/hard-edged shape as frame 0, only larger" — and
regenerate. This is a normal one-retry fix, not a sign something is
fundamentally wrong.

**Don't ask for body parts or decorative effects the rig doesn't support.**
Every existing sprite track (for every character so far) is a head-and-shoulders bust;
none has ever animated arms into frame. If a source mockup shows raised
arms/hands (common in "celebration" or "surprised" concept art) or decorative
overlays (orbiting rings, confetti, a floating icon), leave them out of the
prompt — those read as effects layered on top of the character, and the
firmware already has a generic mechanism for drawing small procedural overlays
(digit glyphs during "working", sparks during celebration) independent of the
character's own baked art. Whether a *new* character's overlays should reuse
the existing generic effect or get a bespoke one to match its concept art is a
firmware decision, not an art-generation one — don't try to solve it by baking
extra elements into the sprite sheet.

## Generation and curation workflow

For each of the 8 direction tracks:

1. Build a numbered layout guide (a 6×4 grid of the reference pose, for the
   model to align poses against).
2. Generate: `python3 characters/copilot/tools/generate_sprite_sheet.py --reference <front.png> --guide <layout.png> --prompt <prompt.txt> --output <sheet.png>`.
   For up/down/diagonals, pass the approved center pose *and* a previously
   approved directional sheet as two `--reference` values, for extra style
   consistency (see `up-turn.txt` and the `*-generated.txt` diagonal prompts in
   `characters/copilot/source/sprite-prompts/` for the two-reference pattern).
3. **Look at the result yourself before doing anything else with it.** Check:
   no stray text, consistent identity/material across all 24 frames, plausible
   rotation progression, correct occlusion of the far eye/feature at extreme
   angles. Rejecting a sheet and regenerating (sometimes with a strengthened
   prompt) is a normal, expected part of this workflow — budget for it.
4. Once accepted, crop/register it into 24 individual pose files (see
   "Processing pipeline" below).

Expression tracks (`surprise, working, complete, attention`) follow the same
generate → review → crop cycle, but their prompts are built from a small
Python dict (identity lock + per-expression description + a templated
"temporal plan" section describing how strength ramps from 0% at frame 0 to
100% at frame 23) rather than static prompt files, since all four share almost
all of their prompt text. Write this once, adapt the four descriptions to your
character.

## Processing pipeline: real gotchas

The cropping/registration script detects each of the 24 poses as a connected
bright region against the black background. This works out of the box for
glossy/bright materials, but **darker matte materials can fragment**: internal
seams and shadowed areas at turned angles can dip below the foreground
brightness threshold, splitting one head into multiple disconnected blobs and
breaking the "expected 24 heads, found N" check. If you hit this, don't lower
the global brightness threshold (risks picking up background noise instead) —
dilate the foreground mask by a few pixels *before* connected-component
labeling (purely for grouping purposes; the actual cropped pixels are
unaffected). A dilation of 3 iterations was enough for a notably darker
material than the existing characters use; test empirically since the right
amount depends on how dark and how seamed your material is.

**Eye/feature detection windows must be redone per character, not reused.**
The existing color-based glow detection (thresholds on hue/brightness) usually
transfers fine if your character's expressive feature is a similarly-toned
glow, but hardcoded pixel-coordinate windows and aspect-ratio filters absolutely
do not — they encode exactly where the *previous* character's eyes sit and what
shape they are. If your character's eyes are a different aspect ratio (e.g.
wider-than-tall instead of taller-than-wide), an inherited aspect filter will
silently reject every real detection. Rederive the windows from your own
character's actual cropped frames, and allow zero detections as a *valid*
result (full occlusion at extreme angles) rather than an error, unless you can
predict exactly which frame indices will occlude — that's brittle across
different generations.

**Blink synthesis (closing eyes without new AI generation) needs three things
tuned per character, and getting them wrong doesn't crash — it just looks
wrong:**

1. *Background color to paint over the glow.* Sample color for the "eyelid"
   fill from nearby material, but exclude a margin around the glow's
   anti-aliased edge (not just the solid glow pixels) — the bloom/anti-aliasing
   halo is tinted toward the glow color and will produce a washed-out,
   wrong-colored eyelid if included in the sample pool. A 6px exclusion margin
   worked for one character's bloom radius; check yours visually (render one
   fully-closed frame and look for a color mismatch against the surrounding
   material).
2. *Where you're allowed to paint.* Use a simple "is this pixel part of the
   character at all" mask for deciding where the eyelid fill can be applied —
   don't reuse the same tight glow-exclusion mask from step 1 for this. If you
   do, a thin ring of glow bloom just outside the tightly-detected eye
   bounding box never gets covered, leaving a visible sliver of the "closed"
   eye still glowing.
3. *How close to the outer silhouette you're allowed to paint.* If your
   character's expressive feature sits close to the head's outer edge (common
   at some scales/crops), a blanket "must be N pixels from any edge" safety
   check can accidentally exclude the feature itself, not just true background.
   Prefer a simple foreground/background test over a distance-from-any-edge
   erosion, unless you've confirmed the erosion doesn't clip anything real.

**Always spot-check the closed-eye (openness=0) result on a handful of frames
across different tracks (a straight-ahead pose, a turned pose, a pitched pose,
a diagonal) before running the full batch.** All three of the above issues are
invisible at openness=1 (nothing changes) and only show up once you actually
render a mostly- or fully-closed frame.

## Deriving `attention_alternate`

This is the one track that reuses existing art instead of generating new art:
take the approved `attention` track and (a) swap which of the two expressive
features is "larger/more open" left-to-right (extract each feature's glow as a
small movable layer — original pixels minus the fully-closed version — and
swap their positions), then (b) apply a rigid whole-head rotation to
exaggerate the opposite lean.

The rotation **sign is not guaranteed to transfer between characters.** Whether
a positive rotation reads as "the same lean, stronger" or "the opposite lean"
depends on which direction your own `attention` prompt's roll went. Render one
test frame at both signs (e.g. ±10°) before committing, and pick whichever one
visually produces a genuinely different-looking tilt rather than an
exaggerated version of the original.

## Turning the manifests into a pack

By the end of this pipeline you should have two manifests (one for the 8 idle
directions, one for the 5 expression tracks — merge order matters: it must
match the canonical 13-track order above) each with 24 frames per track, each
frame carrying `file`, `blinks` (4 filenames), and `eyes` (feature bounding
boxes, possibly empty for occluded poses).

From there a character is just a folder. Create `characters/<id>/` (lowercase
`[a-z0-9-]`, matching the manifest's `id`) with:

- `frames.bin` and `frames.json`: the compressed frames and their table. For
  AI-generated art, copy Copilot's exporter,
  `characters/copilot/tools/export_sprite_firmware.py`, into your folder and
  point it at your manifests; its input and output paths are Copilot's.
- `character.json`: `id`, `name`, `layout`, `frames`, `metadata`, and optionally
  `motionSpeed`, `walk`, `validator` and `thumbnail`. See
  [characters/README.md](../characters/README.md).

Then build and install it:

```bash
python3 tools/character_pack.py build          # -> build/characters/<id>.acpk
python3 tools/character_pack.py validate build/characters/<id>.acpk
npm run character <id>                         # over USB or Wi-Fi
```

The same `.acpk` can also be uploaded from the settings page's **Add
character…** button. Nothing in the firmware changes: the device checks the
pack's animation model, bounds and SHA-256 at install and again at every boot,
and refuses one that does not match.

### How much room there is

The device holds one character at a time, in a **13.875 MiB** character
partition (14,548,992 bytes). The two built-in packs are 9,540,870 bytes
(Copilot) and 10,000,700 bytes (OpenClaw), so a new character has room, but not
unlimited room -- and the partition cannot grow: see the 16 MiB ceiling in
[development.md](development.md), which applies even on a 32 MB board.

Choose the layout with that budget in mind:

- **`base-patch`** stores 288 base poses plus, per pose, only the rectangle the
  four blink levels actually change -- usually just the eyes. This is the right
  choice for AI-generated art, where only the eyes blink.
- **`full-frame`** stores every pose and blink level as a complete image. It
  suits art where blinking changes more than a small patch, as with OpenClaw's
  rendered model.

On identical AI-generated artwork, a full-frame pack came out about **2.9x**
larger than a base-patch one, because the four non-open blink levels are about
three quarters of a flat pack but under a fifth of a patch-diff one. A roughly
10 MB base-patch character would not fit as full-frame.

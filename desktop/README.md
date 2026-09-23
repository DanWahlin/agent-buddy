# Agent Companion for VS Code

Put your agent's own avatar in VS Code, animated, reacting to what the agent is
actually doing.

VS Code's built-in chat pet is not extensible - it is a workbench widget, with
no contribution point and no setting for custom art. This is the thing it
doesn't have: a publishable extension that renders **any** character from a
portable pack, driven by real agent lifecycle hooks.

## Status

| Piece | State |
| --- | --- |
| `@agent-companion/pack-format` - the pack contract, schema and validator | working |
| `@agent-companion/packer` - `agent-pack`, rig to pack | working |
| `@agent-companion/renderer` - canvas renderer and pose logic, with a browser harness | working |
| `@agent-companion/agent-state` - hook bridge, multi-window state, hook installer | working |
| `extension` - the VS Code extension, packaged as a .vsix | working |

## What a pack is

A directory of WebP strips plus a `pack.json`, described in
[docs/pack-format.md](docs/pack-format.md). Thirteen tracks - eight gaze
directions and five expressions - each a run of poses with four blink levels
stored as eye-sized patches rather than whole frames.

Three ship in `packs/`, each thirteen tracks at twelve steps and 120x112:

| Pack | Size | Source |
| --- | --- | --- |
| `marvin` | 556 KB | AI-generated rig, bundled in the extension |
| `copilot` | 656 KB | AI-generated rig |
| `openclaw` | 548 KB | Three.js model, rendered offline |

Only `marvin` is bundled into the `.vsix`. The other two are built from artwork
belonging to third parties - upstream is explicit that "GitHub Copilot artwork
and product names belong to their respective owners" - which is unremarkable in
a private repository and not something to put in a published extension. Point
`agentCompanion.packPaths` at this `packs/` folder to use them.

## Building a pack

```
npm install
npm run build

npx agent-pack build <gaze-dir> <expression-dir> \
  --out packs/marvin --id marvin --name Marvin \
  --anchor <approved-center.png>

npx agent-pack validate packs/marvin
```

The input is a rendered rig: the pair of `animation.json` manifests an ESP32
Agent Companion art pipeline emits, which already carry per-frame eye boxes and
blink filenames. A directory of loose PNGs named `<track>-<NN>.png` and
`<track>-<NN>-blink-<1..4>.png` also works.

`agent-pack build --help` lists the rest: `--steps`, `--scale`, `--quality`,
`--eye-margin`, `--background`, `--alpha`.

## What the packer does that matters

**Realigns frame 0.** Step 0 is the shared centre pose every track returns to
before switching. If tracks disagree there, the seam shows on every idle glance.
The packer forces frame 0 to the anchor - blink art included - and reports which
tracks needed it. On Marvin that is seven of thirteen; on a rig that is already
clean it stays silent.

**Packs blinks as per-step patches.** Whole-frame blink levels are ~74% of a
pack. Patched, ~16%. The rect has to be per-step, because the eyes travel as the
head turns and a per-track rect ends up bigger than what it was shrinking.

**Skips blink strips entirely** for tracks whose blink images are byte-identical
to their base.

**Handles occlusion.** Steep downward poses hide the eyes, and the manifests
record no eye box there. Those steps get a null patch cell and render as
themselves.

**Measures the eyes when a rig does not record them.** The Three.js renderer
emits the field and leaves it empty, which would mean no blink strips and a
character that never blinks. The region is recoverable without the manifest: a
blink frame differs from its base only where the eyes are, so the bounding box
of that difference is the answer. Decided per track - an empty box inside a
track that records them elsewhere means the eyes are occluded at that angle, and
measuring over it would invent a patch the rig says should not exist.

**Chooses a sleep pose that can actually close its eyes.** Sleep is the centre
pose held shut, which assumes the centre pose has working blink art. OpenClaw
arrived with every pose blinking except the one every track shares as its
centre, which would have left the character wide awake while asleep. Both
conditions are checked and they are not the same: a patch cell exists wherever
the eyes are visible, whether that pose has blink art which changes anything is
separate.

**Refuses to quietly pack a blank frame.** A pose holding nothing survives every
other check - the cutout removes all of it, its blink levels all match because
they are equally blank, and the pack still validates. A renderer that captured
before its canvas was ready produces exactly this, and it cost a whole track
before the check existed.

## Running the extension

Press **F5** (the launch config is in `.vscode/launch.json`), or install the
packaged build:

```
npm run build --workspace agent-companion
code --install-extension extension/agent-companion-0.1.0.vsix
```

Open the Agent Companion view from the activity bar, and drag it into the
secondary sidebar if you want it beside Chat. **Agent Companion: Install Agent
Hooks** connects it to a real agent; **Simulate State** drives the expressions by
hand, which stays useful for checking a pack.

The `.vsix` is 399 KB, of which the character art is 420 KB uncompressed.

## Watching the renderer on its own

```
npm run harness --workspace @agent-companion/renderer
```

Serves a page on http://localhost:4321 that loads `packs/marvin` and animates
it: state buttons, directed looks, sleep, forced blink, cross-fade toggle, and a
live read-out of the pose being drawn.

It also runs a real `StateBridge` and pushes the state to the page over SSE, so
the character follows an actual agent with no VS Code running - the same hooks,
the same coordinator, the same pixels, in a plain browser tab. The read-out
names the role the bridge took. If the endpoint is already held by a VS Code
window the harness joins as a subscriber and the two agree, which is the
multi-window behaviour working across hosts rather than a special case.

`npm run filmstrip --workspace @agent-companion/renderer` renders a scripted
session to a PNG instead, which is the quicker way to check a change.

## Reacting to a real agent

**Agent Companion: Install Agent Hooks** wires up Claude Code, Copilot CLI, or
both. It names the files it will touch before writing, keeps any hooks already
there, and **Remove Agent Hooks** takes only its own back out. Restart a running
agent session afterwards to pick them up.

After that the character follows what the agent is doing:

| State | When |
| --- | --- |
| `working` | tools are running, or a subagent is |
| `complete` | the turn finished, as a four second pulse |
| `attention` | a permission prompt or notification is waiting on you |
| `idle` | nothing in flight |

Claude Code carries the whole vocabulary, including `PostToolUseFailure` and
`SubagentStart`; only `errorOccurred` has no direct equivalent, and
`Notification` covers that. Copilot CLI fires the names the coordinator already
uses.

Hooks are asynchronous with a short timeout, and the shim prints nothing and
gives up in about a second when no window is listening. A companion must never
be able to stall or break a session. The hooks run `node` from PATH, so the
installer checks for it and says so if it is missing.

### Across windows

The first window to bind the endpoint leads and runs the coordinator; the others
follow and are pushed the state, so every window agrees and a hook has only one
place to reach. Close the leader and a follower takes over within a moment.
**Agent Companion: Show Connection Status** reports which role a window holds.

The endpoint is a named pipe on Windows and a Unix socket elsewhere. It is
deliberately not the one the ESP32 daemon uses, so both can run at once.

Two platform differences are worth knowing, both found by testing rather than
assumed. Windows named pipes have no half-close, so a client that writes a
request and closes cannot be replied to - the request still lands, and the shim
never waits for an answer. And `chmod` cannot set POSIX bits on Windows, so the
state file relies on the per-user ACL on `%LOCALAPPDATA%` instead of mode 0600.

## Transparency

Packs are cut out by default, so the character sits on the editor's own
background in any theme. `--background <hex>` opts into an opaque card instead.

Source rigs are rendered opaque on a solid backdrop, which suits a device with
its own screen and not a panel inside an editor - a baked-in dark card is
invisible in a dark theme and stark in a light one. A brightness threshold
cannot separate them: on Marvin the backdrop is exactly `(0,0,0)` and the
darkest pixel inside the head is `(14,19,19)`, so any threshold either keeps
backdrop or eats the character, which is the fragmentation the upstream art
notes warn about. Instead the backdrop is found by flooding inwards from the
frame edges, so only dark pixels reachable from outside are removed and dark
seams, shadowed interiors and enclosed hollows are never touched.

`agent-pack cutout <pack-dir>` does the same to a pack that was already built,
for when the rig is no longer to hand. It reports the proportion removed per
strip and warns when that looks wrong, and it leaves blink strips alone - those
are crops from inside the head, where a flood from the border would eat the
character rather than a backdrop.

## Interaction and idle behaviour

**He follows what you are doing.** The caret's place in the *visible* range
steers the gaze, so scrolling moves it as much as typing does, and the middle
third of the view deliberately sends nothing - a head that snaps on every
keystroke reads as twitchy. Debounced to 150ms. `agentCompanion.followCaret`
turns it off.

**Hover and poke.** A webview cannot see the pointer outside itself, so the two
are complementary: the caret drives him while you type, and the pointer takes
over the moment you mouse onto him. Clicking is a poke - upstream's tap reaction
is `surprise`, and its sparks fire the instant it is *requested*, before the
head has even walked back to centre. A poke is a `pulse`, not a state, so it
wears off rather than leaving him permanently startled; a real agent event
during one wins immediately.

**He dozes.** Upstream's cycle, with its constants: two uninterrupted idle
minutes, one minute asleep, round again. Any agent state, look or poke resets
the clock and wakes him. The window losing focus puts him under until it comes
back. `agentCompanion.autoSleep` turns the cycle off, and a sleep you asked for
by hand is never taken back by it.

## Effects

The character is not alone on the canvas. Ported from
`firmware/Copilot/src/CharacterEffects.cpp`:

| State | What is drawn |
| --- | --- |
| `working` | seven cyan dots orbiting the head, brightening toward the leader, and `1`s and `0`s rising and falling in four lanes |
| `complete` | two shells launching on a parabola, bursting into ten-ray stars, then 36 pieces of confetti under gravity |
| `attention` | an amber `?` in a ring of 32 dots, breathing on a two second period |
| `sleep` | three `Z`s drifting up, each on a side chosen by a hash per cycle |
| `surprise` | two sparks at the temples, fired immediately - before the head has even returned to centre |

These are procedural, so a pack needs no art for them. A pack may recolour them
through an optional `effects` block, and every omitted colour keeps its default:

```jsonc
"effects": { "orbit": "80,215,239", "attention": "255,192,86" }
```

The timings and easing are copied exactly, because they are what makes the
motion read as designed. Three things are deliberately different:

- Coordinates stay in the device's 400x352 effect frame and are mapped onto the
  canvas at one scale, so the orbit stays a circle whatever shape the view is.
- Half of the C++ is damage tracking, for a device that repaints only changed
  pixels. A canvas is cleared every frame, so none of it came across.
- The device guards each pixel twice: an ellipse around the head, and a refusal
  to paint over any artwork pixel. The first is a clip path here. The second
  would mean reading pixels back every frame, and the ellipse already covers the
  head, so it was dropped.

## How a pose is chosen

The vendored motion engine owns the look-around and the blink timing, both tuned
on the device. It has no idea about expressions, because upstream those live in
the firmware, so `CharacterPlayer` adds that layer:

- **idle** hands over to the engine entirely;
- an **expression** is a ramp along its own track, centre to full strength, held
  until the state changes;
- **every transition passes through step 0**, the centre pose all thirteen
  tracks agree on. Cutting to an expression from a turned head is the jump the
  frame-0 invariant exists to prevent, so a state change waits, hurrying the
  gaze home rather than snapping;
- **sleep** needs no art: hold the centre pose with the eyes fully closed.

## Tests

```
npm test
```

Tests that need a rendered rig skip themselves when there isn't one; point
`AGENT_COMPANION_RIG` at yours. The interesting ones:

- **frame-0 seam**, asserted as a calibrated bound rather than byte-equality,
  since packs are lossy. The centre pose must differ by well under one motion
  step.
- **the centre pose blinks on every track**, which catches a real bug: realigning
  onto a bare anchor image dropped its blink art, and since sleep is the centre
  pose held closed, Marvin slept with his eyes open.
- **blink patches stay under a quarter of the frame**, which catches the
  per-track-rect regression.

Look at the art too - blink bugs are invisible at level 0 and only show once a
mostly-closed frame is rendered. `renderFrame` and `contactSheet` in the packer
exist for that.

## Credits and licensing

Marvin's rig was produced with the art pipeline in
[DanWahlin/esp32-agent-companion](https://github.com/DanWahlin/esp32-agent-companion),
whose `docs/character-art-notes.md` is the source for most of what the packer
knows about blink synthesis and frame-0 alignment.

**Dan Wahlin has approved this derivative work.** Two directories vendor his
code unmodified, each recording its provenance beside it:
[`packages/agent-state/src/vendor`](packages/agent-state/src/vendor/README.md),
holding the protocol, coordinator and state store, and
[`packages/renderer/src/vendor`](packages/renderer/src/vendor/README.md),
holding the sprite motion engine.

That repository still carries no LICENSE file, so the approval is the only
thing settling reuse. Before publishing anywhere, it is worth asking him to add
one, or recording the grant somewhere more durable than a line in this file.

Character art is the pack author's own; no pack in this repository contains
artwork belonging to anyone else.

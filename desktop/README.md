# Desktop Agent Companion - developer notes

What it is, how to install and run it, and how to connect it to an agent are in
the [root README](../README.md#desktop-agent-companion). Making your own
character is in [docs/character-packs.md](docs/character-packs.md). This file is
about how it works: the pieces, the packer, the renderer, the hooks, and the tests.

Everything below is relative to `desktop/`, which is a self-contained npm
workspace with its own lockfile.

## Status

| Piece | State |
| --- | --- |
| `@agent-companion/pack-format` - the pack contract, schema and validator | working |
| `@agent-companion/packer` - `agent-pack`, rig to pack | working |
| `@agent-companion/renderer` - canvas renderer and pose logic, with a browser harness | working |
| `@agent-companion/agent-state` - hook bridge, per-project routing, hook installer | working |
| `@agent-companion/companion-core` - pack discovery, the page, the host contract | working |
| `extension` - the VS Code extension, packaged as a .vsix | working |
| `apps/desktop` - the standalone window | working on Windows, untried elsewhere |

## How the pieces fit

```
  the agent                 hooks are `node hook.js <event>`, fire and forget
      |
      v
  hook shim  ─────────────> endpoint      one named pipe or Unix socket per machine
                               |
                               v
                        agent-state       one coordinator per project, leader/follower
                               |
             +─────────────────+─────────────────+
             v                                   v
     VS Code extension                     desktop app
     (webview)                             (Tauri window)
             \                                   /
              +──────── companion-core ─────────+
                        the page, pack discovery
                               |
                          renderer + pack-format
```

The shim never waits and never speaks: it writes one line and exits. Whichever
host claimed the endpoint runs the coordinators and pushes state to the rest, so
a hook has one place to reach however many windows are open.

## What a pack is

A directory of WebP strips plus a `pack.json`, described in
[docs/pack-format.md](docs/pack-format.md). Thirteen tracks - eight gaze
directions and five expressions - each a run of poses with four blink levels
stored as eye-sized patches rather than whole frames.

Three live in `packs/`, each thirteen tracks at twelve steps and 120x112:

| Pack | Size | Source | |
| --- | --- | --- | --- |
| `copilot` | 656 KB | AI-generated rig | ships, and is what shows first |
| `claude` | 404 KB | box model, rendered procedurally | ships |
| `openclaw` | 548 KB | Three.js model, rendered offline | ships |

**Copilot, Claude and OpenClaw are the Agent Companion characters.** Those three
are bundled into the `.vsix` and into the desktop app, Copilot is the one shown
before anybody picks, and every icon is cut from its centre pose. Anyone else's
character loads from outside the repository, through `agentCompanion.packPaths`
or the desktop app's Characters folder.

All three that ship wear a name that is not ours - GitHub's, Anthropic's and the
OpenClaw project's - which each `pack.json` records. Whether they may be
published under those names is a trademark question rather than a build one, and
`BUNDLED_PACKS` in [extension/esbuild.mjs](extension/esbuild.mjs) is the single
place to change to stop shipping one.

`claude` is the smallest of the three and much the cleanest input: flat
terracotta over flat black, built from axis-aligned boxes and rendered rather
than generated, so all thirteen tracks already share frame 0 byte for byte and
nothing needed realigning.

## Building a pack

[docs/character-packs.md](docs/character-packs.md) is the walkthrough. In short:

```
npm install
npm run build

npx agent-pack build ../characters/copilot/sprites ../characters/copilot/expressions \
  --out packs/copilot --id copilot --name Copilot \
  --anchor ../characters/copilot/source/generated-sprites/approved-center.png

npx agent-pack validate packs/copilot

# a rig keeping all thirteen tracks in one place needs no second directory,
# and one that already agrees at frame 0 needs no anchor
npx agent-pack build ../characters/claude/sprites --out packs/claude --id claude --name Claude
```

The input is a rendered rig: the `animation.json` an ESP32 Agent Companion art
pipeline emits, which already carries per-frame eye boxes and blink filenames.
How it divides the thirteen tracks up varies by rig and the packer does not
mind - two directories with a manifest each, as Copilot renders gaze and
expressions in separate passes, or one directory and one manifest, whether that
lists all thirteen together like OpenClaw or splits them between `directions`
and `expressions` like Claude. A directory of loose PNGs named
`<track>-<NN>.png` and `<track>-<NN>-blink-<1..4>.png` also works.

`agent-pack build --help` lists the rest: `--steps`, `--scale`, `--quality`,
`--eye-margin`, `--background`, `--alpha`.

## What the packer does that matters

**Realigns frame 0.** Step 0 is the shared centre pose every track returns to
before switching. If tracks disagree there, the seam shows on every idle glance.
The packer forces frame 0 to the anchor - blink art included - and reports which
tracks needed it. On a rig whose gaze tracks drift that can be seven of
thirteen; on one that is already clean, like Copilot's or Claude's, it stays
silent.

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

## Running it

Install and run steps for both hosts are in the
[root README](../README.md#desktop-agent-companion). Two notes for working on it:

- **F5** in this folder launches the extension in a development host (the launch
  config is in `.vscode/launch.json`).
- [apps/desktop/README.md](apps/desktop/README.md) covers the desktop shell,
  including why a pet has to do its own hit-testing: Tauri's click-through is
  all or nothing, so while clicks are passing through the page cannot see the
  pointer at all. The shell reads the cursor instead and hands the window the
  mouse only over the character. That question was settled in
  [apps/click-through-prototype](apps/click-through-prototype/README.md) before
  anything was built on the answer.

## Watching the renderer on its own

```
npm run harness --workspace @agent-companion/renderer
```

Serves a page on http://localhost:4321 that loads `packs/copilot` and animates
it: state buttons, directed looks, sleep, forced blink, cross-fade toggle, and a
live read-out of the pose being drawn.

It also runs a real `StateBridge` and pushes the state to the page over SSE, so
the character follows an actual agent with no VS Code running - the same hooks,
the same coordinator, the same pixels, in a plain browser tab. The read-out
names the role the bridge took. If the endpoint is already held by a VS Code
window the harness joins as a subscriber and the two agree, which is the
multi-window behaviour working across hosts rather than a special case.

`npm run filmstrip --workspace @agent-companion/renderer` renders a scripted
session to a PNG instead, which is the quicker way to check a change, and
`node scripts/effects-sheet.mjs` lays out every effect at the size it is really
seen.

All three show the pack that ships first unless `AGENT_COMPANION_PACK` names a
directory, which is how a newly built character gets looked at before it goes
anywhere.

## The hooks, in detail

The user-facing summary is in the root README. This is the reasoning behind it.

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

**Copilot CLI's `preToolUse` is fail-closed**, which raises the stakes of that
last sentence. Claude Code's hooks are registered `async` and cannot affect a
session; Copilot has no such option, and a `preToolUse` hook that fails does
not merely go unheard - the tool call is *denied*. Confirmed by watching it
happen: a hook pointed at a path Node could not resolve produced
`Error in preToolUse hook (fail-closed)` in `~/.copilot/logs`, and the agent was
told its command had been blocked.

The shim is built for this: it always exits 0, whatever happens, including when
nothing is listening - which a real Copilot session confirms it survives. The
danger is not the shim failing but the shim being *absent*, because the hooks
name it by path.

So the shim has a home of its own, beside the state file rather than inside
whichever host installed it - `%LOCALAPPDATA%\AgentCompanion\hook.js` and its
equivalents. Installing copies it there and points the hooks at that, so an
extension updating or being uninstalled leaves the hooks working, and two hosts
share one shim rather than fighting over whose path is in the file.

Three details, each of which is a way this could have gone wrong instead:

- It is **renamed into place, never copied over**, because a rename is atomic
  and a copy is not. An agent firing a hook mid-install finds the old shim or
  the new one, never half of one.
- Installing **recognises an older install wherever it pointed**, so upgrading
  replaces that entry rather than leaving it beside the new one - a stale entry
  next to a good one still denies the tool call.
- Uninstalling **removes the shim only once nothing names it**. Taking it away
  while the other agent still has hooks is precisely the failure being avoided.

### Across windows

The first window to bind the endpoint leads and runs the coordinators; the
others follow and are pushed their state, so a hook has only one place to
reach. Close the leader and a follower takes over within a moment.
**Agent Companion: Show Connection Status** reports which role a window holds
and which projects it is reacting to.

**Each window follows its own project.** A window sitting idle on one repository
should not animate because an agent is busy in another, so every hook is filed
under the project it came from and a window is only told about the folders it
has open. Claude Code puts `cwd` in every payload and `CLAUDE_PROJECT_DIR` in
the environment the shim inherits; the latter wins, because `cwd` follows the
agent into a worktree while the project root stays put.

An agent that reports no project - one in a terminal outside every open
workspace - is shown by every window rather than none, so it is never
invisible. A window with no folders open sees everything, which is also what a
host with no notion of a workspace should do.

Upstream folds every session into one state, which is right for a single device
on a desk and wrong for an editor. That file is vendored unmodified, so rather
than teach it about projects the bridge runs one coordinator per project and
folds their states per window.

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
cannot separate them: on one dark rig the backdrop is exactly `(0,0,0)` and the
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

**He follows what you are doing.** In the editor, the caret's place in the
*visible* range steers the gaze, so scrolling moves it as much as typing does,
and the middle third of the view deliberately sends nothing - a head that snaps
on every keystroke reads as twitchy. Debounced to 150ms.
`agentCompanion.followCaret` turns it off.

On the desktop there is no caret to follow, so the pointer does the whole job.
The shell is already reading the cursor to decide when to take the mouse, and
the same reading steers the gaze - one mechanism, because a window pretending
not to be a window needs it either way. The eight-way split is the same
function in both hosts, so hovering and typing agree.

**Hover and poke.** A webview cannot see the pointer outside itself, so in the
editor the two are complementary: the caret drives him while you type, and the
pointer takes over the moment you mouse onto him. Clicking is a poke - upstream's tap reaction
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

The real-rig packer tests build Copilot from `../characters/copilot`, so they
run wherever this repository is checked out; point `AGENT_COMPANION_RIG` at a
character folder laid out the same way to build your own instead. They take a
few minutes, because they pack the full-size rig. The Rust in `apps/desktop/src-tauri` and
`apps/click-through-prototype/src-tauri` has its own, run with `cargo test`; CI
does not build them, so they are not part of `npm test`.

CI runs the lot on Windows, macOS and Linux, and says out loud what it skipped
on each - a test that quietly stops running somewhere should be visible rather
than hiding inside a green tick. That matrix has earned its place: it has caught
a build ordering bug, a cleanup race, and the parts of the bridge Windows cannot
reach at all.

The ones worth knowing about:

- **frame-0 seam**, asserted as a calibrated bound rather than byte-equality,
  since packs are lossy. The centre pose must differ by well under one motion
  step.
- **the centre pose blinks on every track**, which catches a real bug: realigning
  onto a bare anchor image dropped its blink art, and since sleep is the centre
  pose held closed, the character slept with its eyes open.
- **blink patches stay under a quarter of the frame**, which catches the
  per-track-rect regression.
- **a window is not disturbed by an agent in another project**, which is a bug
  report written down: two windows on different repositories both animating
  whenever either was busy.
- **the parent going away shuts the bridge down cleanly**, which then starts a
  second one *on the same endpoint* and requires it to lead. On a fresh endpoint
  it would lead regardless, and prove nothing.
- **the transitions seen in use**, in the desktop app's Rust: real cursor
  positions from a real session rather than invented ones, several of which land
  within a few percent of the boundary where the sticky edge does its work.

Some of these carry recorded data rather than made-up data - hook payloads
captured from a Copilot CLI session, cursor tracks from a real drag. Invented
examples cluster in the easy middle of whatever they are testing.

Look at the art too - blink bugs are invisible at level 0 and only show once a
mostly-closed frame is rendered. `renderFrame` and `contactSheet` in the packer
exist for that.

## Credits and licensing

[../docs/character-art-notes.md](../docs/character-art-notes.md) is the source
for most of what the packer knows about blink synthesis and frame-0 alignment.

**Dan Wahlin has approved this derivative work.** Two directories vendor his
code unmodified, each recording its provenance beside it:
[`packages/agent-state/src/vendor`](packages/agent-state/src/vendor/README.md),
holding the protocol, coordinator and state store from
[`../daemon/src`](../daemon/src), and
[`packages/renderer/src/vendor`](packages/renderer/src/vendor/README.md),
holding the sprite motion engine from
[`../web/sprite-motion.js`](../web/sprite-motion.js).

The repository carries no LICENSE file, so that approval is what settles reuse.

No pack in this repository copies anyone's artwork: every frame is rendered, by
the Character Lab or by a tool in this repository. Names are a separate matter.
`copilot` renders a character of GitHub's, `claude` one of Anthropic's and
`openclaw` one of the OpenClaw project's, and all three of those ship - see the
pack table above, which is also where to start if that should change.

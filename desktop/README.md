# Desktop Agent Companion - developer notes

The ESP32 Agent Companion's character in a transparent window on the desktop.
The user-facing summary is in the [root README](../README.md#desktop-agent-companion).

## How the pieces fit

```mermaid
flowchart LR
  hooks[Agent hooks] --> daemon[Companion service<br/>daemon/]
  daemon -- USB / Wi-Fi --> device[ESP32 device<br/>firmware]
  daemon -- status over daemon.sock --> shell[Desktop shell<br/>apps/desktop/src-tauri]
  shell -- state, badges, look --> page[Page<br/>apps/desktop/src/webview]
  shell -- .acpk pack --> page
  page --> engine[Firmware engine as WebAssembly<br/>engine/]
```

There is one of everything:

- **One animation engine.** [`engine/engine.cpp`](engine/engine.cpp) compiles the
  firmware's own `CharacterMotion`, `SpriteMotion`, `SpriteRenderer`,
  `FullFrameRenderer`, `CharacterEffects` and `AgentBadges` from
  [`../firmware/AgentCompanion/src`](../firmware/AgentCompanion/src) to
  WebAssembly, unchanged. The wrapper does only what `AgentCompanion.ino` does
  around them: it owns the frame buffers, applies mode changes, and steps the
  engine once per frame.
- **One kind of pack.** The page loads the same `.acpk` file the device installs,
  from `build/characters` or from the characters added in Settings.
- **One source of truth.** The Rust shell polls the daemon's `status` every
  400 ms. That gives it the state, the agent badges (already filtered by the
  badge setting and cut to four, as the device gets them), the character and its
  pack file, and the desktop settings (shown or hidden, and the look). The desktop has no hooks, no state
  coordinator and no settings of its own.

## Building

```bash
python3 tools/character_pack.py build   # from the repository root: the .acpk packs
cd desktop
npm install
npm start            # builds the page and app icon, then cargo run --release
npm test             # typecheck, engine freshness, parity and cut-out tests
npm run bundle -w @agent-companion/desktop   # the installable app, as releases ship it
```

The engine is committed, in [`engine/prebuilt`](engine/prebuilt): one 110 KB
JavaScript file with the WebAssembly embedded, so the app builds with Rust and
Node alone. Only a change to the engine or to the firmware's animation code needs
a rebuild, with Emscripten (`em++` on `PATH`: `brew install emscripten` on
macOS, or [emscripten.org](https://emscripten.org)):

```bash
npm run build:engine   # then commit desktop/engine/prebuilt
```

`engine/prebuilt/sources.sha256` records what it was built from, and a test
fails until it is rebuilt after such a change. Tagged releases build the app for
macOS (universal) and Windows and attach it to the GitHub Release.

## Matching the device exactly

[`engine/test/parity.test.mjs`](engine/test/parity.test.mjs) builds the
repository's native character preview (`tools/character_preview.cpp`: the same
firmware sources, compiled for the host). It runs that beside the WebAssembly
engine with the same seed, and steps both through idle, working, attention,
complete, surprise and idle again. It checks that every pixel of every frame
matches, for Copilot, Claude and OpenClaw. Any change to the firmware's
animation code reaches the desktop at the next build, and CI fails if the two
ever disagree.

## The look

By default, the window is a small copy of the device: the round screen in a
matte black case, with the two buttons on its right edge. Light from the top
left catches the case's rim and the bevel into the screen. The page draws the
case in the canvas around the engine's frame, and the frame is the device's own
pixels on its own black screen, so it reads exactly as the device does.

With **Show the device around the character** turned off, the character sits straight on the desktop, so the
engine keys the frame (`writeRgba` in `engine.cpp`):

- Black that connects to the edge of the round display is background. Black
  that the art encloses (inside a face) is kept. This is a flood fill from the
  edges, so dark seams and shadowed interiors survive however dark they are.
- The engine renders the character, keeps a copy, then renders the effects.
  Pixels that the effects changed over the background get their brightness
  back as alpha, because the device blends effects against black. A fading
  digit is then a fading digit, not a dark smudge.
- The badge disc's dark fill stays opaque, as it is on the device.

## Keeping it light

A desktop pet runs all day, so it is measured, not assumed. Below are the
figures on an Apple Silicon Mac (release build, all processes the app uses,
including WebKit's), as a share of one CPU core:

| State | CPU | Memory |
| --- | --- | --- |
| Idle | about 3% | about 45 MB in the app and page, 240 MB of GPU memory in WebKit |
| Working (effects every frame) | about 7% | the same |
| Hidden from Settings | 0.1% | GPU memory released |

What keeps it there:
- **30 frames a second, as on the device** (`kTargetFps`), on a timer, not
  at the display's refresh rate, which can be 120 Hz.
- **Unchanged frames cost one engine step and nothing else.** The engine
  compares each frame with the last, and the page uploads and draws nothing
  when they match.
- **One WebGL texture, updated in place**
  ([`present.ts`](apps/desktop/src/webview/present.ts)). WebKit turned a 2D
  canvas's `putImageData` into a new GPU surface each frame: about 400 MB of
  GPU memory and more CPU. A per-frame `ImageBitmap` measured worse still.
- **The engine's frame is shown at its own size.** The frame canvas is
  412x466 and CSS places it, so on a Retina display nothing is scaled.
- **The case is drawn once per size**, on its own canvas under the frame.
- **The "character only" cut-out is cached** while the character holds still
  and only the effects move; a test checks the cached cut-out matches a fresh one.
- **The pack is held once.** The page writes it straight into the engine's
  own buffer.
- **Hidden means stopped**: no engine steps, no drawing, and the shell checks
  the cursor 7 times a second instead of 20.
- **The shell asks the system for the cursor only.** The window's position,
  size and scale come from window events, because each query is a round trip
  to the main thread.

## Credits and licensing

The Desktop Agent Companion is by Darren Robinson, made with Dan Wahlin's
approval. The window itself (the transparent, click-through, draggable pet with
its tray, placement memory and multi-monitor checks) is his work, in
[apps/desktop](apps/desktop/README.md). The animation engine is the ESP32
Agent Companion firmware.

The repository carries no LICENSE file, so that approval is what settles reuse.
`copilot` renders a character of GitHub's, `claude` one of Anthropic's and
`openclaw` one of the OpenClaw project's.

# Agent Companion, as a window of its own

The companion outside VS Code, for an agent running in a terminal - Claude Code,
Copilot CLI, or whatever comes next.

## Running it

```
npm run build --workspace @agent-companion/desktop
cd src-tauri && cargo run
```

Needs Rust 1.88 or newer, and `node` on PATH - which the hooks require anyway.

## How it is put together

The shell is Rust and does almost nothing. Everything that decides what the
character should be doing - the endpoint, the coordinators, which project a
hook belongs to - runs in a Node child process, because that code is already
written and tested on three platforms. They speak newline-delimited JSON over
stdio, so a Rust bridge could replace it later without this app changing.

The page is the same `startView` the extension uses. The only differences are
how a message travels, and that this host serves its own files so the page
fetches the pack rather than being handed one.

What is genuinely this app's own work is being a pet:

**Taking the mouse only over the character.** Tauri's `set_ignore_cursor_events`
is all or nothing - there is no equivalent of Electron's `forward` option
([tauri#6164](https://github.com/tauri-apps/tauri/issues/6164)) - so while
click-through is on the page receives nothing and cannot tell the cursor has
arrived. The decision is made in Rust from the cursor's own position instead.
That is not really a workaround: a companion on the desktop has to follow the
pointer across the whole screen, which a webview cannot see either. Proven
first in `../click-through-prototype`.

**Letting go of the endpoint on the way out.** The bridge leader holds it, and
other windows only take over promptly because it closes its connections when it
stops. So exiting asks the child to stop and waits for it, and the child also
treats its stdin closing as a reason to shut down - which covers this app being
killed rather than asked.

## Moving it, and getting rid of it

**Drag the character.** There is no title bar - a pet with one would be a
dialog - so the character is the handle. A click is still a poke: the page
tells the two apart by whether the pointer travelled a few pixels first, which
only it can see.

**Quit from the tray.** With no title bar and no taskbar button, the tray is
the only way out, and the menu also has *Bring Back to Centre* for when it has
ended up somewhere awkward.

Where it was put is remembered, and checked on the way back up: a position is
only restored if enough of the window would land on a monitor that exists
*now*. Unplug the screen it was living on and it opens where it can be seen
instead of somewhere nobody can reach.

## What it does not do yet

- **Only the bundled pack.** Marvin is copied beside the page at build time and
  fetched as a relative URL. Packs from anywhere else need Tauri's asset
  protocol opening up, which is a scoped permission rather than a switch.
- **No settings, and no autostart.** Nothing to configure, and it does not come
  back after a reboot.
- **No way to simulate a state.** The command exists for the shell to call;
  nothing calls it.
- **Windows only, so far.** WebView2 is Chromium, so the renderer behaves as it
  does in the extension. macOS and Linux use WebKit and are unverified;
  `macOSPrivateApi` is already set, since a transparent window there does not
  work without it, and it rules out the Mac App Store.

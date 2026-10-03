# Agent Companion, as a window of its own

The ESP32 Agent Companion's character on the desktop, for a second screen or for
when the device is out of sight. See [../../README.md](../../README.md) for how
the pieces fit.

## Running it

From the repository root, with Rust 1.88 or newer:

```
npm run desktop
```

Or download the app from the project's Releases. Either way it needs the
companion service running, which also builds the character packs.

## How it is put together

The page runs the firmware's own animation engine, compiled to WebAssembly, on
the `.acpk` pack the shell serves it. The shell follows the ESP32 daemon over
its socket (`src-tauri/src/daemon.rs`) and passes the state, badges and look
to the page. It loads the character the daemon names, and shows or hides the
window as Settings says.

What is genuinely this app's own work is being a pet:

**Taking the mouse only over the character.** Tauri's `set_ignore_cursor_events`
is all or nothing - there is no equivalent of Electron's `forward` option
([tauri#6164](https://github.com/tauri-apps/tauri/issues/6164)) - so while
click-through is on the page receives nothing and cannot tell the cursor has
arrived. The decision is made in Rust from the cursor's own position instead.

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

## Changing character

With a device connected, the character is the one installed on it: change it
in Settings. With no device, choose **Show on desktop** in Settings, or use
**Character** in the tray. The daemon keeps that choice, so the device gets the
same character when it next connects without one. Without the daemon at all,
the tray choice is remembered locally.

Only the pack the page was told to show can be fetched, by its id, over a
protocol of the app's own.

## What it does not do yet

- **No autostart.** It does not come back after a reboot.
- **Windows cannot follow agents.** The companion service has no Windows build,
  so on Windows the app shows the character in idle.
- **Windows and macOS so far; Linux is unverified.** `macOSPrivateApi` is set,
  because a transparent window does not work on macOS without it, and it rules
  out the Mac App Store. On macOS the app is an accessory app: it has no Dock
  icon and can sit over full-screen Spaces.

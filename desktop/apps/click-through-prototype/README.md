# Click-through prototype

Does Tauri hold up for a desktop pet? This exists to answer one question before
any real work is built on the answer.

## The question

Electron has `setIgnoreMouseEvents(true, { forward: true })`: clicks fall
through to whatever is behind, but the window still receives pointer movement.
Tauri has no equivalent. `set_ignore_cursor_events` is all or nothing, the
`forward` option is an open request
([tauri#6164](https://github.com/tauri-apps/tauri/issues/6164)), per-pixel
click-through on transparent areas is a separate one
([tauri#13070](https://github.com/tauri-apps/tauri/issues/13070)), and there
are reports of it misbehaving on Windows 10
([tauri#11461](https://github.com/tauri-apps/tauri/issues/11461)).

That matters because a pet wants both: clicks landing on the desktop behind it,
and a character that notices the pointer and can be poked.

## The answer

It works, with the hit test moved out of the webview.

While click-through is on, the page receives nothing, so it cannot tell when
the cursor has arrived. So Rust reads the cursor position, decides whether it
is over the character, and hands the window the mouse only then. That is not
really a workaround: a desktop pet has to follow the pointer across the whole
screen anyway, which a webview cannot see either. One mechanism, both jobs.

The character is treated as an ellipse rather than a real alpha mask. The art
is a head, the firmware already clips its effects to an ellipse around one, and
reading pixels back every poll to test a cursor would cost far more than it is
worth. The edge is sticky by a few pixels, so a cursor resting on the boundary
does not flip the window style back and forth.

## What was actually verified

On Windows 11, Rust 1.98, Tauri 2.11, WebView2 153.

`set_ignore_cursor_events` does what it says. Watching the window's extended
styles while the flag was cycled showed exactly two states:

```
0x00040118  TOPMOST
0x000C0138  TOPMOST | TRANSPARENT (click-through) | LAYERED
```

The cursor-driven path works end to end. Rather than move the mouse, the test
moves the *window* around a stationary cursor:

```
cursor over the character -> click-through=False
cursor well off it        -> click-through=True
back over the character   -> click-through=False
```

**It looks right.** Run by hand against a VS Code window behind it: the editor
shows through everywhere except the character, with no window chrome and no
opaque card. The `LAYERED` bit going on and off with click-through was the
thing most likely to cause a flicker at the character's edge, and it does not.

`cargo test` covers the geometry, including the case that matters most: a click
in the empty corner of a square window has to reach what is behind it. One of
those tests replays the transitions from that session rather than invented
points - four of them land within a few percent of the boundary, which is the
only place the sticky edge does any work.

## What that session also showed

Stopping it with Ctrl+C leaves WebView2 complaining that it could not
unregister its window class, and the process exits with `STATUS_CONTROL_C_EXIT`.
Harmless here, but it means there is no graceful shutdown path, and the real
app needs one for a reason beyond tidiness: the bridge leader holds the
endpoint, and the other windows only take over promptly because it closes its
connections on the way out. A pet killed rather than asked to quit would leave
them waiting.

## What was not

- **`skipTaskbar`.** tao does this through the shell rather than
  `WS_EX_TOOLWINDOW`, so the style bits do not show it either way, and nobody
  has checked the taskbar.
- **Dragging it about, and where it lands.** The window is centred and stays
  put. Moving a frameless window, remembering where it was per display, and
  surviving a monitor going away are all untouched.
- **macOS and Linux.** Not touched. `macOSPrivateApi` is required for a
  transparent window there - the build refuses without the matching Cargo
  feature - and it rules out the Mac App Store. Linux transparency depends on
  the compositor.
- **Windows 10**, where the open bug reports are.

## Running it

Needs Rust 1.88 or newer; Tauri 2's dependencies will not build on less.

```
cd src-tauri
cargo test      # the geometry
cargo run       # follows the real cursor
cargo run -- --self-test   # cycles click-through, for watching from outside
```

It prints its window handle, which is what the checks above attach to. It is
deliberately not part of the npm workspace: it is a question, not a component,
and nothing should start depending on it.

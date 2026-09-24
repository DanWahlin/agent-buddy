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

`cargo test` covers the geometry, including the case that matters most: a click
in the empty corner of a square window has to reach what is behind it.

## What was not

- **Whether it looks right.** Nobody has seen it. Transparency, and whether the
  character reads as sitting on the desktop, need eyes.
- **The `LAYERED` transition.** That bit goes on and off with click-through,
  and the base state does not have it - so transparency is coming from DWM
  composition rather than layering, and dropping it should be harmless. Should.
  Whether crossing the character's edge causes a visible flicker is the first
  thing to look for.
- **`skipTaskbar`.** tao does this through the shell rather than
  `WS_EX_TOOLWINDOW`, so the style bits do not show it either way.
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

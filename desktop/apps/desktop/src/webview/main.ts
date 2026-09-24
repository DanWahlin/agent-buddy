/**
 * The page inside the window.
 *
 * The same `startView` the extension uses. The only differences are how a
 * message travels - Tauri's events rather than a webview's - and that this
 * host serves its own files, so the page fetches the pack instead of being
 * handed one.
 *
 * It also reports where it drew the character, which is what lets the shell
 * decide when to take the mouse. Nothing else needs that, because nothing else
 * has to pretend not to be a window.
 */

import { startView, type HostMessage, type ViewMessage } from '@agent-companion/companion-core';

interface TauriApi {
  core: {
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    /** A file path the shell has allowed, as a URL this page may load. */
    convertFileSrc(path: string): string;
  };
  event: { listen(name: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}
declare global {
  interface Window { __TAURI__: TauriApi }
}

const tauri = window.__TAURI__;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const message = document.getElementById('message') as HTMLParagraphElement;

/** Held so the pack listener below can hand the view a message of its own. */
let deliver: ((incoming: HostMessage) => void) | null = null;

startView({
  post: (outgoing: ViewMessage) => void tauri.core.invoke('from_view', { message: outgoing }),
  receive: handler => {
    deliver = handler;
    void tauri.event.listen('to-view', event => handler(event.payload as HostMessage));
  },
}, { canvas, message });

/**
 * Which character to show, from the tray.
 *
 * The shell names a pack two ways, because they are genuinely different. The
 * one that ships with the app is baked into the binary and served beside this
 * page, so it is a relative URL. Any other lives on disk outside the app, and
 * has to come through the asset protocol - which the shell opens for that
 * folder alone just before saying so.
 */
void tauri.event.listen('to-view-pack', event => {
  const named = event.payload as { relative?: string; path?: string };
  const url = named.relative ?? (named.path ? tauri.core.convertFileSrc(named.path) : null);
  if (url) deliver?.({ type: 'load', url });
});

/**
 * Tell the shell where the character is, in CSS pixels within the window.
 *
 * An ellipse inscribed in the canvas, which is the character's own frame. The
 * shell hit-tests against it to decide whether the window should take the
 * mouse; get it wrong and either the pet cannot be poked, or it swallows every
 * click on the desktop behind it.
 */
function reportRegion(): void {
  const box = canvas.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return;
  void tauri.core.invoke('set_region', {
    region: {
      cx: box.left + box.width / 2,
      cy: box.top + box.height / 2,
      rx: box.width / 2,
      ry: box.height / 2,
    },
  });
}

window.addEventListener('resize', reportRegion);
// The canvas is sized once the pack is known, which is after startView returns.
const watcher = new ResizeObserver(reportRegion);
watcher.observe(canvas);

/**
 * Dragging the character moves the window; clicking it is still a poke.
 *
 * There is no title bar to drag - a pet with one would be a dialog - so the
 * character is the handle. Only the page can tell the two apart, because only
 * it sees whether the pointer moved before it came up. Once dragging starts the
 * window takes over the pointer and no further events arrive here, which is
 * exactly why the poke has to be decided on the way in rather than on release.
 */
const DRAG_THRESHOLD_PX = 4;
let pressedAt: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', event => {
  pressedAt = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener('pointermove', event => {
  if (!pressedAt) return;
  const moved = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
  if (moved < DRAG_THRESHOLD_PX) return;
  // Past the threshold this is a drag, not a poke. startView's own pointerdown
  // has already fired the poke; a few pixels of travel is a cheap price for
  // not having to delay every reaction until the button comes up.
  pressedAt = null;
  void tauri.core.invoke('start_drag');
});

for (const done of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(done, () => { pressedAt = null; });
}

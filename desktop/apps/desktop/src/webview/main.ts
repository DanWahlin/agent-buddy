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
  };
  event: { listen(name: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}
declare global {
  interface Window { __TAURI__: TauriApi }
}

const tauri = window.__TAURI__;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const message = document.getElementById('message') as HTMLParagraphElement;

/**
 * Anything that arrived before the view was ready to take it.
 *
 * The shell answers `ready` the instant it sees it, so the reply can land
 * before `startView` has handed over its handler. Holding those few messages is
 * cheaper than making the shell wait, or having it retry.
 */
const waiting: HostMessage[] = [];
let deliver: ((incoming: HostMessage) => void) | null = null;

function hand(incoming: HostMessage): void {
  if (deliver) deliver(incoming);
  else waiting.push(incoming);
}

/**
 * Which character to show, and what the agent is doing.
 *
 * Both listeners go on before the page says a word, because `listen` is
 * asynchronous and the first answer comes back immediately. Registering them
 * after `startView` meant the pack arrived while nobody was listening, and the
 * window sat empty.
 *
 * The pack is one ordinary URL, wherever it actually lives, because the shell
 * serves every pack itself. The renderer resolves image names against it just
 * as it would over http, which is the whole reason for not handing over a file
 * path instead.
 */
async function main(): Promise<void> {
  await Promise.all([
    tauri.event.listen('to-view', event => hand(event.payload as HostMessage)),
    tauri.event.listen('to-view-pack', event => {
      const { url } = event.payload as { url?: string };
      if (url) hand({ type: 'load', url });
    }),
  ]);

  startView({
    post: (outgoing: ViewMessage) => void tauri.core.invoke('from_view', { message: outgoing }),
    receive: handler => {
      deliver = handler;
      for (const held of waiting.splice(0)) handler(held);
    },
  }, { canvas, message });
}

void main();

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

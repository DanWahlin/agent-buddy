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
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
  event: { listen(name: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}
declare global {
  interface Window { __TAURI__: TauriApi }
}

const tauri = window.__TAURI__;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const message = document.getElementById('message') as HTMLParagraphElement;

startView({
  post: (outgoing: ViewMessage) => void tauri.core.invoke('from_view', { message: outgoing }),
  receive: handler => void tauri.event.listen('to-view',
    event => handler(event.payload as HostMessage)),
}, { canvas, message }, {
  // Bundled beside the page, so there is nothing to resolve and no protocol to
  // punch a hole in. Packs from elsewhere will need the asset protocol.
  packUrl: 'packs/marvin/pack.json',
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

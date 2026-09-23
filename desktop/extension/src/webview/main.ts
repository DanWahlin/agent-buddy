/**
 * The page inside the view.
 *
 * It fetches nothing: the host sends the manifest and a webview URI for every
 * image, which is why the content security policy needs no `connect-src`. All
 * this does is load those images, run the player, and paint.
 */

import {
  CharacterEffects, CharacterPlayer, PackRenderer, loadImages, type PackImage,
} from '@agent-companion/renderer';
import type { Pack } from '@agent-companion/pack-format';
import type { HostMessage, ViewSettings } from '../protocol.js';
import { pointerDirection } from '../gaze.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const messageElement = document.getElementById('message') as HTMLParagraphElement;
const context = canvas.getContext('2d');

/** The loaded pack, kept so the renderer can be rebuilt when settings change. */
let loaded: { pack: Pack; images: Map<string, PackImage> } | null = null;
let player: CharacterPlayer | null = null;
let renderer: PackRenderer | null = null;
let effects: CharacterEffects | null = null;
let settings: ViewSettings = { crossfade: true, maxScale: 3, autoSleep: true };
let last = 0;
let running = false;
/** Rises with each `show`, so a late image load from a previous pack is dropped. */
let generation = 0;

function say(text: string): void {
  messageElement.textContent = text;
  messageElement.classList.add('visible');
  canvas.classList.add('hidden');
}

function showCanvas(): void {
  messageElement.classList.remove('visible');
  canvas.classList.remove('hidden');
}

function fail(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  say(text);
  vscode.postMessage({ type: 'failed', message: text });
}

/**
 * Size the canvas to the view, at a whole multiple of the pack's own size where
 * it fits, and match the device pixel ratio so it is not soft on a HiDPI screen.
 */
function resize(): void {
  if (!loaded) return;
  const { width: frameWidth, height: frameHeight } = loaded.pack.frame;
  const ratio = window.devicePixelRatio || 1;
  const available = {
    width: Math.max(1, document.body.clientWidth - 16),
    height: Math.max(1, document.body.clientHeight - 16),
  };

  const scale = Math.min(
    settings.maxScale,
    available.width / frameWidth,
    available.height / frameHeight);
  const cssWidth = Math.max(1, Math.floor(frameWidth * scale));
  const cssHeight = Math.max(1, Math.floor(frameHeight * scale));

  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
}

function loop(now: number): void {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!player || !renderer || !context) return;

  const delta = (now - last) / 1000;
  last = now;
  // A view that was hidden comes back with a long gap; step it, don't jump it.
  player.update(Math.min(delta, 1 / 20));
  renderer.draw(context, player.pose(settings.crossfade), canvas.width, canvas.height);
  effects?.draw(context, {
    state: player.state,
    requested: player.requestedState,
    sleeping: player.sleeping,
    seconds: player.stateSeconds,
    eventId: player.eventId,
  }, canvas.width, canvas.height);
}

async function show(message: Extract<HostMessage, { type: 'show' }>): Promise<void> {
  const mine = ++generation;
  settings = message.settings;
  say('Loading ' + message.pack.name + '…');

  const images = await loadImages(message.pack, name => {
    const url = message.images[name];
    if (!url) throw new Error('The host did not provide a URI for ' + name);
    return url;
  });
  if (mine !== generation) return;

  loaded = { pack: message.pack, images };
  renderer = new PackRenderer({ pack: message.pack, images, maxScale: settings.maxScale });
  player = new CharacterPlayer({ pack: message.pack, autoSleep: settings.autoSleep });
  effects = new CharacterEffects(message.pack.effects ?? {});

  resize();
  showCanvas();

  if (!running) {
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'show':
      void show(message).catch(fail);
      break;
    case 'state':
      player?.setState(message.state);
      break;
    case 'look':
      player?.lookAt(message.direction);
      break;
    case 'sleep':
      player?.setSleeping(message.sleeping);
      break;
    case 'settings':
      settings = message.settings;
      // maxScale is baked into the renderer, so it is rebuilt from what is
      // already loaded rather than re-fetching the pack.
      if (loaded) {
        renderer = new PackRenderer({ ...loaded, maxScale: settings.maxScale });
      }
      player?.setAutoSleep(settings.autoSleep);
      resize();
      break;
    case 'error':
      say(message.message);
      break;
  }
});

/**
 * Pointer interaction.
 *
 * The host drives the gaze from the caret, which is all it can see; once the
 * pointer is actually over the character, it takes precedence. Steering is
 * throttled because a move event per frame would queue turns far faster than
 * the engine walks them, and the queue would run long after the mouse stopped.
 */
const STEER_INTERVAL_MS = 100;
let lastSteer = 0;

canvas.addEventListener('pointermove', event => {
  if (!player) return;
  const now = performance.now();
  if (now - lastSteer < STEER_INTERVAL_MS) return;
  lastSteer = now;

  const box = canvas.getBoundingClientRect();
  const direction = pointerDirection(
    event.clientX - box.left, event.clientY - box.top, box.width, box.height);
  if (direction) player.lookAt(direction);
});

canvas.addEventListener('pointerdown', () => {
  // Upstream reacts to a tap with a spring recoil. A pulse rather than a state,
  // so a poke wears off instead of leaving him permanently startled.
  player?.pulse('surprise');
});

window.addEventListener('resize', resize);

if (!context) {
  fail(new Error('This view could not get a 2D canvas.'));
} else {
  vscode.postMessage({ type: 'ready' });
}

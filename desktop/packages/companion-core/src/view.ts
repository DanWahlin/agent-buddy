/**
 * The page that shows the character, whatever is hosting it.
 *
 * It fetches nothing. The host sends the manifest and a URL for every image,
 * which is why a VS Code webview needs no `connect-src` in its policy and a
 * desktop window needs no server. All this does is load those images, run the
 * player, and paint.
 *
 * The only thing that differs between hosts is how a message gets in or out -
 * `acquireVsCodeApi` in one, Tauri's events in the other - so that is the one
 * thing passed in.
 */

import type { Pack } from '@agent-companion/pack-format';
import {
  CharacterEffects, CharacterPlayer, PackRenderer, loadImages, type PackImage,
} from '@agent-companion/renderer';
import { pointerDirection } from './gaze.js';
import type { HostMessage, ViewMessage, ViewSettings } from './protocol.js';
import { DEFAULT_SETTINGS } from './settings.js';

/** How the page reaches its host, and hears back. */
export interface ViewTransport {
  post(message: ViewMessage): void;
  receive(handler: (message: HostMessage) => void): void;
}

/** The two elements the page needs. Hosts own their own markup around them. */
export interface ViewElements {
  canvas: HTMLCanvasElement;
  message: HTMLElement;
}

/**
 * A move event per frame would queue turns faster than the engine walks them,
 * and the queue would still be running long after the mouse stopped.
 */
const STEER_INTERVAL_MS = 100;

export function startView(transport: ViewTransport, elements: ViewElements): void {
  const { canvas, message: messageElement } = elements;
  const context = canvas.getContext('2d');

  /** Kept so the renderer can be rebuilt when settings change. */
  let loaded: { pack: Pack; images: Map<string, PackImage> } | null = null;
  let player: CharacterPlayer | null = null;
  let renderer: PackRenderer | null = null;
  let effects: CharacterEffects | null = null;
  let settings: ViewSettings = { ...DEFAULT_SETTINGS };
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
    transport.post({ type: 'failed', message: text });
  }

  /**
   * Size the canvas to the view, at a whole multiple of the pack's own size
   * where it fits, and match the device pixel ratio so it is not soft on a
   * HiDPI screen.
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

  async function show(shown: Extract<HostMessage, { type: 'show' }>): Promise<void> {
    const mine = ++generation;
    settings = shown.settings;
    say('Loading ' + shown.pack.name + '…');

    const images = await loadImages(shown.pack, name => {
      const url = shown.images[name];
      if (!url) throw new Error('The host did not provide a URI for ' + name);
      return url;
    });
    if (mine !== generation) return;

    loaded = { pack: shown.pack, images };
    renderer = new PackRenderer({ pack: shown.pack, images, maxScale: settings.maxScale });
    player = new CharacterPlayer({ pack: shown.pack, autoSleep: settings.autoSleep });
    effects = new CharacterEffects(shown.pack.effects ?? {});

    resize();
    showCanvas();

    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(loop);
    }
  }

  transport.receive(incoming => {
    switch (incoming.type) {
      case 'show':
        void show(incoming).catch(fail);
        break;
      case 'state':
        player?.setState(incoming.state);
        break;
      case 'look':
        player?.lookAt(incoming.direction);
        break;
      case 'sleep':
        player?.setSleeping(incoming.sleeping);
        break;
      case 'settings':
        settings = incoming.settings;
        // maxScale is baked into the renderer, so it is rebuilt from what is
        // already loaded rather than re-fetching the pack.
        if (loaded) {
          renderer = new PackRenderer({ ...loaded, maxScale: settings.maxScale });
        }
        player?.setAutoSleep(settings.autoSleep);
        resize();
        break;
      case 'error':
        say(incoming.message);
        break;
    }
  });

  /**
   * Pointer interaction.
   *
   * A host drives the gaze from whatever it can see - the caret in an editor,
   * the whole screen on a desktop - but once the pointer is actually over the
   * character it takes precedence.
   */
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
    // Upstream reacts to a tap with a spring recoil. A pulse rather than a
    // state, so a poke wears off instead of leaving him permanently startled.
    player?.pulse('surprise');
  });

  window.addEventListener('resize', resize);

  if (!context) {
    fail(new Error('This view could not get a 2D canvas.'));
  } else {
    transport.post({ type: 'ready' });
  }
}

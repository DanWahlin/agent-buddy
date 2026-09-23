/**
 * Access to the vendored motion engine.
 *
 * `sprite-motion.js` is a UMD module, kept byte-identical to upstream. Its
 * directory is scoped to CommonJS by a local package.json, so importing it
 * yields `module.exports` in Node and bundles correctly for a webview. A
 * `globalThis.SpritePlayer` set by loading the file as a classic script is
 * honoured first, for hosts that prefer that.
 */

import vendored from './vendor/sprite-motion.js';

/** The eight gaze directions the engine cycles. */
export type Direction =
  | 'right' | 'left' | 'up' | 'down'
  | 'up_right' | 'up_left' | 'down_right' | 'down_left';

/** What `sample()` returns: the pose to draw, and optionally the one to cross-fade toward. */
export interface MotionSample {
  from: number;
  to: number;
  mix: number;
}

/** The subset of the vendored engine this package relies on. */
export interface SpriteMotionLike {
  readonly count: number;
  direction: Direction;
  index: number;
  phase: 'center' | 'out' | 'endpoint' | 'return';
  hold: number;
  blinkLevel: number;
  playing: boolean;
  auto: boolean;
  queue: Direction[];
  setPlaying(value: boolean): void;
  setDuration(value: number): void;
  setSpeed(value: number): void;
  setAuto(value: boolean): void;
  setBlinks(value: boolean): void;
  request(direction: Direction): void;
  requestBlink(): void;
  updateBlink(deltaSeconds: number): boolean;
  update(deltaSeconds: number): unknown;
  sample(crossfade?: boolean): MotionSample;
}

export interface SpriteMotionConstructor {
  new (options?: { count?: number; random?: () => number; playing?: boolean }): SpriteMotionLike;
}

export interface SpritePlayerModule {
  SpriteMotion: SpriteMotionConstructor;
  DIRECTIONS: Direction[];
}

let cached: SpritePlayerModule | null = null;

/** Resolve the engine, preferring one a host has already put on the global object. */
export function spritePlayer(): SpritePlayerModule {
  if (cached) return cached;

  const fromGlobal = (globalThis as { SpritePlayer?: SpritePlayerModule }).SpritePlayer;
  const resolved = fromGlobal?.SpriteMotion ? fromGlobal : vendored;
  if (!resolved?.SpriteMotion) {
    throw new Error('sprite-motion.js did not load; the vendored engine is unavailable.');
  }

  cached = resolved;
  return resolved;
}

/** Override the engine, for tests and for bundles that import it directly. */
export function setSpritePlayer(module: SpritePlayerModule): void {
  cached = module;
}

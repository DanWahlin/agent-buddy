/**
 * Finding the eyes when a rig does not say where they are.
 *
 * Blink levels are stored as a patch over the eye region, so the packer needs
 * to know where that region is. Manifests from the AI-generated pipeline record
 * it; the Three.js renderer emits the field but leaves it empty, and a rig
 * assembled from loose PNGs has no manifest at all.
 *
 * It can be recovered without any of that. A blink frame differs from its base
 * only where the eyes are - that is the whole premise of storing blinks as
 * patches - so the bounding box of the difference is the eye region, measured
 * from the art rather than taken on trust.
 */

import sharp from 'sharp';
import type { RigFrame } from './rig.js';

/** `[x0, y0, x1, y1]`, the same shape a manifest records. */
export type EyeBox = [number, number, number, number];

export interface DeriveEyesOptions {
  /** Per-channel difference that counts as a change. */
  threshold?: number;
  /** Ignore differences smaller than this many pixels, which are encoder noise. */
  minimumPixels?: number;
}

/**
 * The region that changes between a frame and its most-closed blink level.
 *
 * Returns an empty array when nothing changes, which is the correct answer for
 * a pose whose eyes are occluded and for a track that never blinks.
 */
export async function deriveEyeBox(
  frame: RigFrame, options: DeriveEyesOptions = {},
): Promise<EyeBox[]> {
  const threshold = options.threshold ?? 8;
  const minimumPixels = options.minimumPixels ?? 4;

  const closed = frame.blinks.at(-1);
  if (!closed) return [];

  const [base, shut] = await Promise.all([raw(frame.file), raw(closed)]);
  if (base.info.width !== shut.info.width || base.info.height !== shut.info.height) return [];

  const { width, height, channels } = base.info;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let changed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      const delta = Math.max(
        Math.abs(base.data[at] - shut.data[at]),
        Math.abs(base.data[at + 1] - shut.data[at + 1]),
        Math.abs(base.data[at + 2] - shut.data[at + 2]));
      if (delta <= threshold) continue;
      changed++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }

  if (changed < minimumPixels) return [];
  // Inclusive of the last changed pixel, as a manifest's boxes are.
  return [[x0, y0, x1 + 1, y1 + 1]];
}

/**
 * Fill in missing eye boxes across a track, leaving recorded ones alone.
 *
 * Only worth calling for a track that records none at all. Within a track that
 * does record them, an empty box means the eyes are occluded at that angle, and
 * measuring over it would invent a patch the rig says should not exist.
 *
 * Returns new frames rather than mutating: frame 0 is shared between tracks
 * once it has been realigned onto the anchor, and writing through it would
 * leak one track's measurement into every other.
 */
export async function resolveEyes(
  frames: RigFrame[], options: DeriveEyesOptions = {},
): Promise<{ frames: RigFrame[]; derived: number }> {
  let derived = 0;
  const resolved = await Promise.all(frames.map(async frame => {
    if (frame.eyes.length > 0) return frame;
    const eyes = await deriveEyeBox(frame, options);
    if (eyes.length === 0) return frame;
    derived++;
    return { ...frame, eyes };
  }));
  return { frames: resolved, derived };
}

function raw(file: string) {
  return sharp(file).raw().toBuffer({ resolveWithObject: true });
}

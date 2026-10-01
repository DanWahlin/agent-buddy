/**
 * Drawing a character pack to a canvas.
 *
 * A frame is a source rectangle in the track's base strip, plus - when the eyes
 * are partly closed and that step has a patch cell - a second, much smaller
 * rectangle from the blink strip composited over it.
 */

import { baseFrameRect, blinkDraw, type Pack, type TrackName } from '@agent-companion/pack-format';
import type { Pose } from './character-player.js';

/** Anything `drawImage` accepts. Kept loose so tests can pass a stub. */
export type PackImage = CanvasImageSource;

export interface PackRendererOptions {
  pack: Pack;
  /** Track image by its pack-relative filename, as `pack.json` names it. */
  images: Map<string, PackImage>;
  /** Largest whole-pixel scale to draw at. Defaults to unbounded. */
  maxScale?: number;
}

export class PackRenderer {
  readonly #pack: Pack;
  readonly #images: Map<string, PackImage>;
  readonly #maxScale: number;

  constructor(options: PackRendererOptions) {
    this.#pack = options.pack;
    this.#images = options.images;
    this.#maxScale = options.maxScale ?? Number.POSITIVE_INFINITY;
  }

  /** Every image a pack references, so a loader knows what to fetch. */
  static imageNames(pack: Pack): string[] {
    const names = new Set<string>();
    for (const track of Object.values(pack.tracks)) {
      if (!track) continue;
      names.add(track.base);
      if (track.blinks) names.add(track.blinks);
    }
    return [...names];
  }

  /**
   * Paint one pose, letterboxed into the canvas. `width` and `height` are in
   * canvas pixels, so a caller handling devicePixelRatio passes the scaled size.
   */
  draw(
    context: CanvasRenderingContext2D, pose: Pose, width: number, height: number,
  ): void {
    const { width: frameWidth, height: frameHeight } = this.#pack.frame;
    const scale = Math.min(this.#maxScale, width / frameWidth, height / frameHeight);
    const drawWidth = frameWidth * scale;
    const drawHeight = frameHeight * scale;
    const left = (width - drawWidth) / 2;
    const top = (height - drawHeight) / 2;

    if (this.#pack.background) {
      context.fillStyle = this.#pack.background;
      context.fillRect(0, 0, width, height);
    } else {
      context.clearRect(0, 0, width, height);
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    this.#drawPose(context, pose.track, pose.from, pose.blinkLevel, left, top, scale, 1);
    if (pose.mix > 0 && pose.to !== pose.from) {
      this.#drawPose(context, pose.track, pose.to, pose.blinkLevel, left, top, scale, pose.mix);
    }
  }

  #drawPose(
    context: CanvasRenderingContext2D, trackName: TrackName, step: number, blinkLevel: number,
    left: number, top: number, scale: number, alpha: number,
  ): void {
    const track = this.#pack.tracks[trackName];
    if (!track) return;
    const base = this.#images.get(track.base);
    if (!base) return;

    const clamped = Math.max(0, Math.min(this.#pack.steps - 1, step));
    const [sx, sy, sw, sh] = baseFrameRect(this.#pack, clamped);

    const previous = context.globalAlpha;
    if (alpha < 1) context.globalAlpha = alpha;
    context.drawImage(base, sx, sy, sw, sh, left, top, sw * scale, sh * scale);

    const draw = blinkDraw(track, clamped, blinkLevel);
    const patch = draw && track.blinks ? this.#images.get(track.blinks) : undefined;
    if (draw && patch) {
      const [px, py, pw, ph] = draw.source;
      const [dx, dy] = draw.destination;
      context.drawImage(
        patch, px, py, pw, ph,
        left + dx * scale, top + dy * scale, pw * scale, ph * scale);
    }
    context.globalAlpha = previous;
  }
}

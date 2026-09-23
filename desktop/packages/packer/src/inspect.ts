/**
 * Rendering a pack back out for inspection.
 *
 * The upstream art notes are blunt that blink bugs are invisible at level 0 and
 * only show once a mostly-closed frame is actually rendered, so the packer
 * ships the means to look rather than leaving it to trust.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { baseFrameRect, blinkDraw, type Pack, type TrackName } from '@agent-companion/pack-format';

export function loadPack(directory: string): Pack {
  return JSON.parse(readFileSync(join(directory, 'pack.json'), 'utf8')) as Pack;
}

/**
 * Compose one frame exactly as the renderer will: the base frame, then the
 * blink cell for that step when the level is above zero.
 */
export async function renderFrame(
  directory: string, pack: Pack, trackName: TrackName, step: number, blinkLevel = 0,
): Promise<Buffer> {
  const track = pack.tracks[trackName];
  if (!track) throw new Error('Pack has no track "' + trackName + '"');

  const [bx, by, bw, bh] = baseFrameRect(pack, step);
  const base = sharp(join(directory, track.base))
    .extract({ left: bx, top: by, width: bw, height: bh });

  const draw = blinkDraw(track, step, blinkLevel);
  if (!draw || !track.blinks) return base.png().toBuffer();

  const [sx, sy, sw, sh] = draw.source;
  const patch = await sharp(join(directory, track.blinks))
    .extract({ left: sx, top: sy, width: sw, height: sh })
    .png().toBuffer();

  return base
    .composite([{ input: patch, left: draw.destination[0], top: draw.destination[1] }])
    .png().toBuffer();
}

/** SHA-256 of a rendered frame, for the frame-0 seam check. */
export async function frameDigest(
  directory: string, pack: Pack, trackName: TrackName, step: number,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  const png = await renderFrame(directory, pack, trackName, step, 0);
  return createHash('sha256').update(png).digest('hex');
}

/** Lay frames out in a labelled grid and return a PNG. */
export async function contactSheet(
  tiles: Array<{ image: Buffer; label?: string }>,
  columns: number, tileWidth: number, tileHeight: number,
  background = '#15181d',
): Promise<Buffer> {
  const rows = Math.ceil(tiles.length / columns);
  const gap = 2;
  const width = columns * (tileWidth + gap) + gap;
  const height = rows * (tileHeight + gap) + gap;

  return sharp({ create: { width, height, channels: 4, background } })
    .composite(tiles.map((tile, index) => ({
      input: tile.image,
      left: gap + (index % columns) * (tileWidth + gap),
      top: gap + Math.floor(index / columns) * (tileHeight + gap),
    })))
    .png()
    .toBuffer();
}

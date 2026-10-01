/**
 * Reading WebP dimensions from the file header.
 *
 * Validation needs a synchronous probe for every image in a pack, which is both
 * quicker and simpler than paying for a decoder. sharp writes lossy VP8 for the
 * base strips and lossless VP8L for small alpha-bearing blink strips, and pads
 * either into a VP8X container when it carries alpha, so all three matter.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ImageProbe } from '@agent-companion/pack-format';

export interface ImageSize {
  width: number;
  height: number;
}

export function webpSize(buffer: Buffer): ImageSize {
  if (buffer.length < 30
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file');
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunk === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(body + 4, 3),
        height: 1 + buffer.readUIntLE(body + 7, 3),
      };
    }
    if (chunk === 'VP8 ') {
      // Frame header: 3-byte tag, 3-byte start code, then 16-bit dimensions.
      return {
        width: buffer.readUInt16LE(body + 6) & 0x3fff,
        height: buffer.readUInt16LE(body + 8) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(body + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }

  throw new Error('no VP8/VP8L/VP8X chunk found');
}

/** An {@link ImageProbe} that resolves pack-relative paths under `directory`. */
export function probeIn(directory: string): ImageProbe {
  return relative => {
    const file = isAbsolute(relative) ? relative : join(directory, relative);
    if (!existsSync(file)) return null;
    try {
      return webpSize(readFileSync(file));
    } catch {
      return null;
    }
  };
}

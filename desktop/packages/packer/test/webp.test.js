import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import sharp from 'sharp';
import { webpSize } from '../dist/index.js';

sharp.cache(false);

const swatch = (width, height, alpha) => sharp({
  create: { width, height, channels: 4, background: { r: 30, g: 90, b: 160, alpha } },
});

test('reads lossy VP8 dimensions', async () => {
  const buffer = await swatch(640, 112, 1).webp({ quality: 82 }).toBuffer();
  assert.deepEqual(webpSize(buffer), { width: 640, height: 112 });
});

test('reads lossless VP8L dimensions', async () => {
  const buffer = await swatch(333, 47, 1).webp({ lossless: true }).toBuffer();
  assert.deepEqual(webpSize(buffer), { width: 333, height: 47 });
});

test('reads VP8X dimensions, which is what alpha produces', async () => {
  const buffer = await swatch(684, 64, 0.5).webp({ quality: 82 }).toBuffer();
  assert.deepEqual(webpSize(buffer), { width: 684, height: 64 });
});

test('handles the strip shapes a pack actually uses', async () => {
  for (const [width, height] of [[1440, 112], [684, 60], [120, 112], [1, 1]]) {
    const buffer = await swatch(width, height, 1).webp({ quality: 82 }).toBuffer();
    assert.deepEqual(webpSize(buffer), { width, height }, width + 'x' + height);
  }
});

test('rejects anything that is not a WebP', () => {
  assert.throws(() => webpSize(Buffer.alloc(64)), /not a WebP file/);
  assert.throws(() => webpSize(Buffer.from('hello')), /not a WebP file/);
});

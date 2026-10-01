/**
 * Preview a cutout against light and dark backgrounds without writing anything.
 *
 *   node scripts/cutout-preview.mjs [pack-dir] [out.png]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyCutout } from '../dist/cutout.js';

sharp.cache(false);

const dir = process.argv[2] ?? join(import.meta.dirname, '..', '..', '..', 'packs', 'copilot');
const out = process.argv[3] ?? join(import.meta.dirname, '..', 'cutout-preview.png');
const pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
const { width: fw, height: fh } = pack.frame;

// One backdrop per VS Code theme family, plus a deliberately awkward one.
const BACKDROPS = ['#1f1f1f', '#f3f3f3', '#c0392b'];
const TRACKS = ['right', 'attention', 'down'];
const STEPS = [0, 5, 11];

const tiles = [];
for (const backdrop of BACKDROPS) {
  for (const trackName of TRACKS) {
    for (const step of STEPS) {
      const file = join(dir, pack.tracks[trackName].base);
      const { data, info } = await sharp(file).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      applyCutout(data, info.width, info.height);

      const cut = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      }).extract({ left: step * fw, top: 0, width: fw, height: fh }).png().toBuffer();

      tiles.push(await sharp({ create: { width: fw, height: fh, channels: 4, background: backdrop } })
        .composite([{ input: cut }]).png().toBuffer());
    }
  }
}

const columns = TRACKS.length * STEPS.length;
const gap = 2;
const sheet = await sharp({
  create: {
    width: columns * (fw + gap) + gap,
    height: BACKDROPS.length * (fh + gap) + gap,
    channels: 4, background: '#808080',
  },
}).composite(tiles.map((input, i) => ({
  input,
  left: gap + (i % columns) * (fw + gap),
  top: gap + Math.floor(i / columns) * (fh + gap),
}))).png().toBuffer();

writeFileSync(out, sheet);
console.log('rows: ' + BACKDROPS.join(', '));
console.log('columns: ' + TRACKS.flatMap(t => STEPS.map(s => t + ':' + s)).join(', '));

/**
 * Render each effect state at a realistic view size, so the overlays can be
 * judged at the scale they are actually seen rather than the pack's native one.
 *
 *   node scripts/effects-sheet.mjs [scale]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CharacterEffects, CharacterPlayer, PackRenderer } from '../dist/index.js';

sharp.cache(false);

const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'packs', 'marvin');
const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8'));
const scale = Number(process.argv[2] ?? 3);
const W = Math.round(pack.frame.width * scale);
const H = Math.round(pack.frame.height * scale);

/** The moments worth looking at, per state. */
const MOMENTS = [
  ['working', [0.4, 1.2, 2.0, 3.0, 4.0]],
  ['complete', [0.4, 0.8, 1.1, 1.6, 2.4]],
  ['attention', [0.3, 1.0, 1.8, 2.6, 3.4]],
  ['sleep', [0.5, 1.4, 2.3, 3.2, 4.1]],
  ['surprise', [0.02, 0.12, 0.22, 0.32, 0.45]],
];

function recordingContext() {
  const calls = [];
  const shapes = [];
  return {
    calls, shapes,
    fillStyle: '', globalAlpha: 1,
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    clearRect() {}, save() {}, restore() {}, clip() {},
    beginPath() {}, rect() {}, ellipse() {}, fill() {},
    drawImage(image, ...args) { calls.push({ image, args }); },
    arc(x, y, r) { shapes.push({ kind: 'arc', x, y, r, fill: this.fillStyle }); },
    fillRect(x, y, w, h) {
      if (String(this.fillStyle).startsWith('rgba')) {
        shapes.push({ kind: 'rect', x, y, w, h, fill: this.fillStyle });
      }
    },
  };
}

async function paint(calls, shapes) {
  const layers = await Promise.all(calls.map(async ({ image, args }) => {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    return {
      input: await sharp(join(PACK_DIR, image.name))
        .extract({
          left: Math.round(sx), top: Math.round(sy),
          width: Math.round(sw), height: Math.round(sh),
        })
        .resize(Math.round(dw), Math.round(dh), { fit: 'fill' })
        .png().toBuffer(),
      left: Math.round(dx), top: Math.round(dy),
    };
  }));

  if (shapes.length) {
    const svg = shapes.map(s => s.kind === 'arc'
      ? `<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${s.r.toFixed(2)}" fill="${s.fill}"/>`
      : `<rect x="${s.x.toFixed(2)}" y="${s.y.toFixed(2)}" width="${s.w.toFixed(2)}" height="${s.h.toFixed(2)}" fill="${s.fill}"/>`
    ).join('');
    layers.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`),
      left: 0, top: 0,
    });
  }

  return sharp({ create: { width: W, height: H, channels: 4, background: pack.background } })
    .composite(layers).png().toBuffer();
}

const images = new Map(PackRenderer.imageNames(pack).map(name => [name, { name }]));
const renderer = new PackRenderer({ pack, images, maxScale: scale });
const effects = new CharacterEffects(pack.effects ?? {});

const tiles = [];
for (const [state, moments] of MOMENTS) {
  for (const seconds of moments) {
    const player = new CharacterPlayer({ pack, random: () => 0.5 });
    if (state === 'sleep') player.setSleeping(true);
    else player.setState(state);
    // Settle into the state, then hold it at the moment we want.
    for (let i = 0; i < 120; i++) player.update(1 / 60);

    const context = recordingContext();
    renderer.draw(context, player.pose(false), W, H);
    effects.draw(context, {
      state: state === 'sleep' ? 'idle' : state,
      requested: state === 'sleep' ? 'idle' : state,
      sleeping: state === 'sleep',
      seconds,
      eventId: 7,
    }, W, H);
    tiles.push(await paint(context.calls, context.shapes));
  }
}

const gap = 3;
const sheet = await sharp({
  create: {
    width: 5 * (W + gap) + gap,
    height: MOMENTS.length * (H + gap) + gap,
    channels: 4, background: '#07090c',
  },
}).composite(tiles.map((input, i) => ({
  input,
  left: gap + (i % 5) * (W + gap),
  top: gap + Math.floor(i / 5) * (H + gap),
}))).png().toBuffer();

writeFileSync(join(import.meta.dirname, '..', 'effects-sheet.png'), sheet);
console.log('rows, top to bottom: ' + MOMENTS.map(m => m[0]).join(', '));
console.log('each row is five moments, at ' + W + 'x' + H);

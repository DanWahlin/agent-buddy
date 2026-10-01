/**
 * Render a scripted session to a filmstrip PNG.
 *
 * This drives the real CharacterPlayer and the real PackRenderer, capturing the
 * draw calls and replaying them with sharp. Nothing is simulated except the
 * canvas itself, so it checks that the player, the renderer and the pack agree -
 * and it produces something to actually look at, which the upstream art notes
 * are insistent about.
 *
 *   node scripts/filmstrip.mjs [out.png]
 *
 * `AGENT_COMPANION_PACK` points it at a pack other than the default one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CharacterEffects, CharacterPlayer, PackRenderer } from '../dist/index.js';

sharp.cache(false);

const PACK_DIR = process.env.AGENT_COMPANION_PACK
  ?? join(import.meta.dirname, '..', '..', '..', 'packs', 'copilot');
const out = process.argv[2] ?? join(import.meta.dirname, '..', 'filmstrip.png');
const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8'));

const SIZE = { width: pack.frame.width, height: pack.frame.height };
const COLUMNS = 10;
const FPS = 60;

/** A scripted session: [seconds to run, what to do first]. */
const SCRIPT = [
  [2.0, p => p.setState('idle')],
  [1.5, p => p.lookAt('up_left')],
  [2.5, p => p.setState('working')],
  [2.0, p => p.setState('complete')],
  [2.5, p => p.setState('attention')],
  [2.0, p => p.setSleeping(true)],
  [2.0, p => p.setSleeping(false)],
  [1.5, p => p.setState('surprise')],
  [1.5, p => p.setState('idle')],
];

function recordingContext() {
  const calls = [];
  const shapes = [];
  let path = null;
  return {
    calls, shapes,
    fillStyle: '', globalAlpha: 1,
    imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
    clearRect() {},
    drawImage(image, ...args) { calls.push({ image, args }); },
    // Effects draw with these; record them so they can be replayed with sharp.
    save() {}, restore() {}, clip() {},
    beginPath() { path = []; },
    rect() {}, ellipse() {},
    arc(x, y, r) { shapes.push({ kind: 'arc', x, y, r, fill: this.fillStyle }); },
    fill() {},
    fillRect(x, y, w, h) {
      // The pack background is painted with fillRect too; only effect fills
      // carry an rgba() style.
      if (String(this.fillStyle).startsWith('rgba')) {
        shapes.push({ kind: 'rect', x, y, w, h, fill: this.fillStyle });
      }
    },
  };
}

/** Replay captured draw calls onto a real surface. */
async function paint(calls, shapes) {
  const layers = await Promise.all(calls.map(async ({ image, args }) => {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    return {
      input: await sharp(join(PACK_DIR, image.name))
        .extract({ left: Math.round(sx), top: Math.round(sy), width: Math.round(sw), height: Math.round(sh) })
        .resize(Math.round(dw), Math.round(dh), { fit: 'fill' })
        .png().toBuffer(),
      left: Math.round(dx),
      top: Math.round(dy),
    };
  }));

  if (shapes.length) {
    const svg = shapes.map(s => s.kind === 'arc'
      ? '<circle cx="' + s.x.toFixed(2) + '" cy="' + s.y.toFixed(2)
        + '" r="' + s.r.toFixed(2) + '" fill="' + s.fill + '"/>'
      : '<rect x="' + s.x.toFixed(2) + '" y="' + s.y.toFixed(2)
        + '" width="' + s.w.toFixed(2) + '" height="' + s.h.toFixed(2)
        + '" fill="' + s.fill + '"/>').join('');
    layers.push({
      input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + SIZE.width
        + '" height="' + SIZE.height + '">' + svg + '</svg>'),
      left: 0, top: 0,
    });
  }

  return sharp({
    create: { ...SIZE, channels: 4, background: pack.background ?? '#000000' },
  }).composite(layers).png().toBuffer();
}

async function main() {
  const images = new Map(PackRenderer.imageNames(pack).map(name => [name, { name }]));
  const renderer = new PackRenderer({ pack, images });
  const player = new CharacterPlayer({ pack });
  const effects = new CharacterEffects(pack.effects ?? {});

  const tiles = [];
  const labels = [];
  let sampleEvery = 0;

  for (const [seconds, action] of SCRIPT) {
    action(player);
    const frames = Math.round(seconds * FPS);
    for (let frame = 0; frame < frames; frame++) {
      player.update(1 / FPS);
      // Sample about six times a second, which is enough to read a ramp.
      if (sampleEvery++ % 10 !== 0) continue;

      const context = recordingContext();
      // Cross-fade is off: discrete poses read more clearly in a still.
      const pose = player.pose(false);
      renderer.draw(context, pose, SIZE.width, SIZE.height);
      effects.draw(context, {
        state: player.state, requested: player.requestedState,
        sleeping: player.sleeping, seconds: player.stateSeconds, eventId: player.eventId,
      }, SIZE.width, SIZE.height);
      if (context.calls.length === 0) continue;

      tiles.push(await paint(context.calls, context.shapes));
      labels.push((player.sleeping ? 'sleep' : player.state) + ' ' + pose.track + ':' + pose.from
        + (pose.blinkLevel ? ' b' + pose.blinkLevel : ''));
    }
  }

  const rows = Math.ceil(tiles.length / COLUMNS);
  const gap = 2;
  const sheet = await sharp({
    create: {
      width: COLUMNS * (SIZE.width + gap) + gap,
      height: rows * (SIZE.height + gap) + gap,
      channels: 4,
      background: '#0a0c0f',
    },
  }).composite(tiles.map((input, index) => ({
    input,
    left: gap + (index % COLUMNS) * (SIZE.width + gap),
    top: gap + Math.floor(index / COLUMNS) * (SIZE.height + gap),
  }))).png().toBuffer();

  writeFileSync(out, sheet);
  console.log('Wrote ' + out + ': ' + tiles.length + ' samples, ' + rows + ' rows of ' + COLUMNS);
  console.log(labels.join('\n'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

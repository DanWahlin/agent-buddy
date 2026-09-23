import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { blinkDraw } from '@agent-companion/pack-format';
import { PackRenderer } from '../dist/index.js';

const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'packs', 'marvin');
const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8'));

/**
 * A canvas context that records instead of painting. The renderer only needs
 * drawImage, fillRect and a few properties, so the geometry can be checked
 * exactly without a browser.
 */
function recordingContext() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fillRect(...args) { calls.push({ op: 'fillRect', args, fillStyle: this.fillStyle }); },
    clearRect(...args) { calls.push({ op: 'clearRect', args }); },
    drawImage(image, ...args) {
      calls.push({ op: 'drawImage', image, args, alpha: this.globalAlpha });
    },
  };
}

/** Stand-ins for the loaded images; the renderer only passes them through. */
function images() {
  return new Map(PackRenderer.imageNames(pack).map(name => [name, { name }]));
}

const renderer = () => new PackRenderer({ pack, images: images() });
const draws = calls => calls.filter(call => call.op === 'drawImage');

test('clears to transparency first, so the panel shows through', () => {
  // The default: a companion sits on the editor's own background rather than
  // in a box, which is the only thing that works in both light and dark themes.
  assert.equal(pack.background, undefined, 'the shipped pack should be a cutout');
  const context = recordingContext();
  renderer().draw(context, pose(), 480, 448);
  assert.equal(context.calls[0].op, 'clearRect');
  assert.deepEqual(context.calls[0].args, [0, 0, 480, 448]);
});

test('paints a card first when a pack asks for one', () => {
  const carded = structuredClone(pack);
  carded.background = '#0e1013';
  const context = recordingContext();
  new PackRenderer({ pack: carded, images: images() }).draw(context, pose(), 480, 448);
  assert.equal(context.calls[0].op, 'fillRect');
  assert.equal(context.calls[0].fillStyle, '#0e1013');
  assert.deepEqual(context.calls[0].args, [0, 0, 480, 448]);
});

test('takes the right source rectangle out of the base strip', () => {
  const context = recordingContext();
  renderer().draw(context, pose({ from: 5 }), 480, 448);
  const [base] = draws(context.calls);

  assert.equal(base.image.name, 'right.webp');
  assert.deepEqual(base.args.slice(0, 4), [5 * pack.frame.width, 0, pack.frame.width, pack.frame.height]);
});

test('letterboxes rather than stretching', () => {
  const context = recordingContext();
  // A stage twice the frame's aspect ratio: the drawing should be centred.
  renderer().draw(context, pose(), 960, 448);
  const [base] = draws(context.calls);
  const [, , , , dx, dy, dw, dh] = base.args;

  const scale = 448 / pack.frame.height;
  assert.equal(dw, pack.frame.width * scale);
  assert.equal(dh, pack.frame.height * scale);
  assert.equal(dy, 0);
  assert.equal(dx, (960 - dw) / 2, 'should be centred horizontally');
  assert.ok(Math.abs(dw / dh - pack.frame.width / pack.frame.height) < 1e-9, 'aspect preserved');
});

test('honours maxScale so a pack need not be blown up', () => {
  const context = recordingContext();
  new PackRenderer({ pack, images: images(), maxScale: 1 }).draw(context, pose(), 960, 896);
  const [base] = draws(context.calls);
  assert.equal(base.args[6], pack.frame.width, 'drawn at 1x despite the space');
  assert.equal(base.args[7], pack.frame.height);
});

test('composites the blink patch over the base, at the same scale', () => {
  const step = pack.tracks.right.patch.cells.findIndex(cell => cell !== null);
  const context = recordingContext();
  renderer().draw(context, pose({ from: step, blinkLevel: 3 }), 480, 448);

  const [base, patch] = draws(context.calls);
  assert.equal(base.image.name, 'right.webp');
  assert.equal(patch.image.name, 'right.blink.webp');

  const expected = blinkDraw(pack.tracks.right, step, 3);
  assert.deepEqual(patch.args.slice(0, 4), expected.source);

  const scale = Math.min(480 / pack.frame.width, 448 / pack.frame.height);
  const left = (480 - pack.frame.width * scale) / 2;
  const top = (448 - pack.frame.height * scale) / 2;
  assert.equal(patch.args[4], left + expected.destination[0] * scale);
  assert.equal(patch.args[5], top + expected.destination[1] * scale);
  assert.equal(patch.args[6], expected.source[2] * scale);
  assert.equal(patch.args[7], expected.source[3] * scale);
});

test('draws no patch where the eyes are open, occluded, or unsupported', () => {
  const occluded = pack.tracks.down.patch.cells.findIndex(cell => cell === null);
  const cases = [
    ['eyes open', pose({ blinkLevel: 0 })],
    ['occluded step', pose({ track: 'down', from: occluded, blinkLevel: 4 })],
  ];
  for (const [label, value] of cases) {
    const context = recordingContext();
    renderer().draw(context, value, 480, 448);
    assert.equal(draws(context.calls).length, 1, label + ' should draw base only');
  }
});

test('cross-fades by drawing the next pose over the first', () => {
  const context = recordingContext();
  renderer().draw(context, pose({ from: 2, to: 3, mix: 0.25 }), 480, 448);
  const painted = draws(context.calls);

  assert.equal(painted.length, 2);
  assert.equal(painted[0].alpha, 1);
  assert.equal(painted[1].alpha, 0.25);
  assert.equal(painted[1].args[0], 3 * pack.frame.width, 'the second should be the `to` pose');
  assert.equal(context.globalAlpha, 1, 'alpha must be restored');
});

test('skips the cross-fade when there is nothing between', () => {
  const context = recordingContext();
  renderer().draw(context, pose({ from: 2, to: 2, mix: 0.5 }), 480, 448);
  assert.equal(draws(context.calls).length, 1);
});

test('clamps a step outside the strip rather than reading past it', () => {
  const context = recordingContext();
  renderer().draw(context, pose({ from: 999 }), 480, 448);
  const [base] = draws(context.calls);
  assert.equal(base.args[0], (pack.steps - 1) * pack.frame.width);
});

test('draws nothing for a track the pack does not have', () => {
  const context = recordingContext();
  const thin = structuredClone(pack);
  delete thin.tracks.up_left;
  new PackRenderer({ pack: thin, images: images() })
    .draw(context, pose({ track: 'up_left' }), 480, 448);
  assert.equal(draws(context.calls).length, 0);
  assert.equal(context.calls[0].op, 'clearRect', 'but still clears the stage');
});

test('turns on smoothing, since these are renders and not pixel art', () => {
  const context = recordingContext();
  renderer().draw(context, pose(), 480, 448);
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(context.imageSmoothingQuality, 'high');
});

function pose(overrides = {}) {
  return { track: 'right', from: 0, to: 0, mix: 0, blinkLevel: 0, ...overrides };
}

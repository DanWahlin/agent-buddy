import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { validatePack } from '@agent-companion/pack-format';
import { buildPack, probeIn, readRig } from '../dist/index.js';
import { loadPack, renderFrame } from '../dist/inspect.js';
import { BLINK_LEVELS, FRAME, POSES, createRig } from './rig-fixture.mjs';

/**
 * The whole packing pipeline, against a rig built on the spot.
 *
 * `pack.test.js` covers what is specific to the real Marvin rig and skips
 * without it. This covers that the packer works at all, so it runs everywhere -
 * including on the platforms where nobody has a rendered rig.
 */

sharp.cache(false);

const scratch = [];
function scratchDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

let rig = null;
let built = null;

before(async () => {
  const root = scratchDir('agent-pack-rig-');
  const { gaze, expressions, anchor } = await createRig(root);
  rig = { dirs: [gaze, expressions], anchor };

  const outDir = scratchDir('agent-pack-out-');
  const result = await buildPack({
    rig: readRig(rig.dirs), outDir, id: 'fixture', name: 'Fixture', anchor,
  });
  built = { outDir, result, pack: loadPack(outDir) };
});

after(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('reads a rig split across two manifests', () => {
  const read = readRig(rig.dirs);
  assert.equal(read.tracks.size, 13);
  assert.equal(read.count, POSES);
  assert.equal(read.width, FRAME.width);
  assert.equal(read.height, FRAME.height);
  assert.deepEqual(read.blinkLevels, BLINK_LEVELS);
});

test('produces a pack that validates, images and all', () => {
  assert.deepEqual(validatePack(built.result.pack, probeIn(built.outDir)), []);
  assert.equal(Object.keys(built.result.pack.tracks).length, 13);
  assert.equal(built.result.pack.steps, Math.round(POSES / 2));
});

test('closes the frame-0 seam the rig arrives with', async () => {
  // The fixture drifts on every gaze track but `right`, the way a generated rig
  // does. All of them should be realigned, and none of the expression tracks.
  assert.deepEqual([...built.result.realigned].sort(),
    ['down', 'down_left', 'down_right', 'left', 'up', 'up_left', 'up_right']);

  const raw = async track => sharp(await renderFrame(built.outDir, built.pack, track, 0, 0))
    .ensureAlpha().raw().toBuffer();

  const centre = await raw('right');
  const step = countDifferent(centre, await sharp(
    await renderFrame(built.outDir, built.pack, 'right', 1, 0)).ensureAlpha().raw().toBuffer());

  for (const name of Object.keys(built.pack.tracks)) {
    const seam = countDifferent(centre, await raw(name));
    assert.ok(seam < Math.max(1, step / 4),
      name + ' frame 0 is ' + seam + ' px from the centre pose, against a '
      + step + ' px motion step');
  }
});

test('a rig that already agrees needs no realignment', async () => {
  const root = scratchDir('agent-pack-clean-');
  const { gaze, expressions, anchor } = await createRig(root, { drift: false });
  const outDir = scratchDir('agent-pack-clean-out-');

  const result = await buildPack({
    rig: readRig([gaze, expressions]), outDir, id: 'clean', name: 'Clean', anchor,
  });
  assert.deepEqual(result.realigned, [], 'nothing to fix, so nothing reported');
});

test('stores blinks as per-step patches, not whole frames', () => {
  const { width, height } = built.pack.frame;
  for (const [name, track] of Object.entries(built.pack.tracks)) {
    if (!track.patch) continue;
    const [w, h] = track.patch.size;
    assert.ok(w * h < (width * height) / 2,
      name + ' patch is ' + w + 'x' + h + ' of a ' + width + 'x' + height + ' frame');
    assert.equal(track.patch.cells.length, built.pack.steps);
  }
});

test('occluded steps carry no patch cell', () => {
  // The fixture hides the eyes past a certain angle on the downward tracks, as
  // a real rig does, and records no eye box there.
  const down = built.pack.tracks.down;
  assert.ok(down.patch, 'it should still blink where the eyes are visible');
  assert.ok(down.patch.cells.some(cell => cell === null), 'some step should be occluded');
  assert.ok(down.patch.cells.some(cell => cell !== null), 'and some should not');

  assert.ok(built.pack.tracks.up.patch.cells.every(cell => cell !== null),
    'looking up never hides the eyes');
});

test('a track whose blinks match its base gets no blink strip', () => {
  for (const name of ['surprise', 'complete']) {
    assert.ok(built.result.neverBlink.includes(name), name + ' should be found not to blink');
    assert.equal(built.pack.tracks[name].blinks, undefined);
    assert.ok(!existsSync(join(built.outDir, name + '.blink.webp')));
  }
  assert.ok(built.pack.tracks.working.blinks, 'a track that does blink keeps its strip');
});

test('the centre pose still blinks after being realigned', async () => {
  const closed = built.pack.blinkLevels.length - 1;
  for (const name of built.result.realigned) {
    const open = await renderFrame(built.outDir, built.pack, name, 0, 0);
    const shut = await renderFrame(built.outDir, built.pack, name, 0, closed);
    assert.notEqual(digest(open), digest(shut),
      name + ' renders the same open and closed at the centre pose');
  }
});

test('sleep closes the eyes on whichever track it names', async () => {
  const { track, step, blinkLevel } = built.pack.sleep;
  const open = await renderFrame(built.outDir, built.pack, track, step, 0);
  const shut = await renderFrame(built.outDir, built.pack, track, step, blinkLevel);
  assert.notEqual(digest(open), digest(shut));
});

test('cuts the backdrop away by default', async () => {
  const meta = await sharp(join(built.outDir, built.pack.tracks.right.base)).metadata();
  assert.equal(meta.hasAlpha, true);
  assert.equal(built.pack.background, undefined);
});

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Pixels differing by more than 8 levels, the upstream metric. */
function countDifferent(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.max(
      Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (delta > 8) count++;
  }
  return count;
}

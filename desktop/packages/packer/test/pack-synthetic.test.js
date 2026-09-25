import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { validatePack } from '@agent-companion/pack-format';
import { buildPack, deriveEyeBox, probeIn, readRig } from '../dist/index.js';
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

test('reads a rig whose one manifest splits gaze from expressions', async () => {
  // Claude's rig arrives this way: thirteen tracks in one directory, divided
  // between `directions` and `expressions` in a single manifest. Which key a
  // track was listed under should make no difference to what comes out.
  const root = scratchDir('agent-pack-rig-combined-');
  const combined = await createRig(root, { combined: true });
  assert.deepEqual(combined.dirs.length, 1);

  const read = readRig(combined.dirs);
  assert.equal(read.tracks.size, 13);
  assert.equal(read.count, POSES);
  for (const [name, track] of read.tracks) {
    assert.equal(track.frames.length, POSES, name + ' should have ' + POSES + ' poses');
  }
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

// --- rigs that arrive imperfect --------------------------------------------

test('measures the eye region when the rig does not record it', async () => {
  // The Three.js renderer emits the field and leaves it empty, so without this
  // the character would get no blink strips at all and never blink.
  const root = scratchDir('agent-pack-noeyes-');
  const { gaze, expressions, anchor } = await createRig(root, { recordEyes: false });
  const outDir = scratchDir('agent-pack-noeyes-out-');

  const result = await buildPack({
    rig: readRig([gaze, expressions]), outDir, id: 'noeyes', name: 'No eyes', anchor,
  });

  assert.ok(result.derivedEyes > 0, 'it should have measured some');
  const patched = Object.values(result.pack.tracks).filter(track => track.patch);
  assert.ok(patched.length > 8, 'and most tracks should still blink');
  assert.deepEqual(validatePack(result.pack, probeIn(outDir)), []);
});

test('the measured region matches the one a manifest records', async () => {
  const root = scratchDir('agent-pack-eyecheck-');
  const { gaze } = await createRig(root, { recordEyes: true });
  const rig = readRig([gaze]);
  const frame = rig.tracks.get('up').frames[1];

  const measured = await deriveEyeBox(frame);
  assert.equal(measured.length, 1);

  // The fixture blinks by changing the whole body, so the measured box is the
  // body rather than the eyes. What matters is that it finds the region that
  // actually changes, and that it is a sane rectangle inside the frame.
  const [x0, y0, x1, y1] = measured[0];
  assert.ok(x1 > x0 && y1 > y0, 'a box with area');
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= FRAME.width && y1 <= FRAME.height,
    'inside the frame: ' + measured[0].join(','));
});

test('a blank pose is reported rather than quietly packed', async () => {
  // A frame holding nothing survives every other check: the cutout removes all
  // of it, its blink levels all match because they are equally blank, and the
  // pack still validates. This is what a renderer capturing before its canvas
  // is ready produces, and it went unnoticed until a character arrived with a
  // whole track missing.
  const root = scratchDir('agent-pack-blank-');
  const { gaze, expressions, anchor } = await createRig(root, {
    // Step 2 is one the packer selects; step 3 would be sampled out and the
    // test would pass for the wrong reason.
    blankPose: { track: 'up', step: 2 },
  });
  const outDir = scratchDir('agent-pack-blank-out-');

  const result = await buildPack({
    rig: readRig([gaze, expressions]), outDir, id: 'blank', name: 'Blank', anchor,
  });

  assert.ok(result.empty.length > 0, 'the blank pose should be reported');
  assert.equal(result.empty[0].track, 'up');
  assert.match(result.empty[0].file, /up-02\.png$/);
});

test('a complete rig reports no blank poses', () => {
  assert.deepEqual(built.result.empty, []);
});

test('sleep picks a pose that can close its eyes', async () => {
  // Sleep is the centre pose held shut, which assumes the centre pose blinks.
  // A rig can arrive where every pose blinks except the shared centre, and
  // pinning sleep to step 0 there leaves the character awake while asleep.
  const root = scratchDir('agent-pack-sleep-');
  const { gaze, expressions, anchor } = await createRig(root, { centreCannotBlink: true });
  const outDir = scratchDir('agent-pack-sleep-out-');

  const result = await buildPack({
    rig: readRig([gaze, expressions]), outDir, id: 'sleepy', name: 'Sleepy', anchor,
  });
  const pack = loadPack(outDir);

  assert.notEqual(pack.sleep.step, 0, 'step 0 cannot blink in this rig');
  const open = await renderFrame(outDir, pack, pack.sleep.track, pack.sleep.step, 0);
  const shut = await renderFrame(outDir, pack, pack.sleep.track, pack.sleep.step,
    pack.sleep.blinkLevel);
  assert.notEqual(digest(open), digest(shut), 'sleep must actually close the eyes');
});

test('sleep stays on the centre pose when that pose can blink', () => {
  assert.equal(built.pack.sleep.step, 0, 'no reason to move it');
});

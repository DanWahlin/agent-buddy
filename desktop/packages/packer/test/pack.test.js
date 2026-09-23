import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { validatePack } from '@agent-companion/pack-format';
import { buildPack, chooseSteps, probeIn, readRig } from '../dist/index.js';
import { loadPack, renderFrame } from '../dist/inspect.js';

// sharp otherwise keeps decoded files open, and Windows refuses to remove the
// temporary directories afterwards.
sharp.cache(false);

const RIG_ROOT = process.env.AGENT_COMPANION_RIG
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '',
    'OneDrive', 'GitHub', 'esp32-agent-companion');
const GAZE = join(RIG_ROOT, 'web', 'generated-sprites-jarvis');
const EXPRESSIONS = join(RIG_ROOT, 'web', 'generated-expressions-jarvis');
const ANCHOR = join(RIG_ROOT, 'assets', 'generated-sprites-jarvis', 'approved-center.png');

/**
 * The full build needs a rendered rig, which only exists on a machine that has
 * one. Everything that needs it is skipped rather than failed elsewhere.
 *
 * Probing by actually reading it, rather than checking the directories exist:
 * a rig kept on a branch leaves the directories behind but empty when the
 * branch is switched, and that is still "no rig here".
 */
const rigProblem = (() => {
  if (!existsSync(GAZE) || !existsSync(EXPRESSIONS)) return 'no rig at ' + RIG_ROOT;
  try {
    const rig = readRig([GAZE, EXPRESSIONS]);
    return rig.tracks.size === 0 ? 'rig at ' + RIG_ROOT + ' has no tracks' : null;
  } catch (error) {
    return 'rig at ' + RIG_ROOT + ' is unusable: ' + error.message;
  }
})();
const haveRig = rigProblem === null;
const withRig = { skip: rigProblem ?? false };

const temporaries = [];
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/** Built once; the read-only tests all share it. */
let marvin = null;

before(async () => {
  if (!haveRig) return;
  const outDir = scratch('agent-pack-');
  const result = await buildPack({
    rig: readRig([GAZE, EXPRESSIONS]),
    outDir, id: 'marvin', name: 'Marvin', anchor: ANCHOR,
  });
  marvin = { outDir, result, pack: loadPack(outDir) };
});

after(() => {
  for (const directory of temporaries) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('chooseSteps keeps the centre and the full turn', () => {
  assert.equal(chooseSteps(24, 12)[0], 0);
  assert.equal(chooseSteps(24, 12).at(-1), 23);
  assert.equal(chooseSteps(24, 12).length, 12);
  assert.deepEqual(chooseSteps(5, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(chooseSteps(4, 9), [0, 1, 2, 3], 'never invents poses');
  assert.deepEqual(chooseSteps(24, 1), [0]);
});

test('chooseSteps spaces the picks evenly', () => {
  const picked = chooseSteps(24, 6);
  const gaps = picked.slice(1).map((value, index) => value - picked[index]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'gaps were ' + gaps.join(','));
});

test('readRig merges the gaze and expression manifests into 13 tracks', withRig, () => {
  const rig = readRig([GAZE, EXPRESSIONS]);
  assert.equal(rig.tracks.size, 13);
  assert.equal(rig.count, 24);
  assert.equal(rig.width, 240);
  assert.equal(rig.height, 224);
  assert.deepEqual(rig.blinkLevels, [1, 0.75, 0.5, 0.25, 0]);
  for (const [name, track] of rig.tracks) {
    assert.equal(track.frames.length, 24, name + ' should have 24 poses');
  }
});

test('readRig refuses a track defined in two directories', withRig, () => {
  assert.throws(() => readRig([GAZE, GAZE]), /appears in more than one rig directory/);
});

test('building Marvin produces a valid, small pack', withRig, () => {
  const { result, outDir } = marvin;
  assert.deepEqual(validatePack(result.pack, probeIn(outDir)), []);
  assert.equal(Object.keys(result.pack.tracks).length, 13);
  assert.equal(result.pack.steps, 12);
  assert.deepEqual(result.pack.frame, { width: 120, height: 112 });

  // The budget that keeps the .vsix honest. Flat storage of the same art is
  // ~27 MB; anything near a megabyte here means the patch packing regressed.
  assert.ok(result.bytes < 1024 * 1024,
    'pack is ' + (result.bytes / 1024).toFixed(0) + ' KB, expected under 1 MB');

  // Upstream, only `right` and the five expression tracks sit on the centre
  // pose; the other seven gaze tracks drift and must be realigned.
  assert.deepEqual([...result.realigned].sort(),
    ['down', 'down_left', 'down_right', 'left', 'up', 'up_left', 'up_right']);
});

test('every track renders the same centre pose, within encoder noise', withRig, async () => {
  const { outDir, pack } = marvin;
  const names = Object.keys(pack.tracks);
  const raw = async (track, step) => sharp(await renderFrame(outDir, pack, track, step, 0))
    .ensureAlpha().raw().toBuffer();

  // Frame 0 is the hinge every track change passes through. Calibrate against a
  // normal single-step advance, which is the largest change the eye already
  // accepts as smooth motion; a seam well inside that reads as nothing. Packs
  // are lossy, so the tracks will never be byte-identical here.
  const centre = await raw('right', 0);
  const step = countDifferent(centre, await raw('right', 1));
  assert.ok(step > 0, 'a motion step should actually change pixels');

  for (const name of names.slice(1)) {
    const seam = countDifferent(centre, await raw(name, 0));
    assert.ok(seam < step / 4,
      name + ' frame 0 differs from the centre pose in ' + seam + ' px, '
      + 'which is not comfortably inside one motion step (' + step + ' px)');
  }
});

test('the centre pose blinks on every track, including realigned ones', withRig, async () => {
  const { outDir, pack, result } = marvin;

  // Realigning frame 0 onto a bare anchor image once dropped its blink art,
  // which silently stopped the centre pose blinking - and sleep is defined as
  // the centre pose held fully closed, so it slept with its eyes open.
  const closed = pack.blinkLevels.length - 1;
  for (const name of result.realigned) {
    const open = await renderFrame(outDir, pack, name, 0, 0);
    const shut = await renderFrame(outDir, pack, name, 0, closed);
    assert.notEqual(digest(open), digest(shut),
      name + ' renders identically open and fully closed at the centre pose');
  }

  const { track, step, blinkLevel } = pack.sleep;
  const sleepOpen = await renderFrame(outDir, pack, track, step, 0);
  const sleepShut = await renderFrame(outDir, pack, track, step, blinkLevel);
  assert.notEqual(digest(sleepOpen), digest(sleepShut), 'sleep must actually close the eyes');
});

test('blink patches stay smaller than the frames they patch', withRig, () => {
  const { width, height } = marvin.pack.frame;

  // A single rect spanning the whole turn covers the eyes' travel and ends up
  // bigger than the frames it was meant to shrink, so patches are per-step.
  for (const [name, track] of Object.entries(marvin.pack.tracks)) {
    if (!track.patch) continue;
    const [w, h] = track.patch.size;
    assert.ok(w * h < (width * height) / 4,
      name + ' patch is ' + w + 'x' + h + ', more than a quarter of the frame');
    assert.equal(track.patch.cells.length, marvin.pack.steps);
  }
});

test('occluded poses carry no blink cell', withRig, () => {
  // `down`, `down_left` and `down_right` hide the eyes at steep angles, and the
  // manifests record no eye box there. Those steps must render as themselves.
  const down = marvin.pack.tracks.down;
  assert.ok(down.patch, 'down should still blink where the eyes are visible');
  assert.ok(down.patch.cells.some(cell => cell === null),
    'down should have at least one occluded step');
  assert.ok(down.patch.cells.some(cell => cell !== null),
    'down should have at least one visible step');
});

test('tracks that never blink carry no blink strip', withRig, async () => {
  const outDir = scratch('agent-pack-noblink-');
  const rig = readRig([GAZE, EXPRESSIONS]);
  // Drop the expression tracks' one blinking pose so the whole track is
  // expression-preserved, the way most of its frames already are.
  for (const name of ['surprise', 'complete']) {
    for (const frame of rig.tracks.get(name).frames) frame.blinks = [];
  }
  const result = await buildPack({ rig, outDir, id: 'marvin', name: 'Marvin', anchor: ANCHOR });

  assert.ok(result.neverBlink.includes('surprise'));
  assert.ok(result.neverBlink.includes('complete'));
  assert.equal(result.pack.tracks.surprise.blinks, undefined);
  assert.equal(result.pack.tracks.surprise.patch, undefined);
  assert.ok(!existsSync(join(outDir, 'surprise.blink.webp')));
  assert.deepEqual(validatePack(result.pack, probeIn(outDir)), []);
});

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Pixels whose colour differs by more than 8 levels, the upstream metric. */
function countDifferent(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.max(
      Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (delta > 8) count++;
  }
  return count;
}

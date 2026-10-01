import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CHARACTER_STATES, GAZE_TRACKS, TRACK_NAMES,
  assertValidPack, baseFrameRect, blinkDraw, validatePack,
} from '../dist/index.js';

/** A minimal pack that passes, which each test then breaks in one way. */
function samplePack(overrides = {}) {
  return {
    format: 1,
    id: 'sample',
    name: 'Sample',
    frame: { width: 120, height: 112 },
    background: '#0e1013',
    steps: 4,
    blinkLevels: [1, 0.75, 0.5, 0.25, 0],
    tracks: {
      right: {
        base: 'right.webp',
        blinks: 'right.blink.webp',
        patch: { size: [40, 16], cells: [[30, 50], [32, 50], null, [36, 52]] },
      },
      working: { base: 'working.webp' },
      surprise: { base: 'surprise.webp' },
      complete: { base: 'complete.webp' },
      attention: { base: 'attention.webp' },
    },
    states: {
      idle: 'gaze',
      surprise: 'surprise',
      working: 'working',
      complete: 'complete',
      attention: 'attention',
    },
    sleep: { track: 'right', step: 0, blinkLevel: 4 },
    ...overrides,
  };
}

/** Dimensions consistent with samplePack(). */
const sampleProbe = name => ({
  'right.webp': { width: 480, height: 112 },
  'right.blink.webp': { width: 160, height: 64 },
  'working.webp': { width: 480, height: 112 },
  'surprise.webp': { width: 480, height: 112 },
  'complete.webp': { width: 480, height: 112 },
  'attention.webp': { width: 480, height: 112 },
}[name] ?? null);

test('a well-formed pack validates, with and without a probe', () => {
  assert.deepEqual(validatePack(samplePack()), []);
  assert.deepEqual(validatePack(samplePack(), sampleProbe), []);
  assert.doesNotThrow(() => assertValidPack(samplePack(), sampleProbe));
});

test('the track list is the thirteen known tracks', () => {
  assert.equal(TRACK_NAMES.length, 13);
  assert.equal(GAZE_TRACKS.length, 8);
  assert.equal(new Set(TRACK_NAMES).size, 13);
  for (const state of CHARACTER_STATES) assert.equal(typeof state, 'string');
});

test('an unknown track name is rejected', () => {
  const pack = samplePack();
  pack.tracks.sideways = { base: 'sideways.webp' };
  assert.match(validatePack(pack).join('\n'), /unknown track "sideways"/);
});

test('blinks without a patch rect is rejected', () => {
  const pack = samplePack();
  delete pack.tracks.right.patch;
  assert.match(validatePack(pack).join('\n'), /has blinks but no patch rect/);
});

test('a patch cell that runs off the frame is rejected', () => {
  const pack = samplePack();
  pack.tracks.right.patch.cells[1] = [100, 50];
  assert.match(validatePack(pack).join('\n'), /patch cell 1 at 100,50 plus 40x16 falls outside/);
});

test('the patch cell count must match steps', () => {
  const pack = samplePack();
  pack.tracks.right.patch.cells.pop();
  assert.match(validatePack(pack).join('\n'), /has 3 patch cells, expected 4/);
});

test('base strip dimensions are checked against steps and frame size', () => {
  const probe = name => (name === 'right.webp' ? { width: 400, height: 112 } : sampleProbe(name));
  assert.match(validatePack(samplePack(), probe).join('\n'),
    /track "right" base is 400x112, expected 480x112/);
});

test('blink strip dimensions are checked against the patch size', () => {
  const probe = name => (name === 'right.blink.webp' ? { width: 160, height: 32 } : sampleProbe(name));
  assert.match(validatePack(samplePack(), probe).join('\n'),
    /track "right" blinks is 160x32, expected 160x64/);
});

test('a missing image is reported rather than thrown', () => {
  const probe = name => (name === 'working.webp' ? null : sampleProbe(name));
  assert.match(validatePack(samplePack(), probe).join('\n'),
    /track "working" base image is missing/);
});

test('states may not name a track the pack does not contain', () => {
  const pack = samplePack();
  pack.states.working = 'up_left';
  assert.match(validatePack(pack).join('\n'), /states.working names absent track "up_left"/);
});

test('states accept a list, for tracks chosen at random', () => {
  const pack = samplePack();
  pack.tracks.attention_alternate = { base: 'attention_alternate.webp' };
  pack.states.attention = ['attention', 'attention_alternate'];
  assert.deepEqual(validatePack(pack), []);
});

test('sleep must point at a track in the pack', () => {
  const pack = samplePack();
  pack.sleep.track = 'down';
  assert.match(validatePack(pack).join('\n'), /sleep.track "down" is not a track in this pack/);
});

test('a non-hex background is rejected', () => {
  assert.match(validatePack(samplePack({ background: 'darkish' })).join('\n'),
    /background must be a hex colour/);
});

test('assertValidPack throws with every problem listed', () => {
  const pack = samplePack({ format: 2, id: '' });
  assert.throws(() => assertValidPack(pack), error => {
    assert.match(error.message, /format must be 1/);
    assert.match(error.message, /id must be a non-empty string/);
    return true;
  });
});

test('baseFrameRect walks the strip a frame at a time', () => {
  const pack = samplePack();
  assert.deepEqual(baseFrameRect(pack, 0), [0, 0, 120, 112]);
  assert.deepEqual(baseFrameRect(pack, 3), [360, 0, 120, 112]);
});

test('blinkDraw maps a step and level onto source and destination rects', () => {
  const track = samplePack().tracks.right;
  const draw = blinkDraw(track, 1, 2);
  assert.deepEqual(draw.source, [40, 16, 40, 16]);
  assert.deepEqual(draw.destination, [32, 50, 40, 16]);
});

test('blinkDraw returns null where there is nothing to composite', () => {
  const pack = samplePack();
  const track = pack.tracks.right;
  assert.equal(blinkDraw(track, 0, 0), null, 'level 0 is the open-eyed base frame');
  assert.equal(blinkDraw(track, 2, 3), null, 'step 2 has occluded eyes');
  assert.equal(blinkDraw(pack.tracks.working, 0, 3), null, 'this track never blinks');
});

test('an effect palette is optional, but checked when present', () => {
  assert.deepEqual(validatePack(samplePack({ effects: { orbit: '80,215,239' } })), []);
  assert.deepEqual(validatePack(samplePack({ effects: {} })), []);

  // A bad value would silently paint nothing once it reached rgba().
  assert.match(validatePack(samplePack({ effects: { orbit: '#50d7ef' } })).join('\n'),
    /effects.orbit must be "r,g,b"/);
  assert.match(validatePack(samplePack({ effects: { orbit: '300,0,0' } })).join('\n'),
    /effects.orbit must be "r,g,b"/);
  assert.match(validatePack(samplePack({ effects: { glow: '1,2,3' } })).join('\n'),
    /unknown effect colour "glow"/);
  assert.match(validatePack(samplePack({ effects: 'blue' })).join('\n'),
    /effects must be an object/);
});

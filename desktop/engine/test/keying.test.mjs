/**
 * The "character only" cut-out is cached while the character holds still and
 * only the effects move. This checks the cached result is exactly what working
 * it out afresh gives, frame by frame, through every mode.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = join(here, '..', 'prebuilt', 'engine.js');
const packs = join(here, '..', '..', '..', 'build', 'characters');
const ready = existsSync(enginePath) && existsSync(join(packs, 'copilot.acpk'));
const skipFor = character =>
  !ready || !existsSync(join(packs, `${character}.acpk`)) ? 'needs the built engine and packs' : false;

async function load(character) {
  const require = createRequire(import.meta.url);
  const engine = await require(enginePath)();
  const bytes = readFileSync(join(packs, `${character}.acpk`));
  engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
  assert.equal(engine._ac_load_reserved(7), 1);
  return engine;
}

for (const character of ['copilot', 'grok']) {
  test(`${character}: the cached cut-out matches a fresh one`, { skip: skipFor(character) }, async () => {
    const engine = await load(character);
    const size = engine._ac_width() * engine._ac_height() * 4;
    const script = [...Array(40).fill(-1), 2, ...Array(120).fill(-1), 4, ...Array(80).fill(-1),
      3, ...Array(60).fill(-1), 0, ...Array(40).fill(-1)];
    for (const [step, mode] of script.entries()) {
      if (mode >= 0) engine._ac_mode(mode, 0);
      let pointer = engine._ac_frame(1 / 30, 1);
      const cached = engine.HEAPU8.slice(pointer, pointer + size);
      engine._ac_forget();
      pointer = engine._ac_frame(0, 1);
      const fresh = engine.HEAPU8.subarray(pointer, pointer + size);
      assert.ok(Buffer.compare(Buffer.from(cached), Buffer.from(fresh)) === 0, `frame ${step} differs`);
    }
  });
}

// Black that touches the edge is background. Grok's eyes are black too, but the
// white ball closes them in, so the cut-out must keep them solid.
test('grok: the cut-out keeps the eyes inside the ball', { skip: skipFor('grok') }, async () => {
  const engine = await load('grok');
  const width = engine._ac_width();
  const size = width * engine._ac_height() * 4;
  for (let step = 0; step < 240; ++step) {
    engine._ac_frame(1 / 30, 0);
    if (step % 20) continue;
    const pointer = engine._ac_frame(0, 1);
    const frame = engine.HEAPU8.subarray(pointer, pointer + size);
    let eyes = 0;
    for (let row = 0; row < size; row += width * 4) {
      // A dark pixel between the first and the last solid white pixel of a row is part of an eye.
      let first = -1;
      let last = -1;
      for (let at = row; at < row + width * 4; at += 4) {
        if (frame[at + 3] === 255 && frame[at] > 200) {
          if (first < 0) first = at;
          last = at;
        }
      }
      for (let at = first + 4; first >= 0 && at < last; at += 4) {
        if (frame[at] > 40) continue;
        assert.equal(frame[at + 3], 255, `frame ${step}: an eye pixel is see-through`);
        ++eyes;
      }
    }
    assert.ok(eyes > 0, `frame ${step}: no eye pixels inside the ball`);
  }
});

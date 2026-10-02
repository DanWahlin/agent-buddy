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
const enginePath = join(here, '..', 'dist', 'engine.js');
const packs = join(here, '..', '..', '..', 'build', 'characters');
const ready = existsSync(enginePath) && existsSync(join(packs, 'copilot.acpk'));

test('the cached cut-out matches a fresh one', { skip: ready ? false : 'needs the built engine and packs' }, async () => {
  const require = createRequire(import.meta.url);
  const engine = await require(enginePath)();
  const bytes = readFileSync(join(packs, 'copilot.acpk'));
  engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
  assert.equal(engine._ac_load_reserved(7), 1);
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

/**
 * The usage lines ("AIC: 902|Tokens: 1.2M") draw at the bottom of the screen,
 * as on the device, and go away again when the daemon clears them.
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

test('usage lines draw at the bottom and clear', { skip: ready ? false : 'needs the built engine and packs' }, async () => {
  const require = createRequire(import.meta.url);
  const engine = await require(enginePath)();
  const bytes = readFileSync(join(packs, 'copilot.acpk'));
  engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
  assert.equal(engine._ac_load_reserved(7), 1);
  const width = engine._ac_width();
  const height = engine._ac_height();
  const frame = () => {
    const pointer = engine._ac_frame(0, 0);
    return engine.HEAPU8.slice(pointer, pointer + width * height * 4);
  };
  const usage = text => {
    const pointer = engine.stringToNewUTF8(text);
    try { return engine._ac_usage(pointer); } finally { engine._free(pointer); }
  };

  const before = frame();
  assert.equal(usage('AIC: 1,234|Tokens: 1.2M'), 1);
  const shown = frame();
  const rows = new Set();
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] !== shown[i] || before[i + 1] !== shown[i + 1] || before[i + 2] !== shown[i + 2]) {
      rows.add(Math.floor(i / 4 / width));
    }
  }
  assert.ok(rows.size > 0, 'the usage text drew nothing');
  assert.ok(Math.min(...rows) > height * 0.8, `the usage text reached row ${Math.min(...rows)}`);

  assert.equal(usage(''), 1);
  assert.deepEqual(frame(), before);
  assert.equal(usage('a|b|c'), 0, 'three lines is one too many');
});

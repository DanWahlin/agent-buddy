/**
 * The tray icon is cut from the frame the window drew. With the device's case
 * shown, that frame is opaque, on the screen's black. The tray's cut-out must
 * give the same transparency the engine gives a keyed frame, so the icon has
 * no black square and keeps the dark parts inside the art.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cutOut } from '../../apps/desktop/src/webview/cutout.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = join(here, '..', 'prebuilt', 'engine.js');
const packs = join(here, '..', '..', '..', 'build', 'characters');
const ready = existsSync(enginePath) && existsSync(join(packs, 'copilot.acpk'));

for (const character of ['copilot', 'claude', 'openclaw']) {
  const skip = !ready || !existsSync(join(packs, `${character}.acpk`)) ? 'needs the built engine and packs' : false;
  test(`the tray cut-out of ${character} matches the engine's keyed frame`, { skip }, async () => {
    const require = createRequire(import.meta.url);
    const engine = await require(enginePath)();
    const bytes = readFileSync(join(packs, `${character}.acpk`));
    engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
    assert.equal(engine._ac_load_reserved(7), 1);
    const width = engine._ac_width();
    const height = engine._ac_height();
    const size = width * height * 4;
    // Idle frames: the character alone, as the tray shows it.
    for (let step = 0; step < 90; ++step) {
      let pointer = engine._ac_frame(1 / 30, 0);
      const opaque = engine.HEAPU8.slice(pointer, pointer + size);
      if (step % 15) continue;
      pointer = engine._ac_frame(0, 1);
      const keyed = engine.HEAPU8.subarray(pointer, pointer + size);
      const cut = cutOut(opaque, width, height);
      for (let at = 3; at < size; at += 4) {
        assert.equal(cut[at], keyed[at], `${character} frame ${step}: alpha differs at pixel ${(at - 3) / 4}`);
      }
      // The corners are clear, and the middle of the art is solid.
      assert.equal(cut[3], 0);
      assert.equal(cut[size - 1], 0);
      const middle = ((height >> 1) * width + (width >> 1)) * 4 + 3;
      assert.equal(cut[middle], 255);
    }
  });
}

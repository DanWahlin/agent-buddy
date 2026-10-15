/**
 * The committed engine was built from the sources as they are now.
 *
 * If this fails, an engine or firmware source changed since prebuilt/engine.js
 * was built: run `npm run build:engine` (needs Emscripten) and commit the result.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { engineSources, fingerprint } from '../fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the prebuilt engine matches its sources', () => {
  const recorded = readFileSync(join(here, '..', 'prebuilt', 'sources.sha256'), 'utf8').trim();
  assert.equal(recorded, fingerprint(),
    'The engine sources changed. Run `npm run build:engine` (needs Emscripten) and commit desktop/engine/prebuilt.');
});

test('the fingerprint follows what the engine includes, not every firmware file', () => {
  const files = engineSources().map(file => relative(join(here, '..', '..', '..'), file).replace(/\\/g, '/'));
  // Config.h includes the board selector, which includes the board's constants.
  for (const file of ['desktop/engine/engine.cpp', 'firmware/AgentCompanion/src/SpriteRenderer.cpp',
    'firmware/AgentCompanion/src/Config.h', 'firmware/AgentCompanion/src/boards/BoardConfig.h',
    'firmware/AgentCompanion/src/boards/waveshare_amoled_175/BoardConfig.h', 'tools/HostSpriteInflate.h',
    'desktop/engine/build.mjs', 'desktop/engine/fingerprint.mjs']) {
    assert.ok(files.includes(file), `${file} is not in the fingerprint`);
  }
  // Device-only code is not compiled into the engine.
  for (const file of ['firmware/AgentCompanion/src/NetworkManager.cpp', 'firmware/AgentCompanion/src/AudioPlayer.cpp',
    'firmware/AgentCompanion/src/UsbSerialWatchdog.h']) {
    assert.ok(!files.includes(file), `${file} should not be in the fingerprint`);
  }
});

/**
 * The committed engine was built from the sources as they are now.
 *
 * If this fails, an engine or firmware source changed since prebuilt/engine.js
 * was built: run `npm run build:engine` (needs Emscripten) and commit the result.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the prebuilt engine matches its sources', () => {
  const recorded = readFileSync(join(here, '..', 'prebuilt', 'sources.sha256'), 'utf8').trim();
  assert.equal(recorded, fingerprint(),
    'The engine sources changed. Run `npm run build:engine` (needs Emscripten) and commit desktop/engine/prebuilt.');
});

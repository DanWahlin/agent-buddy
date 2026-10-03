/**
 * What the prebuilt engine was compiled from, as one hash.
 *
 * The engine is committed (prebuilt/engine.js) so the desktop app builds
 * without Emscripten. This hash, written beside it at build time, lets a test
 * notice when any source has changed since: the wrapper, every firmware source
 * and header, the host inflate shim, and this build's own script and flags.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '..', '..');
const firmware = join(repository, 'firmware', 'AgentCompanion', 'src');

export function engineSources() {
  const firmwareFiles = readdirSync(firmware)
    .filter(name => name.endsWith('.h') || name.endsWith('.cpp'))
    .sort()
    .map(name => join(firmware, name));
  return [
    join(here, 'engine.cpp'),
    join(here, 'build.mjs'),
    join(here, 'fingerprint.mjs'),
    join(repository, 'tools', 'HostSpriteInflate.h'),
    ...firmwareFiles,
  ];
}

export function fingerprint() {
  const hash = createHash('sha256');
  for (const file of engineSources()) {
    // Line endings normalised, so a Windows checkout hashes the same.
    hash.update(relative(repository, file).replace(/\\/g, '/') + '\n');
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

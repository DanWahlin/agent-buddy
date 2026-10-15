/**
 * What the prebuilt engine was compiled from, as one hash.
 *
 * The engine is committed (prebuilt/engine.js) so the desktop app builds
 * without Emscripten. This hash, written beside it at build time, lets a test
 * notice when any input has changed since: the sources that build.mjs compiles,
 * every header they include (followed through `#include "..."`), and this
 * build's own scripts and flags. Firmware files that the engine does not use do
 * not count, so changing them needs no engine rebuild.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '..', '..');
const firmware = join(repository, 'firmware', 'AgentCompanion', 'src');

/** The translation units that build.mjs compiles. */
export const compiledSources = [
  join(here, 'engine.cpp'),
  ...['CharacterMotion', 'CharacterFrame', 'FullFrameRenderer', 'CharacterPack', 'AgentBadges', 'CharacterEffects',
    'SpriteMotion', 'SpriteRenderer', 'SpriteStorage'].map(name => join(firmware, name + '.cpp')),
];

/** The compiled sources and every file they include, then the build scripts. */
export function engineSources() {
  const files = new Set();
  const visit = file => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
      const target = resolve(dirname(file), name);
      if (!existsSync(target)) throw new Error(`${relative(repository, file)} includes a missing file: ${name}`);
      visit(target);
    }
  };
  compiledSources.forEach(visit);
  const name = file => relative(repository, file).replace(/\\/g, '/');
  return [...files].sort((a, b) => name(a).localeCompare(name(b)))
    .concat(join(here, 'build.mjs'), join(here, 'fingerprint.mjs'));
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

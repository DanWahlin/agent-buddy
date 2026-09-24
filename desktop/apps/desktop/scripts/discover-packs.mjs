/**
 * What packs are there, as JSON on stdout.
 *
 * The shell is Rust and the rules for finding a pack are already written in
 * `companion-core`, so this is a one-shot the shell runs rather than a rule
 * reimplemented in another language. Reading a directory is not the hard part;
 * agreeing on what counts as a pack is.
 *
 *   node discover-packs.mjs <bundled-dir> [extra-dir ...]
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverPacks } from '@agent-companion/companion-core';

const filesystem = {
  join: (folder, name) => join(folder, name),
  exists: async target => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  },
  readFile: target => readFile(target, 'utf8'),
  readDirectories: async folder =>
    (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name),
};

const [bundled, ...extra] = process.argv.slice(2);
const roots = [];
if (bundled) roots.push({ folder: resolve(bundled), origin: 'bundled' });
// Later roots win on id, so someone's own pack can shadow the shipped one.
for (const folder of extra) if (folder.trim()) {
  roots.push({ folder: resolve(folder.trim()), origin: 'configured' });
}

const { packs, problems } = await discoverPacks(filesystem, roots);

process.stdout.write(JSON.stringify({
  packs: packs.map(found => ({
    id: found.pack.id,
    name: found.pack.name,
    folder: found.folder,
    origin: found.origin,
  })),
  // Worth saying: a configured folder that holds nothing usable is a typo
  // somebody should hear about, not a silent absence.
  problems: problems.map(problem => ({ folder: problem.folder, reason: problem.reason })),
}) + '\n');

/**
 * Discovery against an in-memory filesystem.
 *
 * The folder handle here is a plain string, which is the point: the rules are
 * exercised without a `Uri`, a webview or a disk anywhere near them.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { choosePack, discoverPacks, type PackFileSystem } from '../src/index.js';

const files = new Map<string, string>();

/** Every path is a POSIX-looking string, joined the obvious way. */
const filesystem: PackFileSystem<string> = {
  join: (folder, name) => folder + '/' + name,
  async exists(target) { return files.has(target); },
  async readFile(target) {
    const found = files.get(target);
    if (found === undefined) throw new Error('ENOENT: ' + target);
    return found;
  },
  async readDirectories(folder) {
    const prefix = folder + '/';
    const names = new Set<string>();
    let any = false;
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      any = true;
      const rest = path.slice(prefix.length);
      // Only immediate children, and only ones that are directories.
      if (rest.includes('/')) names.add(rest.slice(0, rest.indexOf('/')));
    }
    if (!any) throw new Error('ENOENT: ' + folder);
    return [...names];
  },
};

function manifest(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 1,
    id,
    name: id[0].toUpperCase() + id.slice(1),
    frame: { width: 120, height: 112 },
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
      idle: 'gaze', surprise: 'surprise', working: 'working',
      complete: 'complete', attention: 'attention',
    },
    sleep: { track: 'right', step: 0, blinkLevel: 4 },
    ...extra,
  });
}

function addPack(folder: string, id: string) {
  files.set(folder + '/pack.json', manifest(id));
  files.set(folder + '/right.webp', 'binary');
}

const bundled = (folder: string) => [{ folder, origin: 'bundled' as const }];

beforeEach(() => files.clear());

test('a root that is itself a pack folder is used as one', async () => {
  addPack('/app/packs/arthur', 'arthur');
  const { packs, problems } = await discoverPacks(filesystem, bundled('/app/packs/arthur'));

  assert.equal(packs.length, 1);
  assert.equal(packs[0].pack.id, 'arthur');
  assert.equal(packs[0].folder, '/app/packs/arthur');
  assert.equal(packs[0].origin, 'bundled');
  assert.deepEqual(problems, []);
});

test('a root that is a folder of packs yields each of them', async () => {
  addPack('/app/packs/arthur', 'arthur');
  addPack('/app/packs/zaphod', 'zaphod');

  const { packs } = await discoverPacks(filesystem, bundled('/app/packs'));
  assert.deepEqual(packs.map(found => found.pack.id).sort(), ['arthur', 'zaphod']);
});

test('a later root shadows an earlier pack with the same id', async () => {
  addPack('/app/packs/arthur', 'arthur');
  addPack('/home/me/arthur', 'arthur');

  const { packs } = await discoverPacks(filesystem, [
    { folder: '/app/packs', origin: 'bundled' },
    { folder: '/home/me/arthur', origin: 'configured' },
  ]);

  assert.equal(packs.length, 1);
  assert.equal(packs[0].origin, 'configured');
  assert.equal(packs[0].folder, '/home/me/arthur');
});

test('an unreadable root is reported, and the other roots still load', async () => {
  addPack('/app/packs/arthur', 'arthur');

  const { packs, problems } = await discoverPacks(filesystem, [
    { folder: '/app/packs', origin: 'bundled' },
    { folder: '/nowhere', origin: 'configured' },
  ]);

  assert.deepEqual(packs.map(found => found.pack.id), ['arthur']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].folder, '/nowhere');
  assert.match(problems[0].reason, /could not be read/);
});

test('a folder holding nothing usable says so', async () => {
  files.set('/app/packs/notes.txt', 'hello');
  const { packs, problems } = await discoverPacks(filesystem, bundled('/app/packs'));

  assert.deepEqual(packs, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no pack\.json/);
});

test('unparseable JSON is reported with the reason, not thrown', async () => {
  files.set('/app/packs/broken/pack.json', '{ not json');
  const { packs, problems } = await discoverPacks(filesystem, bundled('/app/packs'));

  assert.deepEqual(packs, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /could not be read/);
});

test('a structurally invalid manifest is reported with the first error', async () => {
  files.set('/app/packs/wrong/pack.json', JSON.stringify({ format: 1, id: 'wrong' }));
  const { packs, problems } = await discoverPacks(filesystem, bundled('/app/packs'));

  assert.deepEqual(packs, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /not valid/);
});

test('choosePack honours the id asked for, and falls back rather than showing nothing', async () => {
  addPack('/app/packs/arthur', 'arthur');
  addPack('/app/packs/zaphod', 'zaphod');
  const { packs } = await discoverPacks(filesystem, bundled('/app/packs'));

  assert.equal(choosePack(packs, 'zaphod')?.pack.id, 'zaphod');
  assert.equal(choosePack(packs, 'nobody')?.pack.id, packs[0].pack.id);
  assert.equal(choosePack(packs, undefined)?.pack.id, packs[0].pack.id);
  assert.equal(choosePack([], 'arthur'), null);
});

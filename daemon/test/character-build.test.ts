import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CharacterPackBuilder} from '../src/character-build.js';

// Stands in for tools/character_pack.py; Node runs it as a CommonJS script.
const fakeBuild = `
const fs = require('fs'), path = require('path');
const root = process.cwd();
fs.appendFileSync(path.join(root, 'runs'), 'x');
if (fs.existsSync(path.join(root, 'fail'))) { process.stderr.write('bad pack'); process.exit(1); }
fs.mkdirSync(path.join(root, 'build', 'characters'), {recursive: true});
fs.writeFileSync(path.join(root, 'build', 'characters', 'demo.acpk'), 'pack');
`;

async function checkout(): Promise<{root: string; runs: () => Promise<number>; cleanup: () => Promise<void>}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-companion-build-'));
  await mkdir(join(root, 'tools'));
  await mkdir(join(root, 'characters', 'demo'), {recursive: true});
  await writeFile(join(root, 'tools', 'character_pack.py'), fakeBuild);
  await writeFile(join(root, 'characters', 'demo', 'character.json'), '{"id":"demo"}\n');
  return {
    root,
    runs: async () => (await readFile(join(root, 'runs'), 'utf8').catch(() => '')).length,
    cleanup: () => rm(root, {recursive: true, force: true}),
  };
}

test('character packs rebuild only when a character or a built pack changes', async () => {
  const {root, runs, cleanup} = await checkout();
  try {
    const builder = new CharacterPackBuilder({root, python: process.execPath});
    await builder.refresh();
    await builder.refresh();
    assert.equal(await runs(), 1);
    await writeFile(join(root, 'characters', 'demo', 'frames.json'), '{"frames":[]}\n');
    await builder.refresh();
    assert.equal(await runs(), 2);
    await mkdir(join(root, 'characters', 'added'));
    await writeFile(join(root, 'characters', 'added', 'character.json'), '{"id":"added"}\n');
    await builder.refresh();
    assert.equal(await runs(), 3);
    await rm(join(root, 'build', 'characters', 'demo.acpk'));
    await builder.refresh();
    assert.equal(await runs(), 4);
  } finally {
    await cleanup();
  }
});

test('concurrent refreshes share one build', async () => {
  const {root, runs, cleanup} = await checkout();
  try {
    const builder = new CharacterPackBuilder({root, python: process.execPath});
    await Promise.all([builder.refresh(), builder.refresh(), builder.refresh()]);
    assert.equal(await runs(), 1);
  } finally {
    await cleanup();
  }
});

test('a failed build is logged, keeps the existing packs, and retries next time', async () => {
  const {root, runs, cleanup} = await checkout();
  try {
    const messages: string[] = [];
    const builder = new CharacterPackBuilder({root, python: process.execPath, log: message => messages.push(message)});
    await writeFile(join(root, 'fail'), '');
    await builder.refresh();
    assert.match(messages[0] ?? '', /using the existing ones: bad pack/);
    await rm(join(root, 'fail'));
    await builder.refresh();
    assert.equal(await runs(), 2);
    assert.equal(messages.length, 1);
  } finally {
    await cleanup();
  }
});

test('refresh does nothing outside a source checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-companion-build-'));
  try {
    const messages: string[] = [];
    await new CharacterPackBuilder({root, python: process.execPath, log: message => messages.push(message)}).refresh();
    await new CharacterPackBuilder({root: undefined, log: message => messages.push(message)}).refresh();
    assert.deepEqual(messages, []);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

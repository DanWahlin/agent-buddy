import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {builtInPackFiles} from '../../apps/desktop/scripts/character-packs.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const ids = ['claude', 'copilot', 'openclaw'];
const files = ids.map(id => `${id}.acpk`);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-buddy-bundled-characters-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'build', 'characters'), {recursive: true});
  for (const id of ids) {
    await mkdir(join(root, 'characters', id), {recursive: true});
    await writeFile(join(root, 'characters', id, 'character.json'), JSON.stringify({id}));
    await writeFile(join(root, 'build', 'characters', `${id}.acpk`), id);
  }
  await writeFile(join(root, 'characters', 'built-in.json'), JSON.stringify(ids));
  return root;
}

test('the shipped built-in roster contains only Claude, Copilot and OpenClaw', async () => {
  assert.deepEqual(JSON.parse(await readFile(join(repository, 'characters', 'built-in.json'), 'utf8')), ids);
  assert.deepEqual(builtInPackFiles(repository), files);
});

test('desktop bundling excludes cached add-on packs', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'build', 'characters', 'custom.acpk'), 'add-on');
  assert.deepEqual(builtInPackFiles(root), files);
});

test('desktop bundling requires every built-in pack', async t => {
  const root = await fixture(t);
  await unlink(join(root, 'build', 'characters', 'claude.acpk'));
  assert.throws(() => builtInPackFiles(root), /Missing built-in character pack claude.acpk/);
});

test('desktop bundling rejects add-on sources in the built-in folder', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'characters', 'custom'));
  assert.throws(() => builtInPackFiles(root), /Built-in character sources must match/);
});

test('desktop bundling rejects malformed or duplicate roster ids', async t => {
  const root = await fixture(t);
  for (const value of [[], null, {}, ['../custom'], ['copilot', 'copilot'], [1]]) {
    await writeFile(join(root, 'characters', 'built-in.json'), JSON.stringify(value));
    assert.throws(() => builtInPackFiles(root), /built-in.json must list unique valid character ids/);
  }
});

test('desktop bundling rejects a manifest id that does not match its folder', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'characters', 'copilot', 'character.json'), '{"id":"custom"}');
  assert.throws(() => builtInPackFiles(root), /manifest id does not match its folder/);
});

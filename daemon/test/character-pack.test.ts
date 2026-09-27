import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  addCharacterPack,
  characterRequestValue,
  listCharacters,
  readCharacterThumbnail,
  removeCharacterPack,
  defaultCharacter,
  loadCharacterPreference,
  packNeedsFirmwareUpdate,
  parseCharacterPackHeader,
  readCharacterPack,
  resolveCharacterPack,
  saveCharacterPreference,
} from '../src/character-pack.js';

function pack(id = 'openclaw', name = 'OpenClaw', size = 512, thumbnail?: Buffer): Buffer {
  const data = Buffer.alloc(size);
  data.writeUInt32LE(size - 64, 140);
  if (thumbnail) {
    thumbnail.copy(data, 300);
    data.writeUInt32LE(300, 148);
    data.writeUInt32LE(thumbnail.length, 152);
  }
  data.write('ACPK', 0, 'ascii');
  data.writeUInt16LE(1, 4);
  data.writeUInt16LE(256, 6);
  data.writeUInt32LE(size, 8);
  data.write(id, 16, 'ascii');
  data.write(name, 32, 'ascii');
  return data;
}

test('reads the id and display name from a pack header', () => {
  assert.deepEqual(parseCharacterPackHeader(pack()),
                   {id: 'openclaw', name: 'OpenClaw', thumbnail: null, maxPatchPixels: 0});
  assert.throws(() => parseCharacterPackHeader(Buffer.from('not a pack')), /version 1 character pack/);
  const truncated = pack();
  truncated.writeUInt32LE(1024, 8);
  assert.throws(() => parseCharacterPackHeader(truncated), /size does not match/);
  assert.throws(() => parseCharacterPackHeader(pack('Bad')), /id or name/);
});

test('large blink patches need firmware that keeps internal RAM free for Wi-Fi', () => {
  const basePatch = (pixels: number) => {
    const data = pack('claude', 'Claude');
    data.writeUInt8(1, 12);
    data.writeUInt32LE(pixels, 68);
    return parseCharacterPackHeader(data);
  };
  const fullFrame = pack();
  fullFrame.writeUInt8(2, 12);
  fullFrame.writeUInt32LE(99_999, 68);
  assert.equal(basePatch(14_100).maxPatchPixels, 14_100);
  assert.equal(parseCharacterPackHeader(fullFrame).maxPatchPixels, 0);
  assert.equal(packNeedsFirmwareUpdate(basePatch(14_100), false), true);
  assert.equal(packNeedsFirmwareUpdate(basePatch(14_100), true), false);
  assert.equal(packNeedsFirmwareUpdate(basePatch(7_452), false), false);
  assert.equal(packNeedsFirmwareUpdate(parseCharacterPackHeader(fullFrame), false), false);
});

test('names select built-in packs and other values are absolute paths', () => {
  assert.equal(resolveCharacterPack('openclaw', '/packs'), '/packs/openclaw.acpk');
  assert.equal(resolveCharacterPack('/tmp/custom.acpk', '/packs'), '/tmp/custom.acpk');
  assert.throws(() => resolveCharacterPack('custom.acpk', '/packs'), /absolute/);
  assert.equal(resolveCharacterPack('OpenClaw', '/packs'), '/packs/openclaw.acpk');
  assert.equal(characterRequestValue('copilot', '/work'), 'copilot');
  assert.equal(characterRequestValue('Copilot', '/work'), 'copilot');
  assert.equal(characterRequestValue('Unknown Name', '/work'), 'unknown name');
  assert.equal(characterRequestValue('packs/custom.acpk', '/work'), '/work/packs/custom.acpk');
});

test('loads packs from disk with a build hint for missing built-ins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-pack-'));
  const previous = process.env.AGENT_COMPANION_CHARACTERS;
  const previousUser = process.env.AGENT_COMPANION_USER_CHARACTERS;
  process.env.AGENT_COMPANION_CHARACTERS = directory;
  process.env.AGENT_COMPANION_USER_CHARACTERS = join(directory, 'added');
  try {
    await writeFile(join(directory, 'openclaw.acpk'), pack());
    const loaded = await readCharacterPack('openclaw');
    assert.equal(loaded.name, 'OpenClaw');
    assert.equal(loaded.data.length, 512);
    await assert.rejects(readCharacterPack('copilot'), /Unknown character "copilot". Available: openclaw/);
    assert.equal((await readCharacterPack('OPENCLAW')).id, 'openclaw');
    await assert.rejects(readCharacterPack('Unknown Name'), /Unknown character/);
    await assert.rejects(readCharacterPack(join(directory, 'missing.acpk')), /not found/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_CHARACTERS;
    else process.env.AGENT_COMPANION_CHARACTERS = previous;
    if (previousUser === undefined) delete process.env.AGENT_COMPANION_USER_CHARACTERS;
    else process.env.AGENT_COMPANION_USER_CHARACTERS = previousUser;
  }
});

test('adds, lists, and removes packs uploaded from the settings page', async () => {
  const builtIn = await mkdtemp(join(tmpdir(), 'agent-companion-builtin-'));
  const added = join(builtIn, 'added');
  const previous = [process.env.AGENT_COMPANION_CHARACTERS, process.env.AGENT_COMPANION_USER_CHARACTERS];
  process.env.AGENT_COMPANION_CHARACTERS = builtIn;
  process.env.AGENT_COMPANION_USER_CHARACTERS = added;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  try {
    await writeFile(join(builtIn, 'copilot.acpk'), pack('copilot', 'Copilot', 512, png));
    await assert.rejects(addCharacterPack(pack('copilot', 'Impostor'), builtIn, added), /built-in/);
    await assert.rejects(addCharacterPack(Buffer.from('nope'), builtIn, added), /version 1/);
    const entry = await addCharacterPack(pack('robot', 'Robot'), builtIn, added);
    assert.deepEqual(entry, {id: 'robot', name: 'Robot', builtIn: false, bytes: 512, thumbnail: false});
    assert.deepEqual((await listCharacters(builtIn, added)).map(item => [item.id, item.builtIn, item.thumbnail]),
      [['copilot', true, true], ['robot', false, false]]);
    assert.equal((await readCharacterPack('robot')).name, 'Robot');
    assert.deepEqual(await readCharacterThumbnail('copilot'), png);
    assert.equal(await readCharacterThumbnail('robot'), null);
    await assert.rejects(removeCharacterPack('copilot', added), /Only characters you added/);
    await removeCharacterPack('robot', added);
    assert.deepEqual((await listCharacters(builtIn, added)).map(item => item.id), ['copilot']);
  } finally {
    const [characters, user] = previous;
    if (characters === undefined) delete process.env.AGENT_COMPANION_CHARACTERS;
    else process.env.AGENT_COMPANION_CHARACTERS = characters;
    if (user === undefined) delete process.env.AGENT_COMPANION_USER_CHARACTERS;
    else process.env.AGENT_COMPANION_USER_CHARACTERS = user;
  }
});

test('remembers the chosen character privately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-choice-'));
  const previous = process.env.AGENT_COMPANION_CHARACTER_CONFIG;
  process.env.AGENT_COMPANION_CHARACTER_CONFIG = join(directory, 'character.json');
  try {
    assert.equal(await loadCharacterPreference(), defaultCharacter);
    await saveCharacterPreference('openclaw');
    assert.equal(await loadCharacterPreference(), 'openclaw');
    await writeFile(join(directory, 'character.json'), '{"character":"relative/path"}');
    assert.equal(await loadCharacterPreference(), defaultCharacter);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_CHARACTER_CONFIG;
    else process.env.AGENT_COMPANION_CHARACTER_CONFIG = previous;
  }
});

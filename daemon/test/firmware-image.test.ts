import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {builtFirmwareReader, parseFirmwareImage} from '../src/firmware-image.js';

function image(sha: number): Buffer {
  const data = Buffer.alloc(4096);
  data[0] = 0xe9;
  data.writeUInt32LE(0xabcd5432, 32);
  data.fill(sha, 176, 208);
  return data;
}

test('reads the firmware ID the device reports, from the app description', () => {
  const data = image(0x3a);
  const parsed = parseFirmwareImage(data);
  assert.equal(parsed.id, '3a3a3a3a3a3a3a3a');
  assert.equal(parsed.md5, createHash('md5').update(data).digest('hex'));
  const notApp = image(1);
  notApp.writeUInt32LE(0, 32);
  assert.throws(() => parseFirmwareImage(notApp), /not ESP32 app firmware/);
  assert.throws(() => parseFirmwareImage(Buffer.alloc(10)), /not ESP32 app firmware/);
  const large = Buffer.concat([image(1), Buffer.alloc(0x200000)]);
  assert.throws(() => parseFirmwareImage(large), /too large/);
});

test('the reader follows the built file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'firmware-'));
  try {
    const path = join(dir, 'app.bin');
    const read = builtFirmwareReader(path);
    assert.equal(read(), null);
    await writeFile(path, image(0x11));
    assert.equal(read()?.id, '1111111111111111');
    await writeFile(path, image(0x22));
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    assert.equal(read()?.id, '2222222222222222');
    await rm(path);
    assert.equal(read(), null);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('the built firmware, when there is one, has a valid ID', () => {
  const built = builtFirmwareReader()();
  if (built) assert.match(built.id, /^[0-9a-f]{16}$/);
});

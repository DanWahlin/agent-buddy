import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deflateRawSync} from 'node:zlib';
import {FirmwareReleases, firmwareAssetName, unzip} from '../src/firmware-release.js';
import {runUsbFlasher, usbFlashArguments} from '../src/usb-flasher.js';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function appImage(): Buffer {
  const data = Buffer.alloc(4096);
  data[0] = 0xe9;
  data.writeUInt32LE(0xabcd5432, 32);
  data.fill(0x5c, 176, 208);
  return data;
}

// A zip with the given entries; `deflate` names the ones to compress.
function zip(entries: Record<string, Buffer>, deflate = new Set<string>()): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const packed = deflate.has(name) ? deflateRawSync(data) : data;
    const method = deflate.has(name) ? 8 : 0;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function release(version: string, change: (manifest: Record<string, unknown>) => void = () => undefined) {
  const images: [string, number, number, Buffer][] = [
    ['bin/bootloader.bin', 0, 0x8000, Buffer.alloc(100, 1)],
    ['bin/partitions.bin', 0x8000, 0x1000, Buffer.alloc(100, 2)],
    ['bin/boot_app0.bin', 0xe000, 0x2000, Buffer.alloc(100, 3)],
    ['bin/application.bin', 0x10000, 0x200000, appImage()],
    ['bin/character-copilot.acpk', 0x210000, 0x100000, Buffer.alloc(300, 5)],
  ];
  const manifest: Record<string, unknown> = {
    schema_version: 1, name: 'esp32-agent-companion', version, chip: 'esp32s3', flash_size: '16MB',
    asset_sha256: sha256(images[4]![3]),
    images: images.map(([file, offset, max_size, data]) =>
      ({file, offset, max_size, size: data.length, sha256: sha256(data)})),
  };
  change(manifest);
  const files: Record<string, Buffer> = {'manifest.json': Buffer.from(JSON.stringify(manifest))};
  for (const [file, , , data] of images) files[file] = data;
  files['flash.py'] = Buffer.from('print()');
  files.SHA256SUMS = Buffer.from(Object.entries(files).map(([name, data]) => `${sha256(data)}  ${name}\n`).join(''));
  const archive = zip(files, new Set(['bin/application.bin']));
  return {archive, sums: `${sha256(archive)}  ${firmwareAssetName(version)}\n`};
}

function fakeGitHub(assets: Record<string, Buffer | string>, requests: string[] = []) {
  return async (url: string) => {
    requests.push(url);
    const path = url.replace('https://example.test/releases/', '');
    const body = assets[path];
    return body === undefined ? new Response('missing', {status: 404})
      : new Response(typeof body === 'string' ? body : new Uint8Array(body),
                     {headers: {'content-length': String(Buffer.byteLength(body))}});
  };
}

test('downloads a release firmware, checks it, and keeps it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-'));
  try {
    const {archive, sums} = release('1.2.3');
    const requests: string[] = [];
    const releases = new FirmwareReleases({
      directory, baseUrl: 'https://example.test/releases/',
      fetch: fakeGitHub({'v1.2.3/SHA256SUMS': sums, [`v1.2.3/${firmwareAssetName('1.2.3')}`]: archive}, requests),
    });
    assert.equal(await releases.saved('1.2.3'), null);
    const seen: number[] = [];
    const firmware = await releases.prepare('1.2.3', received => seen.push(received));
    assert.equal(firmware.id, '5c5c5c5c5c5c5c5c');
    assert.equal(firmware.dir, join(directory, 'v1.2.3'));
    assert.deepEqual(await readFile(join(firmware.dir, 'bin', 'application.bin')), appImage());
    assert.equal(seen.at(-1), archive.length);
    assert.equal(requests.length, 2);
    // A second install uses the saved copy.
    assert.equal((await releases.prepare('1.2.3')).id, firmware.id);
    assert.equal((await releases.saved('1.2.3'))?.id, firmware.id);
    assert.equal(requests.length, 2);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses a damaged or unsafe release firmware', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-'));
  const asset = `v1.2.3/${firmwareAssetName('1.2.3')}`;
  const attempt = (assets: Record<string, Buffer | string>) =>
    new FirmwareReleases({directory, baseUrl: 'https://example.test/releases', fetch: fakeGitHub(assets)}).prepare('1.2.3');
  try {
    const good = release('1.2.3');
    await assert.rejects(attempt({}), /does not exist/);
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': good.sums, [asset]: Buffer.concat([good.archive, Buffer.from('x')])}),
                         /SHA256 mismatch/);
    const unsafe = release('1.2.3', manifest => {
      (manifest.images as Record<string, unknown>[])[3]!.offset = 0x20000;
    });
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': unsafe.sums, [asset]: unsafe.archive}), /Unsafe offset/);
    const other = release('1.2.4');
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': `${createHash('sha256').update(other.archive).digest('hex')}  ${
      firmwareAssetName('1.2.3')}\n`, [asset]: other.archive}), /not esp32-agent-companion v1.2.3/);
    await assert.rejects(new FirmwareReleases({directory}).prepare('../1'), /Unsupported release version/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('reads stored and deflated zip entries, and only the ones asked for', () => {
  const archive = zip({'a.txt': Buffer.from('stored'), 'b.txt': Buffer.from('deflated'.repeat(20)), '../c': Buffer.from('x')},
                      new Set(['b.txt']));
  const files = unzip(archive, new Set(['a.txt', 'b.txt']));
  assert.equal(files.get('a.txt')?.toString(), 'stored');
  assert.equal(files.get('b.txt')?.toString(), 'deflated'.repeat(20));
  assert.equal(files.size, 2);
  assert.throws(() => unzip(Buffer.from('not a zip'), new Set()), /not a zip/);
});

test('runs the desktop app to write firmware and follows its progress', async () => {
  assert.deepEqual(usbFlashArguments('/fw', {path: '/dev/cu.usbmodem1', pid: 0x1001}),
                   ['--flash-firmware', '/fw', '--port', '/dev/cu.usbmodem1', '--pid', '1001']);
  assert.deepEqual(usbFlashArguments('/fw', {path: 'COM3', pid: null}), ['--flash-firmware', '/fw', '--port', 'COM3']);
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'flasher-'));
  const script = async (name: string, body: string) => {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  try {
    const events: string[] = [];
    const record = {stage: (stage: string) => events.push(stage), progress: (percent: number) => events.push(String(percent))};
    const port = {path: '/dev/test', pid: 0x1001};
    const good = await script('good', 'test "$1 $3 $5" = "--flash-firmware --port --pid" || exit 9\n'
      + 'echo "stage checking"; echo "stage connecting"; echo "stage writing"; printf "progress 40\\nprogress 100\\n"; echo done');
    await runUsbFlasher(good, '/fw', port, record);
    assert.deepEqual(events, ['checking', 'connecting', 'writing', '40', '100']);
    await assert.rejects(runUsbFlasher(await script('bad', 'echo "error No ESP32-S3 found"; exit 1'), '/fw', port, record),
                         /No ESP32-S3 found/);
    // A program that does not know --flash-firmware exits without a result.
    await assert.rejects(runUsbFlasher(await script('old', 'exit 0'), '/fw', port, record), /Update the desktop app/);
    await assert.rejects(runUsbFlasher(join(directory, 'missing'), '/fw', port, record), /Couldn't start/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

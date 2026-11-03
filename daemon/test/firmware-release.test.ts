import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {deflateRawSync} from 'node:zlib';
import {FirmwareReleases, chooseFirmwareBoard, firmwareAssetName, firmwareBoards, releaseFirmwareId, releaseFirmwareInfo,
  unzip} from '../src/firmware-release.js';
import {explainFlashError, runUsbFlasher, usbFlashArguments} from '../src/usb-flasher.js';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function appImage(marker = 0x5c): Buffer {
  const data = Buffer.alloc(4096);
  data[0] = 0xe9;
  data.writeUInt32LE(0xabcd5432, 32);
  data.fill(marker, 176, 208);
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

function release(version: string, change: (manifest: Record<string, unknown>) => void = () => undefined,
                 board = 'waveshare-amoled-175', marker = 0x5c) {
  const images: [string, number, number, Buffer][] = [
    ['bin/bootloader.bin', 0, 0x8000, Buffer.alloc(100, 1)],
    ['bin/partitions.bin', 0x8000, 0x1000, Buffer.alloc(100, 2)],
    ['bin/boot_app0.bin', 0xe000, 0x2000, Buffer.alloc(100, 3)],
    ['bin/application.bin', 0x10000, 0x200000, appImage(marker)],
    ['bin/character-copilot.acpk', 0x210000, 0x100000, Buffer.alloc(300, 5)],
  ];
  const manifest: Record<string, unknown> = {
    schema_version: 1, name: 'agent-buddy', version, board, chip: 'esp32s3',
    flash_size: '16MB',
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
  return {archive, sums: `${sha256(archive)}  ${firmwareAssetName(version, board)}\n`};
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
      fetch: fakeGitHub({'v1.2.3/SHA256SUMS': sums, [`v1.2.3/${firmwareAssetName('1.2.3', 'waveshare-amoled-175')}`]: archive}, requests),
    });
    assert.equal(await releases.saved('1.2.3', 'waveshare-amoled-175'), null);
    const seen: number[] = [];
    const firmware = await releases.prepare('1.2.3', received => seen.push(received), 'waveshare-amoled-175');
    assert.equal(firmware.id, '5c5c5c5c5c5c5c5c');
    assert.equal(firmware.dir, join(directory, 'v1.2.3'));
    assert.deepEqual(await readFile(join(firmware.dir, 'bin', 'application.bin')), appImage());
    assert.equal(seen.at(-1), archive.length);
    assert.equal(requests.length, 2);
    // A second install uses the saved copy.
    assert.equal((await releases.prepare('1.2.3', undefined, 'waveshare-amoled-175')).id, firmware.id);
    assert.equal((await releases.saved('1.2.3', 'waveshare-amoled-175'))?.id, firmware.id);
    assert.equal(requests.length, 2);
    // The desktop build reads the same ID from the ZIP.
    assert.equal(releaseFirmwareId(archive, '1.2.3', 'waveshare-amoled-175'), firmware.id);
    assert.throws(() => releaseFirmwareId(archive, '1.2.4', 'waveshare-amoled-175'), /not agent-buddy v1.2.4/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses a damaged or unsafe release firmware', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-'));
  const asset = `v1.2.3/${firmwareAssetName('1.2.3', 'waveshare-amoled-175')}`;
  const attempt = (assets: Record<string, Buffer | string>) =>
    new FirmwareReleases({directory, baseUrl: 'https://example.test/releases', fetch: fakeGitHub(assets)})
      .prepare('1.2.3', undefined, 'waveshare-amoled-175');
  try {
    const good = release('1.2.3');
    await assert.rejects(attempt({}), /does not exist/);
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': good.sums, [asset]: Buffer.concat([good.archive, Buffer.from('x')])}),
                         /SHA256 mismatch/);
    const unsafe = release('1.2.3', manifest => {
      (manifest.images as Record<string, unknown>[])[3]!.offset = 0x20000;
    });
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': unsafe.sums, [asset]: unsafe.archive}), /Unsafe offset/);
    const unknownBoard = release('1.2.3', manifest => { manifest.board = 'other-board'; });
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': unknownBoard.sums, [asset]: unknownBoard.archive}),
                         /unsupported board: other-board/);
    // The default board's asset holding another board's firmware is refused.
    const swapped = release('1.2.3', manifest => { manifest.board = 'waveshare-lcd-154'; });
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': swapped.sums, [asset]: swapped.archive}),
                         /for board waveshare-lcd-154, not waveshare-amoled-175/);
    // A bundle that does not name its board is refused, not taken for the default board.
    const unnamed = release('1.2.3', manifest => { delete manifest.board; });
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': unnamed.sums, [asset]: unnamed.archive}),
                         /does not say which board/);
    const other = release('1.2.4');
    await assert.rejects(attempt({'v1.2.3/SHA256SUMS': `${createHash('sha256').update(other.archive).digest('hex')}  ${
      firmwareAssetName('1.2.3', 'waveshare-amoled-175')}\n`, [asset]: other.archive}), /not agent-buddy v1.2.3/);
    await assert.rejects(new FirmwareReleases({directory}).prepare('../1', undefined, 'waveshare-amoled-175'), /Unsupported release version/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('downloads and keeps the release firmware of each board apart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-'));
  try {
    const amoled = release('1.2.3');
    const lcd = release('1.2.3', () => undefined, 'waveshare-lcd-154', 0x6d);
    const lcdAsset = firmwareAssetName('1.2.3', 'waveshare-lcd-154');
    assert.equal(lcdAsset, 'agent-buddy-v1.2.3-waveshare-lcd-154-firmware.zip');
    assert.equal(firmwareAssetName('1.2.3', 'waveshare-amoled-175'), 'agent-buddy-v1.2.3-firmware.zip');
    const sums = amoled.sums + lcd.sums;
    const releases = new FirmwareReleases({directory, baseUrl: 'https://example.test/releases', fetch: fakeGitHub({
      'v1.2.3/SHA256SUMS': sums, [`v1.2.3/${firmwareAssetName('1.2.3', 'waveshare-amoled-175')}`]: amoled.archive,
      [`v1.2.3/${lcdAsset}`]: lcd.archive})});
    const one = await releases.prepare('1.2.3', undefined, 'waveshare-lcd-154');
    assert.deepEqual([one.board, one.id, one.dir], ['waveshare-lcd-154', '6d6d6d6d6d6d6d6d', join(directory, 'v1.2.3-waveshare-lcd-154')]);
    assert.equal(await releases.saved('1.2.3', 'waveshare-amoled-175'), null);
    const other = await releases.prepare('1.2.3', undefined, 'waveshare-amoled-175');
    assert.deepEqual([other.board, other.id], ['waveshare-amoled-175', '5c5c5c5c5c5c5c5c']);
    assert.equal((await releases.saved('1.2.3', 'waveshare-lcd-154'))?.id, one.id);
    assert.equal(await releases.saved('1.2.3', 'other-board'), null);
    await assert.rejects(releases.prepare('1.2.3', undefined, 'other-board'), /no firmware for board other-board/);
    // A saved folder that holds another board's firmware is not used.
    await rm(one.dir, {recursive: true});
    const {cp} = await import('node:fs/promises');
    await cp(other.dir, one.dir, {recursive: true});
    assert.equal(await releases.saved('1.2.3', 'waveshare-lcd-154'), null);
    assert.equal((await releases.prepare('1.2.3', undefined, 'waveshare-lcd-154')).id, one.id);
    // The LCD asset holding the default board's firmware is refused.
    const wrong = new FirmwareReleases({directory: join(directory, 'wrong'), baseUrl: 'https://example.test/releases',
      fetch: fakeGitHub({'v1.2.3/SHA256SUMS': `${sha256(amoled.archive)}  ${lcdAsset}\n`, [`v1.2.3/${lcdAsset}`]: amoled.archive})});
    await assert.rejects(wrong.prepare('1.2.3', undefined, 'waveshare-lcd-154'), /for board waveshare-amoled-175, not waveshare-lcd-154/);
    // The desktop build reads each ZIP's board and ID.
    assert.deepEqual(releaseFirmwareInfo(lcd.archive, '1.2.3'), {board: 'waveshare-lcd-154', id: one.id});
    assert.deepEqual(releaseFirmwareInfo(amoled.archive, '1.2.3'), {board: 'waveshare-amoled-175', id: other.id});
    assert.throws(() => releaseFirmwareId(lcd.archive, '1.2.3', 'waveshare-amoled-175'), /not waveshare-amoled-175/);
    // A ZIP that does not name its board is refused: nothing takes it for the default board.
    const legacy = release('1.2.3', manifest => { delete manifest.board; });
    assert.throws(() => releaseFirmwareInfo(legacy.archive, '1.2.3'), /does not say which board/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('the boards with release firmware are the boards in firmware/boards.json', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const boards = JSON.parse(await readFile(join(root, 'firmware', 'boards.json'), 'utf8')) as
    {default: string; boards: Record<string, {name: string; models: string}>};
  assert.deepEqual(firmwareBoards, Object.entries(boards.boards).map(([id, {name, models}]) => ({id, name, models})));
  assert.equal(firmwareBoards[0]!.id, boards.default);
});

test('a USB device that answers decides its board, and one that does not needs a choice', () => {
  assert.equal(chooseFirmwareBoard('waveshare-lcd-154', null), 'waveshare-lcd-154');
  assert.equal(chooseFirmwareBoard('waveshare-lcd-154', 'waveshare-lcd-154'), 'waveshare-lcd-154');
  assert.throws(() => chooseFirmwareBoard('waveshare-lcd-154', 'waveshare-amoled-175'),
                /reports that it is a Waveshare ESP32-S3-Touch-LCD-1.54, not a Waveshare ESP32-S3-Touch-AMOLED-1.75/);
  assert.throws(() => chooseFirmwareBoard('custom-board', null), /no firmware for it.*BOARD=custom-board/);
  assert.throws(() => chooseFirmwareBoard(null, null), /Choose its board/);
  assert.throws(() => chooseFirmwareBoard(null, 'other-board'), /Unknown board/);
  assert.equal(chooseFirmwareBoard(null, 'waveshare-lcd-154'), 'waveshare-lcd-154');
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
  assert.deepEqual(usbFlashArguments('/fw', {path: '/dev/cu.usbmodem1', pid: 0x1001}, 'waveshare-lcd-154'),
                   ['--flash-firmware', '/fw', '--port', '/dev/cu.usbmodem1', '--board', 'waveshare-lcd-154', '--pid', '1001']);
  assert.deepEqual(usbFlashArguments('/fw', {path: 'COM3', pid: null}, 'waveshare-amoled-175'),
                   ['--flash-firmware', '/fw', '--port', 'COM3', '--board', 'waveshare-amoled-175']);
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
    const good = await script('good', 'test "$1 $3 $5 $6 $7" = "--flash-firmware --port --board waveshare-lcd-154 --pid" || exit 9\n'
      + 'echo "stage checking"; echo "stage connecting"; echo "stage writing"; printf "progress 40\\nprogress 100\\n"; echo done');
    await runUsbFlasher(good, '/fw', port, record, 'waveshare-lcd-154');
    assert.deepEqual(events, ['checking', 'connecting', 'writing', '40', '100']);
    // A write that failed once and then worked is logged, so the first error is not lost.
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => { logged.push(line); };
    try {
      await runUsbFlasher(await script('retried', 'echo "log write failed (Timeout); trying again"; echo done'),
                          '/fw', port, record, 'waveshare-amoled-175');
    } finally {
      console.log = log;
    }
    assert.deepEqual(logged, ['[firmware] write failed (Timeout); trying again']);
    await assert.rejects(runUsbFlasher(await script('bad', 'echo "error No ESP32-S3 found"; exit 1'), '/fw', port, record, 'waveshare-amoled-175'),
                         /No ESP32-S3 found/);
    // A device that does not go into download mode by itself gets the BOOT steps.
    await assert.rejects(runUsbFlasher(await script('stuck',
      'echo "error Couldn\'t connect to the ESP32-S3: Error while connecting to device"; exit 1'), '/fw', port, record, 'waveshare-amoled-175'),
      /Error while connecting to device\. The device did not go into download mode by itself\. .*hold the BOOT button/);
    // A program that does not know --flash-firmware exits without a result.
    await assert.rejects(runUsbFlasher(await script('old', 'exit 0'), '/fw', port, record, 'waveshare-amoled-175'),
                         /Update the desktop app/);
    await assert.rejects(runUsbFlasher(join(directory, 'missing'), '/fw', port, record, 'waveshare-amoled-175'),
                         /Couldn't start/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('flasher errors that the user can fix say what to do', () => {
  assert.match(explainFlashError("Couldn't open /dev/cu.usbmodem1: Resource busy"),
               /^Couldn't open \/dev\/cu\.usbmodem1: Resource busy\. Close any other program .*hold the BOOT button/);
  assert.match(explainFlashError("Couldn't connect to the ESP32-S3: Timeout"), /release BOOT after 2 seconds/);
  assert.match(explainFlashError("Couldn't write the firmware (tried 2 times): Timeout"),
               /^Couldn't write the firmware \(tried 2 times\): Timeout\. Only part of the firmware .*Install again.*hold the BOOT button/);
  assert.equal(explainFlashError("Couldn't read manifest.json: missing"), "Couldn't read manifest.json: missing");
});

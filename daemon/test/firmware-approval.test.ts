import assert from 'node:assert/strict';
import test from 'node:test';
import {
  needsFirmwareApproval, waitForFirmwareApproval, type FirmwareApproval,
} from '../src/wifi-transport.js';
import {assertReleaseBoard, deviceBoard, parseBoardLine} from '../src/firmware-release.js';

function reads(...values: Array<FirmwareApproval | null | Error>): () => Promise<FirmwareApproval | null> {
  return async () => {
    const value = values.length > 1 ? values.shift()! : values[0]!;
    if (value instanceof Error) throw value;
    return value;
  };
}

test('only protocol 11 and later firmware asks for a BOOT press', () => {
  assert.equal(needsFirmwareApproval(10), false);
  assert.equal(needsFirmwareApproval(11), true);
});

test('the wait ends when the device reports the press', async () => {
  await waitForFirmwareApproval(reads('waiting', null, new Error('timeout'), 'waiting', 'allowed'), 1000, 1);
});

test('the wait fails when the device stops waiting', async () => {
  await assert.rejects(waitForFirmwareApproval(reads('waiting', 'none'), 1000, 1), /Nobody pressed the BOOT button/);
});

test('the wait fails after the timeout', async () => {
  await assert.rejects(waitForFirmwareApproval(reads('waiting'), 20, 5), /Nobody pressed the BOOT button/);
});

test('release firmware goes only to the release board', () => {
  assert.equal(deviceBoard(undefined), 'waveshare-amoled-175');
  assert.equal(deviceBoard('../bad'), 'waveshare-amoled-175');
  assert.equal(deviceBoard('other-board'), 'other-board');
  assertReleaseBoard(deviceBoard(undefined));
  assert.throws(() => assertReleaseBoard('other-board'), /BOARD=other-board/);
});

test('the USB i reply names the board on its own line', () => {
  assert.equal(parseBoardLine('BOARD id=waveshare-lcd-154 variant=standard'), 'waveshare-lcd-154');
  assert.equal(parseBoardLine('BOARD id=waveshare-amoled-175'), 'waveshare-amoled-175');
  for (const line of ['INFO protocol=12 board_variant=standard', 'BOARD id=../bad variant=c', 'BOARD id= variant=c',
                      'BUTTON settings presses=1', 'XBOARD id=a'])
    assert.equal(parseBoardLine(line), null, line);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {needsFirmwareApproval, waitForFirmwareApproval, type FirmwareApproval} from '../src/wifi-transport.js';

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

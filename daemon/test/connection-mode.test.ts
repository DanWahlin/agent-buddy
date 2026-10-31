import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {isConnectionMode, isUsbDeviceChoice, loadConnectionMode, loadUsbDeviceChoice, saveConnectionMode,
  saveUsbDeviceChoice} from '../src/connection-mode.js';

test('persists the connection mode and defaults to auto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-connection-'));
  const previous = process.env.AGENT_COMPANION_CONNECTION_CONFIG;
  process.env.AGENT_COMPANION_CONNECTION_CONFIG = join(directory, 'connection.json');
  try {
    assert.equal(await loadConnectionMode(), 'auto');
    await saveConnectionMode('wifi');
    assert.equal(await loadConnectionMode(), 'wifi');
    await writeFile(join(directory, 'connection.json'), '{"mode":"bluetooth"}');
    assert.equal(await loadConnectionMode(), 'auto');
    assert.equal(isConnectionMode('usb'), true);
    assert.equal(isConnectionMode('WIFI'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_CONNECTION_CONFIG;
    else process.env.AGENT_COMPANION_CONNECTION_CONFIG = previous;
  }
});

test('keeps the chosen USB device beside the connection mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-connection-'));
  const previous = process.env.AGENT_COMPANION_CONNECTION_CONFIG;
  process.env.AGENT_COMPANION_CONNECTION_CONFIG = join(directory, 'connection.json');
  try {
    assert.equal(await loadUsbDeviceChoice(), null);
    await saveConnectionMode('usb');
    await saveUsbDeviceChoice({serialNumber: 'B8:1F:3F:D8:37:98', path: '/dev/cu.usbmodem2101'});
    assert.deepEqual(await loadUsbDeviceChoice(), {serialNumber: 'B8:1F:3F:D8:37:98', path: '/dev/cu.usbmodem2101'});
    assert.equal(await loadConnectionMode(), 'usb');
    // Saving the mode keeps the device, and the other way around.
    await saveConnectionMode('wifi');
    assert.deepEqual(await loadUsbDeviceChoice(), {serialNumber: 'B8:1F:3F:D8:37:98', path: '/dev/cu.usbmodem2101'});
    await saveUsbDeviceChoice({serialNumber: null, path: 'COM3'});
    assert.deepEqual(await loadUsbDeviceChoice(), {serialNumber: null, path: 'COM3'});
    assert.equal(await loadConnectionMode(), 'wifi');
    await writeFile(join(directory, 'connection.json'), '{"mode":"usb","usbDevice":{"serialNumber":7,"path":""}}');
    assert.equal(await loadUsbDeviceChoice(), null);
    assert.equal(await loadConnectionMode(), 'usb');
    assert.equal(isUsbDeviceChoice({serialNumber: null, path: 'COM3'}), true);
    assert.equal(isUsbDeviceChoice({serialNumber: '', path: 'COM3'}), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_CONNECTION_CONFIG;
    else process.env.AGENT_COMPANION_CONNECTION_CONFIG = previous;
  }
});

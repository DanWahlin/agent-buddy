import assert from 'node:assert/strict';
import test from 'node:test';
import {isLikelyEsp32Port, parseButtonLine, parseUploadReady, pickPort} from '../src/usb-transport.js';
import {buttonPressed, parseUploadResponse} from '../src/wifi-transport.js';
import {browserCommands} from '../src/browser.js';

test('recognizes macOS and Linux USB serial device paths', () => {
  assert.equal(isLikelyEsp32Port('/dev/cu.usbmodem2101', 'darwin'), true);
  assert.equal(isLikelyEsp32Port('/dev/tty.usbmodem2101', 'darwin'), true);
  assert.equal(isLikelyEsp32Port('/dev/ttyACM0', 'linux'), true);
  assert.equal(isLikelyEsp32Port('/dev/ttyUSB12', 'linux'), true);
  assert.equal(isLikelyEsp32Port('/dev/ttyS0', 'linux'), false);
  assert.equal(isLikelyEsp32Port('COM5', 'linux'), false);
});

test('parses USB upload limits and rejects unusable responses', () => {
  assert.deepEqual(parseUploadReady('UPLOAD_READY max_bytes=14548992 chunk=4096'),
    {maxBytes: 14548992, chunk: 4096});
  assert.throws(() => parseUploadReady('UPLOAD_ERROR renderer_busy'), /cannot install/);
  assert.throws(() => parseUploadReady('UPLOAD_READY bytes=9987964'), /invalid upload response/);
  assert.throws(() => parseUploadReady('UPLOAD_READY max_bytes=100 chunk=16'), /invalid upload response/);
});

test('parses Wi-Fi upload results', () => {
  assert.equal(parseUploadResponse('{"ok":true,"character":"openclaw"}'), 'openclaw');
  assert.throws(() => parseUploadResponse('{"ok":false,"error":"Character pack SHA-256 mismatch."}'),
    /SHA-256 mismatch/);
  assert.throws(() => parseUploadResponse('<html>'), /invalid upload response/);
});

test('reads BOOT button lines from USB', () => {
  assert.equal(parseButtonLine('BUTTON settings presses=1'), 1);
  assert.equal(parseButtonLine('BUTTON settings presses=4294967295'), 4294967295);
  assert.equal(parseButtonLine('BUTTON settings presses=0'), null);
  assert.equal(parseButtonLine('BUTTON settings presses=4294967296'), null);
  assert.equal(parseButtonLine('BUTTON settings presses=x'), null);
  assert.equal(parseButtonLine('BUTTON other presses=1'), null);
  assert.equal(parseButtonLine('TOUCH tap x=1 y=2'), null);
});

test('a Wi-Fi press is a count that goes up in the same boot', () => {
  assert.equal(buttonPressed(null, {boot: 7, presses: 3}), false);
  assert.equal(buttonPressed({boot: 7, presses: 3}, {boot: 7, presses: 3}), false);
  assert.equal(buttonPressed({boot: 7, presses: 3}, {boot: 7, presses: 4}), true);
  assert.equal(buttonPressed({boot: 7, presses: 3}, {boot: 8, presses: 1}), false);
});

test('opens the settings page with each platform\'s browser command', () => {
  const url = 'http://127.0.0.1:4667/#token=abc';
  assert.deepEqual(browserCommands(url, 'darwin', false), [['/usr/bin/open', [url]]]);
  assert.deepEqual(browserCommands(url, 'win32', false), [['cmd', ['/c', 'start', '""', url]]]);
  assert.deepEqual(browserCommands(url, 'linux', false), [['xdg-open', [url]]]);
  assert.deepEqual(browserCommands(url, 'linux', true), [['wslview', [url]], ['explorer.exe', [url]]]);
});

test('picks the Espressif port, with its USB product ID, for installs', () => {
  const ports = [
    {path: '/dev/tty.usbmodem1', vendorId: '2341', productId: '0043'},
    {path: '/dev/tty.usbmodem2101', vendorId: '303A', productId: '1001'},
    {path: '/dev/tty.Bluetooth-Incoming-Port'},
  ] as never;
  assert.deepEqual(pickPort(ports, undefined, 'darwin'), {path: '/dev/cu.usbmodem2101', pid: 0x1001});
  assert.deepEqual(pickPort(ports, '/dev/tty.usbmodem1', 'darwin'), {path: '/dev/cu.usbmodem1', pid: 0x43});
  assert.deepEqual(pickPort([{path: '/dev/ttyACM0'}] as never, undefined, 'linux'), {path: '/dev/ttyACM0', pid: null});
  assert.equal(pickPort([{path: '/dev/ttyS0'}] as never, undefined, 'linux'), null);
});

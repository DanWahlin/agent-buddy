import assert from 'node:assert/strict';
import test from 'node:test';
import {isLikelyEsp32Port, parseUploadReady} from '../src/usb-transport.js';
import {parseUploadResponse} from '../src/wifi-transport.js';

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

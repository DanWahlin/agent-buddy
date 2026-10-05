import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOrientationOffset, orientationFromTenths, orientationPacket, parseOrientationLine,
} from '../src/orientation-settings.js';

test('orientation trim uses bounded half-degree steps', () => {
  for (const value of [-15, -2.5, 0, 0.5, 15]) assert.equal(isOrientationOffset(value), true);
  for (const value of [-15.5, 15.5, 0.1, NaN, Infinity, '0', null])
    assert.equal(isOrientationOffset(value), false);
  assert.equal(orientationPacket(-2.5), '^-25\n');
  assert.equal(orientationPacket(0), '^0\n');
  assert.throws(() => orientationPacket(0.1), /half-degree/);
});

test('USB and Wi-Fi orientation replies use the same device value', () => {
  assert.deepEqual(parseOrientationLine('ORIENTATION_SETTINGS offset_tenths=-25'),
    {offsetDegrees: -2.5});
  assert.deepEqual(orientationFromTenths(5), {offsetDegrees: 0.5});
  for (const value of [7, 151, '5', undefined, null]) {
    assert.throws(() => orientationFromTenths(value), /invalid orientation/);
  }
  assert.throws(() => parseOrientationLine('ORIENTATION_SETTINGS offset_tenths=3'), /invalid orientation/);
  assert.throws(() => parseOrientationLine('ORIENTATION_SETTINGS offset_degrees=0'), /invalid orientation/);
});

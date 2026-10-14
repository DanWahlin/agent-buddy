import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {join} from 'node:path';
import test from 'node:test';
import {asciiMask, activePacket, iconPacket, loadAgentBadgeIcons, shouldSendBadges} from '../src/agent-badges.js';
import {pngToMask24} from '../src/png-mask.js';

const blankArt = Array.from({length: 24}, (_, y) => y === 12 ? '########'.padEnd(24, '.') : '.'.repeat(24));

test('encodes icon and active badge packets within firmware parser bounds', () => {
  const mask = asciiMask(blankArt);
  const packet = iconPacket({id: 'copilot', name: 'Copilot', color: '#6f7cff', mask});
  assert.match(packet, /^%copilot:6F7CFF:[A-Za-z0-9+/=]+\n$/);
  assert.equal(packet.length < 192, true);
  assert.equal(Buffer.from(packet.split(':')[2]!.trim(), 'base64').length, 72);
  assert.equal(activePacket([{id: 'copilot', role: 'w'}, {id: 'claude', role: 'a'}]), '&copilot=w,claude=a\n');
  assert.equal(activePacket([]), '&\n');
  assert.equal(shouldSendBadges(5), false);
  assert.equal(shouldSendBadges(6), true);
});

test('converts non-interlaced PNG alpha and luminance to 24x24 masks', () => {
  const rgba = makePng(2, 2, 6, Buffer.from([
    0, 0, 0, 255, 255, 255, 255, 0,
    255, 0, 0, 0, 0, 255, 0, 255,
  ]));
  const alphaMask = pngToMask24(rgba);
  assert.notEqual(alphaMask[0]! & 0x80, 0);
  assert.equal(alphaMask[1]! & 0x04, 0);

  const gray = makePng(2, 2, 0, Buffer.from([0, 255, 255, 255]));
  const grayMask = pngToMask24(gray);
  assert.notEqual(grayMask[0]! & 0x80, 0);
});

function makePng(width: number, height: number, colorType: 0 | 6, pixels: Buffer): Buffer {
  const channels = colorType === 0 ? 1 : 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), pixels.subarray(y * width * channels, (y + 1) * width * channels));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([
      ...u32(width), ...u32(height), 8, colorType, 0, 0, 0,
    ])),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(u32(data.length)), Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

test('every built-in badge is a 24 by 24 glyph', async () => {
  const icons = await loadAgentBadgeIcons(join(process.cwd(), '.test-output', 'no-badge-icons'));
  assert.equal(icons.length, 7);
  assert.ok(icons.some(icon => icon.id === 'cursor' && icon.color === '#F4F4F5'));
  for (const icon of icons) assert.equal(icon.mask.length, 72, icon.id);
});

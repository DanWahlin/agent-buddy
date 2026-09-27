import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {deviceNetwork} from '../src/protocol.js';
import {
  broadcastAddresses,
  loadWifiConfig,
  parseDiscovery,
  parseWifiProvisioningResponse,
  saveWifiConfig,
  validateWifiCredentials,
  wifiProvisioningPacket,
} from '../src/wifi-config.js';

test('parses valid Agent Companion discovery responses', () => {
  const device = parseDiscovery(Buffer.from(JSON.stringify({
    service: 'esp32-agent-companion',
    protocol: 1,
    deviceId: '0123456789abcdef',
    hostname: 'agent-companion-89abcdef',
    ip: '192.168.1.50',
    port: 80,
    boot: 12345,
  })), '192.168.1.50');
  assert.deepEqual(device, {
    deviceId: '0123456789abcdef',
    hostname: 'agent-companion-89abcdef',
    address: '192.168.1.50',
    port: 80,
    boot: 12345,
  });
});

test('rejects malformed or incompatible discovery responses', () => {
  assert.equal(parseDiscovery(Buffer.from('invalid'), '192.168.1.50'), null);
  assert.equal(parseDiscovery(Buffer.from(JSON.stringify({
    service: 'other',
    protocol: 1,
    deviceId: '0123456789abcdef',
    hostname: 'device',
    port: 80,
    boot: 1,
  })), '192.168.1.50'), null);
  assert.equal(parseDiscovery(Buffer.from(JSON.stringify({
    service: 'esp32-agent-companion',
    protocol: 2,
    deviceId: 'short',
    hostname: 'device',
    port: 70000,
    boot: 1,
  })), '192.168.1.50'), null);
});

test('derives interface broadcast addresses with a global fallback', () => {
  assert.deepEqual(broadcastAddresses({
    en0: [{
      address: '192.168.10.24',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '192.168.10.24/24',
    }],
    lo0: [{
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    }],
  }), ['255.255.255.255', '192.168.10.255']);
});

test('persists private validated Wi-Fi pairing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-wifi-'));
  const path = join(directory, 'wifi.json');
  const previous = process.env.AGENT_COMPANION_WIFI_CONFIG;
  process.env.AGENT_COMPANION_WIFI_CONFIG = path;
  try {
    const config = {
      deviceId: '0123456789abcdef',
      token: '0123456789abcdef0123456789abcdef',
      address: '192.168.10.42',
      port: 80,
    };
    await saveWifiConfig(config);
    assert.deepEqual(await loadWifiConfig(), config);
    assert.match(await readFile(path, 'utf8'), /"deviceId"/);
    await assert.rejects(
      saveWifiConfig({deviceId: 'invalid', token: config.token}),
      /invalid Wi-Fi pairing data/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_WIFI_CONFIG;
    else process.env.AGENT_COMPANION_WIFI_CONFIG = previous;
  }
});

test('encodes validated Wi-Fi credentials for USB provisioning', () => {
  assert.equal(
    wifiProvisioningPacket('My Wi-Fi', 'correct horse battery staple'),
    '@TXkgV2ktRmk=:Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ==\n');
  assert.doesNotThrow(() => validateWifiCredentials('Open network', ''));
  assert.throws(() => validateWifiCredentials('', 'password'), /1 to 32 bytes/);
  assert.throws(() => validateWifiCredentials('network', 'short'), /8 to 63 bytes/);
  assert.throws(() => validateWifiCredentials('x'.repeat(33), 'password'), /1 to 32 bytes/);
});

test('parses USB provisioning identity without accepting other serial output', () => {
  assert.deepEqual(parseWifiProvisioningResponse(
    'WIFI configured device_id=0123456789abcdef token=0123456789abcdef0123456789abcdef'),
  {
    deviceId: '0123456789abcdef',
    token: '0123456789abcdef0123456789abcdef',
  });
  assert.throws(() => parseWifiProvisioningResponse('WIFI configured'), /invalid Wi-Fi pairing data/);
});

test('decodes the Wi-Fi network name the device reports', () => {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  assert.deepEqual(deviceNetwork(encode('Home Wi-Fi "5G" café'), true), {ssid: 'Home Wi-Fi "5G" café', connected: true});
  assert.deepEqual(deviceNetwork(encode('Office'), false), {ssid: 'Office', connected: false});
  // Older firmware doesn't report a name, and an unconfigured device reports an empty one.
  assert.equal(deviceNetwork(undefined, false), null);
  assert.equal(deviceNetwork('', false), null);
});

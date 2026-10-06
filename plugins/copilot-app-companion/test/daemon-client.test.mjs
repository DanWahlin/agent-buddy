import assert from 'node:assert/strict';
import test from 'node:test';
import {socketPath} from '../server/daemon-client.mjs';

test('uses the same daemon socket paths as the serial owner', () => {
  assert.equal(socketPath({
    platform: 'darwin',
    home: '/Users/example',
    environment: {},
    temporary: '/tmp',
    uid: 501,
  }), '/Users/example/Library/Application Support/ESP32 Agent Companion/daemon.sock');
  assert.equal(socketPath({
    platform: 'linux',
    home: '/home/example',
    environment: {XDG_RUNTIME_DIR: '/run/user/1000'},
    temporary: '/tmp',
    uid: 1000,
  }), '/run/user/1000/esp32-agent-companion/daemon.sock');
});

test('honors an explicit socket override', () => {
  assert.equal(socketPath({
    environment: {AGENT_COMPANION_SOCKET: '/custom/daemon.sock'},
  }), '/custom/daemon.sock');
});

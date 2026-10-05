import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  defaultDataDirectory,
  defaultSocketPath,
  isNamedPipe,
  serviceInfo,
  socketPath,
  statePath,
  wifiConfigPath,
  windowsPipeName,
} from '../src/paths.js';

test('honors explicit daemon path overrides', () => {
  const previousSocket = process.env.AGENT_COMPANION_SOCKET;
  const previousState = process.env.AGENT_COMPANION_STATE;
  const previousWifi = process.env.AGENT_COMPANION_WIFI_CONFIG;
  process.env.AGENT_COMPANION_SOCKET = join('custom', 'daemon.sock');
  process.env.AGENT_COMPANION_STATE = join('custom', 'state.json');
  process.env.AGENT_COMPANION_WIFI_CONFIG = join('custom', 'wifi.json');
  try {
    assert.equal(socketPath(), join('custom', 'daemon.sock'));
    assert.equal(statePath(), join('custom', 'state.json'));
    assert.equal(wifiConfigPath(), join('custom', 'wifi.json'));
  } finally {
    if (previousSocket === undefined) delete process.env.AGENT_COMPANION_SOCKET;
    else process.env.AGENT_COMPANION_SOCKET = previousSocket;
    if (previousState === undefined) delete process.env.AGENT_COMPANION_STATE;
    else process.env.AGENT_COMPANION_STATE = previousState;
    if (previousWifi === undefined) delete process.env.AGENT_COMPANION_WIFI_CONFIG;
    else process.env.AGENT_COMPANION_WIFI_CONFIG = previousWifi;
  }
});

test('uses native macOS and Linux runtime paths', () => {
  assert.equal(defaultSocketPath('darwin', '/Users/example', {}, '/tmp', 501),
               '/Users/example/Library/Application Support/ESP32 Agent Companion/daemon.sock');
  assert.equal(defaultDataDirectory('darwin', '/Users/example', {}),
               '/Users/example/Library/Application Support/ESP32 Agent Companion');
  assert.equal(defaultSocketPath('linux', '/home/example',
                                 {XDG_RUNTIME_DIR: '/run/user/1000'}, '/tmp', 1000),
               '/run/user/1000/esp32-agent-companion/daemon.sock');
  assert.equal(defaultSocketPath('linux', '/home/example', {}, '/tmp', 1000),
               '/tmp/esp32-agent-companion-1000/daemon.sock');
  assert.equal(defaultDataDirectory('linux', '/home/example',
                                    {XDG_STATE_HOME: '/home/example/state'}),
               '/home/example/state/esp32-agent-companion');
});

test('uses a per-user named pipe and LOCALAPPDATA on Windows', () => {
  assert.equal(defaultSocketPath('win32', 'C:\\Users\\Dan', {}, 'C:\\Temp', -1, 'Dan'),
               '\\\\.\\pipe\\esp32-agent-companion-Dan');
  assert.equal(windowsPipeName('Dan W'), '\\\\.\\pipe\\esp32-agent-companion-Dan_W');
  assert.equal(windowsPipeName('dé😀'), '\\\\.\\pipe\\esp32-agent-companion-d___');
  assert.equal(windowsPipeName(''), '\\\\.\\pipe\\esp32-agent-companion-user');
  assert.equal(isNamedPipe('\\\\.\\pipe\\esp32-agent-companion-Dan'), true);
  assert.equal(isNamedPipe('\\\\?\\pipe\\x'), true);
  assert.equal(isNamedPipe('/tmp/daemon.sock'), false);
  assert.equal(defaultDataDirectory('win32', 'C:\\Users\\Dan', {LOCALAPPDATA: 'D:\\Local'}),
               'D:\\Local\\ESP32 Agent Companion');
  assert.equal(defaultDataDirectory('win32', 'C:\\Users\\Dan', {LOCALAPPDATA: 'relative'}),
               'C:\\Users\\Dan\\AppData\\Local\\ESP32 Agent Companion');
  assert.equal(defaultDataDirectory('win32', 'C:\\Users\\Dan', {}),
               'C:\\Users\\Dan\\AppData\\Local\\ESP32 Agent Companion');
});

test('reports the folder the daemon runs from and its version', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-root-'));
  try {
    assert.deepEqual(serviceInfo(`${root}/`), {root, version: null});
    writeFileSync(join(root, 'VERSION'), '0.8.0\n');
    assert.deepEqual(serviceInfo(root), {root, version: '0.8.0'});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
  const own = serviceInfo();
  assert.ok(!own.root.endsWith('/') && own.root.length > 1);
});

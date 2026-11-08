import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Resvg} from '@resvg/resvg-js';
import {
  agents, fetchStatus, parseConnection, parseStatus, readConnection, settingsPath, settingsUrl, stateFor,
} from '../dist/streamdeck/src/client.js';
import {keyImage} from '../dist/streamdeck/src/key-image.js';
import {defaultIcons} from '../dist/daemon/src/agent-badge-art.js';

const token = 'a'.repeat(48);
const roles = {working: ['claude'], attention: ['copilot'], complete: []};

test('discovers installed and overridden settings files on supported platforms', () => {
  assert.equal(settingsPath('darwin', '/home/test', {}),
    '/home/test/Library/Application Support/ESP32 Agent Companion/settings.json');
  assert.equal(settingsPath('win32', 'C:\\Users\\test', {LOCALAPPDATA: 'D:\\Local'}),
    'D:\\Local\\ESP32 Agent Companion\\settings.json');
  assert.equal(settingsPath('win32', 'C:\\Users\\test', {LOCALAPPDATA: 'relative'}),
    'C:\\Users\\test\\AppData\\Local\\ESP32 Agent Companion\\settings.json');
  assert.equal(settingsPath('linux', '/home/test', {XDG_STATE_HOME: '/state'}),
    '/state/esp32-agent-companion/settings.json');
  assert.equal(settingsPath('darwin', '/home/test', {AGENT_COMPANION_DATA_DIR: '/custom'}),
    '/custom/settings.json');
  assert.equal(settingsPath('darwin', '/home/test', {AGENT_COMPANION_SETTINGS_INFO: '/custom/info.json'}),
    '/custom/info.json');
});

test('accepts only authenticated local Settings URLs and never puts the token in API URLs', () => {
  const connection = parseConnection({url: `http://127.0.0.1:4667/#token=${token}`});
  assert.equal(connection.url.href, 'http://127.0.0.1:4667/');
  assert.equal(connection.token, token);
  assert.equal(settingsUrl(connection), `http://127.0.0.1:4667/#token=${token}`);
  for (const url of [
    `https://127.0.0.1:4667/#token=${token}`, `http://example.com/#token=${token}`,
    `http://user:pass@localhost/#token=${token}`, `http://localhost/other#token=${token}`,
    `http://localhost/?token=${token}`, 'http://localhost/#token=short', 'not a url',
  ]) {
    assert.throws(() => parseConnection({url}));
  }
});

test('reads the private connection file afresh, including token changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-streamdeck-'));
  const path = join(directory, 'settings.json');
  try {
    await assert.rejects(readConnection(path), /Start Agent Buddy/);
    await writeFile(path, '{broken');
    await assert.rejects(readConnection(path), /Invalid settings.json/);
    await writeFile(path, JSON.stringify({url: `http://127.0.0.1:4667/#token=${token}`}));
    assert.equal((await readConnection(path)).token, token);
    const changed = 'b'.repeat(48);
    await writeFile(path, JSON.stringify({url: `http://127.0.0.1:4667/#token=${changed}`}));
    assert.equal((await readConnection(path)).token, changed);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('attention wins, while another agent key still shows concurrent work', () => {
  const status = parseStatus({state: 'attention', badges: {enabled: false, roles}});
  assert.equal(stateFor(status, 'all'), 'attention');
  assert.equal(stateFor(status, 'copilot'), 'attention');
  assert.equal(stateFor(status, 'claude'), 'working');
  assert.equal(stateFor(status, 'codex'), 'idle');
  assert.equal(stateFor({...status, roles: {...roles, working: ['copilot', 'claude']}}, 'copilot'), 'attention');
  for (const state of ['idle', 'working', 'complete']) {
    const ids = state === 'idle' ? [] : ['codex'];
    const byRole = {working: [], attention: [], complete: [], ...(state === 'idle' ? {} : {[state]: ids})};
    const value = parseStatus({state, badges: {roles: byRole}});
    assert.equal(stateFor(value, 'all'), state);
    assert.equal(stateFor(value, 'codex'), state);
  }
});

test('old or malformed responses produce errors, never an idle success', () => {
  assert.throws(() => parseStatus({state: 'idle', badges: {active: []}}), /Update Agent Buddy/);
  for (const value of [
    null, {}, {state: 'broken', badges: {roles}},
    {state: 'idle', badges: {roles: {working: ['unknown'], attention: [], complete: []}}},
  ]) assert.throws(() => parseStatus(value));
});

test('every key state has a readable image and attention can pulse without changing its label', () => {
  for (const agent of ['all', ...Object.keys(agents)]) {
    for (const state of ['idle', 'working', 'attention', 'complete', 'offline', 'setup']) {
      const image = keyImage(state, agent);
      assert.match(image, /^data:image\/svg\+xml;base64,/);
      const svg = Buffer.from(image.split(',')[1], 'base64').toString();
      assert.match(svg, /width="144" height="144"/);
      assert.match(svg, /<text/);
    }
  }
  assert.notEqual(keyImage('attention', 'all', true), keyImage('attention', 'all', false));
  assert.match(Buffer.from(keyImage('attention', 'all', true).split(',')[1], 'base64').toString(), /Needs you/);
});

test('agent logos retain the app artwork and brand colors in every state, including attention pulses', () => {
  for (const [agent, icon] of Object.entries(defaultIcons)) {
    const rgb = icon.color.slice(1).match(/../g).map(hex => parseInt(hex, 16));
    for (const state of ['idle', 'working', 'attention', 'complete', 'offline', 'setup', 'connecting']) {
      const svg = Buffer.from(keyImage(state, agent, true).split(',')[1], 'base64').toString();
      const {pixels} = new Resvg(svg).render();
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
          if (icon.art[y][x] !== '#') continue;
          const offset = ((32 + 3 * y) * 144 + 26 + 3 * x) * 4;
          assert.deepEqual([...pixels.subarray(offset, offset + 3)], rgb, `${agent}: ${state}`);
        }
      }
    }
  }
});

test('status badges distinguish working, idle, completion, disconnection, and setup without relying on text', () => {
  const badges = ['idle', 'working', 'complete', 'offline', 'setup'].map(state => {
    const svg = Buffer.from(keyImage(state, 'copilot').split(',')[1], 'base64').toString();
    const {pixels} = new Resvg(svg).render();
    return Buffer.concat(Array.from({length: 24}, (_, row) =>
      Buffer.from(pixels.subarray(((73 + row) * 144 + 108) * 4, ((73 + row) * 144 + 132) * 4))));
  });
  assert.equal(new Set(badges.map(badge => badge.toString('base64'))).size, badges.length);
});

test('authenticates real HTTP polling, refuses redirects, and exposes service failures safely', async () => {
  let mode = 'ok';
  let redirected = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-companion-token'], token);
    assert.equal(request.url, '/api/status');
    if (mode === 'redirect') {
      response.writeHead(302, {Location: '/leak'});
      response.end();
      return;
    }
    if (mode === 'unauthorized') {
      response.writeHead(401);
      response.end();
      return;
    }
    if (mode === 'bad') {
      response.end('{bad');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({state: 'attention', badges: {roles}}));
  });
  server.on('request', request => { if (request.url === '/leak') redirected = true; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = parseConnection({url: `http://127.0.0.1:${server.address().port}/#token=${token}`});
  try {
    assert.equal((await fetchStatus(connection)).roles.attention[0], 'copilot');
    mode = 'unauthorized';
    await assert.rejects(fetchStatus(connection), /Settings token changed/);
    mode = 'bad';
    await assert.rejects(fetchStatus(connection), /Invalid Agent Buddy status/);
    mode = 'redirect';
    await assert.rejects(fetchStatus(connection), error => {
      assert.equal(error.message.includes(token), false);
      return /offline or not responding/.test(error.message);
    });
    assert.equal(redirected, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  await assert.rejects(fetchStatus(connection), /offline or not responding/);
});

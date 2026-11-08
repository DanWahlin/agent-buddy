import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {WebSocketServer} from 'ws';

test('packaged SDK action registers, updates keys, opens Settings, and disconnects cleanly', {timeout: 15000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-streamdeck-sdk-'));
  const token = 'a'.repeat(48);
  let roles = {working: ['claude'], attention: ['copilot'], complete: []};
  let state = 'attention';
  let polls = 0;
  const http = createServer((request, response) => {
    polls++;
    assert.equal(request.url, '/api/status');
    assert.equal(request.headers['x-companion-token'], token);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({state, badges: {enabled: false, roles}}));
  });
  const ws = new WebSocketServer({host: '127.0.0.1', port: 0});
  let child;
  let socket;
  const messages = [];
  let output = '';
  const waitFor = async predicate => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const match = messages.find(predicate);
      if (match) return match;
      if (child?.exitCode !== null && child?.exitCode !== undefined)
        throw new Error(`Plugin exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for SDK message: ${output}`);
  };
  const imageHas = (context, text) => message => message.event === 'setImage'
    && message.context === context
    && Buffer.from(message.payload.image.split(',')[1], 'base64').toString().includes(text);
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    if (!ws.address()) await once(ws, 'listening');
    const url = `http://127.0.0.1:${http.address().port}/#token=${token}`;
    const settingsFile = join(root, 'settings.json');
    await writeFile(settingsFile, JSON.stringify({url}));
    await mkdir(join(root, 'bin'));
    await copyFile('com.agentbuddy.status.sdPlugin/manifest.json', join(root, 'manifest.json'));
    await copyFile('com.agentbuddy.status.sdPlugin/bin/plugin.js', join(root, 'bin/plugin.js'));
    const connected = once(ws, 'connection', {signal: AbortSignal.timeout(6000)});
    child = spawn(process.execPath, [
      'bin/plugin.js', '-port', String(ws.address().port),
      '-pluginUUID', 'test-plugin', '-registerEvent', 'registerPlugin',
      '-info', JSON.stringify({
        application: {font: 'Arial', language: 'en', platform: 'mac', platformVersion: '14', version: '6.6.0'},
        plugin: {uuid: 'com.agentbuddy.status', version: '0.1.0.0'},
        devicePixelRatio: 1, colors: {},
        devices: [{id: 'deck', name: 'Test deck', size: {columns: 5, rows: 3}, type: 0}],
      }),
    ], {cwd: root, env: {...process.env, AGENT_COMPANION_SETTINGS_INFO: settingsFile}});
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    [socket] = await connected;
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await waitFor(message => message.event === 'registerPlugin');
    const event = (name, context, settings = {}) => socket.send(JSON.stringify({
      event: name, action: 'com.agentbuddy.status.monitor', context, device: 'deck',
      payload: {controller: 'Keypad', coordinates: {column: context === 'all' ? 0 : 1, row: 0},
        settings: {pulse: false, ...settings}, state: 0},
    }));
    event('willAppear', 'all');
    event('willAppear', 'claude', {agent: 'claude'});
    await waitFor(imageHas('all', 'Needs you'));
    await waitFor(imageHas('claude', 'Working'));
    event('propertyInspectorDidAppear', 'all');
    socket.send(JSON.stringify({
      event: 'sendToPlugin', action: 'com.agentbuddy.status.monitor', context: 'all',
      payload: {event: 'getStatus'},
    }));
    await waitFor(message => message.event === 'sendToPropertyInspector'
      && message.payload.message === 'Your agent needs you.');
    event('keyDown', 'all');
    assert.equal((await waitFor(message => message.event === 'openUrl')).payload.url, url);
    assert.deepEqual(roles.attention, ['copilot']);
    roles = {working: [], attention: [], complete: ['claude']};
    state = 'complete';
    await waitFor(imageHas('claude', 'Complete'));
    event('didReceiveSettings', 'claude', {agent: 'copilot'});
    await waitFor(imageHas('claude', 'Idle'));
    event('willDisappear', 'all');
    event('willDisappear', 'claude');
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = polls;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(polls, before);
    assert.equal(output.includes(token), false);
  } catch (error) {
    const files = await readdir(join(root, 'logs')).catch(() => []);
    const logs = await Promise.all(files.map(file => readFile(join(root, 'logs', file), 'utf8')));
    throw new Error(`${error.message}\n${output}\n${logs.join('\n')}`);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit', {signal: AbortSignal.timeout(2000)});
      child.kill();
      await exited;
    }
    socket?.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(root, {recursive: true, force: true});
  }
});

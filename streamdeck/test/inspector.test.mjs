import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('property inspector restores settings, requests status, and saves only non-secret preferences', async () => {
  const elements = new Map(['agent', 'pulse', 'settingsFile', 'status'].map(id => [id, {
    value: '', checked: false, textContent: '',
    listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
  }]));
  const sent = [];
  let socket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { this.url = url; socket = this; }
    send(message) { sent.push(JSON.parse(message)); }
  }
  const context = {
    window: {}, WebSocket: FakeWebSocket,
    document: {getElementById: id => elements.get(id)},
  };
  vm.runInNewContext(await readFile('com.agentbuddy.status.sdPlugin/ui/settings.js', 'utf8'), context);
  context.window.connectElgatoStreamDeckSocket('1234', 'pi', 'registerPropertyInspector', '{}',
    JSON.stringify({action: 'com.agentbuddy.status.monitor', context: 'key',
      payload: {settings: {agent: 'claude', pulse: false, settingsFile: '/custom/settings.json'}}}));
  assert.equal(socket.url, 'ws://127.0.0.1:1234');
  assert.equal(elements.get('agent').value, 'claude');
  assert.equal(elements.get('pulse').checked, false);
  socket.onopen();
  assert.equal(sent[0].event, 'registerPropertyInspector');
  assert.equal(sent[1].payload.event, 'getStatus');
  socket.onmessage({data: JSON.stringify({event: 'sendToPropertyInspector', context: 'key',
    payload: {event: 'status', message: 'Your agent needs you.'}})});
  assert.equal(elements.get('status').textContent, 'Your agent needs you.');
  elements.get('agent').value = 'copilot';
  elements.get('agent').listeners.change();
  assert.deepEqual(sent.at(-1), {
    event: 'setSettings', context: 'key',
    payload: {agent: 'copilot', pulse: false, settingsFile: '/custom/settings.json'},
  });
  socket.onmessage({data: JSON.stringify({event: 'didReceiveSettings', context: 'key',
    payload: {settings: {agent: 'all', pulse: true}}})});
  assert.equal(elements.get('agent').value, 'all');
  assert.equal(elements.get('settingsFile').value, '');
  socket.readyState = 3;
  const before = sent.length;
  elements.get('pulse').listeners.change();
  assert.equal(sent.length, before);
  assert.match(elements.get('status').textContent, /Not connected/);
});

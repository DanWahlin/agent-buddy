import assert from 'node:assert/strict';
import test from 'node:test';
import {createToolHandler, listTools} from '../server/tools.mjs';

test('publishes status, connection test, state, and contextual narration tools', () => {
  assert.deepEqual(listTools().map(tool => tool.name),
                   ['status', 'test_connection', 'set_state', 'narrate']);
  const stateSchema = listTools()[2].inputSchema.properties.state;
  assert.deepEqual(stateSchema.enum,
                   ['idle', 'surprise', 'working', 'complete', 'attention']);
});

test('maps validated narration to the daemon with a speech timeout', async () => {
  const calls = [];
  const handle = createToolHandler({
    request: async (request, options) => {
      calls.push({request, options});
      return {ok: true};
    },
  });
  const result = await handle('narrate', {text: 'Let me check the calendar.'});
  assert.deepEqual(calls, [{
    request: {type: 'narrate', text: 'Let me check the calendar.'},
    options: {timeoutMs: 60_000},
  }]);
  assert.equal(result.isError, undefined);
});

test('rejects invalid narration without contacting the daemon', async () => {
  let called = false;
  const handle = createToolHandler({request: async () => {
    called = true;
    return {};
  }});
  const result = await handle('narrate', {text: ''});
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /at most 180 characters/);
});

test('maps state changes to a stable daemon lease', async () => {
  const requests = [];
  const handle = createToolHandler({
    leaseId: 'copilot-app:test',
    request: async request => {
      requests.push(request);
      return {ok: true, state: request.state};
    },
  });
  const result = await handle('set_state', {state: 'working'});
  assert.deepEqual(requests, [{
    type: 'lease',
    leaseId: 'copilot-app:test',
    state: 'working',
  }]);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, 'working');
});

test('rejects invalid state inputs without contacting the daemon', async () => {
  let called = false;
  const handle = createToolHandler({request: async () => {
    called = true;
    return {};
  }});
  const result = await handle('set_state', {state: 'sleeping'});
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /state must be one of/);
});

test('returns explicit daemon and device errors', async () => {
  const handle = createToolHandler({request: async () => {
    throw new Error('USB device is not connected.');
  }});
  const result = await handle('test_connection', {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'USB device is not connected.');
});

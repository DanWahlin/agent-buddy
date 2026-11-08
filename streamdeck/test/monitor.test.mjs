import assert from 'node:assert/strict';
import test from 'node:test';
import {Monitor} from '../dist/streamdeck/src/monitor.js';

const idle = {state: 'idle', roles: {working: [], attention: [], complete: []}};
const attention = {state: 'attention', roles: {working: ['claude'], attention: ['copilot'], complete: []}};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('shares polls across keys, avoids redundant images, and recovers from offline', async () => {
  let calls = 0;
  let status = idle;
  let error;
  const logs = [];
  const renders = [];
  const monitor = new Monitor({
    read: async () => ({}),
    fetch: async () => { calls++; if (error) throw error; return status; },
    log: message => logs.push(message),
  });
  try {
    monitor.add('all', {pulse: false}, async update => renders.push(['all', update.state]));
    monitor.add('claude', {agent: 'claude'}, async update => renders.push(['claude', update.state]));
    await nextTurn();
    renders.length = 0;
    const before = calls;
    status = attention;
    await monitor.poll();
    assert.equal(calls - before, 1);
    assert.deepEqual(renders, [['all', 'attention'], ['claude', 'working']]);
    await monitor.poll();
    assert.equal(renders.length, 2);
    error = new Error('Start Agent Buddy.');
    await monitor.poll();
    assert.deepEqual(renders.slice(-2), [['all', 'offline'], ['claude', 'offline']]);
    await monitor.poll();
    assert.deepEqual(logs, ['Start Agent Buddy.']);
    error = undefined;
    status = idle;
    await monitor.poll();
    assert.deepEqual(renders.slice(-2), [['all', 'idle'], ['claude', 'idle']]);
  } finally {
    monitor.remove('all');
    monitor.remove('claude');
  }
});

test('removed or reconfigured keys do not receive an in-flight stale response', async () => {
  let finish;
  const renders = [];
  let blocked = true;
  const monitor = new Monitor({
    read: async () => ({}),
    fetch: () => blocked ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(attention),
    log: () => {},
  });
  try {
    monitor.add('key', {agent: 'copilot'}, async update => renders.push(update.state));
    await nextTurn();
    monitor.add('key', {agent: 'claude'}, async update => renders.push(update.state));
    finish(attention);
    await nextTurn();
    assert.deepEqual(renders, []);
    blocked = false;
    await monitor.poll();
    assert.deepEqual(renders, ['working']);
    blocked = true;
    const pending = monitor.poll();
    await nextTurn();
    monitor.remove('key');
    finish(attention);
    await pending;
    assert.deepEqual(renders, ['working']);
  } finally {
    monitor.remove('key');
  }
});

test('polls custom paths independently and surfaces invalid agent settings', async () => {
  const paths = [];
  const renders = [];
  const monitor = new Monitor({
    read: async path => { paths.push(path); return {}; },
    fetch: async () => idle,
    log: () => {},
  });
  try {
    monitor.add('one', {settingsFile: '/custom/one.json'}, async () => {});
    monitor.add('two', {settingsFile: '/custom/two.json', agent: 'unknown'},
      async update => renders.push(update));
    await nextTurn();
    paths.length = 0;
    await monitor.poll();
    assert.deepEqual(paths.sort(), ['/custom/one.json', '/custom/two.json']);
    assert.equal(renders.at(-1).state, 'setup');
    assert.match(renders.at(-1).message, /Select a supported agent/);
  } finally {
    monitor.remove('one');
    monitor.remove('two');
  }
});

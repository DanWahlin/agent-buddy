import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { StateBridge } from '../src/bridge.js';
import { endpointIsFile } from '../src/paths.js';
import type { CharacterState } from '../src/vendor/protocol.js';

/**
 * Real sockets, not stubs. The whole point of this layer is what happens across
 * process boundaries, and a mocked transport would not have caught the things
 * that actually go wrong here.
 */

let counter = 0;
const scratch: string[] = [];

async function endpoint(): Promise<string> {
  const id = process.pid + '-' + (counter++);
  if (!endpointIsFile()) return '\\\\.\\pipe\\agent-companion-test-' + id;
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-test-'));
  scratch.push(directory);
  return join(directory, 's');
}

async function bridge(overrides: Partial<Parameters<typeof makeBridge>[0]> = {}) {
  return makeBridge({ endpoint: await endpoint(), ...overrides });
}

function makeBridge(options: { endpoint: string; statePath?: string }) {
  const seen: CharacterState[] = [];
  const logs: string[] = [];
  const instance = new StateBridge({
    endpoint: options.endpoint,
    statePath: options.statePath ?? join(tmpdir(), 'agent-companion-test-state-' + (counter++) + '.json'),
    onState: state => seen.push(state),
    onLog: line => logs.push(line),
    retryMs: 50,
  });
  return { instance, seen, logs, endpoint: options.endpoint };
}

/** Send one newline-delimited request and resolve with the reply. */
function request(path: string, value: unknown, keepOpen = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(path);
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('error', reject);
    socket.on('data', chunk => {
      const line = String(chunk).split('\n').find(Boolean);
      if (!line) return;
      if (!keepOpen) socket.destroy();
      resolve(JSON.parse(line));
    });
    socket.on('connect', () => socket.write(JSON.stringify(value) + '\n'));
  });
}

/** Poll until a condition holds, so tests never depend on a fixed sleep. */
async function until(check: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  assert.fail('timed out waiting for ' + label);
}

test.after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

test('the first window to start becomes the leader', async t => {
  const { instance, logs } = await bridge();
  t.after(() => instance.stop());

  await instance.start();
  assert.equal(instance.role, 'leader');
  assert.match(logs.join('\n'), /Listening on/);
});

test('a hook drives the state, and the reply says so', async t => {
  const { instance, seen } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  const reply = await request(instance.endpoint, {
    type: 'hook', event: 'preToolUse', payload: { session_id: 's1' },
  }) as { ok: boolean; state: string };

  assert.equal(reply.ok, true);
  await until(() => instance.state === 'working', 'the state to become working');
  assert.ok(seen.includes('working'));
});

test('a full session runs idle to working to complete', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  const send = (event: string) =>
    request(instance.endpoint, { type: 'hook', event, payload: { session_id: 's1' } });

  await send('sessionStart');
  await send('userPromptSubmitted');
  await send('preToolUse');
  await until(() => instance.state === 'working', 'working');

  await send('postToolUse');
  await send('agentStop');
  await until(() => instance.state === 'complete', 'complete');

  // The celebration is a pulse; it falls back on its own.
  await until(() => instance.state === 'idle', 'idle again', 6000);
});

test('a notification asks for attention and keeps it', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  await request(instance.endpoint, {
    type: 'hook', event: 'notification', payload: { session_id: 's1' },
  });
  await until(() => instance.state === 'attention', 'attention');

  await delay(200);
  assert.equal(instance.state, 'attention', 'attention should not lapse on its own');
});

test('an unknown event or state is refused, not acted on', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  const bad = await request(instance.endpoint,
    { type: 'hook', event: 'nonsense' }) as { ok: boolean; error: string };
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown event/);

  const worse = await request(instance.endpoint,
    { type: 'send', state: 'dancing' }) as { ok: boolean; error: string };
  assert.equal(worse.ok, false);
  assert.equal(instance.state, 'idle');
});

test('malformed input is refused without taking the bridge down', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  const reply = await request(instance.endpoint, 'not-an-object') as { ok: boolean };
  assert.equal(reply.ok, false);

  // Still serving.
  const status = await request(instance.endpoint, { type: 'status' }) as { ok: boolean };
  assert.equal(status.ok, true);
});

test('status reports the role and session count', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();
  await request(instance.endpoint, {
    type: 'hook', event: 'sessionStart', payload: { session_id: 's1' },
  });

  const status = await request(instance.endpoint, { type: 'status' }) as
    { role: string; sessions: number; state: string };
  assert.equal(status.role, 'leader');
  assert.equal(status.sessions, 1);
  assert.equal(status.state, 'idle');
});

test('a second window follows the first instead of fighting for the socket', async t => {
  const shared = await endpoint();
  const first = makeBridge({ endpoint: shared });
  const second = makeBridge({ endpoint: shared });
  t.after(async () => { await second.instance.stop(); await first.instance.stop(); });

  await first.instance.start();
  await second.instance.start();

  assert.equal(first.instance.role, 'leader');
  assert.equal(second.instance.role, 'subscriber');

  // A hook reaching the leader must reach the follower too.
  await request(shared, { type: 'hook', event: 'preToolUse', payload: { session_id: 's1' } });
  await until(() => second.instance.state === 'working', 'the follower to see working');
  assert.ok(second.seen.includes('working'));
});

test('a follower takes over when the leader closes', async t => {
  const shared = await endpoint();
  const first = makeBridge({ endpoint: shared });
  const second = makeBridge({ endpoint: shared });
  t.after(async () => { await second.instance.stop(); await first.instance.stop(); });

  await first.instance.start();
  await second.instance.start();
  assert.equal(second.instance.role, 'subscriber');

  await first.instance.stop();
  await until(() => second.instance.role === 'leader', 'the follower to take over', 5000);

  // And it really is serving now.
  const status = await request(shared, { type: 'status' }) as { ok: boolean; role: string };
  assert.equal(status.role, 'leader');
});

test('the leader closing at once still releases a follower', async t => {
  // The follower has connected but its `subscribe` line may not have been read
  // yet, so the leader does not know it is there. Tracking only subscribers
  // left that connection open, `server.close()` waited on it, and the follower
  // was never woken - on Unix sockets, where this was found, and in principle
  // anywhere. Closing a window must not depend on that timing.
  const shared = await endpoint();
  const first = makeBridge({ endpoint: shared });
  const second = makeBridge({ endpoint: shared });
  t.after(async () => { await second.instance.stop(); await first.instance.stop(); });

  await first.instance.start();
  await second.instance.start();
  assert.equal(second.instance.role, 'subscriber');

  // No pause here on purpose: stop while the subscribe is still in flight.
  const started = Date.now();
  await first.instance.stop();
  const took = Date.now() - started;

  assert.ok(took < 1000, 'stopping took ' + took + 'ms, so it waited on a socket');
  await until(() => second.instance.role === 'leader', 'the follower to take over', 5000);
});

test('a left-behind socket file does not block a new leader', async t => {
  if (!endpointIsFile()) {
    t.skip('named pipes vanish with their process; there is nothing to leave behind');
    return;
  }
  const shared = await endpoint();
  // A window that crashed leaves the path occupied by something nothing is
  // listening on. Binding then fails as in-use, and connecting fails too, which
  // together mean the owner is gone and the path can be cleared.
  await writeFile(shared, '');

  const { instance, logs } = makeBridge({ endpoint: shared });
  t.after(() => instance.stop());
  await instance.start();

  assert.equal(instance.role, 'leader', logs.join('\n'));
});

test('setState reaches followers as well as the leader', async t => {
  const shared = await endpoint();
  const first = makeBridge({ endpoint: shared });
  const second = makeBridge({ endpoint: shared });
  t.after(async () => { await second.instance.stop(); await first.instance.stop(); });

  await first.instance.start();
  await second.instance.start();

  first.instance.setState('surprise');
  await until(() => second.instance.state === 'surprise', 'the follower to see surprise');
});

test('a client that writes JSON and closes without a newline is still understood', async t => {
  const { instance } = await bridge();
  t.after(() => instance.stop());
  await instance.start();

  // Upstream's clients write one object and close, with no trailing newline.
  // The request must still be acted on. Whether a reply gets back depends on
  // the platform: a Unix socket half-closes, so the server can still answer,
  // but a Windows named pipe tears down both directions at once and the reply
  // is lost. The hook shim never waits for one, so this only affects the reply.
  const replied = await new Promise<boolean>(resolve => {
    const socket = createConnection(instance.endpoint);
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.on('close', () => resolve(false));
    socket.on('data', () => { socket.destroy(); resolve(true); });
    socket.on('connect', () =>
      socket.end(JSON.stringify({ type: 'hook', event: 'preToolUse', payload: { session_id: 'x' } })));
  });

  // The event landed, which is the part that matters.
  await until(() => instance.state === 'working', 'the half-closed request to be acted on');

  if (endpointIsFile()) {
    assert.equal(replied, true, 'a Unix socket should be able to answer a half-closed client');
  }
});

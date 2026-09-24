/**
 * The bridge as a process: hooks in one end, lines out the other.
 *
 * This is what a shell that is not Node will spawn, so it is tested the way
 * one would drive it - a real child process, real stdio, a real endpoint -
 * rather than by calling into it.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { endpointIsFile } from '../src/paths.js';

// These run compiled, from dist-test/test, so the package root is two up.
const HOST = join(import.meta.dirname, '..', '..', 'dist', 'host.js');
if (!existsSync(HOST)) {
  // Otherwise every test below waits out its timeout and blames the host.
  throw new Error('no host build at ' + HOST + ' - run the package build first');
}

let counter = 0;
const scratch: string[] = [];

async function endpoint(): Promise<string> {
  const id = process.pid + '-' + (counter++);
  if (!endpointIsFile()) return '\\\\.\\pipe\\agent-companion-host-test-' + id;
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-host-'));
  scratch.push(directory);
  return join(directory, 's');
}

interface Host {
  child: ChildProcessWithoutNullStreams;
  lines: Array<Record<string, unknown>>;
  endpoint: string;
  say: (command: unknown) => void;
}

async function startHost(args: string[] = []): Promise<Host> {
  const where = await endpoint();
  const child = spawn(process.execPath, [HOST, ...args], {
    env: {
      ...process.env,
      AGENT_COMPANION_VSCODE_SOCKET: where,
      AGENT_COMPANION_VSCODE_STATE: join(tmpdir(), 'agent-companion-host-state-' + (counter++) + '.json'),
    },
  });

  const lines: Array<Record<string, unknown>> = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    // Chunk boundaries are not line boundaries; hold the partial back.
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
  });

  return {
    child,
    lines,
    endpoint: where,
    say: command => child.stdin.write(JSON.stringify(command) + '\n'),
  };
}

async function until(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail('timed out waiting for ' + label);
}

const states = (host: Host) =>
  host.lines.filter(line => line.type === 'state').map(line => line.state);

/** One hook line, the way the shim sends it. */
function fire(where: string, event: string, payload: Record<string, unknown> = {}): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; socket.destroy(); resolve(); };
    const line = JSON.stringify({
      type: 'hook', event, payload: { session_id: 'host-test', ...payload },
    }) + '\n';
    // Never wait for a reply: a Windows named pipe has no half-close.
    const socket = createConnection(where, () => socket.end(line, done));
    socket.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

test.after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

test('it announces itself, then reports what the agent is doing', async t => {
  const host = await startHost();
  t.after(() => host.child.kill());

  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');
  const ready = host.lines.find(line => line.type === 'ready')!;
  assert.equal(ready.role, 'leader');
  assert.equal(ready.state, 'idle');
  assert.equal(ready.endpoint, host.endpoint);

  await fire(host.endpoint, 'preToolUse', { tool_name: 'Bash' });
  await until(() => states(host).includes('working'), 'working');

  await fire(host.endpoint, 'notification', { notification_type: 'permission_prompt' });
  await until(() => states(host).includes('attention'), 'attention');
});

test('the shell can drive a state by hand', async t => {
  const host = await startHost();
  t.after(() => host.child.kill());
  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');

  host.say({ type: 'send', state: 'complete' });
  await until(() => states(host).includes('complete'), 'the simulated state');
});

test('folders given up front decide what it reacts to', async t => {
  const host = await startHost(['--folders', '/repo-a']);
  t.after(() => host.child.kill());
  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');

  // Another project's agent is not this host's business.
  await fire(host.endpoint, 'preToolUse', { cwd: '/repo-b' });
  await delay(400);
  assert.deepEqual(states(host), [], 'should have stayed quiet');

  await fire(host.endpoint, 'preToolUse', { cwd: '/repo-a/src' });
  await until(() => states(host).includes('working'), 'its own project');
});

test('nonsense on stdin is ignored rather than fatal', async t => {
  const host = await startHost();
  t.after(() => host.child.kill());
  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');

  host.say('not-an-object');
  host.child.stdin.write('{ not json\n');
  host.say({ type: 'nonsense' });

  // Still serving.
  await fire(host.endpoint, 'preToolUse');
  await until(() => states(host).includes('working'), 'the bridge to still be alive');
});

/**
 * The reason this process exists in the shape it does.
 *
 * The leader holds the endpoint and the other windows only take over promptly
 * because it closes its connections on the way out. A host that quits without
 * asking would otherwise leave them waiting, so stdin closing has to be enough.
 */
test('the parent going away is enough to shut it down cleanly', async t => {
  const host = await startHost();
  const exited = new Promise<number | null>(resolve => host.child.on('exit', resolve));
  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');

  host.child.stdin.end();

  const code = await Promise.race([exited, delay(4000).then(() => 'timed out' as const)]);
  assert.equal(code, 0, 'should exit cleanly, not hang or crash');
  assert.ok(
    host.lines.some(line => line.type === 'stopping'),
    'should say it is stopping: ' + JSON.stringify(host.lines));

  // And the endpoint is free again, so the next host can lead rather than follow.
  const next = await startHost();
  t.after(() => next.child.kill());
  await until(() => next.lines.some(line => line.type === 'ready'), 'a new leader');
  assert.equal(next.lines.find(line => line.type === 'ready')!.role, 'leader');
});

test('an explicit stop is honoured too', async t => {
  const host = await startHost();
  const exited = new Promise<number | null>(resolve => host.child.on('exit', resolve));
  await until(() => host.lines.some(line => line.type === 'ready'), 'the ready line');

  host.say({ type: 'stop' });
  const code = await Promise.race([exited, delay(4000).then(() => 'timed out' as const)]);
  assert.equal(code, 0);
});

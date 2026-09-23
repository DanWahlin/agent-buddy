/**
 * End to end: the built hook shim, spawned the way an agent spawns it, driving
 * a real bridge over a real socket.
 *
 * This is the one check that covers the whole chain - bundling, CommonJS
 * output, stdin parsing, the endpoint, the wire format and the coordinator - so
 * it runs the shipped `dist/hook.js`, not the TypeScript source.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StateBridge } from '../../packages/agent-state/dist/bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, '..', 'dist', 'hook.js');
const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\agent-companion-e2e-' + process.pid
  : join(process.env.TMPDIR ?? '/tmp', 'ac-e2e-' + process.pid + '.sock');

/** Run the shim exactly as a hook would: event as argv, payload on stdin. */
function fireHook(event, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [shim, event], {
      env: { ...process.env, AGENT_COMPANION_VSCODE_SOCKET: endpoint },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout, stderr, code: 0 });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function until(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail('timed out waiting for ' + label);
}

const seen = [];
const bridge = new StateBridge({
  endpoint,
  statePath: join(process.env.TEMP ?? '/tmp', 'ac-e2e-state-' + process.pid + '.json'),
  onState: state => seen.push(state),
  onLog: () => {},
});

let failures = 0;
function check(name, fn) {
  return fn().then(
    () => console.log('  ok   ' + name),
    error => { failures++; console.log('  FAIL ' + name + ': ' + error.message); });
}

await bridge.start();
assert.equal(bridge.role, 'leader');
console.log('bridge listening on ' + endpoint);

await check('a tool starting makes it work', async () => {
  const result = await fireHook('preToolUse', {
    session_id: 'e2e-1', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  });
  // Silence matters: anything on stdout or stderr shows up in the user's agent.
  assert.equal(result.stdout, '', 'the shim must print nothing to stdout');
  assert.equal(result.stderr, '', 'the shim must print nothing to stderr');
  await until(() => bridge.state === 'working', 'working');
});

await check('a subagent keeps it working', async () => {
  await fireHook('subagentStart', { session_id: 'e2e-1', agent_id: 'sub-1' });
  await fireHook('postToolUse', { session_id: 'e2e-1' });
  await delay(100);
  assert.equal(bridge.state, 'working', 'a running subagent should hold it');
  await fireHook('subagentStop', { session_id: 'e2e-1', agent_id: 'sub-1' });
});

await check('stopping celebrates then settles', async () => {
  await fireHook('agentStop', { session_id: 'e2e-1' });
  await until(() => bridge.state === 'complete', 'complete');
  await until(() => bridge.state === 'idle', 'idle again', 8000);
});

await check('a permission prompt asks for attention', async () => {
  await fireHook('notification', { session_id: 'e2e-1' });
  await until(() => bridge.state === 'attention', 'attention');
});

await check('the shim stays silent and quick when nothing is listening', async () => {
  await bridge.stop();
  const started = Date.now();
  const result = await fireHook('preToolUse', { session_id: 'e2e-2' });
  const took = Date.now() - started;
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  // A hook that hangs would stall the agent that fired it.
  assert.ok(took < 6000, 'the shim took ' + took + 'ms with no listener');
});

console.log('\nstates seen: ' + seen.join(' -> '));
await bridge.stop().catch(() => undefined);
process.exit(failures ? 1 : 0);

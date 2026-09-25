/**
 * The harness serving real agent state to a real page.
 *
 * `shim.e2e.mjs` in the extension already covers the shim reaching the bridge.
 * What is new here is the other half - bridge to page - so this drives the
 * endpoint the way the shim does and watches the SSE stream a browser opens.
 *
 * It is the standalone path end to end, minus the window: no VS Code anywhere.
 * Running it on all three platforms is the point, because the endpoint is a
 * named pipe on Windows and a Unix socket elsewhere, and the two differ in ways
 * that have caught bugs before - including the one this file's `fire` works
 * around.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SERVE = join(import.meta.dirname, '..', 'scripts', 'serve.mjs');
const BUDGET_MS = 15000;

/** An endpoint of our own, so a companion already running is left alone. */
function endpointFor(id) {
  return process.platform === 'win32'
    ? ['', '', '.', 'pipe', 'agent-companion-harness-' + id].join('\\')
    : join(tmpdir(), 'ac-harness-' + id + '.sock');
}

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(ready, what, log = () => '') {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for ' + what + '\n' + log());
}

async function startHarness() {
  const id = process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const endpoint = endpointFor(id);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE], {
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_COMPANION_VSCODE_SOCKET: endpoint,
      AGENT_COMPANION_VSCODE_STATE: join(tmpdir(), 'ac-harness-' + id + '.json'),
    },
  });

  let log = '';
  let exited = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  child.on('exit', code => { exited = code; });

  try {
    await waitFor(
      () => exited !== null
        || /Bridge (leader|subscriber)|No agent bridge|did not start/.test(log),
      'the harness to start', () => log);
  } catch (error) {
    // Nothing has registered cleanup yet, so a readiness failure would
    // otherwise leave the server running and wedge the runner.
    child.kill();
    throw error;
  }

  // Only an unbuilt workspace is a precondition. Every other outcome - a dead
  // server, a bridge that could not start, or a subscriber role on an endpoint
  // nothing else should hold - is a genuine failure and must not skip.
  if (exited !== null) {
    throw new Error('the harness exited with ' + exited + '\n' + log);
  }
  if (/No agent bridge/.test(log)) { child.kill(); return null; }
  if (!/Bridge leader/.test(log)) {
    child.kill();
    throw new Error('expected the bridge to lead its own endpoint, got:\n' + log);
  }

  return { endpoint, port, stop: () => child.kill(), log: () => log };
}

/** The stream a browser opens. */
function openStream(port) {
  return new Promise(resolve => {
    const frames = [];
    let pending = '';
    const request = get('http://127.0.0.1:' + port + '/events', response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        // A chunk boundary is not a line boundary. Keep the trailing partial
        // line back until the rest of it arrives, or a split frame would be
        // parsed as truncated JSON and take the test down with it.
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      });
      response.on('error', () => {});
      resolve({ frames, close: () => request.destroy() });
    });
    // The server is killed when the test ends, which resets this. Expected.
    request.on('error', () => {});
  });
}

/**
 * Write one hook line exactly as the shim does, and never wait for a reply.
 *
 * Waiting for `close` deadlocks on Windows, where a named pipe has no
 * half-close and the server may hold the connection open. The shim has the same
 * contract for the same reason, with the same belt-and-braces timeout.
 */
function fire(endpoint, event, payload = {}) {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };

    const line = JSON.stringify({
      type: 'hook', event, payload: { session_id: 'harness-test', ...payload },
    }) + '\n';

    const socket = createConnection(endpoint, () => {
      // The callback fires once the line is flushed, so destroying is safe.
      socket.end(line, done);
    });
    socket.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

test('agent hooks reach the page as state, with no VS Code running', async t => {
  const harness = await startHarness();
  if (!harness) {
    t.skip('the agent-state build is missing, so the harness has no bridge');
    return;
  }

  let stream;
  // Registered before anything can throw, so a failure never orphans the
  // server and wedges the runner.
  t.after(() => { stream?.close(); harness.stop(); });

  stream = await openStream(harness.port);
  const seen = () => stream.frames.map(frame => frame.state).join(' -> ');

  // A page opened mid-session is told where things stand rather than waiting.
  await waitFor(() => stream.frames.length > 0, 'the opening frame', harness.log);
  assert.equal(stream.frames[0].state, 'idle');
  assert.equal(stream.frames[0].bridge, 'leader');

  const expect = async (event, payload, state) => {
    const mark = stream.frames.length;
    await fire(harness.endpoint, event, payload);
    // Either a new frame carried it, or it was already the state and the
    // coordinator rightly published nothing.
    await waitFor(
      () => stream.frames.slice(mark).some(frame => frame.state === state)
        || stream.frames.at(-1).state === state,
      '"' + state + '" after ' + event + ' (saw: ' + seen() + ')', harness.log);
  };

  await expect('preToolUse', { tool_name: 'Bash' }, 'working');
  await expect('notification', { notification_type: 'permission_prompt' }, 'attention');
  await expect('userPromptSubmitted', {}, 'working');
  // userPromptSubmitted clears hadWork, and a stop only celebrates a turn that
  // actually ran something - so a tool call has to happen before the stop.
  await expect('preToolUse', { tool_name: 'Edit' }, 'working');
  await expect('agentStop', {}, 'complete');
});

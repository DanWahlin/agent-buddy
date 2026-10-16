import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import type {DaemonRequest, HookEvent} from '../src/protocol.js';
import {StateCoordinator} from '../src/state-coordinator.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// A tool result can be larger than the hook reader keeps. The conversation id is at the front of
// that payload, and a later stop has to clear the same conversation.
test('oversized Cursor hook input keeps the conversation and a later stop clears it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cursor-hook-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\cursor-hook-${process.pid}-${Date.now()}` : join(folder, 'daemon.sock');
  const coordinator = new StateCoordinator(() => {}, {sweepMs: 0});
  const requests: DaemonRequest[] = [];
  const server: Server = createServer({allowHalfOpen: true}, socket => {
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    const handle = () => {
      if (handled) return;
      const newline = input.indexOf('\n');
      const text = (newline >= 0 ? input.slice(0, newline) : input).trim();
      if (!text) return;
      handled = true;
      const request = JSON.parse(text) as DaemonRequest;
      requests.push(request);
      if (request.type === 'hook' && typeof request.event === 'string')
        coordinator.handle(request.event as HookEvent, request.payload ?? {});
      socket.end(`${JSON.stringify({ok: true, state: coordinator.state})}\n`);
    };
    socket.on('data', chunk => {
      input += chunk;
      if (input.includes('\n')) handle();
    });
    socket.on('end', handle);
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    const body = JSON.stringify({
      conversation_id: 'conv-keep',
      parent_conversation_id: 'parent-keep',
      hook_event_name: 'afterShellExecution',
      output: 'x'.repeat(4 * 1024 * 1024),
    });
    assert.ok(body.length > 4 * 1024 * 1024);
    const shell = await runHook(socketPath, 'afterShellExecution', body);
    assert.equal(shell.stdout, '{}\n');
    const posted = requests[0];
    if (posted?.type !== 'hook') assert.fail(`expected a hook, got ${posted?.type}`);
    assert.equal(posted.event, 'postToolUse');
    assert.equal(posted.payload.sessionId, 'cursor:conv-keep');
    assert.equal(posted.payload.parentSessionId, 'cursor:parent-keep');
    assert.equal(coordinator.state, 'working');
    assert.equal(coordinator.snapshot().sessions.some(session => session.id === 'unknown-session'), false);

    const stop = await runHook(socketPath, 'stop', JSON.stringify({
      conversation_id: 'conv-keep', status: 'completed',
    }));
    assert.equal(stop.stdout, '{}\n');
    assert.equal(coordinator.state, 'complete');
    assert.equal(coordinator.snapshot().sessions.some(session => session.id === 'cursor:conv-keep'), true);
    assert.equal(coordinator.snapshot().sessions.some(session => session.id === 'unknown-session'), false);
  } finally {
    coordinator.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(folder, {recursive: true, force: true});
  }
});

function runHook(socketPath: string, event: string, input: string): Promise<{stdout: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'hook', 'cursor', event], {
      env: {...process.env, AGENT_COMPANION_SOCKET: socketPath},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook ${event} timed out: ${stderr}`));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`hook ${event} exited ${code}: ${stderr}`));
      else resolve({stdout});
    });
    child.stdin.end(input);
  });
}

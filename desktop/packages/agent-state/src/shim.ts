#!/usr/bin/env node
/**
 * The hook shim: `node shim.js <event>`, with the agent's JSON on stdin.
 *
 * This runs inside someone's agent session, so the contract is that it is
 * invisible. It always exits 0, it never writes to stdout or stderr, and it
 * gives up quickly if no window is listening. A companion that can break a
 * session, or slow one down, is not worth having.
 */

import { createConnection } from 'node:net';
import { endpointPath } from './paths.js';

const CONNECT_TIMEOUT_MS = 1000;
const TOTAL_TIMEOUT_MS = 2000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    // A hook payload is small; a runaway one is not worth forwarding.
    if (size > 64 * 1024) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(event: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };

    const socket = createConnection(endpointPath());
    socket.setTimeout(CONNECT_TIMEOUT_MS, done);
    socket.on('error', done);
    socket.on('close', done);
    socket.on('connect', () => {
      socket.setTimeout(0);
      // The project root, so the right window reacts. It is only in the agent's
      // environment, which this inherits by being its child - and it is steadier
      // than the payload's `cwd`, which follows the agent into a worktree.
      const projectDir = process.env.CLAUDE_PROJECT_DIR;
      socket.end(JSON.stringify({ type: 'hook', event, payload, projectDir }) + '\n');
    });
    // Nothing is waiting on the reply, so do not linger for one.
    socket.on('data', done);
    setTimeout(done, TOTAL_TIMEOUT_MS).unref?.();
  });
}

async function main(): Promise<void> {
  const event = process.argv[2];
  if (!event) return;

  let payload: Record<string, unknown> = {};
  try {
    const input = await readStdin();
    if (input.trim()) {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // An unreadable payload still tells us the event happened; the coordinator
    // falls back to a single unknown session.
  }

  await send(event, payload);
}

main().catch(() => undefined).finally(() => process.exit(0));

import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createConnection, createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {handleSocket} from '../src/daemon.js';

async function withServer(run: (path: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'companion-protocol-'));
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\companion-protocol-${process.pid}-${Date.now()}` : join(folder, 'daemon.sock');
  const server: Server = createServer({allowHalfOpen: true}, socket =>
    handleSocket(socket, {} as never, {} as never, {} as never, () => 'http://127.0.0.1:1234/'));
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await run(path);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(folder, {recursive: true, force: true});
  }
}

function exchange(path: string, send: (socket: ReturnType<typeof createConnection>) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('no reply'));
    }, 1000);
    socket.setEncoding('utf8');
    socket.on('connect', () => send(socket));
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(reply));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

test('answers at the newline so Windows named-pipe clients need not half-close', async () => {
  await withServer(async path => {
    const request = `${JSON.stringify({type: 'settings'})}\n`;
    const expected = {url: 'http://127.0.0.1:1234/'};
    assert.deepEqual(await exchange(path, socket => socket.write(request)), expected);
    assert.deepEqual(await exchange(path, socket => socket.end(request)), expected);
    // Only Unix sockets answer a request that ends at a half-close: a named pipe closes for both sides.
    if (process.platform !== 'win32')
      assert.deepEqual(await exchange(path, socket => socket.end(JSON.stringify({type: 'settings'}))), expected);
    const split = await exchange(path, socket => {
      socket.write('{"type":');
      setTimeout(() => socket.write('"settings"}\n'), 20);
    });
    assert.deepEqual(split, expected);
    const bad = await exchange(path, socket => socket.write('not json\n')) as {ok: boolean};
    assert.equal(bad.ok, false);
  });
});

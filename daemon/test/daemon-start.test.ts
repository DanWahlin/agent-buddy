import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('a daemon that finds another daemon on its socket exits at once with an error', {
  skip: process.platform === 'win32' && 'Windows uses a named pipe',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-start-'));
  const socket = join(root, 'daemon.sock');
  const other = createServer(connection => connection.destroy());
  await new Promise<void>(resolve => other.listen(socket, resolve));
  try {
    const child = spawn(process.execPath, [cli, 'daemon'], {
      env: {...process.env, HOME: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root,
            AGENT_COMPANION_SOCKET: socket, AGENT_COMPANION_STATE: join(root, 'state.json')},
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('The daemon did not exit.'));
      }, 20_000);
      child.once('exit', exitCode => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 1);
    assert.match(errors, /already listening/);
  } finally {
    await new Promise<void>(resolve => other.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});

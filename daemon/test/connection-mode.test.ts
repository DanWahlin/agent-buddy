import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {isConnectionMode, loadConnectionMode, saveConnectionMode} from '../src/connection-mode.js';

test('persists the connection mode and defaults to auto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-connection-'));
  const previous = process.env.AGENT_COMPANION_CONNECTION_CONFIG;
  process.env.AGENT_COMPANION_CONNECTION_CONFIG = join(directory, 'connection.json');
  try {
    assert.equal(await loadConnectionMode(), 'auto');
    await saveConnectionMode('wifi');
    assert.equal(await loadConnectionMode(), 'wifi');
    await writeFile(join(directory, 'connection.json'), '{"mode":"bluetooth"}');
    assert.equal(await loadConnectionMode(), 'auto');
    assert.equal(isConnectionMode('usb'), true);
    assert.equal(isConnectionMode('WIFI'), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_CONNECTION_CONFIG;
    else process.env.AGENT_COMPANION_CONNECTION_CONFIG = previous;
  }
});

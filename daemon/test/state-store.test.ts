import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {StateStore} from '../src/state-store.js';
import type {PersistedCoordinatorState} from '../src/state-coordinator.js';

// Windows has no POSIX permission bits, so mode checks run only on macOS and Linux.
const posix = process.platform !== 'win32';

const saved: PersistedCoordinatorState = {
  version: 1,
  sessions: [{
    id: 'one',
    activeUntil: 2000,
    attentionUntil: 0,
    lastMainEventAt: 1000,
    lastSeenAt: 1000,
    hadWork: true,
    completionPending: false,
    subagents: [{id: 'id:child', instances: 1, leaseUntil: 3000, lastEventAt: 1000}],
  }],
};

test('atomically persists private daemon state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'nested', 'state.json');
  const store = new StateStore(path);
  await store.flush(saved);
  assert.deepEqual(await store.load(), saved);
  if (posix) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'nested'))).mode & 0o777, 0o700);
  }
});

test('quarantines malformed persistence rather than failing startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'state.json');
  await writeFile(path, '{"version":99}\n');
  const store = new StateStore(path);
  assert.equal(await store.load(), undefined);
  const files = await import('node:fs/promises').then(fs => fs.readdir(directory));
  assert.equal(files.length, 1);
  assert.match(files[0] ?? '', /^state\.json\.invalid-\d+$/);
  assert.match(await readFile(join(directory, files[0] ?? ''), 'utf8'), /version/);
});

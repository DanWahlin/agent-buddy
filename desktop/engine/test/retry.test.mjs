import assert from 'node:assert/strict';
import test from 'node:test';
import {PermanentError, retry} from '../../apps/desktop/scripts/retry.mjs';

const quick = {delayMs: 1};

test('a task that fails for a while is tried again', async () => {
  let calls = 0;
  assert.equal(await retry('Task', async () => {
    if (++calls < 3) throw new Error('timed out');
    return 'done';
  }, quick), 'done');
  assert.equal(calls, 3);
});

test('a task stops after its attempts, with the last error', async () => {
  let calls = 0;
  await assert.rejects(retry('Task', async () => {
    throw new Error(`timed out ${++calls}`);
  }, {...quick, attempts: 2}), /timed out 2/);
  assert.equal(calls, 2);
});

test('a permanent error is not tried again', async () => {
  let calls = 0;
  await assert.rejects(retry('Task', async () => {
    calls++;
    throw new PermanentError('HTTP 404');
  }, quick), PermanentError);
  assert.equal(calls, 1);
});

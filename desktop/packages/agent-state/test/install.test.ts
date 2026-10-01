/**
 * Giving the shim a home that outlives whichever host installed it.
 *
 * Hooks name the shim by path, and Copilot CLI's preToolUse is fail-closed: a
 * shim that cannot be run denies the tool call rather than going unheard. So
 * the ways this can go wrong are not cosmetic, and each has a test.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installShim, removeShim } from '../src/install.js';
import { shimPath } from '../src/paths.js';
import { mergeClaudeCodeHooks, removeClaudeCodeHooks } from '../src/hooks.js';

const scratch: string[] = [];
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-companion-install-'));
  scratch.push(directory);
  return directory;
}

test.after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

test('the shim lands where it was asked to, contents intact', async () => {
  const where = await workspace();
  const built = join(where, 'hook-built.js');
  await writeFile(built, 'console.log("shim");');
  // A directory that does not exist yet, which is the first-run case.
  const target = join(where, 'installed', 'hook.js');

  const result = await installShim(built, target);
  assert.equal(result.path, target);
  assert.equal(result.replaced, true);
  assert.equal(await readFile(target, 'utf8'), 'console.log("shim");');
});

/** Size alone would miss this, and the new shim would never be installed. */
test('a rebuild that comes out the same length still replaces the old one', async () => {
  const where = await workspace();
  const built = join(where, 'hook.js');
  const target = join(where, 'installed', 'hook.js');

  await writeFile(built, 'AAAA');
  await installShim(built, target);
  await writeFile(built, 'BBBB');

  assert.equal((await installShim(built, target)).replaced, true);
  assert.equal(await readFile(target, 'utf8'), 'BBBB');
});

test('installing the same shim twice does not rewrite it', async () => {
  const where = await workspace();
  const built = join(where, 'hook.js');
  await writeFile(built, 'same');
  const target = join(where, 'installed', 'hook.js');

  assert.equal((await installShim(built, target)).replaced, true);
  assert.equal((await installShim(built, target)).replaced, false);
});

test('a newer build replaces the installed one', async () => {
  const where = await workspace();
  const built = join(where, 'hook.js');
  const target = join(where, 'installed', 'hook.js');

  await writeFile(built, 'old');
  await installShim(built, target);
  await writeFile(built, 'a longer, newer shim');
  assert.equal((await installShim(built, target)).replaced, true);
  assert.equal(await readFile(target, 'utf8'), 'a longer, newer shim');
});

/**
 * A copy can be caught half-written; a rename cannot. An agent firing a hook
 * mid-install must find either the old shim or the new one, never a truncated
 * file - which on Copilot CLI would block the tool call.
 */
test('nothing is left behind in the shim\'s directory', async () => {
  const where = await workspace();
  const built = join(where, 'hook.js');
  await writeFile(built, 'shim');
  const target = join(where, 'installed', 'hook.js');

  await installShim(built, target);
  await writeFile(built, 'shim, changed');
  await installShim(built, target);

  assert.deepEqual(await readdir(join(where, 'installed')), ['hook.js'],
    'a staging file was left where an agent could try to run it');
});

test('removing it is safe to repeat, and safe when it was never there', async () => {
  const where = await workspace();
  const built = join(where, 'hook.js');
  await writeFile(built, 'shim');
  const target = join(where, 'installed', 'hook.js');

  await installShim(built, target);
  assert.equal(await removeShim(target), true);
  assert.equal(await removeShim(target), true);
  assert.equal(await removeShim(join(where, 'never', 'hook.js')), true);
});

test('the shim has a home of its own, not one inside a host', () => {
  const windows = shimPath('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.equal(windows, 'C:\\Users\\me\\AppData\\Local\\AgentCompanion\\hook.js');

  const mac = shimPath('darwin', {}, '/Users/me');
  assert.equal(mac, '/Users/me/Library/Application Support/Agent Companion/hook.js');

  const linux = shimPath('linux', { XDG_STATE_HOME: '/home/me/.local/state' });
  assert.equal(linux, '/home/me/.local/state/agent-companion-vscode/hook.js');
});

/**
 * The migration that matters.
 *
 * Existing installs name a shim inside a versioned extension directory. That
 * path stops resolving on the next update, and a stale entry left beside a good
 * one still denies every Copilot tool call - so installing has to replace it,
 * not sit next to it.
 */
test('an older install pointing into an extension directory is replaced, not doubled', () => {
  const stale = 'C:\\Users\\me\\.vscode\\extensions\\'
    + 'darrenjrobinson.agent-companion-0.1.0\\dist\\hook.js';
  const settings = {
    hooks: {
      PreToolUse: [{
        hooks: [{ type: 'command', command: 'node', args: [stale, 'preToolUse'], async: true }],
      }],
    },
  };

  const merged = mergeClaudeCodeHooks(settings, {
    node: 'node', shim: 'C:\\Users\\me\\AppData\\Local\\AgentCompanion\\hook.js',
  });

  const entries = (merged.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(entries.length, 1, 'the stale entry should be gone, not kept alongside');
  const args = ((entries[0] as { hooks: Array<{ args: string[] }> }).hooks[0]).args;
  assert.ok(args[0].includes('AgentCompanion'), 'should name the new home: ' + args[0]);
});

test('removing takes an older install out too, wherever it pointed', () => {
  const stale = '/home/me/.vscode-server/extensions/'
    + 'darrenjrobinson.agent-companion-0.1.0/dist/hook.js';
  const settings = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: [stale, 'preToolUse'] }] }],
    },
  };

  const cleaned = removeClaudeCodeHooks(settings, '/home/me/.local/state/x/hook.js');
  assert.equal(cleaned.hooks, undefined, 'nothing of ours should be left: '
    + JSON.stringify(cleaned));
});

test('somebody else\'s hook is left alone, even one that runs a hook.js', () => {
  const theirs = '/home/me/tools/my-linter/hook.js';
  const settings = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: [theirs, 'x'] }] }],
    },
  };

  const cleaned = removeClaudeCodeHooks(settings, '/home/me/.local/state/x/hook.js');
  const entries = (cleaned.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(entries.length, 1, 'that is not ours to remove');
});

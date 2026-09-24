import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  UNATTRIBUTED, combineStates, folderContains, normaliseFolder, projectOf, routeIsVisibleTo, routeOf,
} from '../src/routing.js';

test('a Windows path compares case-insensitively, a POSIX one does not', () => {
  assert.equal(normaliseFolder('C:\\Repos\\Thing', 'win32'), 'c:/repos/thing');
  assert.equal(normaliseFolder('/Repos/Thing', 'linux'), '/Repos/Thing');
});

test('trailing separators do not change a folder', () => {
  assert.equal(normaliseFolder('/repo/', 'linux'), '/repo');
  assert.equal(normaliseFolder('/repo///', 'linux'), '/repo');
  assert.equal(normaliseFolder('C:\\repo\\', 'win32'), 'c:/repo');
});

test('the project root wins over cwd, because cwd follows the agent', () => {
  // Claude Code moves cwd into a worktree; the project root stays put.
  assert.equal(
    projectOf({ cwd: '/repo/.worktrees/spike' }, '/repo'),
    '/repo');
});

test('cwd is used when no project root was captured', () => {
  assert.equal(projectOf({ cwd: '/repo' }), '/repo');
  assert.equal(projectOf({ cwd: '/repo' }, '   '), '/repo');
});

test('a payload with nowhere in it cannot be placed', () => {
  assert.equal(projectOf({}), null);
  assert.equal(projectOf(undefined), null);
  assert.equal(projectOf({ cwd: '' }), null);
  // Copilot CLI may not send a cwd at all; a non-string must not be trusted.
  assert.equal(projectOf({ cwd: 42 as unknown as string }), null);
});

test('an unplaceable hook routes to the shared bucket', () => {
  assert.equal(routeOf({}), UNATTRIBUTED);
  assert.equal(routeOf({ cwd: '/repo' }, undefined, 'linux'), '/repo');
  assert.equal(routeOf({ cwd: 'C:\\Repo' }, undefined, 'win32'), 'c:/repo');
});

test('a folder contains itself and what is under it', () => {
  assert.equal(folderContains('/repo', '/repo', 'linux'), true);
  assert.equal(folderContains('/repo', '/repo/src/deep', 'linux'), true);
  assert.equal(folderContains('/repo/', '/repo/src', 'linux'), true);
});

/** The bug a naive startsWith would have: a sibling that shares a prefix. */
test('a folder does not claim a sibling that merely starts the same', () => {
  assert.equal(folderContains('/repo', '/repo-backup', 'linux'), false);
  assert.equal(folderContains('/repo', '/repository', 'linux'), false);
  assert.equal(folderContains('C:\\repo', 'C:\\repo-old', 'win32'), false);
});

test('a window sees its own project and not another', () => {
  assert.equal(routeIsVisibleTo('/repo-a/src', ['/repo-a'], 'linux'), true);
  assert.equal(routeIsVisibleTo('/repo-b', ['/repo-a'], 'linux'), false);
});

test('a multi-root window sees any of its folders', () => {
  const folders = ['/repo-a', '/repo-b'];
  assert.equal(routeIsVisibleTo('/repo-b/src', folders, 'linux'), true);
  assert.equal(routeIsVisibleTo('/repo-c', folders, 'linux'), false);
});

test('an unattributed session is shown everywhere, so it is never invisible', () => {
  assert.equal(routeIsVisibleTo(UNATTRIBUTED, ['/repo-a'], 'linux'), true);
  assert.equal(routeIsVisibleTo(UNATTRIBUTED, [], 'linux'), true);
});

test('a window with no folders sees everything, as it did before routing', () => {
  assert.equal(routeIsVisibleTo('/anywhere', [], 'linux'), true);
});

test('Windows matching ignores case and separator, because the OS does', () => {
  assert.equal(routeIsVisibleTo('c:/repo/src', ['C:\\Repo'], 'win32'), true);
  assert.equal(routeIsVisibleTo('c:/repo/src', ['C:\\Repo'], 'linux'), false);
});

test('the loudest route wins, in the coordinator\'s own order', () => {
  assert.equal(combineStates(['idle', 'working']), 'working');
  assert.equal(combineStates(['working', 'attention']), 'attention');
  assert.equal(combineStates(['complete', 'working']), 'working');
  assert.equal(combineStates(['idle', 'complete']), 'complete');
});

test('nothing at all is idle', () => {
  assert.equal(combineStates([]), 'idle');
  assert.equal(combineStates(['idle', 'idle']), 'idle');
});

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {initialOnboarding, isOnboardingChange, OnboardingStore, readOnboarding} from '../src/onboarding.js';

test('older installations do not get forced into onboarding; new desktop setup is explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'onboarding.json');
  try {
    const store = new OnboardingStore(path);
    assert.equal(store.state.completed, true);
    assert.equal(readOnboarding(path), null);
    await store.reset();
    assert.deepEqual(new OnboardingStore(path).state, initialOnboarding());
    assert.equal(store.state.completed, false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('setup choices survive restarts and concurrent saves without changing completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'nested', 'onboarding.json');
  try {
    const store = new OnboardingStore(path);
    await store.reset();
    await Promise.all([
      store.update({step: 'agents', agents: ['codex'], agentStage: 'connect'}),
      store.update({character: 'claude', display: 'both'}),
      store.update({deferredAgents: ['codex'], deviceDeferred: true}),
    ]);
    const resumed = new OnboardingStore(path).state;
    assert.equal(resumed.step, 'agents');
    assert.equal(resumed.agentStage, 'connect');
    assert.deepEqual(resumed.agents, ['codex']);
    assert.equal(resumed.character, 'claude');
    assert.equal(resumed.display, 'both');
    assert.equal(resumed.deviceDeferred, true);
    assert.deepEqual(resumed.deferredAgents, ['codex']);
    assert.equal(resumed.completed, false);
    await store.finish();
    assert.equal(new OnboardingStore(path).state.completed, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).step, 'complete');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('setup input cannot grant completion, inject unknown agents, or use malformed choices', () => {
  for (const value of [
    null, [], {completed: true}, {visitedSteps: ['complete']}, {agents: ['unknown']}, {agents: ['codex', 'codex']},
    {character: '../secret'}, {display: 'cloud'}, {deviceDeferred: 'true'}, {agentStage: false}, {port: ''},
  ]) assert.equal(isOnboardingChange(value), false, JSON.stringify(value));
  assert.equal(isOnboardingChange({step: 'character', agents: [], deferredAgents: ['hermes'], character: 'openclaw',
                                  display: 'desktop', agentsDeferred: true, port: null}), true);
});

test('visited steps survive backward navigation, restarts, and setup reruns without unlocking skipped steps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'onboarding.json');
  try {
    const store = new OnboardingStore(path);
    await store.reset();
    await store.update({step: 'agents', agents: ['copilot']});
    await store.update({step: 'character', character: 'claude'});
    await store.update({step: 'display', display: 'desktop'});
    await store.update({step: 'complete'});
    await store.update({step: 'agents'});
    assert.deepEqual(store.state.visitedSteps, ['welcome', 'agents', 'character', 'display', 'complete']);
    const reopened = new OnboardingStore(path);
    assert.deepEqual(reopened.state.visitedSteps, store.state.visitedSteps);
    await reopened.reset({agents: store.state.agents, character: store.state.character}, true);
    assert.equal(reopened.state.step, 'welcome');
    assert.deepEqual(reopened.state.visitedSteps, store.state.visitedSteps);
    assert.equal(reopened.state.visitedSteps.includes('firmware'), false);
    await reopened.reset();
    assert.deepEqual(reopened.state.visitedSteps, ['welcome']);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('older setup records gain safe visited history and malformed history reports an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'onboarding.json');
  try {
    const {visitedSteps: _visited, ...legacy} = {...initialOnboarding(), step: 'complete', completed: true};
    await writeFile(path, JSON.stringify(legacy));
    assert.deepEqual(readOnboarding(path)?.visitedSteps, ['welcome', 'agents', 'character', 'display', 'complete']);
    await writeFile(path, JSON.stringify({...legacy, step: 'firmware', completed: false, display: 'both'}));
    assert.deepEqual(readOnboarding(path)?.visitedSteps, ['welcome', 'agents', 'character', 'display', 'firmware']);
    for (const visitedSteps of [null, 'welcome', ['welcome', 'unknown'], ['welcome', 'welcome'], ['complete'], ['welcome']]) {
      await writeFile(path, JSON.stringify({...legacy, visitedSteps}));
      assert.throws(() => readOnboarding(path), /progress is invalid/);
      assert.match(new OnboardingStore(path).problem ?? '', /Saved setup progress/);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('invalid persistence keeps setup incomplete, reports recovery, and preserves the damaged file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'onboarding.json');
  try {
    for (const text of ['{"version":1,"completed":true}', '{bad', 'null', '[]',
      JSON.stringify({...initialOnboarding(true), step: 'agents', visitedSteps: ['welcome', 'agents']})]) {
      await writeFile(path, text);
      assert.throws(() => readOnboarding(path), /invalid/);
      const store = new OnboardingStore(path);
      assert.equal(store.state.completed, false);
      assert.equal(store.state.step, 'welcome');
      assert.match(store.problem ?? '', /damaged file.*kept/);
      assert.equal(await readFile(path, 'utf8'), text);
      const before = new Set(await readdir(directory));
      await store.update({step: 'agents'});
      const backup = (await readdir(directory)).find(name => !before.has(name) && name.endsWith('.invalid'));
      assert.ok(backup);
      assert.equal(await readFile(join(directory, backup), 'utf8'), text);
      assert.equal(store.problem, null);
      assert.equal(new OnboardingStore(path).state.step, 'agents');
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a failed save leaves progress intact and removes its temporary file before retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onboarding-'));
  const path = join(directory, 'onboarding.json');
  try {
    const store = new OnboardingStore(path);
    await store.reset();
    await rm(path);
    await mkdir(path);
    await assert.rejects(store.update({step: 'agents'}));
    assert.equal(store.state.step, 'welcome');
    assert.deepEqual(await readdir(directory), ['onboarding.json']);
    await rm(path, {recursive: true});
    await store.update({step: 'agents'});
    assert.equal(new OnboardingStore(path).state.step, 'agents');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

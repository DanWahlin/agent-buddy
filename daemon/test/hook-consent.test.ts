import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {agentStatuses, defaultAgentContext, initializeHookConsent, installAgent, installDetectedAgents} from '../src/agents/index.js';
import {loadAgentsConfig, updateAgentsConfig} from '../src/agents/config.js';
import {copilotAdapter} from '../src/agents/copilot.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hook-consent-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const config = join(data, 'agents.json');
  const node = join(root, 'node');
  const cli = join(root, 'daemon', 'dist', 'src', 'cli.js');
  const claude = join(home, '.claude', 'settings.json');
  await mkdir(dirname(cli), {recursive: true});
  await mkdir(dirname(claude), {recursive: true});
  await writeFile(node, '');
  await writeFile(cli, '');
  await writeFile(claude, '{"theme":"dark"}');
  const ctx = defaultAgentContext({home, node, cli, dataDir: data, platform: 'darwin',
    env: {PATH: '', AGENT_COMPANION_AGENTS_CONFIG: config},
    runCommand: async () => ({stdout: '', status: 0}), appFolders: []});
  return {root, ctx, config, claude, cleanup: () => rm(root, {recursive: true, force: true})};
}

test('fresh desktop setup and updates install no unapproved agent hooks', async () => {
  const {ctx, config, claude, cleanup} = await fixture();
  try {
    await initializeHookConsent(ctx, true);
    assert.deepEqual((await loadAgentsConfig(config)).approved, {});
    assert.ok(agentStatuses(ctx, new Map(), new Map()).every(agent => !agent.enabled));
    const results = await installDetectedAgents(ctx, {});
    assert.ok(results.every(result => !result.installed));
    assert.equal(await readFile(claude, 'utf8'), '{"theme":"dark"}');
    assert.equal(existsSync(join(ctx.home, '.copilot', 'hooks', 'agent-companion.json')), false);
    await installAgent('claude', ctx);
    assert.equal((await loadAgentsConfig(config)).approved?.claude, true);
    const update = await installDetectedAgents(ctx, {});
    assert.equal(update.find(result => result.id === 'claude')?.installed, true);
    assert.equal(update.find(result => result.id === 'copilot')?.installed, false);
    await updateAgentsConfig(state => { state.enabled.claude = false; }, config);
    assert.equal((await installDetectedAgents(ctx, {})).find(result => result.id === 'claude')?.installed, false);
  } finally {
    await cleanup();
  }
});

test('legacy migration preserves existing hook consent without adding newly detected agents', async () => {
  const {ctx, config, claude, cleanup} = await fixture();
  try {
    await copilotAdapter.install(ctx);
    await initializeHookConsent(ctx, false);
    assert.deepEqual((await loadAgentsConfig(config)).approved, {copilot: true});
    const results = await installDetectedAgents(ctx, {});
    assert.equal(results.find(result => result.id === 'copilot')?.installed, true);
    assert.equal(results.find(result => result.id === 'claude')?.installed, false);
    assert.equal(await readFile(claude, 'utf8'), '{"theme":"dark"}');
  } finally {
    await cleanup();
  }
});

test('explicit command-line setup can install detected hooks while respecting removals', async () => {
  const {ctx, config, cleanup} = await fixture();
  try {
    await initializeHookConsent(ctx, true);
    const results = await installDetectedAgents(ctx, {copilot: true}, false);
    assert.equal(results.find(result => result.id === 'copilot')?.installed, false);
    assert.equal(results.find(result => result.id === 'claude')?.installed, true);
    assert.equal((await loadAgentsConfig(config)).approved?.claude, true);
  } finally {
    await cleanup();
  }
});

test('unreadable consent fails closed without installing hooks or rewriting the damaged file', async () => {
  const {ctx, config, claude, cleanup} = await fixture();
  try {
    await mkdir(dirname(config), {recursive: true});
    await writeFile(config, '{invalid');
    const loaded = await loadAgentsConfig(config);
    assert.deepEqual(loaded.approved, {});
    assert.match(loaded.problem ?? '', /Hooks are disabled/);
    const results = await installDetectedAgents(ctx, {});
    assert.ok(results.every(result => !result.installed));
    assert.equal(await readFile(config, 'utf8'), '{invalid');
    assert.equal(await readFile(claude, 'utf8'), '{"theme":"dark"}');
  } finally {
    await cleanup();
  }
});

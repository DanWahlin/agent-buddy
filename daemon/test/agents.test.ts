import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {lstat, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {parseDocument} from 'yaml';
import {claudeAdapter} from '../src/agents/claude.js';
import {codexAdapter} from '../src/agents/codex.js';
import {copilotAdapter} from '../src/agents/copilot.js';
import {grokAdapter} from '../src/agents/grok.js';
import {hermesAdapter} from '../src/agents/hermes.js';
import {openclawAdapter} from '../src/agents/openclaw.js';
import {defaultAgentContext, shouldIgnoreGrokClaudeHook} from '../src/agents/index.js';
import {StateCoordinator} from '../src/state-coordinator.js';
import type {AgentContext} from '../src/agents/types.js';

async function fixture(): Promise<{home: string; ctx: AgentContext; cleanup: () => Promise<void>}> {
  const root = join(process.cwd(), '.test-output', `agents-${randomUUID()}`);
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const ctx = defaultAgentContext({
    home,
    node: '/opt/node/bin/node',
    cli: '/repo/agent companion/daemon/dist/src/cli.js',
    platform: 'darwin',
    env: {PATH: ''},
    dataDir: join(root, 'data'),
    socketPath: join(root, 'daemon.sock'),
    runCommand: async () => ({stdout: '', status: 0}),
  });
  return {home, ctx, cleanup: async () => rm(root, {recursive: true, force: true})};
}

test('Claude install is merge-safe, idempotent, backed up, and removable', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const settings = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), {recursive: true});
    await writeFile(settings, JSON.stringify({
      model: 'sonnet',
      hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: '/other/tool'}]}]},
    }, null, 2));
    await claudeAdapter.install(ctx);
    await claudeAdapter.install(ctx);
    const installed = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(installed.model, 'sonnet');
    assert.equal(installed.hooks.PreToolUse.length, 2);
    assert.equal(installed.hooks.PreToolUse.filter((group: {hooks: Array<{args?: string[]}>}) =>
      group.hooks.some(hook => hook.args?.[2] === 'claude')).length, 1);
    assert.equal(existsSync(`${settings}.bak`), true);
    await claudeAdapter.uninstall(ctx);
    const removed = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(removed.hooks.PreToolUse.length, 1);
    assert.equal(removed.hooks.PreToolUse[0].hooks[0].command, '/other/tool');
  } finally {
    await cleanup();
  }
});

test('Claude reinstall after a Node upgrade replaces the old hooks instead of duplicating them', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const settings = join(home, '.claude', 'settings.json');
    await claudeAdapter.install({...ctx, node: '/old/node/v22/bin/node'});
    await claudeAdapter.install({...ctx, node: '/new/node/v24/bin/node'});
    const installed = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].hooks[0].command, '/new/node/v24/bin/node');
    await claudeAdapter.uninstall(ctx);
    assert.equal(JSON.parse(await readFile(settings, 'utf8')).hooks, undefined);
  } finally {
    await cleanup();
  }
});

test('config edits write through symlinks and refuse malformed JSON', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const dotfiles = join(home, 'dotfiles');
    await mkdir(dotfiles, {recursive: true});
    await mkdir(join(home, '.claude'), {recursive: true});
    const real = join(dotfiles, 'claude-settings.json');
    const link = join(home, '.claude', 'settings.json');
    await writeFile(real, '{"model": "sonnet"}\n');
    await symlink(real, link);
    await claudeAdapter.install(ctx);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(JSON.parse(await readFile(real, 'utf8')).model, 'sonnet');
    assert.ok(JSON.parse(await readFile(real, 'utf8')).hooks.SessionStart);

    const codexHooks = join(home, '.codex', 'hooks.json');
    await mkdir(join(home, '.codex'), {recursive: true});
    for (const broken of ['[1, 2]\n', '{"hooks": {\n']) {
      await writeFile(codexHooks, broken);
      await assert.rejects(codexAdapter.install(ctx), /left unchanged/);
      assert.equal(await readFile(codexHooks, 'utf8'), broken);
    }
  } finally {
    await cleanup();
  }
});

test('Hermes refuses to edit a config it cannot parse safely', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const config = join(home, '.hermes', 'config.yaml');
    await mkdir(join(home, '.hermes'), {recursive: true});
    for (const broken of ['model: [unclosed\n', '- just\n- a list\n', 'a: 1\n---\nb: 2\n']) {
      await writeFile(config, broken);
      await assert.rejects(hermesAdapter.install(ctx), /left unchanged/);
      assert.equal(await readFile(config, 'utf8'), broken);
    }
  } finally {
    await cleanup();
  }
});

test('Codex install appends without shifting existing groups and reports approval', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const hooksPath = join(home, '.codex', 'hooks.json');
    await mkdir(join(home, '.codex'), {recursive: true});
    await writeFile(hooksPath, JSON.stringify({
      hooks: {PreToolUse: [{matcher: 'Shell', hooks: [{type: 'command', command: 'echo third-party'}]}]},
    }, null, 2));
    await codexAdapter.install(ctx);
    await codexAdapter.install(ctx);
    const installed = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.equal(installed.hooks.PreToolUse.length, 2);
    assert.equal(installed.hooks.PreToolUse[0].hooks[0].command, 'echo third-party');
    assert.match(installed.hooks.PreToolUse[1].hooks[0].command, /hook codex PreToolUse/);
    assert.equal(codexAdapter.hookStatus(ctx), 'needs-approval');
    await writeFile(join(home, '.codex', 'config.toml'), '[hooks.state."x:y:z"]\ntrusted_hash = "abc"\n');
    assert.equal(codexAdapter.hookStatus(ctx), 'needs-approval');
    // Approve every one of our hooks at its real position, the way Codex's /hooks review does.
    const installedHooks = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8')).hooks as
      Record<string, Array<{hooks: Array<{command?: string}>}>>;
    const keys: string[] = [];
    for (const [event, groups] of Object.entries(installedHooks)) {
      groups.forEach((group, groupIndex) => group.hooks.forEach((hook, hookIndex) => {
        if (hook.command?.includes('hook codex'))
          keys.push(`[hooks.state."${join(home, '.codex', 'hooks.json')}:${event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}:${groupIndex}:${hookIndex}"]`);
      }));
    }
    await writeFile(join(home, '.codex', 'config.toml'), keys.slice(1).map(key => `${key}\ntrusted_hash = "a"\n`).join(''));
    assert.equal(codexAdapter.hookStatus(ctx), 'needs-approval');
    await writeFile(join(home, '.codex', 'config.toml'), keys.map(key => `${key}\ntrusted_hash = "a"\n`).join(''));
    assert.equal(codexAdapter.hookStatus(ctx), 'installed');
    await codexAdapter.uninstall(ctx);
    const removed = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.equal(removed.hooks.PreToolUse.length, 1);
  } finally {
    await cleanup();
  }
});

test('Hermes install preserves YAML comments and removes only companion commands', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const config = join(home, '.hermes', 'config.yaml');
    await mkdir(join(home, '.hermes'), {recursive: true});
    await writeFile(config, '# keep this comment\nprofile: default\nhooks:\n  pre_tool_call:\n    - command: other-tool\n      timeout: 9\n');
    await hermesAdapter.install(ctx);
    await hermesAdapter.install(ctx);
    const installed = await readFile(config, 'utf8');
    assert.match(installed, /# keep this comment/);
    assert.equal((installed.match(/hook hermes pre_tool_call/g) ?? []).length, 1);
    assert.equal(parseDocument(installed).getIn(['hooks', 'pre_tool_call', 0, 'command']), 'other-tool');
    assert.equal(hermesAdapter.hookStatus(ctx), 'needs-approval');
    await hermesAdapter.uninstall(ctx);
    const removed = await readFile(config, 'utf8');
    assert.match(removed, /other-tool/);
    assert.doesNotMatch(removed, /hook hermes/);
  } finally {
    await cleanup();
  }
});

test('Grok drop-in and OpenClaw plugin install without touching other files', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    await mkdir(join(home, '.grok', 'hooks'), {recursive: true});
    await writeFile(join(home, '.grok', 'hooks', 'herdr.json'), '{"hooks":{}}\n');
    await grokAdapter.install(ctx);
    assert.equal(existsSync(join(home, '.grok', 'hooks', 'herdr.json')), true);
    assert.match(await readFile(join(home, '.grok', 'hooks', 'agent-companion.json'), 'utf8'), /hook grok PreToolUse/);
    await grokAdapter.uninstall(ctx);
    assert.equal(existsSync(join(home, '.grok', 'hooks', 'agent-companion.json')), false);
    await assert.rejects(openclawAdapter.install(ctx), /openclaw command wasn't found/);
    assert.equal(existsSync(join(ctx.dataDir, 'integrations', 'openclaw-plugin')), false);
    const bin = join(home, 'bin');
    await mkdir(bin, {recursive: true});
    await writeFile(join(bin, 'openclaw'), '#!/bin/sh\n', {mode: 0o755});
    const calls: string[][] = [];
    const withCli = {...ctx, env: {PATH: bin},
      runCommand: async (_command: string, args: string[]) => { calls.push(args); return {stdout: '', status: 0}; }};
    await openclawAdapter.install(withCli);
    assert.match(await readFile(join(ctx.dataDir, 'integrations', 'openclaw-plugin', 'index.js'), 'utf8'),
                 /agent: 'openclaw'/);
    assert.deepEqual(calls.map(args => args.slice(0, 2)), [['plugins', 'install'], ['plugins', 'enable'], ['config', 'set']]);
    await assert.rejects(openclawAdapter.install({...withCli, runCommand: async () => { throw new Error('boom'); }}), /boom/);
    assert.equal(openclawAdapter.hookStatus(withCli), 'missing');
  } finally {
    await cleanup();
  }
});

test('normalizers map attention, work, completion, and idle events per agent', () => {
  assert.deepEqual(claudeAdapter.normalize('PermissionRequest', {session_id: 's'}, 100)
    .map(hook => [hook.event, hook.payload.sessionId]), [['notification', 'claude:s']]);
  assert.deepEqual(codexAdapter.normalize('Interrupt', {session_id: 's'}, 100)
    .map(hook => hook.event), ['sessionEnd']);
  assert.deepEqual(grokAdapter.normalize('Stop', {sessionId: 's', reason: 'channel_closed'}, 100)
    .map(hook => hook.event), ['sessionEnd']);
  assert.deepEqual(hermesAdapter.normalize('pre_tool_call', {session_id: 's', tool_name: 'clarify'}, 100)
    .map(hook => hook.event), ['notification']);
  assert.deepEqual(openclawAdapter.normalize('agent_end', {sessionId: 's', success: true}, 100)
    .map(hook => hook.event), ['agentStop']);
  assert.deepEqual(copilotAdapter.normalize('errorOccurred', {sessionId: 's', recoverable: true}, 100), []);
  assert.deepEqual(copilotAdapter.normalize('errorOccurred', {sessionId: 's', recoverable: false}, 100)
    .map(hook => hook.event), ['errorOccurred']);
});

test('coordinator keeps multi-agent sessions isolated and reports display drivers', () => {
  const states: string[] = [];
  const coordinator = new StateCoordinator(state => states.push(state), {now: () => 1000, sweepMs: 0});
  coordinator.handle('preToolUse', {sessionId: 'claude:same'});
  coordinator.handle('notification', {sessionId: 'codex:same', notification_type: 'permission_prompt'});
  assert.equal(coordinator.state, 'attention');
  assert.deepEqual(coordinator.drivingAgents, ['codex']);
  assert.equal(coordinator.agentActivity().get('claude')?.activeSessions, 1);
  assert.equal(coordinator.agentActivity().get('codex')?.activeSessions, 1);
  coordinator.close();
});

test('agent-specific stop events can clear attention when the native agent resolves it', () => {
  const coordinator = new StateCoordinator(() => undefined, {now: () => 1000, sweepMs: 0});
  coordinator.handle('preToolUse', {sessionId: 'codex:s'});
  coordinator.handle('notification', {sessionId: 'codex:s', notification_type: 'permission_prompt'});
  assert.equal(coordinator.state, 'attention');
  coordinator.handle('agentStop', {sessionId: 'codex:s', clearAttention: true});
  assert.equal(coordinator.state, 'complete');
  coordinator.close();
});

test('Claude hooks invoked by Grok are ignored when Grok is enabled', async () => {
  const {home, cleanup} = await fixture();
  const oldPath = process.env.AGENT_COMPANION_AGENTS_CONFIG;
  try {
    await mkdir(join(home, '.grok', 'hooks'), {recursive: true});
    await writeFile(join(home, '.grok', 'hooks', 'agent-companion.json'), '{}\n');
    process.env.AGENT_COMPANION_AGENTS_CONFIG = join(home, 'agents.json');
    assert.equal(shouldIgnoreGrokClaudeHook({GROK_HOOK_EVENT: 'PreToolUse'}, {}, home), true);
    await writeFile(process.env.AGENT_COMPANION_AGENTS_CONFIG, '{"enabled":{"grok":false}}\n');
    assert.equal(shouldIgnoreGrokClaudeHook({GROK_HOOK_EVENT: 'PreToolUse'}, {}, home), false);
  } finally {
    if (oldPath === undefined) delete process.env.AGENT_COMPANION_AGENTS_CONFIG;
    else process.env.AGENT_COMPANION_AGENTS_CONFIG = oldPath;
    await cleanup();
  }
});

test('Hermes edits only the hooks block and keeps user hooks and formatting', async () => {
  const {replaceHooksSection} = await import('../src/agents/hermes.js');
  const source = [
    '# my config',
    'model:',
    '  default: nous/hermes  # pinned',
    'hooks:',
    '  pre_tool_call:',
    '    - command: /usr/local/bin/audit.sh',
    'personalities:',
    '    technical: You are a technical expert. Provide detailed, accurate technical information that is long.',
    '',
  ].join('\n');
  const next = replaceHooksSection(source, {
    pre_tool_call: [{command: '/usr/local/bin/audit.sh'}, {command: "'/n' '/c.js' hook hermes pre_tool_call", timeout: 5}],
  });
  assert.ok(next.startsWith('# my config\nmodel:\n  default: nous/hermes  # pinned\nhooks:\n'));
  assert.ok(next.endsWith('personalities:\n    technical: You are a technical expert. Provide detailed, accurate technical information that is long.\n'));
  assert.match(next, /audit\.sh[\s\S]*hook hermes pre_tool_call/);
  assert.equal(replaceHooksSection(next, {pre_tool_call: [{command: '/usr/local/bin/audit.sh'}]}).includes('hook hermes'), false);
  const removed = replaceHooksSection(source, {});
  assert.equal(removed, '# my config\nmodel:\n  default: nous/hermes  # pinned\npersonalities:\n    technical: You are a technical expert. Provide detailed, accurate technical information that is long.\n');
});

test('agents report the one-time step they still need', async () => {
  const {agentStatuses} = await import('../src/agents/index.js');
  const home = join('/tmp', `agent-actions-${randomUUID()}`);
  const config = join(home, 'agents.json');
  const previous = process.env.AGENT_COMPANION_AGENTS_CONFIG;
  process.env.AGENT_COMPANION_AGENTS_CONFIG = config;
  try {
    await mkdir(join(home, '.codex'), {recursive: true});
    const ctx = {home, node: '/abs/node', cli: '/abs/cli.js', platform: 'darwin' as const, env: {PATH: ''},
                 dataDir: home, socketPath: join(home, 'daemon.sock')};
    await codexAdapter.install(ctx);
    const codex = () => agentStatuses(ctx, new Map(), new Map()).find(agent => agent.id === 'codex');
    assert.equal(codex()?.action?.kind, 'approve');
    assert.match(codex()?.action?.steps.join(' ') ?? '', /\/hooks/);
    const approved = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8')).hooks as
      Record<string, Array<{hooks: unknown[]}>>;
    const keys = Object.entries(approved).flatMap(([event, groups]) => groups.map((_, index) =>
      `[hooks.state."${join(home, '.codex', 'hooks.json')}:${event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}:${index}:0"]\ntrusted_hash = "a"\n`));
    await writeFile(join(home, '.codex', 'config.toml'), keys.join(''));
    assert.equal(codex()?.action?.kind, 'restart');
    assert.equal(agentStatuses(ctx, new Map(), new Map([['codex', Date.now()]])).find(agent => agent.id === 'codex')?.action,
                 undefined);
    await writeFile(config, JSON.stringify({enabled: {codex: false}}));
    assert.equal(codex()?.action, undefined);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_AGENTS_CONFIG;
    else process.env.AGENT_COMPANION_AGENTS_CONFIG = previous;
    await rm(home, {recursive: true, force: true});
  }
});

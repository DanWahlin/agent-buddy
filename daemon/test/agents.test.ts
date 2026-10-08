import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
import {chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {parseDocument} from 'yaml';
import {claudeAdapter, claudeConfigPath} from '../src/agents/claude.js';
import {codexAdapter} from '../src/agents/codex.js';
import {codexQuote} from '../src/agents/commands.js';
import {copilotAdapter, copilotAppVersion, copilotVersions} from '../src/agents/copilot.js';
import {grokAdapter, runsClaudeHooks} from '../src/agents/grok.js';
import {hermesAdapter} from '../src/agents/hermes.js';
import {openclawAdapter} from '../src/agents/openclaw.js';
import {agentStatuses, defaultAgentContext, installDetectedAgents, setAgentHookRemoved,
        shouldIgnoreGrokClaudeHook} from '../src/agents/index.js';
import {loadAgentsConfig} from '../src/agents/config.js';
import {StateCoordinator} from '../src/state-coordinator.js';
import type {AgentContext} from '../src/agents/types.js';

// Windows has no POSIX permission bits, so mode checks run only on macOS and Linux.
const posix = process.platform !== 'win32';

// Creates the files, so the hook status checks find this install's Node.js and CLI on disk.
async function touch(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, '');
  }
}

async function fixture(): Promise<{root: string; home: string; ctx: AgentContext; cleanup: () => Promise<void>}> {
  const root = join(process.cwd(), '.test-output', `agents-${randomUUID()}`);
  const home = join(root, 'home');
  await mkdir(home, {recursive: true});
  const node = join(root, 'node bin', 'node');
  const cli = join(root, 'agent companion', 'daemon', 'dist', 'src', 'cli.js');
  await touch(node, cli);
  const ctx = defaultAgentContext({
    home,
    node,
    cli,
    platform: 'darwin',
    env: {PATH: ''},
    dataDir: join(root, 'data'),
    socketPath: join(root, 'daemon.sock'),
    runCommand: async () => ({stdout: '', status: 0}),
  });
  return {root, home, ctx, cleanup: async () => rm(root, {recursive: true, force: true})};
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

test('installing from the desktop app\'s copy replaces a repository install\'s hooks, and back', async () => {
  const {home, ctx, cleanup} = await fixture();
  const app = {...ctx, node: '/data/runtime/node', cli: '/data/runtime/daemon/dist/src/cli.js'};
  try {
    const settings = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), {recursive: true});
    // Someone else's hook that happens to run a cli.js is kept.
    await writeFile(settings, JSON.stringify({hooks: {SessionStart: [{hooks: [
      {type: 'command', command: '/opt/node', args: ['/other/cli.js', 'hook', 'claude', 'SessionStart']}]}]}}));
    for (const install of [ctx, app, ctx]) {
      await claudeAdapter.install(install);
      await codexAdapter.install(install);
      await hermesAdapter.install(install);
    }
    const claude = JSON.parse(await readFile(settings, 'utf8'));
    assert.deepEqual(claude.hooks.SessionStart.map((group: {hooks: Array<{args: string[]}>}) => group.hooks[0]?.args[0]),
                     ['/other/cli.js', ctx.cli]);
    const codex = await readFile(join(home, '.codex', 'hooks.json'), 'utf8');
    assert.equal(codex.includes(app.cli), false);
    assert.equal(JSON.parse(codex).hooks.SessionStart.length, 1);
    const hermes = await readFile(join(home, '.hermes', 'config.yaml'), 'utf8');
    assert.equal(hermes.includes(app.cli), false);
    assert.equal(hermes.split('hook hermes on_session_start').length - 1, 1);
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

test('Grok tells the user how to stop it from running the Claude hook', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    assert.equal(grokAdapter.note?.(ctx), undefined);
    await grokAdapter.install(ctx);
    assert.equal(grokAdapter.note?.(ctx), undefined, 'no note without the Claude hook');
    await claudeAdapter.install(ctx);
    assert.match(grokAdapter.note?.(ctx) ?? '', /\[compat\.claude\] hooks = false to .*config\.toml/);
    assert.equal(runsClaudeHooks(ctx), true);
    const config = join(home, '.grok', 'config.toml');
    for (const text of ['[compat.claude]\nskills = true\nhooks = false # off\n', '[compat]\nclaude.hooks = false\n',
                        'compat.claude.hooks = false\n', '[compat]\nclaude = { hooks = false }\n']) {
      await writeFile(config, text);
      assert.equal(runsClaudeHooks(ctx), false, text);
      assert.equal(grokAdapter.note?.(ctx), undefined, text);
    }
    for (const text of ['[compat.claude]\nhooks = true\n', '[compat.cursor]\nhooks = false\n',
                        '# [compat.claude]\n# hooks = false\n', '[compat.claude]\nmcps = false\n']) {
      await writeFile(config, text);
      assert.equal(runsClaudeHooks(ctx), true, text);
    }
    assert.equal(runsClaudeHooks({...ctx, env: {...ctx.env, GROK_CLAUDE_HOOKS_ENABLED: 'false'}}), false);
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
    const plugin = await readFile(join(ctx.dataDir, 'integrations', 'openclaw-plugin', 'index.js'), 'utf8');
    assert.match(plugin, /agent: 'openclaw'/);
    const pipeTest = new RegExp(plugin.match(/\(\/(.+?)\/i\.test\(socketPath\)/)?.[1] ?? '$^', 'i');
    assert.equal(pipeTest.test('\\\\.\\pipe\\esp32-agent-companion-Dan'), true);
    assert.equal(pipeTest.test('/tmp/daemon.sock'), false);
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
  for (const name of ['ask_user', 'exit_plan_mode']) {
    assert.deepEqual(copilotAdapter.normalize('preToolUse', {sessionId: 's', toolCalls: [{id: 't', name, args: {}}]}, 100)
      .map(hook => [hook.event, hook.payload.sessionId, hook.payload.notification_type, hook.payload.timestamp]),
                     [['notification', 'copilot:s', 'elicitation_dialog', 100]]);
  }
  assert.deepEqual(copilotAdapter.normalize('preToolUse', {sessionId: 's', toolName: 'ask_user'}, 100)
    .map(hook => hook.event), ['notification']);
  assert.deepEqual(copilotAdapter.normalize('preToolUse', {sessionId: 's', toolCalls: [{id: 't', name: 'bash'}]}, 100)
    .map(hook => hook.event), ['preToolUse']);
  assert.deepEqual(copilotAdapter.normalize('preToolUse',
    {sessionId: 's', toolCalls: [{id: 'a', name: 'bash'}, {id: 'b', name: 'ask_user'}]}, 100)
    .map(hook => [hook.event, hook.payload.waitingOn]), [['notification', ['ask_user']]]);
  assert.deepEqual(copilotAdapter.normalize('postToolUse', {sessionId: 's', toolName: 'ask_user', timestamp: 200}, 100)
    .map(hook => hook.event), ['postToolUse']);
});

test('a Copilot question shows Needs attention over other working sessions until answered', () => {
  let time = 1000;
  const coordinator = new StateCoordinator(() => {}, {now: () => time, sweepMs: 0});
  const handle = (hooks: ReturnType<typeof copilotAdapter.normalize>) => {
    for (const hook of hooks) coordinator.handle(hook.event, hook.payload);
  };
  handle(copilotAdapter.normalize('preToolUse', {sessionId: 'other', toolCalls: [{id: 'a', name: 'bash'}]}, time));
  handle(copilotAdapter.normalize('preToolUse', {sessionId: 'asker', toolCalls: [{id: 'b', name: 'ask_user'}]}, ++time));
  assert.equal(coordinator.state, 'attention');
  time += 5000;
  handle(copilotAdapter.normalize('postToolUse', {sessionId: 'asker', toolName: 'ask_user', timestamp: time}, time));
  assert.equal(coordinator.state, 'working');
  coordinator.close();
});

test('a Copilot question stays Needs attention while other tools in its batch finish', () => {
  let time = 1000;
  const coordinator = new StateCoordinator(() => {}, {now: () => time, sweepMs: 0});
  const handle = (event: string, payload: Record<string, unknown>) => {
    for (const hook of copilotAdapter.normalize(event, {sessionId: 'asker', timestamp: time, ...payload}, time)) {
      coordinator.handle(hook.event, hook.payload);
    }
  };
  // The model asks and runs a command in one batch; the command finishes first.
  handle('preToolUse', {toolCalls: [{id: 'a', name: 'bash'}, {id: 'b', name: 'ask_user'}]});
  assert.equal(coordinator.state, 'attention');
  time += 300;
  handle('postToolUse', {toolName: 'bash'});
  assert.equal(coordinator.state, 'attention');
  time += 300;
  handle('postToolUseFailure', {toolName: 'view'});
  assert.equal(coordinator.state, 'attention');
  // The answer ends the wait, and a restart in between keeps it.
  const restored = new StateCoordinator(() => {}, {now: () => time, sweepMs: 0, restored: coordinator.snapshot()});
  assert.equal(restored.state, 'attention');
  time += 5000;
  for (const hook of copilotAdapter.normalize('postToolUse', {sessionId: 'asker', toolName: 'ask_user', timestamp: time}, time)) {
    restored.handle(hook.event, hook.payload);
  }
  assert.equal(restored.state, 'working');
  coordinator.close();
  restored.close();
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

test('a normal turn end clears error attention but keeps pending permission prompts', () => {
  let now = 1000;
  const coordinator = new StateCoordinator(() => undefined, {now: () => now, sweepMs: 0});
  coordinator.handle('preToolUse', {sessionId: 'hermes:s', timestamp: now++});
  coordinator.handle('errorOccurred', {sessionId: 'hermes:s', timestamp: now++});
  assert.equal(coordinator.state, 'attention');
  coordinator.handle('agentStop', {sessionId: 'hermes:s', timestamp: now++});
  assert.equal(coordinator.state, 'complete');
  assert.equal(coordinator.snapshot().sessions[0]?.attentionUntil, 0);

  coordinator.handle('notification', {sessionId: 'claude:s', notification_type: 'permission_prompt', timestamp: now++});
  coordinator.handle('agentStop', {sessionId: 'claude:s', timestamp: now++});
  assert.equal(coordinator.state, 'attention');
  coordinator.close();
});

test('error attention survives a restart and still clears on the next turn end', () => {
  const first = new StateCoordinator(() => undefined, {now: () => 1000, sweepMs: 0});
  first.handle('errorOccurred', {sessionId: 'grok:s', timestamp: 1000});
  const restored = new StateCoordinator(() => undefined, {now: () => 2000, sweepMs: 0, restored: first.snapshot()});
  first.close();
  assert.equal(restored.state, 'attention');
  restored.handle('agentStop', {sessionId: 'grok:s', timestamp: 2000});
  assert.notEqual(restored.state, 'attention');
  restored.close();
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
    const ctx = {home, node: join(home, 'node'), cli: join(home, 'daemon', 'dist', 'src', 'cli.js'),
                 platform: 'darwin' as const, env: {PATH: ''},
                 dataDir: home, socketPath: join(home, 'daemon.sock')};
    await touch(ctx.node, ctx.cli);
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

async function withAgentsConfig<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENT_COMPANION_AGENTS_CONFIG;
  process.env.AGENT_COMPANION_AGENTS_CONFIG = path;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_AGENTS_CONFIG;
    else process.env.AGENT_COMPANION_AGENTS_CONFIG = previous;
  }
}

test('hook status reads the hooks: stale, partial, or broken hooks are outdated, not installed', async () => {
  const {root, home, ctx, cleanup} = await fixture();
  try {
    for (const adapter of [copilotAdapter, grokAdapter, claudeAdapter, codexAdapter, hermesAdapter]) {
      assert.equal(adapter.hookStatus(ctx), 'missing', adapter.id);
      await adapter.install(ctx);
      assert.notEqual(adapter.hookStatus(ctx), 'missing', adapter.id);
      assert.notEqual(adapter.hookStatus(ctx), 'outdated', adapter.id);
    }

    // Hooks that run another companion install.
    const other = {...ctx, cli: join(root, 'other', 'daemon', 'dist', 'src', 'cli.js')};
    await touch(other.cli);
    for (const adapter of [copilotAdapter, grokAdapter, claudeAdapter, codexAdapter, hermesAdapter]) {
      await adapter.install(other);
      assert.equal(adapter.hookStatus(ctx), 'outdated', adapter.id);
      await adapter.install(ctx);
    }

    // The Node.js that the hooks run is gone (for example, after a Node.js upgrade).
    await rm(ctx.node);
    for (const adapter of [copilotAdapter, grokAdapter, claudeAdapter, codexAdapter, hermesAdapter])
      assert.equal(adapter.hookStatus(ctx), 'outdated', adapter.id);
    await touch(ctx.node);

    // An event is missing.
    const settings = join(home, '.claude', 'settings.json');
    const claude = JSON.parse(await readFile(settings, 'utf8'));
    delete claude.hooks.Stop;
    await writeFile(settings, JSON.stringify(claude));
    assert.equal(claudeAdapter.hookStatus(ctx), 'outdated');

    // Our own hook file holds something that isn't our hooks.
    for (const [adapter, path] of [[copilotAdapter, join(home, '.copilot', 'hooks', 'agent-companion.json')],
                                   [grokAdapter, join(home, '.grok', 'hooks', 'agent-companion.json')]] as const) {
      for (const content of ['not json', '{}\n', '{"version": 1, "hooks": {}}\n']) {
        await writeFile(path, content);
        assert.equal(adapter.hookStatus(ctx), 'outdated', `${adapter.id}: ${content}`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('hooks of another install show as installed-but-outdated and can be removed', async () => {
  const {root, home, ctx, cleanup} = await fixture();
  try {
    const other = {...ctx, cli: join(root, 'other', 'daemon', 'dist', 'src', 'cli.js')};
    await touch(other.cli);
    for (const adapter of [claudeAdapter, codexAdapter, hermesAdapter]) await adapter.install(other);
    const statuses = await withAgentsConfig(join(home, 'agents.json'), async () =>
      agentStatuses(ctx, new Map(), new Map()));
    for (const id of ['claude', 'codex', 'hermes']) {
      const status = statuses.find(agent => agent.id === id);
      assert.equal(status?.hookStatus, 'outdated', id);
      assert.equal(status?.installed, true, id);
      assert.match(status?.hint ?? '', /Reinstall/, id);
    }
    for (const adapter of [claudeAdapter, codexAdapter, hermesAdapter]) {
      await adapter.uninstall(ctx);
      assert.equal(adapter.hookStatus(ctx), 'missing', adapter.id);
    }
  } finally {
    await cleanup();
  }
});

test('uninstall creates no file and changes no file that has none of our hooks', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    for (const adapter of [claudeAdapter, codexAdapter, hermesAdapter, copilotAdapter, grokAdapter]) await adapter.uninstall(ctx);
    for (const path of ['.claude/settings.json', '.codex/hooks.json', '.hermes/config.yaml',
                        '.copilot/hooks/agent-companion.json', '.grok/hooks/agent-companion.json'])
      assert.equal(existsSync(join(home, path)), false, path);

    const files = {
      [join(home, '.claude', 'settings.json')]: '{\n    "model": "sonnet",\n    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"}]}]}\n}',
      [join(home, '.codex', 'hooks.json')]: '{"hooks": {}}',
      [join(home, '.hermes', 'config.yaml')]: 'hooks:   # mine\n  pre_tool_call: [{command: x}]\n',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, content, {mode: 0o644});
      await chmod(path, 0o644);
    }
    for (const adapter of [claudeAdapter, codexAdapter, hermesAdapter]) await adapter.uninstall(ctx);
    for (const [path, content] of Object.entries(files)) {
      assert.equal(await readFile(path, 'utf8'), content, path);
      assert.equal(existsSync(`${path}.bak`), false, path);
      if (posix) assert.equal((await stat(path)).mode & 0o777, 0o644, path);
    }

    // A real edit keeps the file's own permissions too.
    await claudeAdapter.install(ctx);
    const claude = join(home, '.claude', 'settings.json');
    if (posix) assert.equal((await stat(claude)).mode & 0o777, 0o644);
    // A reinstall with nothing to change doesn't rewrite the file.
    const before = await readFile(claude, 'utf8');
    await chmod(claude, 0o640);
    await claudeAdapter.install(ctx);
    assert.equal(await readFile(claude, 'utf8'), before);
  } finally {
    await cleanup();
  }
});

test('install refuses hook values it does not understand, and uninstall keeps them', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const settings = join(home, '.claude', 'settings.json');
    await mkdir(dirname(settings), {recursive: true});
    for (const content of ['{"hooks": "off"}', '{"hooks": {"Stop": "x"}}']) {
      await writeFile(settings, content);
      await assert.rejects(claudeAdapter.install(ctx), /left unchanged/);
      assert.equal(await readFile(settings, 'utf8'), content);
    }

    // An event we don't use holds something odd, and a group has no `hooks` list: both stay.
    await writeFile(settings, JSON.stringify({hooks: {Custom: 'keep', Stop: [{matcher: 'odd'}]}}));
    await claudeAdapter.install(ctx);
    await claudeAdapter.uninstall(ctx);
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).hooks, {Custom: 'keep', Stop: [{matcher: 'odd'}]});

    // A group that mixes our handler with the user's keeps the user's handler.
    const mixed = {hooks: {Stop: [{hooks: [{type: 'command', command: 'mine'},
      {type: 'command', command: ctx.node, args: [ctx.cli, 'hook', 'claude', 'Stop']}]}]}};
    await writeFile(settings, JSON.stringify(mixed));
    await claudeAdapter.uninstall(ctx);
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).hooks, {Stop: [{hooks: [{type: 'command', command: 'mine'}]}]});

    const hermes = join(home, '.hermes', 'config.yaml');
    await mkdir(dirname(hermes), {recursive: true});
    for (const content of ['hooks: off\n', 'hooks:\n  pre_tool_call: off\n']) {
      await writeFile(hermes, content);
      await assert.rejects(hermesAdapter.install(ctx), /left unchanged/);
      assert.equal(await readFile(hermes, 'utf8'), content);
    }
    await writeFile(hermes, 'hooks:\n  custom: keep\n');
    await hermesAdapter.install(ctx);
    await hermesAdapter.uninstall(ctx);
    assert.equal(parseDocument(await readFile(hermes, 'utf8')).getIn(['hooks', 'custom']), 'keep');
    assert.doesNotMatch(await readFile(hermes, 'utf8'), /hook hermes/);
  } finally {
    await cleanup();
  }
});

test('a Codex reinstall keeps every group at its position, so approvals stay valid', async () => {
  const {root, home, ctx, cleanup} = await fixture();
  try {
    const hooksPath = join(home, '.codex', 'hooks.json');
    await mkdir(dirname(hooksPath), {recursive: true});
    await writeFile(hooksPath, JSON.stringify({hooks: {PreToolUse: [{hooks: [{type: 'command', command: 'first'}]}]}}));
    await codexAdapter.install(ctx);
    const installed = JSON.parse(await readFile(hooksPath, 'utf8'));
    installed.hooks.PreToolUse.push({hooks: [{type: 'command', command: 'added later'}]});
    await writeFile(hooksPath, JSON.stringify(installed));
    const other = {...ctx, cli: join(root, 'other', 'daemon', 'dist', 'src', 'cli.js')};
    for (const install of [other, ctx]) {
      await codexAdapter.install(install);
      const groups = JSON.parse(await readFile(hooksPath, 'utf8')).hooks.PreToolUse as Array<{hooks: Array<{command: string}>}>;
      assert.equal(groups.length, 3);
      assert.equal(groups[0]?.hooks[0]?.command, 'first');
      assert.ok(groups[1]?.hooks[0]?.command.includes(codexQuote(install.cli)));
      assert.equal(groups[2]?.hooks[0]?.command, 'added later');
    }
  } finally {
    await cleanup();
  }
});

test('setup does not add back hooks the user removed', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    await mkdir(join(home, '.claude'), {recursive: true});
    await writeFile(join(home, '.claude', 'settings.json'), '{}\n');
    await withAgentsConfig(join(home, 'agents.json'), async () => {
      await setAgentHookRemoved('copilot', true);
      assert.deepEqual((await loadAgentsConfig()).removed, {copilot: true});
      const results = await installDetectedAgents(ctx);
      const copilot = results.find(result => result.id === 'copilot');
      assert.equal(copilot?.installed, false);
      assert.match(copilot?.message ?? '', /agents install copilot/);
      assert.equal(copilotAdapter.hookStatus(ctx), 'missing');
      assert.equal(results.find(result => result.id === 'claude')?.installed, true);

      await setAgentHookRemoved('copilot', false);
      assert.deepEqual((await loadAgentsConfig()).removed, {});
      await installDetectedAgents(ctx);
      assert.equal(copilotAdapter.hookStatus(ctx), 'installed');
    });
  } finally {
    await cleanup();
  }
});

test('a reinstall removes stale companion hooks under events it does not install', async () => {
  const {root, home, ctx, cleanup} = await fixture();
  try {
    const gone = {...ctx, node: join(root, 'removed', 'node')};
    const claude = join(home, '.claude', 'settings.json');
    const codex = join(home, '.codex', 'hooks.json');
    await mkdir(dirname(claude), {recursive: true});
    await mkdir(dirname(codex), {recursive: true});
    await writeFile(claude, JSON.stringify({hooks: {PreCompact: [{hooks: [
      {type: 'command', command: 'mine'},
      {type: 'command', command: gone.node, args: [ctx.cli, 'hook', 'claude', 'PreCompact']}]}]}}));
    await writeFile(codex, JSON.stringify({hooks: {OldEvent: [{hooks: [
      {type: 'command', command: `"${gone.node}" "${ctx.cli}" hook codex OldEvent`}]}]}}));
    await claudeAdapter.install(ctx);
    await codexAdapter.install(ctx);
    assert.equal(claudeAdapter.hookStatus(ctx), 'installed');
    assert.notEqual(codexAdapter.hookStatus(ctx), 'outdated');
    assert.deepEqual(JSON.parse(await readFile(claude, 'utf8')).hooks.PreCompact,
                     [{hooks: [{type: 'command', command: 'mine'}]}]);
    assert.equal(JSON.parse(await readFile(codex, 'utf8')).hooks.OldEvent, undefined);
  } finally {
    await cleanup();
  }
});

test('each change keeps a timestamped copy, and only the last five copies stay', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const settings = join(home, '.claude', 'settings.json');
    await mkdir(dirname(settings), {recursive: true});
    await writeFile(settings, '{"model": "original"}\n', {mode: 0o644});
    const copies = () => readdirSync(dirname(settings)).filter(name => /^settings\.json\.agent-companion-.+\.bak$/.test(name)).sort();
    for (let change = 0; change < 7; change += 1) {
      await claudeAdapter.install({...ctx, node: join(home, `node-${change}`)});
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(copies().length, 5);
    assert.match(await readFile(join(dirname(settings), copies().at(-1)!), 'utf8'), /node-5/);
    if (posix) assert.equal((await stat(join(dirname(settings), copies()[0]!))).mode & 0o777, 0o600);
    assert.equal(await readFile(`${settings}.bak`, 'utf8'), '{"model": "original"}\n');
    if (posix) assert.equal((await stat(`${settings}.bak`)).mode & 0o777, 0o600);
    // No change, no copy.
    await claudeAdapter.install({...ctx, node: join(home, 'node-6')});
    assert.match(await readFile(join(dirname(settings), copies().at(-1)!), 'utf8'), /node-5/);
  } finally {
    await cleanup();
  }
});

test('removing the Codex hook names the user\'s approved hooks that moved', async () => {
  const {home, ctx, cleanup} = await fixture();
  try {
    const hooksPath = join(home, '.codex', 'hooks.json');
    await mkdir(dirname(hooksPath), {recursive: true});
    assert.deepEqual(await codexAdapter.install(ctx), []);
    const installed = JSON.parse(await readFile(hooksPath, 'utf8'));
    installed.hooks.Stop.push({hooks: [{type: 'command', command: 'approved-stop'}]});
    installed.hooks.SessionStart.push({hooks: [{type: 'command', command: 'not-approved'}]});
    await writeFile(hooksPath, JSON.stringify(installed));
    await writeFile(join(home, '.codex', 'config.toml'), `[hooks.state."${hooksPath}:stop:1:0"]\ntrusted_hash = "a"\n`);
    const warnings = await codexAdapter.uninstall(ctx);
    assert.equal(warnings?.length, 1);
    assert.match(warnings?.[0] ?? '', /\/hooks/);
    assert.match(warnings?.[0] ?? '', /Stop: approved-stop/);
    assert.doesNotMatch(warnings?.[0] ?? '', /not-approved/);
    assert.deepEqual(await codexAdapter.uninstall(ctx), []);
  } finally {
    await cleanup();
  }
});

test('agent versions come from a background probe, and a found command counts as detected', async () => {
  const {root, ctx, cleanup} = await fixture();
  try {
    const bin = join(root, 'bin');
    await mkdir(bin, {recursive: true});
    const windows = process.platform === 'win32';
    if (windows) {
      await writeFile(join(bin, 'hermes.cmd'),
                      '@echo off\r\nping -n 1 -w 200 127.0.0.1 >nul\r\necho Hermes Agent v1.2.3\r\necho more details\r\n');
    } else {
      const hermes = join(bin, 'hermes');
      await writeFile(hermes, '#!/bin/sh\nsleep 0.2\necho "Hermes Agent v1.2.3"\necho "more details"\n');
      await chmod(hermes, 0o755);
    }
    // cmd.exe runs a .cmd file, so Windows needs ComSpec and System32 too.
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const withBin = windows
      ? {...ctx, platform: 'win32' as const,
         env: {PATH: `${bin};${system}`, PATHEXT: '.CMD;.EXE', ComSpec: join(system, 'cmd.exe')}}
      : {...ctx, env: {PATH: bin}};
    const first = hermesAdapter.detect(withBin);
    assert.equal(first.installed, true);
    assert.equal(first.version, undefined);
    for (let tries = 0; tries < 50 && !hermesAdapter.detect(withBin).version; tries++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(hermesAdapter.detect(withBin).version, 'Hermes Agent v1.2.3');
  } finally {
    await cleanup();
  }
});

test('Copilot shows the versions of the CLI and the GitHub Copilot app', async () => {
  const {root, ctx, cleanup} = await fixture();
  try {
    const apps = join(root, 'Applications');
    const contents = join(apps, 'GitHub Copilot.app', 'Contents');
    await mkdir(contents, {recursive: true});
    await writeFile(join(contents, 'Info.plist'),
      '<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>1.1.26</string></dict></plist>');
    assert.equal(copilotAppVersion(ctx, [join(root, 'none'), apps]), '1.1.26');
    assert.equal(copilotAppVersion({...ctx, platform: 'linux'}, [apps]), undefined);
    assert.equal(copilotAppVersion(ctx, [join(root, 'none')]), undefined);
    assert.equal(copilotVersions('GitHub Copilot CLI 1.0.91', '1.1.26'), 'CLI 1.0.91 · app 1.1.26');
    assert.equal(copilotVersions(undefined, '1.1.26'), 'app 1.1.26');
    assert.equal(copilotVersions('GitHub Copilot CLI 1.0.91', undefined), 'CLI 1.0.91');
    assert.equal(copilotVersions(undefined, undefined), undefined);
  } finally {
    await cleanup();
  }
});

test('each agent\'s own folder variable moves the files the hooks go in', async () => {
  const {root, home, ctx, cleanup} = await fixture();
  try {
    const env = {
      PATH: '', COPILOT_HOME: join(root, 'copilot'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'), GROK_HOME: join(root, 'grok'), HERMES_HOME: join(root, 'hermes'),
    };
    const moved = {...ctx, env};
    for (const adapter of [copilotAdapter, claudeAdapter, codexAdapter, grokAdapter]) await adapter.install(moved);
    assert.ok(existsSync(join(root, 'copilot', 'hooks', 'agent-companion.json')));
    assert.ok(existsSync(join(root, 'claude', 'settings.json')));
    assert.ok(existsSync(join(root, 'codex', 'hooks.json')));
    assert.ok(existsSync(join(root, 'grok', 'hooks', 'agent-companion.json')));
    for (const folder of ['.copilot', '.claude', '.codex', '.grok']) assert.equal(existsSync(join(home, folder)), false);
    assert.equal(copilotAdapter.hookStatus(moved), 'installed');
    assert.equal(copilotAdapter.hookStatus(ctx), 'missing');
    // Codex approves a hook by its file's full path, so the key names the moved file.
    const status = await codexAdapter.detect(moved);
    assert.equal(status.configPath, join(root, 'codex', 'hooks.json'));

    // "~" is the home folder; an empty or relative value is not used.
    assert.equal(claudeConfigPath(home, {CLAUDE_CONFIG_DIR: '~/claude-work'}), join(home, 'claude-work', 'settings.json'));
    assert.equal(claudeConfigPath(home, {CLAUDE_CONFIG_DIR: '  '}), join(home, '.claude', 'settings.json'));
    assert.equal(claudeConfigPath(home, {CLAUDE_CONFIG_DIR: 'relative'}), join(home, '.claude', 'settings.json'));
  } finally {
    await cleanup();
  }
});

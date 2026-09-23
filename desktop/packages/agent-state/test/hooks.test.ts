import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_CODE_EVENTS, claudeCodeHooks, copilotCliHooks,
  mergeClaudeCodeHooks, removeClaudeCodeHooks,
} from '../src/hooks.js';
import { hookEvents } from '../src/vendor/protocol.js';
import { dataDirectory, endpointIsFile, endpointPath, statePath } from '../src/paths.js';

const target = { node: '/usr/bin/node', shim: '/ext/dist/hook.js' };

test('every coordinator event a Claude Code session can produce is covered', () => {
  const mapped = new Set(Object.values(CLAUDE_CODE_EVENTS));
  // `errorOccurred` is the one event Claude Code has no equivalent for;
  // PostToolUseFailure and Notification carry that meaning instead.
  const missing = hookEvents.filter(event => !mapped.has(event));
  assert.deepEqual(missing, ['errorOccurred']);
});

test('a permission request is treated as wanting attention', () => {
  assert.equal(CLAUDE_CODE_EVENTS.PermissionRequest, 'notification');
  assert.equal(CLAUDE_CODE_EVENTS.Notification, 'notification');
});

test('Claude Code hooks use exec form and never block the session', () => {
  const hooks = claudeCodeHooks(target);
  for (const [event, entries] of Object.entries(hooks)) {
    const hook = (entries as Array<{ hooks: Array<Record<string, unknown>> }>)[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, target.node, event);
    // args selects exec form, so a Windows path needs no shell quoting.
    assert.deepEqual(hook.args, [target.shim, CLAUDE_CODE_EVENTS[event]]);
    assert.equal(hook.async, true, event + ' must not sit on the critical path');
    assert.ok((hook.timeout as number) <= 5, event + ' should give up quickly');
  }
});

test('Copilot CLI gets every event, with notifications narrowed to real prompts', () => {
  const file = copilotCliHooks(target) as { version: number; hooks: Record<string, unknown> };
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.hooks).sort(), [...hookEvents].sort());

  const notification = (file.hooks.notification as Array<Record<string, unknown>>)[0];
  assert.equal(notification.matcher, 'permission_prompt|elicitation_dialog');
  const other = (file.hooks.preToolUse as Array<Record<string, unknown>>)[0];
  assert.equal(other.matcher, undefined, 'only notifications need narrowing');
});

test('merging leaves other hooks alone', () => {
  const settings = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'their-linter' }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'their-archiver' }] }],
    },
  };
  const merged = mergeClaudeCodeHooks(settings, target) as
    { model: string; hooks: Record<string, unknown[]> };

  assert.equal(merged.model, 'opus', 'unrelated settings survive');
  assert.equal(merged.hooks.PostCompact.length, 1, 'an event we do not use is untouched');
  assert.equal(merged.hooks.PreToolUse.length, 2, 'theirs, then ours');
  assert.equal(
    ((merged.hooks.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0]).command,
    'their-linter');
});

test('installing twice repoints rather than stacking duplicates', () => {
  const once = mergeClaudeCodeHooks({}, target);
  const twice = mergeClaudeCodeHooks(once, target);
  const thrice = mergeClaudeCodeHooks(twice, target);

  for (const event of Object.keys(CLAUDE_CODE_EVENTS)) {
    const entries = (thrice as { hooks: Record<string, unknown[]> }).hooks[event];
    assert.equal(entries.length, 1, event + ' should have exactly one of ours');
  }
});

test('an updated extension path replaces the old entry', () => {
  const old = mergeClaudeCodeHooks({}, { node: '/usr/bin/node', shim: '/ext-0.1.0/hook.js' });
  const updated = mergeClaudeCodeHooks(old, { node: '/usr/bin/node', shim: '/ext-0.2.0/hook.js' });

  const entries = (updated as { hooks: Record<string, unknown[]> }).hooks.PreToolUse;
  // The old one is left, since it is a different path and might be someone
  // else's; what matters is that ours is present exactly once.
  const ours = entries.filter(entry =>
    JSON.stringify(entry).includes('/ext-0.2.0/hook.js'));
  assert.equal(ours.length, 1);
});

test('removing takes out ours and only ours', () => {
  const settings = mergeClaudeCodeHooks({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'their-linter' }] }] },
  }, target);

  const cleaned = removeClaudeCodeHooks(settings, target.shim) as
    { hooks: Record<string, unknown[]> };
  assert.equal(cleaned.hooks.PreToolUse.length, 1);
  assert.match(JSON.stringify(cleaned.hooks.PreToolUse), /their-linter/);
  for (const event of Object.keys(CLAUDE_CODE_EVENTS)) {
    if (event === 'PreToolUse') continue;
    assert.equal(cleaned.hooks[event], undefined, event + ' should be gone entirely');
  }
});

test('removing everything leaves no empty hooks block behind', () => {
  const settings = mergeClaudeCodeHooks({ model: 'opus' }, target);
  const cleaned = removeClaudeCodeHooks(settings, target.shim);
  assert.deepEqual(cleaned, { model: 'opus' });
});

// --- paths ------------------------------------------------------------------

test('Windows gets a named pipe, which upstream has no branch for at all', () => {
  const pipe = endpointPath('win32', {});
  assert.match(pipe, /^\\\\\.\\pipe\\/);
  assert.ok(!pipe.includes('/'), 'a pipe name is not a filesystem path');
});

test('Unix endpoints stay short enough for a socket path', () => {
  const linux = endpointPath('linux', { XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.equal(linux, '/run/user/1000/agent-companion-vscode/bridge.sock');
  // The limit is about 104 bytes, so the home directory is deliberately avoided.
  assert.ok(linux.length < 104, linux);

  const darwin = endpointPath('darwin', {});
  assert.match(darwin, /Application Support\/Agent Companion\/bridge\.sock$/);
});

test('the endpoint never collides with the ESP32 daemon', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
    const value = endpointPath(platform, { XDG_RUNTIME_DIR: '/run/user/1000' });
    assert.doesNotMatch(value, /esp32-agent-companion/,
      'both should be able to run, and a shared socket would mean one eats the other');
  }
});

test('the endpoint and state path can be overridden', () => {
  assert.equal(
    endpointPath('linux', { AGENT_COMPANION_VSCODE_SOCKET: '/tmp/x.sock' }), '/tmp/x.sock');
  assert.equal(
    statePath('linux', { AGENT_COMPANION_VSCODE_STATE: '/tmp/x.json' }), '/tmp/x.json');
});

test('state lives somewhere per-user on each platform', () => {
  assert.match(dataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }),
    /AppData\\Local\\AgentCompanion$/);
  assert.match(dataDirectory('darwin', {}, '/Users/me'),
    /^\/Users\/me\/Library\/Application Support\/Agent Companion$/);
  assert.match(dataDirectory('linux', { XDG_STATE_HOME: '/home/me/.local/state' }),
    /\.local\/state[\\/]agent-companion-vscode$/);
});

test('only the filesystem endpoints need cleaning up', () => {
  assert.equal(endpointIsFile('win32'), false);
  assert.equal(endpointIsFile('linux'), true);
  assert.equal(endpointIsFile('darwin'), true);
});

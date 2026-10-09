import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {findExecutable, isCompanionHookCommand, shellHookCommand, versionOf} from './commands.js';
import {isRecord, updateJsonFile} from './file-utils.js';
import {hookHealth, parseHookCommand, type FoundHook} from './hook-config.js';
import {canonicalEvent, normalized} from './normalize.js';
import type {AgentAdapter, AgentContext, HookStatus} from './types.js';
import type {HookEvent, HookPayload} from '../protocol.js';

// Lifecycle events the CLI and the IDE both send. Shell, MCP, and file hooks are
// the same work as a tool call: they keep a long run from looking idle.
const events = [
  'sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'subagentStart', 'subagentStop', 'beforeShellExecution', 'afterShellExecution',
  'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit',
  'stop', 'sessionEnd',
];

// These block the agent when the hook prints nothing or JSON they don't accept.
const permissionEvents = new Set([
  'preToolUse', 'subagentStart', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile',
]);

const launchers = ['cursor-agent', 'cursor-agent.exe', 'cursor-agent.cmd'];

const asWork: Record<string, HookEvent> = {
  sessionStart: 'sessionStart',
  beforeSubmitPrompt: 'userPromptSubmitted',
  preToolUse: 'preToolUse',
  beforeShellExecution: 'preToolUse',
  beforeMCPExecution: 'preToolUse',
  beforeReadFile: 'preToolUse',
  postToolUse: 'postToolUse',
  afterShellExecution: 'postToolUse',
  afterMCPExecution: 'postToolUse',
  afterFileEdit: 'postToolUse',
  postToolUseFailure: 'postToolUseFailure',
  subagentStart: 'subagentStart',
  subagentStop: 'subagentStop',
  sessionEnd: 'sessionEnd',
};

export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  name: 'Cursor Agent',
  hint: status => status === 'missing'
    ? 'Install hooks, then restart open Cursor and Cursor Agent sessions so they load them.'
    : undefined,
  detect(ctx) {
    const executable = cursorCliPath(ctx);
    const onPath = findExecutable('cursor-agent', ctx.env, ctx.platform) ? 'cursor-agent'
      : executable && findExecutable('agent', ctx.env, ctx.platform) === executable ? 'agent' : undefined;
    return {
      installed: Boolean(executable),
      version: onPath ? versionOf(onPath, ctx) : undefined,
      configPath: cursorHooksPath(ctx.home),
    };
  },
  hookStatus(ctx) {
    return cursorHookStatus(ctx);
  },
  async install(ctx) {
    const path = cursorHooksPath(ctx.home);
    await updateJsonFile(path, root => withCursorHooks(root, path, ctx));
  },
  async uninstall(ctx) {
    await updateJsonFile(cursorHooksPath(ctx.home), root => withoutCursorHooks(root, ctx), {create: false});
  },
  normalize(nativeEvent, payload, receiptTime) {
    const fields = cursorFields(payload);
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'stop') {
      const status = String(payload.status ?? '');
      if (status === 'error') return normalized('cursor', 'errorOccurred', fields, receiptTime);
      if (status === 'aborted') return normalized('cursor', 'sessionEnd', fields, receiptTime);
      return normalized('cursor', 'agentStop', fields, receiptTime);
    }
    return normalized('cursor', asWork[name] ?? canonicalEvent(nativeEvent, fields), fields, receiptTime);
  },
};

export function cursorHooksPath(home: string): string {
  return join(home, '.cursor', 'hooks.json');
}

// The `agent` command is also other tools. It counts only beside the Cursor launcher,
// and the Windows installer is found in %LOCALAPPDATA%\cursor-agent even when it is
// not on PATH.
export function cursorCliPath(ctx: AgentContext): string | undefined {
  const named = findExecutable('cursor-agent', ctx.env, ctx.platform);
  if (named) return named;
  const agent = findExecutable('agent', ctx.env, ctx.platform);
  if (agent && launchers.some(name => existsSync(join(dirname(agent), name)))) return agent;
  for (const directory of cursorInstallDirectories(ctx)) {
    for (const name of launchers) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function cursorInstallDirectories(ctx: AgentContext): string[] {
  const directories = [join(ctx.home, '.local', 'bin')];
  if (ctx.platform === 'win32') {
    const local = ctx.env.LOCALAPPDATA?.trim() || join(ctx.home, 'AppData', 'Local');
    directories.unshift(join(local, 'cursor-agent'));
  }
  return directories;
}

// Cursor blocks a permission hook that prints nothing. Anything else gets an empty
// object, which the observational hooks accept.
export function cursorHookResponse(event: string | undefined): string {
  if (event === 'beforeSubmitPrompt') return '{"continue":true}\n';
  if (event && permissionEvents.has(event)) return '{"permission":"allow"}\n';
  return '{}\n';
}

function cursorHookCommand(ctx: AgentContext, event: string): string {
  return shellHookCommand(ctx, 'cursor', event);
}

function isOurCursorHook(value: unknown, ctx: AgentContext): boolean {
  return isRecord(value) && typeof value.command === 'string' && isCompanionHookCommand(value.command, 'cursor', ctx);
}

function hookMap(root: Record<string, unknown>, path: string): Record<string, unknown> {
  if (root.hooks === undefined || root.hooks === null) return {};
  if (!isRecord(root.hooks)) throw new Error(`"hooks" in ${path} isn't an object, so it was left unchanged.`);
  return root.hooks;
}

function entriesOf(hooks: Record<string, unknown>, event: string, path: string): unknown[] {
  const entries = hooks[event];
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new Error(`"hooks.${event}" in ${path} isn't a list, so it was left unchanged.`);
  return entries;
}

function withCursorHooks(root: Record<string, unknown>, path: string, ctx: AgentContext): Record<string, unknown> {
  if (root.version === undefined) root.version = 1;
  const hooks = hookMap(root, path);
  const current = new Map(events.map(event => [event, entriesOf(hooks, event, path)]));
  for (const [event, value] of Object.entries(hooks)) {
    if (current.has(event) || !Array.isArray(value)) continue;
    const kept = value.filter(entry => !isOurCursorHook(entry, ctx));
    if (kept.length) hooks[event] = kept;
    else if (value.length) delete hooks[event];
  }
  for (const event of events) hooks[event] = placeOurs(current.get(event)!, ctx, event);
  root.hooks = hooks;
  return root;
}

// Our hook stays where it was, so the commands around it keep their positions.
function placeOurs(entries: unknown[], ctx: AgentContext, event: string): unknown[] {
  const ours = {command: cursorHookCommand(ctx, event), timeout: 5};
  const index = entries.findIndex(entry => isOurCursorHook(entry, ctx));
  const without = entries.filter(entry => !isOurCursorHook(entry, ctx));
  if (index < 0) return [...without, ours];
  const before = entries.slice(0, index).filter(entry => !isOurCursorHook(entry, ctx)).length;
  return [...without.slice(0, before), ours, ...without.slice(before)];
}

function withoutCursorHooks(root: Record<string, unknown>, ctx: AgentContext): Record<string, unknown> {
  if (!isRecord(root.hooks)) return root;
  const hooks = root.hooks;
  let removed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(entry => !isOurCursorHook(entry, ctx));
    if (kept.length === entries.length) continue;
    removed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed && !Object.keys(hooks).length) delete root.hooks;
  return root;
}

function cursorHookStatus(ctx: AgentContext): HookStatus {
  const path = cursorHooksPath(ctx.home);
  if (!existsSync(path)) return 'missing';
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'outdated';
  }
  if (!isRecord(root) || (root.hooks !== undefined && !isRecord(root.hooks))) return 'outdated';
  const hooks = isRecord(root.hooks) ? root.hooks : {};
  const found: FoundHook[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      if (events.includes(event)) return 'outdated';
      continue;
    }
    for (const entry of entries) {
      if (!isOurCursorHook(entry, ctx)) continue;
      const parsed = parseHookCommand(String((entry as {command: string}).command), 'cursor');
      if (!parsed) return 'outdated';
      found.push({...parsed, event});
    }
  }
  return hookHealth(found, events, ctx);
}

// The CLI's session id is conversation_id. sessionStart also sends session_id.
function cursorFields(payload: HookPayload): HookPayload {
  const next: HookPayload = {...payload};
  if (next.sessionId === undefined && next.session_id === undefined && typeof next.conversation_id === 'string')
    next.session_id = next.conversation_id;
  if (next.parentSessionId === undefined && next.parent_session_id === undefined
      && typeof next.parent_conversation_id === 'string')
    next.parent_session_id = next.parent_conversation_id;
  if (next.agentName === undefined && next.agent_name === undefined && typeof next.subagent_type === 'string')
    next.agent_name = next.subagent_type;
  return next;
}

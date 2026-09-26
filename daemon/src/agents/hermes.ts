import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {isMap, isScalar, parseDocument, stringify} from 'yaml';
import {shellQuote, versionOf} from './commands.js';
import {readText, writeTextAtomically} from './file-utils.js';
import {attentionPayload, canonicalEvent, isTool, namespacePayload, normalized} from './normalize.js';
import type {AgentAdapter, AgentContext, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call',
  'subagent_start', 'subagent_stop', 'pre_approval_request', 'post_approval_response',
  'on_session_end', 'on_session_finalize', 'on_session_reset', 'api_request_error',
  'agent_loop_stopped',
];

export const hermesAdapter: AgentAdapter = {
  id: 'hermes',
  name: 'Hermes Agent',
  hint: status => status === 'missing'
    ? 'Install hooks. Hermes asks you to approve the hook the first time it runs.'
    : status === 'needs-approval' ? 'Hermes asks you to approve the hook the first time it runs.' : undefined,
  detect(ctx) {
    const configPath = hermesConfigPath(ctx);
    const version = versionOf('hermes', ctx);
    return {installed: Boolean(version) || existsSync(configPath), version, configPath};
  },
  hookStatus(ctx) {
    if (!containsOurHook(ctx)) return 'missing';
    return hermesApprovedEvents(ctx).includes('pre_llm_call') ? 'installed' : 'needs-approval';
  },
  async install(ctx) {
    const path = hermesConfigPath(ctx);
    const source = (await readText(path)) ?? '';
    const hooks = withoutOurHooks(currentHooks(source), ctx);
    for (const event of events) hooks[event] = [...(hooks[event] ?? []), {command: hermesCommand(ctx, event), timeout: 5}];
    await writeTextAtomically(path, replaceHooksSection(source, hooks));
  },
  async uninstall(ctx) {
    const path = hermesConfigPath(ctx);
    const source = await readText(path);
    if (source === undefined || source === null) return;
    const hooks = withoutOurHooks(currentHooks(source), ctx);
    const next = replaceHooksSection(source, hooks);
    if (next !== source) await writeTextAtomically(path, next);
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'pre_tool_call' && isTool(payload, 'clarify')) return notification(payload, receiptTime);
    if (name === 'pre_approval_request') {
      const extra = object(payload.extra);
      if (extra.surface === 'smart') return [];
      return notification(payload, receiptTime);
    }
    if (name === 'post_approval_response') return normalized('hermes', 'preToolUse', payload, receiptTime);
    if (name === 'post_tool_call') {
      const extra = object(payload.extra);
      return normalized('hermes', extra.status === 'error' || extra.error_type ? 'postToolUseFailure' : 'postToolUse',
                        payload, receiptTime);
    }
    if (name === 'on_session_end') return normalized('hermes', 'agentStop', payload, receiptTime);
    if (name === 'agent_loop_stopped') return normalized('hermes', 'sessionEnd', payload, receiptTime);
    return normalized('hermes', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function hermesConfigPath(ctx: Pick<AgentContext, 'home' | 'env'>): string {
  return join(ctx.env.HERMES_HOME ?? join(ctx.home, '.hermes'), 'config.yaml');
}

function hermesCommand(ctx: AgentContext, event: string): string {
  return `${shellQuote(ctx.node)} ${shellQuote(ctx.cli)} hook hermes ${event}`;
}

function containsOurHook(ctx: AgentContext): boolean {
  try {
    return isOurCommand(readFileSync(hermesConfigPath(ctx), 'utf8'), ctx);
  } catch {
    return false;
  }
}

function isOurCommand(command: string, ctx: AgentContext): boolean {
  return command.includes(ctx.cli) && command.includes('hook hermes');
}

function notification(payload: HookPayload, receiptTime: number): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('hermes', attentionPayload(payload, receiptTime))}];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type HookEntry = Record<string, unknown>;

// Refuses files we can't edit safely so a broken config never gets a second `hooks:` block.
function parseConfig(source: string) {
  const doc = parseDocument(source || '{}');
  if (doc.errors.length)
    throw new Error(`Couldn't parse the Hermes config, so it was left unchanged: ${doc.errors[0]?.message}`);
  if (doc.contents !== null && !isMap(doc.contents))
    throw new Error('The Hermes config isn\'t a YAML mapping, so it was left unchanged.');
  return doc;
}

function currentHooks(source: string): Record<string, HookEntry[]> {
  const value = parseConfig(source).toJSON() as Record<string, unknown> | null;
  const hooks = value && typeof value.hooks === 'object' && value.hooks && !Array.isArray(value.hooks)
    ? value.hooks as Record<string, unknown> : {};
  const result: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    result[event] = Array.isArray(entries) ? entries as HookEntry[] : [];
  }
  return result;
}

function withoutOurHooks(hooks: Record<string, HookEntry[]>, ctx: AgentContext): Record<string, HookEntry[]> {
  const result: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries.filter(entry => !isOurCommand(String(entry?.command ?? ''), ctx));
    if (kept.length) result[event] = kept;
  }
  return result;
}

// Rewrites only the top-level `hooks:` block so the rest of the user's file keeps its exact text.
export function replaceHooksSection(source: string, hooks: Record<string, HookEntry[]>): string {
  const block = Object.keys(hooks).length ? stringify({hooks}, {lineWidth: 0}) : '';
  const contents = parseConfig(source).contents;
  const pair = isMap(contents)
    ? contents.items.find(item => isScalar(item.key) && item.key.value === 'hooks') : undefined;
  const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
  const valueRange = (pair?.value as {range?: [number, number, number]} | null | undefined)?.range;
  if (!keyRange) {
    if (!block) return source;
    const separator = source && !source.endsWith('\n') ? '\n' : '';
    return `${source}${separator}${block}`;
  }
  const lineStart = source.lastIndexOf('\n', keyRange[0] - 1) + 1;
  let end = valueRange ? valueRange[2] : keyRange[2];
  if (source[end - 1] !== '\n' && source[end] === '\n') end += 1;
  return source.slice(0, lineStart) + block + source.slice(end);
}

// Hermes stores approved (event, command) pairs in shell-hooks-allowlist.json beside config.yaml.
export function hermesApprovedEvents(ctx: AgentContext): string[] {
  try {
    const path = join(dirname(hermesConfigPath(ctx)), 'shell-hooks-allowlist.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as {approvals?: Array<{event?: unknown; command?: unknown}>};
    return (data.approvals ?? [])
      .filter(item => typeof item.command === 'string' && isOurCommand(item.command, ctx)
        && item.command === hermesCommand(ctx, String(item.event)))
      .map(item => String(item.event));
  } catch {
    return [];
  }
}

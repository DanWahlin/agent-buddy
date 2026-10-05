import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {isMap, isScalar, parseDocument, stringify} from 'yaml';
import {isCompanionHookCommand, shellHookCommand, hasCommand, versionOf} from './commands.js';
import {hermesHome} from './homes.js';
import {isRecord, readText, recordOf, writeTextAtomically} from './file-utils.js';
import {attentionPayload, canonicalEvent, isTool, namespacePayload, normalized} from './normalize.js';
import {eventGroups, hookHealth, parseHookCommand, type FoundHook} from './hook-config.js';
import type {AgentAdapter, AgentContext, HookStatus, NormalizedHook} from './types.js';
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
    return {installed: hasCommand('hermes', ctx) || existsSync(configPath), version, configPath};
  },
  hookStatus(ctx) {
    const status = hermesHookHealth(ctx);
    if (status !== 'installed') return status;
    return hermesApprovedEvents(ctx).includes('pre_llm_call') ? 'installed' : 'needs-approval';
  },
  async install(ctx) {
    const path = hermesConfigPath(ctx);
    const source = (await readText(path)) ?? '';
    const current = hooksSection(source);
    if (!current) throw new Error(`"hooks" in ${path} isn't a mapping, so it was left unchanged.`);
    // Reads every event first, so a value that isn't a list stops the install before any change.
    for (const event of events) eventGroups(current, event, path);
    const hooks = withoutOurHooks(current, ctx, false);
    for (const event of events)
      hooks[event] = [...eventGroups(hooks, event, path), {command: hermesCommand(ctx, event), timeout: 5}];
    for (const [event, entries] of Object.entries(hooks)) {
      if (Array.isArray(entries) && !entries.length && (current[event] as unknown[]).length) delete hooks[event];
    }
    const legacy = legacyWindowsConfigPath(ctx);
    if (legacy) await removeOurHooksFrom(legacy, ctx);
    if (JSON.stringify(hooks) === JSON.stringify(current)) return;
    await writeTextAtomically(path, replaceHooksSection(source, hooks));
  },
  async uninstall(ctx) {
    await removeOurHooksFrom(hermesConfigPath(ctx), ctx);
    const legacy = legacyWindowsConfigPath(ctx);
    if (legacy) await removeOurHooksFrom(legacy, ctx);
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'pre_tool_call' && isTool(payload, 'clarify')) return notification(payload, receiptTime);
    if (name === 'pre_approval_request') {
      const extra = recordOf(payload.extra);
      if (extra.surface === 'smart') return [];
      return notification(payload, receiptTime);
    }
    if (name === 'post_approval_response') return normalized('hermes', 'preToolUse', payload, receiptTime);
    if (name === 'post_tool_call') {
      const extra = recordOf(payload.extra);
      return normalized('hermes', extra.status === 'error' || extra.error_type ? 'postToolUseFailure' : 'postToolUse',
                        payload, receiptTime);
    }
    if (name === 'on_session_end') return normalized('hermes', 'agentStop', payload, receiptTime);
    if (name === 'agent_loop_stopped') return normalized('hermes', 'sessionEnd', payload, receiptTime);
    return normalized('hermes', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function hermesConfigPath(ctx: Pick<AgentContext, 'home' | 'env' | 'platform'>): string {
  return join(hermesHome(ctx.home, ctx.env, ctx.platform), 'config.yaml');
}

// Earlier versions wrote the hooks to ~/.hermes on Windows too, where Hermes never reads them.
function legacyWindowsConfigPath(ctx: AgentContext): string | undefined {
  if (ctx.platform !== 'win32' || ctx.env.HERMES_HOME?.trim()) return undefined;
  const path = join(ctx.home, '.hermes', 'config.yaml');
  return path === hermesConfigPath(ctx) ? undefined : path;
}

async function removeOurHooksFrom(path: string, ctx: AgentContext): Promise<void> {
  const source = await readText(path);
  if (source === null) return;
  const current = hooksSection(source);
  if (!current) return;
  const hooks = withoutOurHooks(current, ctx, true);
  if (JSON.stringify(hooks) === JSON.stringify(current)) return;
  await writeTextAtomically(path, replaceHooksSection(source, hooks));
}

function hermesCommand(ctx: AgentContext, event: string): string {
  return shellHookCommand(ctx, 'hermes', event);
}

function hermesHookHealth(ctx: AgentContext): HookStatus {
  let hooks: Record<string, unknown> | undefined;
  try {
    hooks = hooksSection(readFileSync(hermesConfigPath(ctx), 'utf8'));
  } catch {
    return 'missing';
  }
  const found: FoundHook[] = [];
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isOurEntry(entry, ctx)) continue;
      found.push({...(parseHookCommand(String(entry.command), 'hermes') ?? {node: '', cli: ''}), event});
    }
  }
  return hookHealth(found, events, ctx);
}

function isOurEntry(entry: unknown, ctx: AgentContext): entry is Record<string, unknown> {
  return isRecord(entry) && isCompanionHookCommand(String(entry.command ?? ''), 'hermes', ctx);
}

function notification(payload: HookPayload, receiptTime: number): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('hermes', attentionPayload(payload, receiptTime))}];
}

// Refuses files we can't edit safely so a broken config never gets a second `hooks:` block.
function parseConfig(source: string) {
  const doc = parseDocument(source || '{}');
  if (doc.errors.length)
    throw new Error(`Couldn't parse the Hermes config, so it was left unchanged: ${doc.errors[0]?.message}`);
  if (doc.contents !== null && !isMap(doc.contents))
    throw new Error('The Hermes config isn\'t a YAML mapping, so it was left unchanged.');
  return doc;
}

// The `hooks:` mapping, or undefined when `hooks:` holds something else.
function hooksSection(source: string): Record<string, unknown> | undefined {
  const value = parseConfig(source).toJSON() as Record<string, unknown> | null;
  const hooks = value?.hooks;
  if (hooks === undefined || hooks === null) return {};
  return isRecord(hooks) ? {...hooks} : undefined;
}

// Removes our entries and keeps everything else, including values that aren't lists. With
// `dropEmptied`, an event goes when it held only our entries.
function withoutOurHooks(hooks: Record<string, unknown>, ctx: AgentContext, dropEmptied: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      result[event] = entries;
      continue;
    }
    const kept = entries.filter(entry => !isOurEntry(entry, ctx));
    if (!dropEmptied || kept.length || !entries.length) result[event] = kept;
  }
  return result;
}

// Rewrites only the top-level `hooks:` block so the rest of the user's file keeps its exact text.
export function replaceHooksSection(source: string, hooks: Record<string, unknown>): string {
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
      .filter(item => typeof item.command === 'string' && item.command === hermesCommand(ctx, String(item.event)))
      .map(item => String(item.event));
  } catch {
    return [];
  }
}

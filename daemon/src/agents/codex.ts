import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {updateJsonFile} from './file-utils.js';
import {codexQuote, versionOf} from './commands.js';
import {attentionPayload, canonicalEvent, namespacePayload, normalized} from './normalize.js';
import type {AgentAdapter, AgentContext, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd',
];

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex CLI',
  hint: status => status === 'needs-approval'
    ? 'Approve the new hooks in Codex with /hooks.'
    : status === 'missing' ? 'Install hooks, then approve them in Codex with /hooks.' : undefined,
  detect(ctx) {
    const configPath = codexHooksPath(ctx.home);
    const version = versionOf('codex', ctx);
    return {installed: Boolean(version) || existsSync(configPath), version, configPath};
  },
  hookStatus(ctx) {
    if (!containsOurHook(ctx)) return 'missing';
    return codexTrustLooksComplete(ctx) ? 'installed' : 'needs-approval';
  },
  async install(ctx) {
    await updateJsonFile(codexHooksPath(ctx.home), root => {
      const hooks = object(root.hooks);
      for (const event of events) {
        const groups = removeOurGroups(array(hooks[event]), ctx);
        groups.push(codexGroup(ctx, event));
        hooks[event] = groups;
      }
      root.hooks = hooks;
      return root;
    });
  },
  async uninstall(ctx) {
    await updateJsonFile(codexHooksPath(ctx.home), root => {
      const hooks = object(root.hooks);
      for (const key of Object.keys(hooks)) {
        const groups = removeOurGroups(array(hooks[key]), ctx);
        if (groups.length) hooks[key] = groups;
        else delete hooks[key];
      }
      if (Object.keys(hooks).length) root.hooks = hooks;
      else delete root.hooks;
      return root;
    });
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'PermissionRequest') return notification(payload, receiptTime);
    if (name === 'Interrupt') return normalized('codex', 'sessionEnd', payload, receiptTime);
    if (name === 'Stop') return normalized('codex', 'agentStop', {...payload, clearAttention: true}, receiptTime);
    return normalized('codex', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function codexHooksPath(home: string): string {
  return join(home, '.codex', 'hooks.json');
}

function codexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml');
}

function codexCommand(ctx: AgentContext, event: string): string {
  return `${codexQuote(ctx.node)} ${codexQuote(ctx.cli)} hook codex ${event}`;
}

function codexGroup(ctx: AgentContext, event: string): Record<string, unknown> {
  return {
    hooks: [{
      type: 'command',
      command: codexCommand(ctx, event),
      async: event !== 'SessionEnd',
      // Codex caps SessionEnd and Interrupt hooks at 3 seconds.
      timeout: event === 'SessionEnd' ? 2 : event === 'Interrupt' ? 3 : 5,
    }],
  };
}

function removeOurGroups(groups: unknown[], ctx: AgentContext): unknown[] {
  return groups.map(group => {
    if (!group || typeof group !== 'object') return group;
    const copy = {...group as Record<string, unknown>};
    const hooks = array(copy.hooks).filter(hook => !isOurHook(hook, ctx));
    if (!hooks.length) return null;
    copy.hooks = hooks;
    return copy;
  }).filter(Boolean);
}

function isOurHook(value: unknown, ctx: AgentContext): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = (value as Record<string, unknown>).command;
  return typeof command === 'string' && command.includes(`${codexQuote(ctx.cli)} hook codex`);
}

function containsOurHook(ctx: AgentContext): boolean {
  try {
    const root = JSON.parse(readFileSync(codexHooksPath(ctx.home), 'utf8')) as Record<string, unknown>;
    const hooks = object(root.hooks);
    return Object.values(hooks).some(groups => array(groups)
      .some(group => array(object(group).hooks).some(hook => isOurHook(hook, ctx))));
  } catch {
    return false;
  }
}

// Codex records each approved hook as [hooks.state."<file>:<event>:<group>:<handler>"].
export function untrustedCodexHooks(ctx: AgentContext): string[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(codexHooksPath(ctx.home), 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const config = readFileSyncSafe(codexConfigPath(ctx.home)) ?? '';
  const missing: string[] = [];
  for (const [event, groups] of Object.entries(object(root.hooks))) {
    array(groups).forEach((group, groupIndex) => {
      array(object(group).hooks).forEach((hook, hookIndex) => {
        if (!isOurHook(hook, ctx)) return;
        const key = `${codexHooksPath(ctx.home)}:${snakeCase(event)}:${groupIndex}:${hookIndex}`;
        if (!config.includes(`[hooks.state."${key}"]`)) missing.push(event);
      });
    });
  }
  return missing;
}

function codexTrustLooksComplete(ctx: AgentContext): boolean {
  return untrustedCodexHooks(ctx).length === 0;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function notification(payload: HookPayload, receiptTime: number): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('codex', attentionPayload(payload, receiptTime))}];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

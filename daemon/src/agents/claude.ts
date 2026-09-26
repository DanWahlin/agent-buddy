import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {updateJsonFile} from './file-utils.js';
import {attentionPayload, canonicalEvent, isTool, namespacePayload, normalized} from './normalize.js';
import {versionOf} from './commands.js';
import type {AgentAdapter, AgentContext, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Elicitation', 'Notification',
  'Stop', 'StopFailure', 'SessionEnd',
];

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  hint: status => status === 'missing'
    ? 'Install hooks, then accept Claude’s folder-trust prompt if it asks.'
    : undefined,
  detect(ctx) {
    const configPath = claudeConfigPath(ctx.home);
    const version = versionOf('claude', ctx);
    return {installed: Boolean(version) || existsSync(configPath), version, configPath};
  },
  hookStatus(ctx) {
    return fileContainsOurHook(ctx) ? 'installed' : 'missing';
  },
  async install(ctx) {
    await updateJsonFile(claudeConfigPath(ctx.home), settings => {
      const hooks = object(settings.hooks);
      for (const event of events) {
        const groups = removeOurGroups(array(hooks[event]), ctx);
        groups.push(claudeGroup(ctx, event));
        hooks[event] = groups;
      }
      settings.hooks = hooks;
      return settings;
    });
  },
  async uninstall(ctx) {
    await updateJsonFile(claudeConfigPath(ctx.home), settings => {
      const hooks = object(settings.hooks);
      for (const key of Object.keys(hooks)) {
        const groups = removeOurGroups(array(hooks[key]), ctx);
        if (groups.length) hooks[key] = groups;
        else delete hooks[key];
      }
      if (Object.keys(hooks).length) settings.hooks = hooks;
      else delete settings.hooks;
      return settings;
    });
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'Notification') {
      const type = String(payload.notification_type ?? '');
      if (type === 'idle_prompt') return normalized('claude', 'sessionEnd', payload, receiptTime);
      if (['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type))
        return notification(payload, receiptTime, type);
    }
    if (name === 'PermissionRequest' || name === 'Elicitation'
        || (name === 'PreToolUse' && isTool(payload, 'AskUserQuestion', 'ExitPlanMode'))) {
      return notification(payload, receiptTime);
    }
    return normalized('claude', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function claudeConfigPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function claudeGroup(ctx: AgentContext, event: string): Record<string, unknown> {
  const group: Record<string, unknown> = {
    hooks: [{type: 'command', command: ctx.node, args: [ctx.cli, 'hook', 'claude', event], timeout: 2}],
  };
  if (event === 'Notification') group.matcher = 'permission_prompt|elicitation_dialog|elicitation_url_dialog|idle_prompt|agent_needs_input';
  return group;
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
  const hook = value as Record<string, unknown>;
  const args = Array.isArray(hook.args) ? hook.args : [];
  // Ignore `command`: the Node path changes with every Node upgrade or version manager switch.
  return hook.type === 'command' && args[0] === ctx.cli && args[1] === 'hook' && args[2] === 'claude';
}

function fileContainsOurHook(ctx: AgentContext): boolean {
  try {
    const settings = JSON.parse(readFileSync(claudeConfigPath(ctx.home), 'utf8')) as Record<string, unknown>;
    const hooks = object(settings.hooks);
    return Object.values(hooks).some(groups => array(groups)
      .some(group => object(group).hooks && array(object(group).hooks).some(hook => isOurHook(hook, ctx))));
  } catch {
    return false;
  }
}

function notification(payload: HookPayload, receiptTime: number, type = 'permission_prompt'): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('claude', attentionPayload(payload, receiptTime, type))}];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

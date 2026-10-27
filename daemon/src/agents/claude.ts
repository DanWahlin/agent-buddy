import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isRecord, updateJsonFile} from './file-utils.js';
import {attentionPayload, canonicalEvent, isTool, namespacePayload, normalized} from './normalize.js';
import {isCompanionCli, hasCommand, versionOf} from './commands.js';
import {claudeHome} from './homes.js';
import {clientVersions, findApp, type AppSpec} from './apps.js';
import {hookHealth, removeOurHooks, withOurHooks, type FoundHook} from './hook-config.js';
import type {AgentAdapter, AgentContext, HookStatus, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Elicitation', 'Notification',
  'Stop', 'StopFailure', 'SessionEnd',
];

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  clients: 'CLI, Claude app, or IDE',
  hint: status => status === 'missing'
    ? 'Install hooks, then accept Claude’s folder-trust prompt if it asks.'
    : undefined,
  detect(ctx) {
    const configPath = claudeConfigPath(ctx.home, ctx.env);
    const apps = [findApp(ctx, claudeAppSpec)].flatMap(app => app ?? []);
    const version = clientVersions(versionOf('claude', ctx)?.replace(/\s*\(Claude Code\)$/i, ''), apps);
    return {installed: hasCommand('claude', ctx) || existsSync(configPath) || apps.length > 0, version, configPath};
  },
  hookStatus(ctx) {
    return claudeHookStatus(ctx);
  },
  async install(ctx) {
    const path = claudeConfigPath(ctx.home, ctx.env);
    await updateJsonFile(path, settings =>
      withOurHooks(settings, path, events, hook => isOurHook(hook, ctx), event => claudeGroup(ctx, event)));
  },
  async uninstall(ctx) {
    await updateJsonFile(claudeConfigPath(ctx.home, ctx.env), settings => removeOurHooks(settings, hook => isOurHook(hook, ctx)),
                         {create: false});
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

// The Code tab of the Claude app runs its own Claude Code with the same ~/.claude folder. On Windows,
// the app is an MSIX package (its publisher ID differs between the Microsoft Store and winget), or a
// per-user Squirrel install from the .exe installer (winget product code AnthropicClaude).
const claudeAppSpec: AppSpec = {
  label: 'Claude app',
  mac: 'Claude.app',
  windows: {packages: ['AnthropicPBC.Claude_fnn82j28hfe8t', 'Claude_pzs8sxrjxfjjc'],
            squirrel: {folder: 'AnthropicClaude', program: 'claude.exe'}},
  linux: 'claude-desktop',
};

export function claudeConfigPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(claudeHome(home, env), 'settings.json');
}

function claudeGroup(ctx: AgentContext, event: string): Record<string, unknown> {
  const group: Record<string, unknown> = {
    hooks: [{type: 'command', command: ctx.node, args: [ctx.cli, 'hook', 'claude', event], timeout: 2}],
  };
  if (event === 'Notification') group.matcher = 'permission_prompt|elicitation_dialog|elicitation_url_dialog|idle_prompt|agent_needs_input';
  return group;
}

// A hook of any companion install, so a reinstall replaces another install's hooks.
function isOurHook(value: unknown, ctx: AgentContext): boolean {
  if (!isRecord(value)) return false;
  const args = Array.isArray(value.args) ? value.args : [];
  // Ignore `command`: the Node path changes with every Node upgrade or version manager switch.
  return value.type === 'command' && isCompanionCli(args[0], ctx) && args[1] === 'hook' && args[2] === 'claude';
}

function claudeHookStatus(ctx: AgentContext): HookStatus {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(claudeConfigPath(ctx.home, ctx.env), 'utf8'));
  } catch {
    return 'missing';
  }
  const found: FoundHook[] = [];
  const hooks = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []) {
        if (!isOurHook(hook, ctx)) continue;
        const handler = hook as {command?: unknown; args: unknown[]};
        found.push({event, node: String(handler.command ?? ''), cli: String(handler.args[0])});
      }
    }
  }
  return hookHealth(found, events, ctx);
}

function notification(payload: HookPayload, receiptTime: number, type = 'permission_prompt'): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('claude', attentionPayload(payload, receiptTime, type))}];
}

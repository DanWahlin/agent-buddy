import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {powershellHookCommand, shellHookCommand, hasCommand, versionOf} from './commands.js';
import {claudeAdapter} from './claude.js';
import {grokHome} from './homes.js';
import {isRecord, removeFile, writeTextAtomically} from './file-utils.js';
import {attentionPayload, canonicalEvent, namespacePayload, normalized} from './normalize.js';
import {hookHealth, parseHookCommand, type FoundHook} from './hook-config.js';
import type {AgentAdapter, AgentContext, HookStatus, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'StopFailure', 'StopCancelled',
  'SessionEnd',
];

export const grokAdapter: AgentAdapter = {
  id: 'grok',
  name: 'Grok Build',
  hint: status => status === 'missing' ? 'Install the Grok drop-in hook file.' : undefined,
  note(ctx) {
    const status = grokHookStatus(ctx);
    if (status === 'missing' || !runsClaudeHooks(ctx)) return undefined;
    const claude = claudeAdapter.hookStatus(ctx);
    if (claude === 'missing' || claude === 'unsupported') return undefined;
    return 'Grok also runs Claude’s hooks, and reports the Agent Companion Claude hook as failed. This does not '
      + `change the display. To stop it, add [compat.claude] hooks = false to ${grokConfigPath(ctx)}. `
      + 'Grok then skips all of your Claude hooks.';
  },
  detect(ctx) {
    const configPath = grokHookPath(ctx.home, ctx.env);
    const version = versionOf('grok', ctx);
    return {installed: hasCommand('grok', ctx) || existsSync(grokHome(ctx.home, ctx.env)), version, configPath};
  },
  hookStatus(ctx) {
    return grokHookStatus(ctx);
  },
  async install(ctx) {
    await writeTextAtomically(grokHookPath(ctx.home, ctx.env), `${JSON.stringify(createGrokHooks(ctx), null, 2)}\n`);
  },
  async uninstall(ctx) {
    await removeFile(grokHookPath(ctx.home, ctx.env));
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    const subagentType = payload.subagentType ?? payload.subagent_type;
    if (subagentType && name !== 'SubagentStart' && name !== 'SubagentStop') return [];
    if (name === 'Notification') {
      const type = String(payload.notificationType ?? payload.notification_type ?? '');
      if (type === 'idle_prompt') return normalized('grok', 'sessionEnd', payload, receiptTime);
      if (type === 'agent_error') return normalized('grok', 'errorOccurred', payload, receiptTime);
      if (type === 'permission_prompt' || type === 'elicitation_dialog') return notification(payload, receiptTime, type);
      return [];
    }
    if (name === 'Stop') {
      return String(payload.reason ?? '') === 'end_turn'
        ? normalized('grok', 'agentStop', payload, receiptTime)
        : normalized('grok', 'sessionEnd', payload, receiptTime);
    }
    if (name === 'StopCancelled') return normalized('grok', 'sessionEnd', payload, receiptTime);
    return normalized('grok', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function grokHookPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(grokHome(home, env), 'hooks', 'agent-companion.json');
}

export function grokConfigPath(ctx: AgentContext): string {
  return join(grokHome(ctx.home, ctx.env), 'config.toml');
}

// Grok runs the hooks in Claude's settings unless compat.claude.hooks is false.
export function runsClaudeHooks(ctx: AgentContext): boolean {
  const env = ctx.env.GROK_CLAUDE_HOOKS_ENABLED?.trim().toLowerCase();
  if (env === 'false' || env === '0') return false;
  let text: string;
  try {
    text = readFileSync(grokConfigPath(ctx), 'utf8');
  } catch {
    return true;
  }
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, '').trim();
    const header = /^\[\s*([^\[\]]+?)\s*\]$/.exec(line);
    if (header) {
      table = (header[1] ?? '').replace(/\s*\.\s*/g, '.');
      continue;
    }
    const [, name = '', value = ''] = /^([\w.\s"-]+?)\s*=\s*(.+)$/.exec(line) ?? [];
    const key = [table, name.replace(/["\s]/g, '')].filter(Boolean).join('.');
    if (key === 'compat.claude.hooks' && value === 'false') return false;
    if (key === 'compat.claude' && /^\{.*\bhooks\s*=\s*false\b.*\}$/.test(value)) return false;
  }
  return true;
}

function createGrokHooks(ctx: AgentContext): object {
  const command = (event: string) => [{
    hooks: [{
      type: 'command',
      command: grokHookCommand(ctx, event),
      timeout: 5,
    }],
  }];
  return {hooks: Object.fromEntries(events.map(event => [event, command(event)]))};
}

function grokHookCommand(ctx: AgentContext, event: string): string {
  return ctx.platform === 'win32' ? powershellHookCommand(ctx, 'grok', event) : shellHookCommand(ctx, 'grok', event);
}

// The file is ours alone, so a file without readable companion hooks is 'outdated', not 'missing'.
function grokHookStatus(ctx: AgentContext): HookStatus {
  const path = grokHookPath(ctx.home, ctx.env);
  if (!existsSync(path)) return 'missing';
  const found: FoundHook[] = [];
  try {
    const root = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const hooks = isRecord(root) && isRecord(root.hooks) ? root.hooks : {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []) {
          const command = isRecord(hook) ? String(hook.command ?? '') : '';
          const parsed = parseHookCommand(command, 'grok');
          if (!parsed) continue;
          // PowerShell can't run the command line that earlier versions wrote on Windows.
          if (ctx.platform === 'win32' && !command.trim().startsWith('&')) return 'outdated';
          found.push({...parsed, event});
        }
      }
    }
  } catch {
    return 'outdated';
  }
  return found.length ? hookHealth(found, events, ctx) : 'outdated';
}

function notification(payload: HookPayload, receiptTime: number, type = 'permission_prompt'): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('grok', attentionPayload(payload, receiptTime, type))}];
}

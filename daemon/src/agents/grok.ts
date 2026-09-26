import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {shellQuote, versionOf} from './commands.js';
import {removeFile, writeTextAtomically} from './file-utils.js';
import {attentionPayload, canonicalEvent, namespacePayload, normalized} from './normalize.js';
import type {AgentAdapter, AgentContext, NormalizedHook} from './types.js';
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
  detect(ctx) {
    const configPath = grokHookPath(ctx.home);
    const version = versionOf('grok', ctx);
    return {installed: Boolean(version) || existsSync(join(ctx.home, '.grok')), version, configPath};
  },
  hookStatus(ctx) {
    return existsSync(grokHookPath(ctx.home)) ? 'installed' : 'missing';
  },
  async install(ctx) {
    await writeTextAtomically(grokHookPath(ctx.home), `${JSON.stringify(createGrokHooks(ctx), null, 2)}\n`);
  },
  async uninstall(ctx) {
    await removeFile(grokHookPath(ctx.home));
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

export function grokHookPath(home: string): string {
  return join(home, '.grok', 'hooks', 'agent-companion.json');
}

function createGrokHooks(ctx: AgentContext): object {
  const command = (event: string) => [{
    hooks: [{
      type: 'command',
      command: `${shellQuote(ctx.node)} ${shellQuote(ctx.cli)} hook grok ${event}`,
      timeout: 5,
    }],
  }];
  return {hooks: Object.fromEntries(events.map(event => [event, command(event)]))};
}

function notification(payload: HookPayload, receiptTime: number, type = 'permission_prompt'): NormalizedHook[] {
  return [{event: 'notification', payload: namespacePayload('grok', attentionPayload(payload, receiptTime, type))}];
}

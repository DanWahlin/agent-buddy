import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {writeTextAtomically, removeFile} from './file-utils.js';
import {canonicalEvent, normalized} from './normalize.js';
import {versionOf} from './commands.js';
import type {AgentAdapter, AgentContext, HookStatus} from './types.js';

export const copilotAdapter: AgentAdapter = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  hint: status => status === 'missing' ? 'Run setup to install the Copilot hook file.' : undefined,
  detect(ctx) {
    const configPath = copilotHookPath(ctx.home);
    return {installed: true, version: versionOf('gh', ctx), configPath};
  },
  hookStatus(ctx) {
    return hasCopilotHooks(ctx) ? 'installed' : 'missing';
  },
  async install(ctx) {
    await writeTextAtomically(copilotHookPath(ctx.home), `${JSON.stringify(createCopilotHooks(ctx.node, ctx.cli), null, 2)}\n`);
  },
  async uninstall(ctx) {
    await removeFile(copilotHookPath(ctx.home));
  },
  normalize(nativeEvent, payload, receiptTime) {
    return normalized('copilot', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function copilotHookPath(home: string): string {
  return join(home, '.copilot', 'hooks', 'agent-companion.json');
}

export function createCopilotHooks(node: string, cli: string): object {
  const command = (event: string) => [{
    type: 'command',
    exec: node,
    args: [cli, 'hook', 'copilot', event],
    timeoutSec: 2,
  }];
  return {
    version: 1,
    hooks: {
      sessionStart: command('sessionStart'),
      userPromptSubmitted: command('userPromptSubmitted'),
      preToolUse: command('preToolUse'),
      postToolUse: command('postToolUse'),
      postToolUseFailure: command('postToolUseFailure'),
      subagentStart: command('subagentStart'),
      subagentStop: command('subagentStop'),
      agentStop: command('agentStop'),
      notification: [{
        ...command('notification')[0],
        matcher: 'permission_prompt|elicitation_dialog',
      }],
      errorOccurred: command('errorOccurred'),
      sessionEnd: command('sessionEnd'),
    },
  };
}

function hasCopilotHooks(ctx: AgentContext): boolean {
  if (!existsSync(copilotHookPath(ctx.home))) return false;
  return true;
}

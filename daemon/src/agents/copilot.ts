import {existsSync, readFileSync} from 'node:fs';
import {join, win32} from 'node:path';
import {isRecord, writeTextAtomically, removeFile} from './file-utils.js';
import {attentionPayload, canonicalEvent, namespacePayload, normalized} from './normalize.js';
import {versionOf} from './commands.js';
import {copilotHome} from './homes.js';
import {hookHealth, type FoundHook} from './hook-config.js';
import type {AgentAdapter, AgentContext, HookStatus} from './types.js';
import type {HookPayload} from '../protocol.js';

export const copilotAdapter: AgentAdapter = {
  id: 'copilot',
  name: 'GitHub Copilot',
  hint: status => status === 'missing' ? 'Run setup to install the Copilot hook file.' : undefined,
  detect(ctx) {
    const configPath = copilotHookPath(ctx.home, ctx.env);
    return {installed: true, version: copilotVersions(versionOf('copilot', ctx), copilotAppVersion(ctx)), configPath};
  },
  hookStatus(ctx) {
    return copilotHookStatus(ctx);
  },
  async install(ctx) {
    await writeTextAtomically(copilotHookPath(ctx.home, ctx.env),
      `${JSON.stringify(createCopilotHooks(ctx.node, ctx.cli, ctx.platform, ctx.env), null, 2)}\n`);
  },
  async uninstall(ctx) {
    await removeFile(copilotHookPath(ctx.home, ctx.env));
  },
  normalize(nativeEvent, payload, receiptTime) {
    const event = canonicalEvent(nativeEvent, payload);
    // Copilot retries recoverable model-call errors itself, so they don't need the user.
    if (event === 'errorOccurred' && payload.recoverable === true) return [];
    // Questions and plan approvals wait for the user but fire no notification hook. The
    // postToolUse of that question sets Working again. Copilot can run other tools in
    // the same batch; their events must not end the wait, so it names the tools it waits on.
    const waiting = event === 'preToolUse' ? calledTools(payload).filter(name => userInputTools.includes(name)) : [];
    if (waiting.length) {
      return [{event: 'notification', payload: namespacePayload('copilot',
        {...attentionPayload(payload, receiptTime, 'elicitation_dialog'), waitingOn: [...new Set(waiting)]})}];
    }
    return normalized('copilot', event, payload, receiptTime);
  },
};

const userInputTools = ['ask_user', 'exit_plan_mode'];

// Copilot's preToolUse lists the calls in toolCalls[].name instead of toolName.
function calledTools(payload: HookPayload): string[] {
  const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
  const names = calls.flatMap(call => (isRecord(call) && typeof call.name === 'string' ? [call.name] : []));
  const single = payload.toolName ?? payload.tool_name;
  return typeof single === 'string' ? [single, ...names] : names;
}

export function copilotHookPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(copilotHome(home, env), 'hooks', 'agent-companion.json');
}

// The GitHub Copilot app runs its own Copilot CLI with the same ~/.copilot folder, so
// the CLI and the app share one hook file. Settings shows the version of each one found.
export function copilotVersions(cli: string | undefined, app: string | undefined): string | undefined {
  const parts = [
    cli && `CLI ${cli.replace(/^GitHub Copilot CLI\s*/i, '')}`,
    app && `app ${app}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function copilotAppVersion(ctx: AgentContext,
  folders = ['/Applications', join(ctx.home, 'Applications')]): string | undefined {
  if (ctx.platform !== 'darwin') return undefined;
  for (const folder of folders) {
    try {
      const plist = readFileSync(join(folder, 'GitHub Copilot.app', 'Contents', 'Info.plist'), 'utf8');
      const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
      if (version) return version;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

// Copilot denies every tool call when a preToolUse hook cannot run, and a running session keeps
// the hooks it loaded at its start. So after an uninstall removes Node.js and the CLI, such a
// session could use no tool until it restarted. The system shell, which is always there, runs
// the hook only while Node.js and the CLI are on disk. Otherwise it reads the event that Copilot
// writes to it, so that write can't fail, and exits with 0.
export function copilotHookCommand(node: string, cli: string, event: string, platform: NodeJS.Platform,
                                   env: NodeJS.ProcessEnv): {exec: string; args: string[]} {
  const hook = [cli, 'hook', 'copilot', event];
  if (platform !== 'win32') {
    return {exec: '/bin/sh', args: ['-c', '[ -x "$0" ] && [ -f "$1" ] && exec "$0" "$@"; while read -r _; do :; done',
                                    node, ...hook]};
  }
  // Copilot quotes an argument for cmd.exe only when it has a space, so a path with a character
  // that cmd.exe reads in its command line runs Node.js directly, as before.
  if ([node, cli].some(path => /["%^&|<>()!,;=]/.test(path))) return {exec: node, args: hook};
  const root = env.SystemRoot?.trim() || env.windir?.trim() || 'C:\\Windows';
  return {exec: win32.join(root, 'System32', 'cmd.exe'),
          args: ['/d', '/c', 'if', 'exist', node, '(if', 'exist', cli, '(', node, ...hook, ')', 'else', 'more', '>nul)',
                 'else', 'more', '>nul']};
}

export function createCopilotHooks(node: string, cli: string, platform: NodeJS.Platform = process.platform,
                                   env: NodeJS.ProcessEnv = process.env): object {
  const command = (event: string) => [{
    type: 'command',
    ...copilotHookCommand(node, cli, event, platform, env),
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

// The Node.js and CLI of a companion hook: `<node> <cli> hook copilot EVENT` run directly, as earlier
// versions wrote it, or through the system shell, with Node.js and the CLI just before `hook`.
export function parseCopilotHookEntry(exec: unknown, args: unknown[]): {node: string; cli: string} | undefined {
  const at = args.findIndex((arg, index) => arg === 'hook' && args[index + 1] === 'copilot');
  if (at < 1) return undefined;
  const cli = args[at - 1];
  const node = at === 1 ? exec : args[at - 2];
  return typeof cli === 'string' && typeof node === 'string' ? {node, cli} : undefined;
}

// The file is ours alone, so a file without readable companion hooks is 'outdated', not 'missing'.
function copilotHookStatus(ctx: AgentContext): HookStatus {
  const path = copilotHookPath(ctx.home, ctx.env);
  if (!existsSync(path)) return 'missing';
  const found: FoundHook[] = [];
  try {
    const root = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const hooks = isRecord(root) && isRecord(root.hooks) ? root.hooks : {};
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!isRecord(entry) || !Array.isArray(entry.args)) continue;
        const hook = parseCopilotHookEntry(entry.exec, entry.args as unknown[]);
        if (hook) found.push({event, ...hook});
      }
    }
  } catch {
    return 'outdated';
  }
  const events = Object.keys((createCopilotHooks('', '') as {hooks: object}).hooks);
  return found.length ? hookHealth(found, events, ctx) : 'outdated';
}

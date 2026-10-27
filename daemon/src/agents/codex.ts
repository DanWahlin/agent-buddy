import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isRecord, recordOf, updateJsonFile} from './file-utils.js';
import {codexQuote, findExecutable, isCompanionHookCommand, hasCommand, powershellHookCommand, shellQuote, versionOf,
        versionOfExecutable} from './commands.js';
import {bundledCodexCli, clientVersions, findApp, type AppSpec, type DesktopApp} from './apps.js';
import {codexHome} from './homes.js';
import {attentionPayload, canonicalEvent, namespacePayload, normalized} from './normalize.js';
import {hookHealth, parseHookCommand, removeOurHooks, withOurHooks, type FoundHook} from './hook-config.js';
import type {AgentAdapter, AgentContext, HookStatus, NormalizedHook} from './types.js';
import type {HookPayload} from '../protocol.js';

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd',
];

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  clients: 'CLI, ChatGPT app, or VS Code',
  hint: status => status === 'needs-approval'
    ? 'Approve the new hooks with /hooks in the Codex CLI, then reopen the ChatGPT app.'
    : status === 'missing' ? 'Install hooks, then approve them with /hooks in the Codex CLI.' : undefined,
  detect(ctx) {
    const configPath = codexHooksPath(ctx.home, ctx.env);
    const apps = codexApps(ctx);
    const version = clientVersions(versionOf('codex', ctx)?.replace(/^codex-cli\s*/i, ''), apps);
    return {installed: hasCommand('codex', ctx) || existsSync(configPath) || apps.length > 0, version, configPath};
  },
  hookStatus(ctx) {
    const status = codexHookHealth(ctx);
    if (status !== 'installed') return status;
    return codexTrustLooksComplete(ctx) ? 'installed' : 'needs-approval';
  },
  async install(ctx) {
    const path = codexHooksPath(ctx.home, ctx.env);
    return editCodexHooks(ctx, root =>
      withOurHooks(root, path, events, hook => isOurHook(hook, ctx, true), event => codexGroup(ctx, event)));
  },
  async uninstall(ctx) {
    return editCodexHooks(ctx, root => removeOurHooks(root, hook => isOurHook(hook, ctx, true)), {create: false});
  },
  normalize(nativeEvent, payload, receiptTime) {
    const name = String(nativeEvent ?? payload.hook_event_name ?? '');
    if (name === 'PermissionRequest') return notification(payload, receiptTime);
    if (name === 'Interrupt') return normalized('codex', 'sessionEnd', payload, receiptTime);
    if (name === 'Stop') return normalized('codex', 'agentStop', {...payload, clearAttention: true}, receiptTime);
    return normalized('codex', canonicalEvent(nativeEvent, payload), payload, receiptTime);
  },
};

export function codexHooksPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(codexHome(home, env), 'hooks.json');
}

// The ChatGPT app includes a Codex CLI and uses the same ~/.codex folder. It replaced the Codex app,
// which an older macOS install can still have. Its Windows package keeps the name OpenAI.Codex.
const codexAppSpecs: readonly AppSpec[] = [
  {label: 'ChatGPT app', mac: 'ChatGPT.app', windows: {packages: ['OpenAI.Codex_2p2nqsd0c76g0']}, linux: 'chatgpt'},
  {label: 'Codex app', mac: 'Codex.app'},
];

// An older macOS ChatGPT app has no Codex, so there the bundled CLI must be present. On Windows,
// the package always includes it, but its folder is known only after the first registry read.
export function codexApps(ctx: AgentContext): DesktopApp[] {
  return codexAppSpecs.flatMap(spec => findApp(ctx, spec) ?? [])
    .filter(app => ctx.platform === 'win32' || bundledCodexCli(ctx, app));
}

// The Codex CLI that the user runs to approve hooks.
export interface CodexApproval {
  // `codex`, or the quoted path of a CLI that a desktop app includes.
  command: string;
  // The app that includes the CLI, for example "ChatGPT app".
  app?: string;
}

// What the user runs in a terminal to approve hooks: `codex` when it is on PATH, otherwise the
// newest CLI that a Codex desktop app includes, or undefined when there is neither. A CLI older
// than hook approval can't approve hooks, so it is skipped. A version that is not known yet (it is
// read in the background) doesn't exclude a CLI, but a known version comes first.
export function codexApproval(ctx: AgentContext,
                              version: (path: string) => string | undefined = path => versionOfExecutable(path, ctx),
): CodexApproval | undefined {
  const onPath = findExecutable('codex', ctx.env, ctx.platform);
  if (onPath && canApproveHooks(versionParts(version(onPath)))) return {command: 'codex'};
  const bundled = codexApps(ctx).flatMap(app => {
    const path = bundledCodexCli(ctx, app);
    const parts = path ? versionParts(version(path)) : undefined;
    return path && canApproveHooks(parts) ? [{path, parts, app: app.label}] : [];
  }).sort((first, second) => !first.parts || !second.parts ? Number(!first.parts) - Number(!second.parts)
    : compareVersions(second.parts, first.parts))[0];
  if (!bundled) return undefined;
  // On Windows, the terminal is PowerShell, which runs a quoted path with `&`.
  const command = ctx.platform === 'win32' ? `& '${bundled.path.replaceAll("'", "''")}'` : shellQuote(bundled.path);
  return {command, app: bundled.app};
}

// Codex 0.129.0 added hook approval (openai/codex#20321). Its prereleases came before that change.
const firstCodexWithHookApproval = [0, 129, 0, 1];

function canApproveHooks(parts: number[] | undefined): boolean {
  return !parts || compareVersions(parts, firstCodexWithHookApproval) >= 0;
}

// Major, minor, patch, then 0 for a prerelease (such as 0.129.0-alpha.1) or 1 for a release.
function versionParts(version: string | undefined): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z])?/.exec(version ?? '');
  return match ? [...match.slice(1, 4).map(Number), match[4] ? 0 : 1] : undefined;
}

function compareVersions(first: number[], second: number[]): number {
  for (let index = 0; index < 4; index++) {
    if (first[index] !== second[index]) return first[index]! - second[index]!;
  }
  return 0;
}

// The first setup step, which opens the Codex CLI that can approve hooks.
export function codexRunStep(approval: CodexApproval | undefined, platform: NodeJS.Platform): string {
  if (!approval) {
    return 'Install the Codex CLI with npm install -g @openai/codex. Then open a terminal in any folder and run codex.';
  }
  if (!approval.app) return 'Open a terminal in any folder and run codex.';
  // The Windows command is a PowerShell call, which Command Prompt can't run.
  const terminal = platform === 'win32' ? 'PowerShell' : 'a terminal';
  return `Open ${terminal} in any folder and run the Codex CLI that your ${approval.app} includes: ${approval.command}`;
}

// An install runs once, possibly before the background reads find the app's CLI, and an agent in WSL
// has no PATH here. So when no command is known, the warning doesn't tell the user to install one.
function codexWarningStep(ctx: AgentContext): string {
  if (ctx.hostPath) return codexRunStep({command: 'codex'}, ctx.platform);
  const approval = codexApproval(ctx);
  return approval ? codexRunStep(approval, ctx.platform) : 'Open the Codex CLI in a terminal.';
}

function codexConfigPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(codexHome(home, env), 'config.toml');
}

function codexCommand(ctx: AgentContext, event: string): string {
  return `${codexQuote(ctx.node)} ${codexQuote(ctx.cli)} hook codex ${event}`;
}

function codexGroup(ctx: AgentContext, event: string): Record<string, unknown> {
  return {
    hooks: [{
      type: 'command',
      command: codexCommand(ctx, event),
      // On Windows, Codex runs hooks in its session shell, which is PowerShell.
      ...(ctx.platform === 'win32' ? {commandWindows: powershellHookCommand(ctx, 'codex', event)} : {}),
      async: event !== 'SessionEnd',
      // Codex caps SessionEnd and Interrupt hooks at 3 seconds.
      timeout: event === 'SessionEnd' ? 2 : event === 'Interrupt' ? 3 : 5,
    }],
  };
}

// `anyInstall` also matches the hooks of another companion install, to replace them.
function isOurHook(value: unknown, ctx: AgentContext, anyInstall = false): boolean {
  if (!isRecord(value)) return false;
  const command = value.command;
  if (typeof command !== 'string') return false;
  return command.includes(`${codexQuote(ctx.cli)} hook codex`)
    || (anyInstall && isCompanionHookCommand(command, 'codex', ctx));
}

function codexHookHealth(ctx: AgentContext): HookStatus {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(codexHooksPath(ctx.home, ctx.env), 'utf8')) as Record<string, unknown>;
  } catch {
    return 'missing';
  }
  const found: FoundHook[] = [];
  for (const [event, groups] of Object.entries(recordOf(root?.hooks))) {
    for (const group of array(groups)) {
      for (const hook of array(recordOf(group).hooks)) {
        if (!isOurHook(hook, ctx, true)) continue;
        // Earlier installs wrote a cmd.exe line, which PowerShell cannot run.
        const windows = recordOf(hook).commandWindows;
        if (ctx.platform === 'win32' && !(typeof windows === 'string' && windows.trim().startsWith('&'))) return 'outdated';
        found.push({...(parseHookCommand(String(recordOf(hook).command), 'codex') ?? {node: '', cli: ''}), event});
      }
    }
  }
  return hookHealth(found, events, ctx);
}

// Codex links each approval to a hook's position (event, group, handler). When removing our hooks moves
// one of the user's approved hooks, Codex skips it until the user approves it again, so tell them.
async function editCodexHooks(ctx: AgentContext, update: (root: Record<string, unknown>) => Record<string, unknown>,
                              options?: {create?: boolean}): Promise<string[]> {
  const path = codexHooksPath(ctx.home, ctx.env);
  let before = new Map<object, {event: string; position: string}>();
  let after = new Map<object, {event: string; position: string}>();
  await updateJsonFile(path, root => {
    before = userHookPositions(root, ctx);
    const next = update(root);
    after = userHookPositions(next, ctx);
    return next;
  }, options);
  const config = readFileSyncSafe(codexConfigPath(ctx.home, ctx.env)) ?? '';
  const key = codexKeyPath(ctx);
  const moved = [...before].filter(([handler, {position}]) => after.has(handler)
    && after.get(handler)!.position !== position && hasHookState(config, `${key}:${position}`));
  if (!moved.length) return [];
  const names = moved.map(([handler, {event}]) => `${event}: ${String((handler as {command?: unknown}).command ?? '?')}`);
  return [`Codex: some of your own hooks moved, so Codex skips them until you approve them again. `
    + `${codexWarningStep(ctx)} Type /hooks and approve: ${names.join('; ')}`];
}

// The position of each of the user's hook handlers, by object, as Codex writes it in an approval key.
function userHookPositions(root: Record<string, unknown>, ctx: AgentContext): Map<object, {event: string; position: string}> {
  const positions = new Map<object, {event: string; position: string}>();
  for (const [event, groups] of Object.entries(recordOf(root.hooks))) {
    array(groups).forEach((group, groupIndex) => {
      array(recordOf(group).hooks).forEach((hook, hookIndex) => {
        if (isRecord(hook) && !isOurHook(hook, ctx, true))
          positions.set(hook, {event, position: `${snakeCase(event)}:${groupIndex}:${hookIndex}`});
      });
    });
  }
  return positions;
}

// Codex records each approved hook as [hooks.state."<file>:<event>:<group>:<handler>"].
export function untrustedCodexHooks(ctx: AgentContext): string[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(codexHooksPath(ctx.home, ctx.env), 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const config = readFileSyncSafe(codexConfigPath(ctx.home, ctx.env)) ?? '';
  const missing: string[] = [];
  for (const [event, groups] of Object.entries(recordOf(root.hooks))) {
    array(groups).forEach((group, groupIndex) => {
      array(recordOf(group).hooks).forEach((hook, hookIndex) => {
        if (!isOurHook(hook, ctx)) return;
        const key = `${codexKeyPath(ctx)}:${snakeCase(event)}:${groupIndex}:${hookIndex}`;
        if (!hasHookState(config, key)) missing.push(event);
      });
    });
  }
  return missing;
}

// The hooks file as Codex names it in its approval keys: in WSL, a Linux path.
function codexKeyPath(ctx: AgentContext): string {
  const path = codexHooksPath(ctx.home, ctx.env);
  return ctx.agentPath?.(path) ?? path;
}

// TOML escapes the backslashes of a Windows path in a quoted key; a literal key keeps them.
export function hasHookState(config: string, key: string): boolean {
  const escaped = key.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return config.includes(`[hooks.state."${escaped}"]`) || config.includes(`[hooks.state.'${key}']`)
    || config.includes(`[hooks.state."${key}"]`);
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

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

import {existsSync, readdirSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename, join} from 'node:path';
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
  note: ctx => codexUpdateSteps(ctx).join(' ') || undefined,
  detect(ctx) {
    const configPath = codexHooksPath(ctx.home, ctx.env);
    const apps = codexApps(ctx);
    const version = clientVersions(cliVersion(versionOf('codex', ctx)), apps);
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
// newest CLI that a Codex desktop app includes, or undefined when there is neither. A CLI that
// can't run the Agent Buddy hooks doesn't list them in /hooks, so it is skipped. A version that is
// not known yet (it is read in the background) doesn't exclude a CLI, but a known version comes first.
export function codexApproval(ctx: AgentContext,
                              version: (path: string) => string | undefined = path => versionOfExecutable(path, ctx),
): CodexApproval | undefined {
  const onPath = findExecutable('codex', ctx.env, ctx.platform);
  if (onPath && runsOurHooks(versionParts(version(onPath)))) return {command: 'codex'};
  const bundled = codexApps(ctx).flatMap(app => {
    const path = bundledCodexCli(ctx, app);
    const parts = path ? versionParts(version(path)) : undefined;
    return path && runsOurHooks(parts) ? [{path, parts, app: app.label}] : [];
  }).sort((first, second) => !first.parts || !second.parts ? Number(!first.parts) - Number(!second.parts)
    : compareVersions(second.parts, first.parts))[0];
  if (!bundled) return undefined;
  // On Windows, the terminal is PowerShell, which runs a quoted path with `&`.
  const command = ctx.platform === 'win32' ? `& '${bundled.path.replaceAll("'", "''")}'` : shellQuote(bundled.path);
  return {command, app: bundled.app};
}

// A Codex that runs here, with its version once that is known.
export interface CodexClient {
  kind: 'cli' | 'app' | 'extension';
  // How the user knows it: "Codex CLI", an app such as "ChatGPT app", or an editor such as "VS Code".
  label: string;
  version?: string;
}

// Each Codex here: the codex on PATH, the CLI that each Codex desktop app includes, and the CLI that
// the Codex extension includes in each editor. In a location whose commands this service can't
// run, such as a WSL distribution, the version of codex comes from the location's probe.
export function codexClients(ctx: AgentContext,
                             version: (path: string) => string | undefined = path => versionOfExecutable(path, ctx),
): CodexClient[] {
  const read = (path: string | undefined) => path ? cliVersion(version(path)) : undefined;
  const onPath = ctx.commandVersions ? undefined : findExecutable('codex', ctx.env, ctx.platform);
  const cli = ctx.commandVersions ? cliVersion(ctx.commandVersions.codex) : read(onPath);
  return [
    ...(onPath || cli ? [{kind: 'cli' as const, label: 'Codex CLI', ...(cli ? {version: cli} : {})}] : []),
    ...codexApps(ctx).map(app => {
      const found = read(bundledCodexCli(ctx, app));
      return {kind: 'app' as const, label: app.label, ...(found ? {version: found} : {})};
    }),
    ...codexExtensions(ctx, read),
  ];
}

// What the user updates before Codex runs the Agent Buddy hooks: each Codex here that can't run
// them. Reopening such a client doesn't help. A version that is not known yet doesn't count.
// `place` names a location other than this computer, such as "WSL: Ubuntu".
export function codexUpdateSteps(ctx: AgentContext,
                                 version: (path: string) => string | undefined = path => versionOfExecutable(path, ctx),
                                 place?: string): string[] {
  const steps = codexClients(ctx, version).flatMap(client => client.version && !runsOurHooks(versionParts(client.version))
    ? [updateStep(client.kind, client.label, client.version, place)] : []);
  return [...new Set(steps)];
}

function updateStep(kind: CodexClient['kind'], label: string, version: string, place: string | undefined): string {
  const problem = 'can’t run the Agent Buddy hooks';
  const text = kind === 'cli' ? `your Codex CLI ${version} ${problem}. Update the Codex CLI.`
    : kind === 'app' ? `your ${label} includes Codex ${version}, which ${problem}. Update the ${label}, then reopen it.`
    : `the Codex extension in ${label} includes Codex ${version}, which ${problem}. `
      + `Update the extension, then reload the ${label} window.`;
  return place ? `In ${place}, ${text}` : text[0]!.toUpperCase() + text.slice(1);
}

function cliVersion(text: string | undefined): string | undefined {
  return text?.replace(/^codex-cli\s*/i, '') || undefined;
}

// The editors that run the Codex extension (openai.chatgpt), with the folders in the home folder that
// hold their extensions. An editor that is gone leaves its folder, so the local folder counts only
// while the editor is installed. The server folder holds the extensions of a remote window, such as
// a VS Code window in WSL or over SSH.
interface CodexEditor {
  label: string;
  local: string;
  server: string;
  // The command that the editor's package puts on PATH on Linux.
  command: string;
  // A real path of that command in another editor's folder: Cursor and Windsurf can add a `code` command.
  otherEditor?: RegExp;
  app: AppSpec;
}

const codexEditors: readonly CodexEditor[] = [
  {label: 'VS Code', local: '.vscode', server: '.vscode-server', command: 'code', otherEditor: /cursor|windsurf/i, app: {
    label: 'VS Code', mac: 'Visual Studio Code.app', windows: {folders: [
      {base: 'LOCALAPPDATA', folder: 'Programs\\Microsoft VS Code', program: 'Code.exe'},
      {base: 'ProgramFiles', folder: 'Microsoft VS Code', program: 'Code.exe'},
    ]},
  }},
  {label: 'VS Code Insiders', local: '.vscode-insiders', server: '.vscode-server-insiders', command: 'code-insiders',
   otherEditor: /cursor|windsurf/i, app: {
    label: 'VS Code Insiders', mac: 'Visual Studio Code - Insiders.app', windows: {folders: [
      {base: 'LOCALAPPDATA', folder: 'Programs\\Microsoft VS Code Insiders', program: 'Code - Insiders.exe'},
      {base: 'ProgramFiles', folder: 'Microsoft VS Code Insiders', program: 'Code - Insiders.exe'},
    ]},
  }},
  {label: 'Cursor', local: '.cursor', server: '.cursor-server', command: 'cursor', app: {
    label: 'Cursor', mac: 'Cursor.app', windows: {folders: [{base: 'LOCALAPPDATA', folder: 'Programs\\cursor', program: 'Cursor.exe'}]},
  }},
  {label: 'Windsurf', local: '.windsurf', server: '.windsurf-server', command: 'windsurf', app: {
    label: 'Windsurf', mac: 'Windsurf.app', windows: {folders: [{base: 'LOCALAPPDATA', folder: 'Programs\\Windsurf', program: 'Windsurf.exe'}]},
  }},
];

// On macOS and Windows, the editor's app shows that it is installed. On Linux, its command does,
// unless that command is really in another editor's folder.
function editorInstalled(ctx: AgentContext, editor: CodexEditor): boolean {
  if (ctx.platform === 'darwin' || ctx.platform === 'win32') return Boolean(findApp(ctx, editor.app));
  const command = findExecutable(editor.command, ctx.env, ctx.platform);
  if (!command) return false;
  try {
    return !editor.otherEditor?.test(realpathSync(command));
  } catch {
    return false;
  }
}

// A remote window updates its extensions while it is connected, so a server folder whose list hasn't
// changed for this long belongs to remote windows that the user no longer opens.
const serverListMaxAgeMs = 30 * 24 * 60 * 60_000;

// A remote place, such as a WSL distribution, has no installed editor of its own: only server folders.
function codexExtensions(ctx: AgentContext, read: (path: string | undefined) => string | undefined): CodexClient[] {
  return codexEditors.flatMap(editor => {
    const local = ctx.hostPath ? undefined : installedCodexExtension(join(ctx.home, editor.local, 'extensions'));
    const server = installedCodexExtension(join(ctx.home, editor.server, 'extensions'));
    return [
      ...(local && editorInstalled(ctx, editor) ? [local.folder] : []),
      ...(server && Date.now() - server.changedAt < serverListMaxAgeMs ? [server.folder] : []),
    ].map(extension => {
      const found = extensionCodexVersion(ctx, extension, read);
      return {kind: 'extension' as const, label: editor.label, ...(found ? {version: found} : {})};
    });
  });
}

// An editor lists the folder of each installed extension in extensions.json. The folder of an older
// version can stay until the editor deletes it, so only the listed folder counts. Status requests
// arrive every second, so a list is read again only when it changes.
const extensionLists = new Map<string, {key: string; folder?: string}>();

function installedCodexExtension(extensions: string): {folder: string; changedAt: number} | undefined {
  const list = join(extensions, 'extensions.json');
  let key: string;
  let changedAt: number;
  try {
    const details = statSync(list);
    key = `${details.mtimeMs}:${details.size}`;
    changedAt = details.mtimeMs;
  } catch {
    extensionLists.delete(list);
    return undefined;
  }
  let known = extensionLists.get(list);
  if (known?.key !== key) {
    let folder: string | undefined;
    try {
      const entries: unknown = JSON.parse(readFileSync(list, 'utf8'));
      const entry = recordOf(Array.isArray(entries) ? entries.find(item =>
        String(recordOf(recordOf(item).identifier).id).toLowerCase() === 'openai.chatgpt') : undefined);
      // Older lists give only the full location, as a URI path such as /c:/Users/.../openai.chatgpt-<version>.
      const name = typeof entry.relativeLocation === 'string' ? entry.relativeLocation
        : basename(String(recordOf(entry.location).path ?? ''));
      folder = /^openai\.chatgpt-[\w.-]+$/i.test(name) ? join(extensions, name) : undefined;
    } catch {
      folder = undefined;
    }
    known = {key, folder};
    extensionLists.set(list, known);
  }
  return known.folder ? {folder: known.folder, changedAt} : undefined;
}

// The extension keeps its Codex in bin/<system>/, beside a codex-package.json that gives its
// version. Without that file, the version comes from the CLI, which only runs on this computer. An
// installed extension's folder doesn't change, so what it has is read once.
const extensionContents = new Map<string, {version?: string; cli?: string}>();

function extensionCodexVersion(ctx: AgentContext, extension: string,
                               read: (path: string | undefined) => string | undefined): string | undefined {
  let contents = extensionContents.get(extension);
  if (!contents) {
    contents = {};
    const bin = join(extension, 'bin');
    let systems: string[] = [];
    try {
      systems = readdirSync(bin);
    } catch {
      // No bin folder.
    }
    for (const system of systems) {
      try {
        const found = (JSON.parse(readFileSync(join(bin, system, 'codex-package.json'), 'utf8')) as {version?: unknown}).version;
        if (typeof found === 'string' && found) {
          contents.version = found;
          break;
        }
      } catch {
        // No codex-package.json in this folder.
      }
    }
    if (!contents.version) {
      contents.cli = systems.map(system => join(bin, system, ctx.platform === 'win32' ? 'codex.exe' : 'codex'))
        .find(path => existsSync(path));
    }
    extensionContents.set(extension, contents);
  }
  return contents.version ?? (ctx.hostPath ? undefined : read(contents.cli));
}

// Codex 0.148.0-alpha.6 added async hooks (openai/codex#37533). An older Codex skips async hooks
// and doesn't list them in /hooks. All the Agent Buddy hooks but SessionEnd are async, and
// SessionEnd alone can't show a session. Hook approval came before, in 0.129.0 (openai/codex#20321).
const firstCodexWithAsyncHooks = [0, 148, 0, 0, 6];

function runsOurHooks(parts: number[] | undefined): boolean {
  return !parts || compareVersions(parts, firstCodexWithAsyncHooks) >= 0;
}

// Major, minor, patch, then 0 for a prerelease (such as 0.148.0-alpha.6) or 1 for a release, then
// the prerelease number.
function versionParts(version: string | undefined): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-]*(?:\.(\d+))?)?/.exec(version ?? '');
  return match ? [...match.slice(1, 4).map(Number), match[4] ? 0 : 1, Number(match[5] ?? 0)] : undefined;
}

function compareVersions(first: number[], second: number[]): number {
  for (let index = 0; index < first.length; index++) {
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

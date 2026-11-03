import {execFile} from 'node:child_process';
import {existsSync, readdirSync, statSync, type Dirent} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {claudeAdapter} from './claude.js';
import {codexAdapter} from './codex.js';
import {commandInvocation, findExecutable} from './commands.js';
import {copilotAdapter} from './copilot.js';
import {isHookCurrent} from './hook-config.js';
import {grokAdapter, grokHookPath} from './grok.js';
import {hermesAdapter} from './hermes.js';
import {openclawAdapter} from './openclaw.js';
import {configuredAgentEnabled, isAgentEnabledSync, loadAgentsConfigSync, updateAgentsConfig} from './config.js';
import {namespacePayload} from './normalize.js';
import {codexApproval, codexRunStep, codexUpdateSteps, untrustedCodexHooks} from './codex.js';
import {claudeHome, codexHome, copilotHome, grokHome, hermesHome} from './homes.js';
import {runWsl, wslExecutable, WslLocations} from './wsl.js';
import {defaultDataDirectory, socketPath} from '../paths.js';
import type {HookPayload} from '../protocol.js';
import type {
  AgentAction, AgentAdapter, AgentContext, AgentId, AgentLocation, AgentLocations, AgentLocationStatus, AgentStatus,
  HookStatus, NormalizedHook,
} from './types.js';

const execFileAsync = promisify(execFile);

export const adapters: readonly AgentAdapter[] = [
  copilotAdapter,
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  hermesAdapter,
  openclawAdapter,
];

export const adapterById = new Map<AgentId, AgentAdapter>(adapters.map(adapter => [adapter.id, adapter]));

export function defaultAgentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const cli = overrides.cli ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  return {
    home: overrides.home ?? homedir(),
    node: overrides.node ?? process.execPath,
    cli,
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    dataDir: overrides.dataDir ?? defaultDataDirectory(overrides.platform ?? process.platform, overrides.home ?? homedir(),
                                                       overrides.env ?? process.env),
    socketPath: overrides.socketPath ?? socketPath(),
    runCommand: overrides.runCommand ?? (async (command, args, options) => {
      const env = overrides.env ?? process.env;
      const platform = overrides.platform ?? process.platform;
      const run = commandInvocation(findExecutable(command, env, platform) ?? command, args, env, platform);
      const {stdout} = await execFileAsync(run.file, run.args, {
        timeout: options?.timeoutMs ?? 5000,
        env,
        windowsHide: true,
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      });
      return {stdout: String(stdout), status: 0};
    }),
    ...(overrides.appFolders ? {appFolders: overrides.appFolders} : {}),
  };
}

export function normalizeAgentHook(
    agent: AgentId, nativeEvent: string | undefined, payload: HookPayload, receiptTime = Date.now()): NormalizedHook[] {
  return adapterById.get(agent)?.normalize(nativeEvent, payload, receiptTime) ?? [];
}

export function namespaceAgentPayload(agent: AgentId, payload: HookPayload): HookPayload {
  return namespacePayload(agent, payload);
}

function agentAction(adapter: AgentAdapter, contexts: AgentContext[], locations: AgentLocation[], hookStatus: string,
                     enabled: boolean, seen: boolean): AgentAction | undefined {
  if (!enabled || (hookStatus !== 'installed' && hookStatus !== 'needs-approval')) return undefined;
  if (hookStatus === 'needs-approval' && adapter.id === 'codex') {
    // Each place approves only its own hooks: this computer with a Codex CLI that runs here, and
    // a WSL distribution with codex in that distribution. A codex there that can't run the hooks
    // doesn't list them in /hooks, so its update step comes first.
    const host = contexts[0]!;
    const hostWaiting = untrustedCodexHooks(host).length;
    const distributions = locations.flatMap(location => {
      const count = location.running && location.ctx ? untrustedCodexHooks(location.ctx).length : 0;
      return count ? [{location, count}] : [];
    });
    const waiting = distributions.reduce((count, distribution) => count + distribution.count, hostWaiting);
    const hostSteps = hostWaiting > 0 || !distributions.length;
    const approval = hostSteps ? codexApproval(host) : undefined;
    return {kind: 'approve', title: 'Approve the hooks in the Codex CLI', steps: [
      ...(hostSteps ? [codexRunStep(approval, host.platform)] : []),
      ...distributions.flatMap(({location}) => [...codexUpdateSteps(location.ctx!, undefined, location.name),
                                                `In ${location.name}, open a terminal and run codex.`]),
      `Type /hooks and approve the Agent Buddy hooks${waiting ? ` (${waiting} waiting)` : ''}. Codex skips hooks `
        + 'until you do. The ChatGPT app and the Codex app can’t approve hooks.',
      ...codexClientSteps(host, locations.filter(location => !distributions.some(distribution => distribution.location === location))),
    ], ...(approval?.app ? {command: approval.command} : {})};
  }
  if (hookStatus === 'needs-approval' && adapter.id === 'hermes') {
    return {kind: 'approve', title: 'Approve the hooks in Hermes', steps: [
      'Run hermes in a terminal and send it a prompt.',
      'When Hermes asks whether to allow each Agent Buddy hook, approve it. Hermes asks once per event.',
      'Until you do, gateway and cron runs skip the hooks.',
    ]};
  }
  if (seen) return undefined;
  const steps = [`Restart any ${adapter.name} sessions that were already open so they load the hooks.`];
  if (adapter.id === 'claude') {
    steps.push('If Claude asks whether you trust the folder, choose Yes. Its hooks wait until you do.',
               'If you use the Claude app, quit and reopen it, then start a new session in the Code tab. '
                 + 'Cowork and cloud sessions don’t run the hooks.');
  }
  if (adapter.id === 'codex') steps.push(...codexClientSteps(contexts[0]!, locations));
  if (adapter.id === 'openclaw') steps.push('Restart the OpenClaw Gateway so it loads the plugin.');
  return {kind: 'restart', title: `Waiting for ${adapter.name}`, steps};
}

// A Codex desktop app or the VS Code extension reads hooks and their approvals only when it starts.
// A Codex that can't run the hooks needs an update first, on this computer or in a WSL distribution.
function codexClientSteps(host: AgentContext, locations: AgentLocation[]): string[] {
  return [
    'If you use Codex in the ChatGPT app, the Codex app, or VS Code, quit and reopen it so it loads the hooks.',
    ...codexUpdateSteps(host),
    ...locations.flatMap(location => location.running && location.ctx
      ? codexUpdateSteps(location.ctx, undefined, location.name) : []),
  ];
}

export function agentStatuses(
    ctx: AgentContext,
    activity: Map<AgentId, {activeSessions: number; driving: boolean}>,
    lastEvents: Map<AgentId, number>): AgentStatus[] {
  const config = loadAgentsConfigSync(hookConsentPath(ctx));
  const locations = ctx.locations?.list() ?? [];
  return adapters.map(adapter => {
    const detection = adapter.detect(ctx);
    const hostStatus = adapter.hookStatus(ctx);
    const others = locations.flatMap(location => locationStatus(adapter, location) ?? []);
    const running = others.filter(other => other.running);
    // Hooks in a place without the agent never run, so they don't change the status or the setup
    // steps, but they still count as installed, so that Remove deletes them.
    const counted = running.filter(other => other.detected);
    // The places that count: this computer when the agent or its hooks are here, and each running
    // location with the agent. A stopped WSL distribution keeps the status it had when it last ran.
    const hostCounts = !counted.length || detection.installed || hasHooks(hostStatus);
    const statuses = [...(hostCounts ? [hostStatus] : []), ...counted.map(other => other.hookStatus)];
    const hookStatus = others.length ? combinedStatus(statuses) : hostStatus;
    const detected = detection.installed || others.some(other => other.detected);
    const active = activity.get(adapter.id);
    const enabled = configuredAgentEnabled(config, adapter.id, detected);
    const seen = Boolean(config.seen?.[adapter.id]) || lastEvents.has(adapter.id);
    const contexts = [ctx, ...locations.filter(location => location.running && location.ctx).map(location => location.ctx!)];
    return {
      id: adapter.id,
      name: adapter.name,
      ...(adapter.clients ? {clients: adapter.clients} : {}),
      detected,
      // 'outdated' hooks are still in the agent's config, so the user can remove them.
      installed: [hostStatus, ...running.map(other => other.hookStatus)].some(hasHooks),
      version: detection.version,
      configPath: detection.configPath,
      hookStatus,
      enabled,
      lastEventAt: lastEvents.get(adapter.id),
      activeSessions: active?.activeSessions ?? 0,
      driving: active?.driving ?? false,
      hint: hookStatus === 'outdated'
        ? `${others.length ? 'Some places are missing hooks, or their hooks' : 'Some hooks are missing or'} run another `
          + 'copy of Agent Buddy or Node.js. Choose Reinstall to fix them.'
        : adapter.hint(hookStatus) ?? adapter.note?.(ctx),
      action: agentAction(adapter, contexts, locations.filter(location => counted.some(other => other.id === location.id)),
                          hookStatus, enabled, seen),
      ...(config.problem ? {warning: config.problem} : {}),
      ...(others.length ? {locations: [{
        id: 'host', name: hostName(ctx.platform), running: true, detected: detection.installed, hookStatus: hostStatus,
        configPath: detection.configPath,
      }, ...others]} : {}),
    };
  });
}

function hasHooks(status: HookStatus): boolean {
  return status !== 'missing' && status !== 'unsupported';
}

// One status for the agent in all the places it runs.
export function combinedStatus(statuses: HookStatus[]): HookStatus {
  const known = statuses.filter(status => status !== 'unsupported');
  if (!known.length) return statuses[0] ?? 'missing';
  if (known.every(status => status === 'installed')) return 'installed';
  if (known.every(status => status === 'missing')) return 'missing';
  if (known.every(status => status === 'installed' || status === 'needs-approval')) return 'needs-approval';
  return 'outdated';
}

function hostName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
}

// Where each agent keeps its settings, so an agent that is not on the login shell's PATH (for
// example, one that nvm loads in .bashrc) is found too.
const agentHomes: Partial<Record<AgentId, (home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string>> = {
  copilot: copilotHome, claude: claudeHome, codex: codexHome, grok: grokHome, hermes: hermesHome,
};

const lastLocationStatus = new Map<string, AgentLocationStatus>();

// The agent's status in another location, or undefined when it has neither the agent nor hooks.
export function locationStatus(adapter: AgentAdapter, location: AgentLocation): AgentLocationStatus | undefined {
  const key = `${location.id}:${adapter.id}`;
  const ctx = location.ctx;
  if (!location.running || !ctx) {
    const last = lastLocationStatus.get(key);
    return last && {...last, running: location.running};
  }
  const home = agentHomes[adapter.id];
  const configPath = adapter.id === 'openclaw' ? undefined : adapter.detect(ctx).configPath;
  const detected = location.commands.includes(adapter.id)
    || Boolean(home && agentFolderInUse(home(ctx.home, ctx.env, ctx.platform), configPath));
  let status: AgentLocationStatus | undefined;
  if (adapter.id === 'openclaw') {
    status = detected ? {id: location.id, name: location.name, running: true, detected, hookStatus: 'unsupported',
                         hint: 'The OpenClaw plugin can’t reach the companion service from WSL yet.'} : undefined;
  } else {
    const found = adapter.hookStatus(ctx);
    const hookStatus = location.problem && !hasHooks(found) ? 'unsupported' : found;
    status = detected || hasHooks(hookStatus) ? {
      id: location.id, name: location.name, running: true, detected, hookStatus,
      configPath: configPath && (ctx.agentPath?.(configPath) ?? configPath),
      hint: location.problem ?? (!detected && hasHooks(hookStatus)
        ? `${adapter.name} isn’t installed in this distribution, so these hooks never run there.`
        // A Codex here that can't run the hooks must be updated before it can approve them.
        : [adapter.id === 'codex' ? codexUpdateSteps(ctx).join(' ') : '',
           hookStatus === 'needs-approval' ? adapter.hint(hookStatus) : undefined].filter(Boolean).join(' ') || undefined),
    } : undefined;
  }
  if (status) lastLocationStatus.set(key, status);
  else lastLocationStatus.delete(key);
  return status;
}

// An agent's settings folder shows that the agent is in a place, unless all that it holds is the hook
// file that Agent Buddy wrote, with its backups. An older probe counted a Windows program that WSL
// finds through the Windows PATH as the agent, so setup could leave such a folder in a distribution.
// Status requests arrive every second, so the folders are read again only when one of them changes.
// A folder's mtime changes in steps (on Windows, about 16 ms), so a change in the same step as a read
// keeps the mtime. An answer is kept only when it was read 2 seconds or more after the folders first
// had these mtimes. Both times come from this computer's clock: a WSL distribution's clock can differ.
const foldersInUse = new Map<string, {key: string; inUse: boolean; since: number; readAt: number}>();
const mtimeStepMarginMs = 2000;

function agentFolderInUse(folder: string, configPath: string | undefined): boolean {
  const path = configPath ? relative(folder, configPath) : '';
  const parts = path && !path.startsWith('..') && !isAbsolute(path) ? path.split(/[\\/]/) : [];
  // The folders from the agent's folder down to the hook file. A file that is added or deleted in
  // one of them changes the mtime of that folder.
  const folders = [folder, ...parts.slice(0, -1).map((_, index) => join(folder, ...parts.slice(0, index + 1)))];
  const times: number[] = [];
  for (const [index, each] of folders.entries()) {
    try {
      times.push(statSync(each).mtimeMs);
    } catch {
      if (index === 0) {
        foldersInUse.delete(folder);
        return false;
      }
      times.push(-1);
    }
  }
  const key = `${configPath ?? ''}:${times.join(':')}`;
  const known = foldersInUse.get(folder);
  if (known?.key === key && known.readAt - known.since >= mtimeStepMarginMs) return known.inUse;
  const now = Date.now();
  const inUse = !parts.length || !onlyHookFiles(folder, parts);
  foldersInUse.set(folder, {key, inUse, since: known?.key === key ? known.since : now, readAt: now});
  return inUse;
}

// Whether all that the folder holds is the file at `parts` below it, with its backups. The agent's
// own folder must hold something. A folder on the way to the file can be empty: Copilot and Grok
// keep the hook file in a hooks folder, which stays when Remove deletes the file.
function onlyHookFiles(folder: string, parts: string[], top = true): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, {withFileTypes: true});
  } catch {
    return false;
  }
  const [name, ...rest] = parts as [string, ...string[]];
  return (!top || entries.length > 0) && entries.every(entry => rest.length
    ? entry.isDirectory() && entry.name === name && onlyHookFiles(join(folder, name), rest, false)
    : entry.isFile() && (entry.name === name || entry.name === `${name}.bak`
      || (entry.name.startsWith(`${name}.agent-companion-`) && entry.name.endsWith('.bak'))));
}

// The other places where agents run: WSL distributions on Windows.
export function otherAgentLocations(ctx: AgentContext): AgentLocations | undefined {
  if (ctx.platform !== 'win32') return undefined;
  const wsl = wslExecutable(ctx.env);
  return wsl ? new WslLocations(ctx, runWsl(wsl)) : undefined;
}

interface LocationTarget {
  location: AgentLocation;
  ctx: AgentContext;
}

// The running locations where the agent is, or, for a removal, where its hooks are.
async function locationTargets(adapter: AgentAdapter, ctx: AgentContext, hooksOnly: boolean,
): Promise<LocationTarget[]> {
  if (!ctx.locations || adapter.id === 'openclaw') return [];
  await ctx.locations.refresh();
  return targetsIn(adapter, ctx.locations.list(), hooksOnly);
}

function targetsIn(adapter: AgentAdapter, locations: AgentLocation[], hooksOnly: boolean): LocationTarget[] {
  if (adapter.id === 'openclaw') return [];
  return locations.flatMap(location => {
    const status = location.running && location.ctx ? locationStatus(adapter, location) : undefined;
    if (!status || !(hooksOnly ? hasHooks(status.hookStatus) : status.detected)) return [];
    return [{location, ctx: location.ctx!}];
  });
}

// Runs `change` in each location and returns its warnings, with the location's name. A failure in one
// location is a warning too, so the other locations still change.
async function changeEachLocation(targets: LocationTarget[], change: (ctx: AgentContext) => Promise<string[] | void>,
                                  failure: (location: AgentLocation, error: string) => string): Promise<string[]> {
  const warnings: string[] = [];
  for (const {location, ctx} of targets) {
    try {
      warnings.push(...((await change(ctx)) ?? []).map(warning => `${location.name}: ${warning}`));
    } catch (error) {
      warnings.push(failure(location, errorText(error)));
    }
  }
  return warnings;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function markAgentSeen(id: AgentId, at = Date.now()): Promise<void> {
  await updateAgentsConfig(config => {
    if (config.seen?.[id]) return false;
    config.seen = {...config.seen, [id]: at};
  });
}

export async function setAgentEnabled(id: AgentId, enabled: boolean): Promise<void> {
  await updateAgentsConfig(config => {
    config.enabled[id] = enabled;
  });
}

export async function setAgentHookRemoved(id: AgentId, removed: boolean): Promise<void> {
  await updateAgentsConfig(config => {
    if (Boolean(config.removed?.[id]) === removed) return false;
    const next = {...config.removed};
    if (removed) next[id] = true;
    else delete next[id];
    config.removed = next;
  });
}

export function isAgentEnabled(id: AgentId, detected = true): boolean {
  return isAgentEnabledSync(id, detected);
}

// Both return warnings for the user, if any.
// In WSL distributions too, where the agent is. A failure there is a warning, so the other
// places still get their hooks.
export async function installAgent(id: AgentId, ctx: AgentContext, onlyNeeded = false): Promise<string[]> {
  const adapter = adapterById.get(id);
  if (!adapter) throw new Error(`Unknown agent: ${id}`);
  const targets = await locationTargets(adapter, ctx, false);
  const here = adapter.id === 'copilot' || adapter.detect(ctx).installed || hasHooks(adapter.hookStatus(ctx));
  if (!here && !targets.length) {
    const stopped = (ctx.locations?.list() ?? [])
      .filter(location => !location.running && locationStatus(adapter, location)?.detected);
    if (stopped.length)
      throw new Error(`Open ${stopped.map(location => location.name).join(' or ')} so the service can reach it, then try again.`);
  }
  const warnings = (here || !targets.length) && (!onlyNeeded || !isHookCurrent(adapter.hookStatus(ctx)))
    ? [...(await adapter.install(ctx)) ?? []] : [];
  warnings.push(...targets.flatMap(({location}) => location.problem ? [`${location.name}: ${location.problem}`] : []));
  const changes = targets.filter(({location, ctx: there}) =>
    !location.problem && (!onlyNeeded || !isHookCurrent(adapter.hookStatus(there))));
  warnings.push(...await changeEachLocation(changes, there => adapter.install(there),
                                            (location, error) => `${location.name}: ${adapter.name} hooks not installed (${error})`));
  await rememberHookApproval(ctx, [id]);
  return warnings;
}

export async function initializeHookConsent(ctx: AgentContext, fresh: boolean): Promise<void> {
  await updateAgentsConfig(config => {
    if (config.approved !== undefined) return false;
    config.approved = fresh ? {} : existingHookApprovals(ctx);
  }, hookConsentPath(ctx));
}

function existingHookApprovals(ctx: AgentContext): Partial<Record<AgentId, boolean>> {
  return Object.fromEntries(adapters.filter(adapter =>
    hasHooks(adapter.hookStatus(ctx))
      || (ctx.locations?.list() ?? []).some(location =>
        hasHooks(locationStatus(adapter, location)?.hookStatus ?? 'missing')))
    .map(adapter => [adapter.id, true]));
}

export async function rememberHookApproval(ctx: AgentContext, ids: AgentId[]): Promise<void> {
  await updateAgentsConfig(config => {
    config.approved ??= existingHookApprovals(ctx);
    for (const id of ids) config.approved[id] = true;
  }, hookConsentPath(ctx));
}

function hookConsentPath(ctx: AgentContext): string {
  return ctx.env.AGENT_COMPANION_AGENTS_CONFIG ?? process.env.AGENT_COMPANION_AGENTS_CONFIG
    ?? join(ctx.dataDir, 'agents.json');
}

export async function uninstallAgent(id: AgentId, ctx: AgentContext, allLocations = false): Promise<string[]> {
  const adapter = adapterById.get(id);
  if (!adapter) throw new Error(`Unknown agent: ${id}`);
  let targets: LocationTarget[];
  if (allLocations) {
    await ctx.locations?.refresh({all: true, force: true});
    targets = targetsIn(adapter, ctx.locations?.list() ?? [], true);
  } else targets = await locationTargets(adapter, ctx, true);
  const warnings = [...(await adapter.uninstall(ctx)) ?? []];
  warnings.push(...await changeEachLocation(targets, there => adapter.uninstall(there),
                                            (location, error) => `${location.name}: remove the ${adapter.name} hooks yourself (${error})`));
  return warnings;
}

// For an uninstall: every place's hooks, in stopped WSL distributions too. Returns what the
// user must do by hand.
export async function removeAllAgentHooks(ctx: AgentContext): Promise<string[]> {
  await ctx.locations?.refresh({all: true});
  // One list for all agents: WSL stops an idle distribution soon, and a new list would skip it.
  const locations = ctx.locations?.list() ?? [];
  const manual: string[] = [];
  for (const adapter of adapters) {
    try {
      // Only hooks that are there, so an agent without hooks does not get new, empty config files.
      if (hasHooks(adapter.hookStatus(ctx))) manual.push(...(await adapter.uninstall(ctx)) ?? []);
    } catch (error) {
      manual.push(`Remove the ${adapter.name} hook yourself: ${errorText(error)}`);
    }
    manual.push(...await changeEachLocation(targetsIn(adapter, locations, true), there => adapter.uninstall(there),
                                            (location, error) => `Remove the ${adapter.name} hook in ${location.name} yourself: ${error}`));
  }
  return manual;
}

// Skips the agents whose hooks the user removed, so setup and app updates don't add them back.
export async function installDetectedAgents(
    ctx: AgentContext, removed: Partial<Record<AgentId, boolean>> = loadAgentsConfigSync().removed ?? {},
    respectConsent = true,
): Promise<Array<{id: AgentId; installed: boolean; message: string}>> {
  const results: Array<{id: AgentId; installed: boolean; message: string}> = [];
  const config = loadAgentsConfigSync(hookConsentPath(ctx));
  const permitted = (id: AgentId) => !respectConsent || config.approved === undefined
    || (config.approved[id] === true && config.enabled[id] !== false);
  for (const adapter of adapters) {
    if (removed[adapter.id]) {
      results.push({id: adapter.id, installed: false, message:
        `${adapter.name}: hooks not installed because you removed them (to add them back, choose Install hook in Settings or run agents install ${adapter.id})`});
      continue;
    }
    if (!permitted(adapter.id)) {
      results.push({id: adapter.id, installed: false, message: `${adapter.name}: hooks not selected in setup`});
      continue;
    }
    const detected = adapter.id === 'copilot' || adapter.detect(ctx).installed;
    if (!detected) {
      results.push({id: adapter.id, installed: false, message: `${adapter.name}: not detected`});
      continue;
    }
    try {
      const warnings = (await adapter.install(ctx)) ?? [];
      results.push({id: adapter.id, installed: true,
                    message: [`${adapter.name}: hooks installed`, ...warnings].join('\n  ')});
    } catch (error) {
      results.push({id: adapter.id, installed: false,
                    message: `${adapter.name}: hook install skipped (${errorText(error)})`});
    }
  }
  if (ctx.locations) await ctx.locations.refresh();
  for (const location of ctx.locations?.list() ?? []) {
    if (!location.running || !location.ctx) continue;
    for (const adapter of adapters) {
      const status = locationStatus(adapter, location);
      if (removed[adapter.id] || !permitted(adapter.id) || adapter.id === 'openclaw' || !status?.detected) continue;
      const name = `${adapter.name} (${location.name})`;
      if (location.problem) {
        results.push({id: adapter.id, installed: false, message: `${name}: hooks not installed. ${location.problem}`});
        continue;
      }
      try {
        const warnings = (await adapter.install(location.ctx)) ?? [];
        results.push({id: adapter.id, installed: true, message: [`${name}: hooks installed`, ...warnings].join('\n  ')});
      } catch (error) {
        results.push({id: adapter.id, installed: false, message: `${name}: hook install skipped (${errorText(error)})`});
      }
    }
  }
  if (!respectConsent)
    await rememberHookApproval(ctx, [...new Set(results.filter(result => result.installed).map(result => result.id))]);
  return results;
}

export function shouldIgnoreGrokClaudeHook(env: NodeJS.ProcessEnv, payload: HookPayload, home: string): boolean {
  const grokSignal = Boolean(env.GROK_HOOK_EVENT || env.GROK_SESSION_ID || payload.hookEventName);
  return grokSignal && isAgentEnabledSync('grok', true) && existsSync(grokHookPath(home, env));
}

export type {AgentAction, AgentContext, AgentId, AgentStatus};

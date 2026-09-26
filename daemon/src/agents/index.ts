import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {claudeAdapter} from './claude.js';
import {codexAdapter} from './codex.js';
import {copilotAdapter} from './copilot.js';
import {grokAdapter, grokHookPath} from './grok.js';
import {hermesAdapter} from './hermes.js';
import {openclawAdapter} from './openclaw.js';
import {isAgentEnabledSync, loadAgentsConfigSync, updateAgentsConfig} from './config.js';
import {namespacePayload} from './normalize.js';
import {untrustedCodexHooks} from './codex.js';
import {defaultDataDirectory, socketPath} from '../paths.js';
import type {HookPayload} from '../protocol.js';
import type {AgentAction, AgentAdapter, AgentContext, AgentId, AgentStatus, NormalizedHook} from './types.js';

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
      const {stdout} = await execFileAsync(command, args, {
        timeout: options?.timeoutMs ?? 5000,
        env: overrides.env ?? process.env,
      });
      return {stdout: String(stdout), status: 0};
    }),
  };
}

export function normalizeAgentHook(
    agent: AgentId, nativeEvent: string | undefined, payload: HookPayload, receiptTime = Date.now()): NormalizedHook[] {
  return adapterById.get(agent)?.normalize(nativeEvent, payload, receiptTime) ?? [];
}

export function namespaceAgentPayload(agent: AgentId, payload: HookPayload): HookPayload {
  return namespacePayload(agent, payload);
}

function agentAction(adapter: AgentAdapter, ctx: AgentContext, hookStatus: string,
                     enabled: boolean, seen: boolean): AgentAction | undefined {
  if (!enabled || (hookStatus !== 'installed' && hookStatus !== 'needs-approval')) return undefined;
  if (hookStatus === 'needs-approval' && adapter.id === 'codex') {
    const waiting = untrustedCodexHooks(ctx).length;
    return {kind: 'approve', title: 'Approve the hooks in Codex', steps: [
      'Open Codex in any folder and type /hooks.',
      `Approve the Agent Companion hooks${waiting ? ` (${waiting} waiting)` : ''}. Codex skips hooks until you do.`,
    ]};
  }
  if (hookStatus === 'needs-approval' && adapter.id === 'hermes') {
    return {kind: 'approve', title: 'Approve the hooks in Hermes', steps: [
      'Run hermes in a terminal and send it a prompt.',
      'When Hermes asks whether to allow each Agent Companion hook, approve it. Hermes asks once per event.',
      'Until you do, gateway and cron runs skip the hooks.',
    ]};
  }
  if (seen) return undefined;
  const steps = [`Restart any ${adapter.name} sessions that were already open so they load the hooks.`];
  if (adapter.id === 'claude')
    steps.push('If Claude asks whether you trust the folder, choose Yes. Its hooks wait until you do.');
  if (adapter.id === 'openclaw') steps.push('Restart the OpenClaw Gateway so it loads the plugin.');
  return {kind: 'restart', title: `Waiting for ${adapter.name}`, steps};
}

export function agentStatuses(
    ctx: AgentContext,
    activity: Map<AgentId, {activeSessions: number; driving: boolean}>,
    lastEvents: Map<AgentId, number>): AgentStatus[] {
  const config = loadAgentsConfigSync();
  return adapters.map(adapter => {
    const detection = adapter.detect(ctx);
    const hookStatus = adapter.hookStatus(ctx);
    const active = activity.get(adapter.id);
    const enabled = config.enabled[adapter.id] ?? detection.installed;
    const seen = Boolean(config.seen?.[adapter.id]) || lastEvents.has(adapter.id);
    return {
      id: adapter.id,
      name: adapter.name,
      detected: detection.installed,
      installed: hookStatus === 'installed' || hookStatus === 'needs-approval',
      version: detection.version,
      configPath: detection.configPath,
      hookStatus,
      enabled,
      lastEventAt: lastEvents.get(adapter.id),
      activeSessions: active?.activeSessions ?? 0,
      driving: active?.driving ?? false,
      hint: adapter.hint(hookStatus),
      action: agentAction(adapter, ctx, hookStatus, enabled, seen),
    };
  });
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

export function isAgentEnabled(id: AgentId, detected = true): boolean {
  return isAgentEnabledSync(id, detected);
}

export async function installAgent(id: AgentId, ctx: AgentContext): Promise<void> {
  const adapter = adapterById.get(id);
  if (!adapter) throw new Error(`Unknown agent: ${id}`);
  await adapter.install(ctx);
}

export async function uninstallAgent(id: AgentId, ctx: AgentContext): Promise<void> {
  const adapter = adapterById.get(id);
  if (!adapter) throw new Error(`Unknown agent: ${id}`);
  await adapter.uninstall(ctx);
}

export async function installDetectedAgents(ctx: AgentContext): Promise<Array<{id: AgentId; installed: boolean; message: string}>> {
  const results: Array<{id: AgentId; installed: boolean; message: string}> = [];
  for (const adapter of adapters) {
    const detected = adapter.id === 'copilot' || adapter.detect(ctx).installed;
    if (!detected) {
      results.push({id: adapter.id, installed: false, message: `${adapter.name}: not detected`});
      continue;
    }
    try {
      await adapter.install(ctx);
      results.push({id: adapter.id, installed: true, message: `${adapter.name}: hooks installed`});
    } catch (error) {
      results.push({id: adapter.id, installed: false,
                    message: `${adapter.name}: hook install skipped (${error instanceof Error ? error.message : String(error)})`});
    }
  }
  return results;
}

export function shouldIgnoreGrokClaudeHook(env: NodeJS.ProcessEnv, payload: HookPayload, home: string): boolean {
  const grokSignal = Boolean(env.GROK_HOOK_EVENT || env.GROK_SESSION_ID || payload.hookEventName);
  return grokSignal && isAgentEnabledSync('grok', true) && fileExists(grokHookPath(home));
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

export type {AgentAction, AgentContext, AgentId, AgentStatus};

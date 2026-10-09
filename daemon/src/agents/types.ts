import type {HookEvent, HookPayload} from '../protocol.js';

export const agentIds = ['copilot', 'claude', 'codex', 'cursor', 'grok', 'hermes', 'openclaw'] as const;
export type AgentId = typeof agentIds[number];

export type HookStatus = 'installed' | 'missing' | 'outdated' | 'needs-approval' | 'unsupported';

export interface AgentDetection {
  installed: boolean;
  version?: string;
  configPath?: string;
}

export interface NormalizedHook {
  event: HookEvent;
  payload: HookPayload;
}

export interface CommandResult {
  stdout: string;
  status: number;
}

export interface AgentContext {
  home: string;
  node: string;
  cli: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  socketPath: string;
  runCommand?: (command: string, args: string[], options?: {timeoutMs?: number}) => Promise<CommandResult>;
  // For an agent in a WSL distribution: a path as the agent sees it, as a path that this service
  // can open, and the reverse. Without them, both are the same.
  hostPath?: (agentPath: string) => string;
  agentPath?: (hostPath: string) => string;
  // The other places where agents run, such as WSL distributions on Windows.
  locations?: AgentLocations;
}

export interface AgentLocation {
  id: string;
  name: string;
  running: boolean;
  // The agent commands found on the location's PATH.
  commands: readonly string[];
  // Missing until the service has looked into the location.
  ctx?: AgentContext;
  // Why no agent there can reach this service.
  problem?: string;
}

export interface AgentLocations {
  list(): AgentLocation[];
  refresh(options?: {all?: boolean}): Promise<void>;
}

export interface AgentLocationStatus {
  id: string;
  name: string;
  running: boolean;
  detected: boolean;
  hookStatus: HookStatus;
  configPath?: string;
  hint?: string;
}

export interface AgentStatus {
  id: AgentId;
  name: string;
  detected: boolean;
  installed: boolean;
  version?: string;
  configPath?: string;
  hookStatus: HookStatus;
  enabled: boolean;
  lastEventAt?: number;
  activeSessions: number;
  driving: boolean;
  hint?: string;
  // What the last hook install or removal changed that the user must fix, such as Codex approvals.
  warning?: string;
  // Something the user still has to do before this agent can drive the display.
  action?: AgentAction;
  // Each place the agent runs, when it runs in more than this computer's own system.
  locations?: AgentLocationStatus[];
}

export interface AgentAction {
  kind: 'approve' | 'restart';
  title: string;
  steps: string[];
}

export interface AgentAdapter {
  id: AgentId;
  name: string;
  hint(status: HookStatus): string | undefined;
  // Advice that depends on the user's other settings, shown when no other hint applies.
  note?(ctx: AgentContext): string | undefined;
  detect(ctx: AgentContext): AgentDetection;
  hookStatus(ctx: AgentContext): HookStatus;
  // Both return warnings for the user, if any.
  install(ctx: AgentContext): Promise<string[] | void>;
  uninstall(ctx: AgentContext): Promise<string[] | void>;
  normalize(nativeEvent: string | undefined, payload: HookPayload, receiptTime: number): NormalizedHook[];
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (agentIds as readonly string[]).includes(value);
}

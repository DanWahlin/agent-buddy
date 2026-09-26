import type {HookEvent, HookPayload} from '../protocol.js';

export const agentIds = ['copilot', 'claude', 'codex', 'grok', 'hermes', 'openclaw'] as const;
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
  // Something the user still has to do before this agent can drive the display.
  action?: AgentAction;
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
  detect(ctx: AgentContext): AgentDetection;
  hookStatus(ctx: AgentContext): HookStatus;
  install(ctx: AgentContext): Promise<void>;
  uninstall(ctx: AgentContext): Promise<void>;
  normalize(nativeEvent: string | undefined, payload: HookPayload, receiptTime: number): NormalizedHook[];
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (agentIds as readonly string[]).includes(value);
}

import type {ConnectionMode} from './connection-mode.js';
import type {AgentId, AgentStatus} from './agents/types.js';

export const characterStates = ['idle', 'surprise', 'working', 'complete', 'attention'] as const;
export type CharacterState = typeof characterStates[number];

export const hookEvents = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'agentStop',
  'notification',
  'errorOccurred',
  'sessionEnd',
] as const;
export type HookEvent = typeof hookEvents[number];

export interface HookPayload {
  sessionId?: string;
  session_id?: string;
  parentSessionId?: string;
  parent_session_id?: string;
  subagentId?: string;
  subagent_id?: string;
  agentId?: string;
  agent_id?: string;
  agentName?: string;
  agent_name?: string;
  toolName?: string;
  tool_name?: string;
  toolCallId?: string;
  tool_call_id?: string;
  timestamp?: number | string;
  notification_type?: string;
  [key: string]: unknown;
}

export type DaemonRequest =
  | {type: 'hook'; agent?: AgentId; event?: HookEvent | string; nativeEvent?: string; payload: HookPayload}
  | {type: 'send'; state: CharacterState}
  | {type: 'status'}
  | {type: 'agents'}
  | {type: 'agentEnable'; agent: AgentId; enabled: boolean}
  | {type: 'agentInstall'; agent: AgentId}
  | {type: 'agentUninstall'; agent: AgentId}
  | {type: 'reloadWifi'}
  | {type: 'configureWifi'; ssid: string; password: string}
  | {type: 'installCharacter'; character: string}
  | {type: 'setConnection'; mode: ConnectionMode}
  | {type: 'badges'; enabled: boolean}
  | {type: 'listCharacters'}
  | {type: 'settings'};

export interface DaemonStatus {
  state: CharacterState;
  transport: string | null;
  connected: boolean;
  port: string | null;
  character: string | null;
  mode: ConnectionMode;
  sessions: number;
  agents?: AgentStatus[];
  drivingAgents?: AgentId[];
  // The Wi-Fi network the device is set up for, as the device reports it. Never stored.
  network?: DeviceNetwork | null;
}

export interface DeviceNetwork {
  ssid: string;
  connected: boolean;
}

// Firmware reports the network name as base64 because names may hold spaces, quotes, or any byte.
export function deviceNetwork(ssidBase64: string | undefined, connected: boolean): DeviceNetwork | null {
  if (!ssidBase64) return null;
  const ssid = Buffer.from(ssidBase64, 'base64').toString('utf8');
  return ssid ? {ssid, connected} : null;
}

export type InstallProgress = (sent: number, total: number) => void;

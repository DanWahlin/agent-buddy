import type {ConnectionMode} from './connection-mode.js';
import type {AgentId, AgentStatus} from './agents/types.js';
import type {DeviceOrientation} from './orientation-settings.js';

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
  // The desktop app names itself, so the service knows it runs and where to start it from.
  | {type: 'status'; client?: 'desktop'; executable?: string; environment?: Record<string, string>; flasher?: number}
  | {type: 'agents'}
  | {type: 'agentEnable'; agent: AgentId; enabled: boolean}
  | {type: 'agentInstall'; agent: AgentId}
  | {type: 'agentUninstall'; agent: AgentId}
  | {type: 'reloadWifi'}
  | {type: 'configureWifi'; ssid: string; password: string}
  | {type: 'installCharacter'; character: string}
  | {type: 'setConnection'; mode: ConnectionMode}
  | {type: 'badges'; enabled: boolean}
  | {type: 'desktop'; visible?: boolean; backdrop?: string; sounds?: boolean; volume?: number; character?: string}
  | {type: 'usage'; enabled?: boolean; window?: string}
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
  orientation?: DeviceOrientation | null;
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

// A network the device can see. The ESP32 radio is 2.4 GHz only, so 5 GHz networks never appear.
export interface WifiNetwork {
  ssid: string;
  rssi: number;
  secure: boolean;
}

export function parseWifiNetworkLine(line: string): WifiNetwork | null {
  const match = /^WIFI_NETWORK rssi=(-?\d+) secure=([01]) ssid_b64=([A-Za-z0-9+/=]+)$/.exec(line);
  if (!match) return null;
  const ssid = Buffer.from(match[3]!, 'base64').toString('utf8');
  return ssid ? {ssid, rssi: Number(match[1]), secure: match[2] === '1'} : null;
}

// Mesh systems and repeaters broadcast one name many times; keep the strongest signal for each.
export function uniqueWifiNetworks(networks: readonly WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const network of networks) {
    const previous = best.get(network.ssid);
    if (!previous || network.rssi > previous.rssi) best.set(network.ssid, network);
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid));
}

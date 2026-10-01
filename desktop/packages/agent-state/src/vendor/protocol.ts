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
  | {type: 'hook'; event: HookEvent; payload: HookPayload}
  | {type: 'send'; state: CharacterState}
  | {type: 'status'};

export interface DaemonStatus {
  state: CharacterState;
  transport: string | null;
  connected: boolean;
  port: string | null;
  sessions: number;
}

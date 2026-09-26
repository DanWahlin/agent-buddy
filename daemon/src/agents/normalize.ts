import type {HookEvent, HookPayload} from '../protocol.js';
import type {AgentId, NormalizedHook} from './types.js';

const eventAliases: Record<string, HookEvent> = {
  sessionstart: 'sessionStart',
  on_session_start: 'sessionStart',
  session_start: 'sessionStart',
  userpromptsubmit: 'userPromptSubmitted',
  userpromptsubmitted: 'userPromptSubmitted',
  user_prompt_submit: 'userPromptSubmitted',
  pre_llm_call: 'userPromptSubmitted',
  message_received: 'userPromptSubmitted',
  pretooluse: 'preToolUse',
  pre_tool_use: 'preToolUse',
  pre_tool_call: 'preToolUse',
  before_tool_call: 'preToolUse',
  posttooluse: 'postToolUse',
  post_tool_use: 'postToolUse',
  post_tool_call: 'postToolUse',
  after_tool_call: 'postToolUse',
  posttoolusefailure: 'postToolUseFailure',
  post_tool_use_failure: 'postToolUseFailure',
  subagentstart: 'subagentStart',
  subagent_start: 'subagentStart',
  subagent_spawned: 'subagentStart',
  subagentstop: 'subagentStop',
  subagent_stop: 'subagentStop',
  subagent_ended: 'subagentStop',
  stop: 'agentStop',
  agentstop: 'agentStop',
  agent_stop: 'agentStop',
  agent_end: 'agentStop',
  notification: 'notification',
  permissionrequest: 'notification',
  permission_request: 'notification',
  pre_approval_request: 'notification',
  elicitation: 'notification',
  erroroccurred: 'errorOccurred',
  error_occurred: 'errorOccurred',
  stopfailure: 'errorOccurred',
  stop_failure: 'errorOccurred',
  api_request_error: 'errorOccurred',
  sessionend: 'sessionEnd',
  session_end: 'sessionEnd',
  on_session_finalize: 'sessionEnd',
  on_session_reset: 'sessionEnd',
  gateway_stop: 'sessionEnd',
  interrupt: 'sessionEnd',
  stopcancelled: 'sessionEnd',
  stop_cancelled: 'sessionEnd',
};

export function nativeName(nativeEvent: string | undefined, payload: HookPayload): string {
  const fromPayload = payload.hook_event_name ?? payload.hookEventName ?? payload.event;
  return String(nativeEvent ?? (typeof fromPayload === 'string' ? fromPayload : '')).trim();
}

export function canonicalEvent(nativeEvent: string | undefined, payload: HookPayload): HookEvent | undefined {
  const name = nativeName(nativeEvent, payload);
  if (!name) return undefined;
  const compact = name.replaceAll('-', '_');
  return eventAliases[compact] ?? eventAliases[compact.toLowerCase()]
    ?? eventAliases[compact.replaceAll('_', '').toLowerCase()];
}

export function withTimestamp(payload: HookPayload, receiptTime: number): HookPayload {
  return payload.timestamp === undefined ? {...payload, timestamp: receiptTime} : payload;
}

export function namespacePayload(agent: AgentId, payload: HookPayload): HookPayload {
  const next: HookPayload = {...payload};
  namespaceKey(next, 'sessionId');
  namespaceKey(next, 'session_id');
  namespaceKey(next, 'parentSessionId');
  namespaceKey(next, 'parent_session_id');
  namespaceKey(next, 'subagentId');
  namespaceKey(next, 'subagent_id');
  namespaceKey(next, 'agentId');
  namespaceKey(next, 'agent_id');
  return next;

  function namespaceKey(target: HookPayload, key: keyof HookPayload): void {
    const value = target[key];
    if (typeof value !== 'string' || !value || value.startsWith(`${agent}:`)) return;
    target[key] = `${agent}:${value}`;
  }
}

export function normalized(
    agent: AgentId, event: HookEvent | undefined, payload: HookPayload, receiptTime: number): NormalizedHook[] {
  if (!event) return [];
  return [{event, payload: namespacePayload(agent, withTimestamp(normalizeFields(payload), receiptTime))}];
}

export function normalizeFields(payload: HookPayload): HookPayload {
  const next: HookPayload = {...payload};
  copy('session_id', 'sessionId');
  copy('parent_session_id', 'parentSessionId');
  copy('subagent_id', 'subagentId');
  copy('agent_id', 'agentId');
  copy('agent_type', 'agentName');
  copy('agent_name', 'agentName');
  copy('tool_name', 'toolName');
  copy('tool_use_id', 'toolCallId');
  copy('tool_call_id', 'toolCallId');
  copy('notificationType', 'notification_type');
  return next;

  function copy(from: string, to: keyof HookPayload): void {
    if (next[to] !== undefined) return;
    const value = next[from];
    if (typeof value === 'string' || typeof value === 'number') next[to] = value;
  }
}

export function attentionPayload(payload: HookPayload, receiptTime: number, type = 'permission_prompt'): HookPayload {
  return withTimestamp({...normalizeFields(payload), notification_type: payload.notification_type ?? type}, receiptTime);
}

export function isTool(payload: HookPayload, ...names: string[]): boolean {
  const tool = payload.toolName ?? payload.tool_name;
  return typeof tool === 'string' && names.includes(tool);
}

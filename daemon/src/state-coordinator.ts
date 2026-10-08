import type {CharacterState, HookEvent, HookPayload} from './protocol.js';
import type {AgentId} from './agents/types.js';
import type {AgentBadgeActive} from './agent-badges.js';

export interface PersistedSubagent {
  id: string;
  instances: number;
  leaseUntil: number;
  lastEventAt: number;
}

export interface PersistedSession {
  id: string;
  activeUntil: number;
  attentionUntil: number;
  attentionReason?: 'input' | 'error';
  /** The tools whose answer ends the wait, when the agent named them. Other tools' events do not. */
  waitingOn?: string[];
  lastMainEventAt: number;
  lastSeenAt: number;
  hadWork: boolean;
  completionPending: boolean;
  subagents: PersistedSubagent[];
}

export interface PersistedCoordinatorState {
  version: 1;
  sessions: PersistedSession[];
}

interface SessionState extends Omit<PersistedSession, 'subagents'> {
  subagents: Map<string, PersistedSubagent>;
}

export interface StateCoordinatorOptions {
  completeMs?: number;
  activeLeaseMs?: number;
  attentionLeaseMs?: number;
  subagentLeaseMs?: number;
  retainedSessionMs?: number;
  sweepMs?: number;
  now?: () => number;
  restored?: PersistedCoordinatorState;
  onMutation?: (state: PersistedCoordinatorState) => void;
}

export class StateCoordinator {
  readonly #sessions = new Map<string, SessionState>();
  readonly #onState: (state: CharacterState) => void;
  readonly #onMutation: ((state: PersistedCoordinatorState) => void) | undefined;
  readonly #now: () => number;
  readonly #completeMs: number;
  readonly #activeLeaseMs: number;
  readonly #attentionLeaseMs: number;
  readonly #subagentLeaseMs: number;
  readonly #retainedSessionMs: number;
  #state: CharacterState = 'idle';
  #drivingAgents = new Set<AgentId>();
  #completeTimer: NodeJS.Timeout | undefined;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(onState: (state: CharacterState) => void, options: StateCoordinatorOptions = {}) {
    this.#onState = onState;
    this.#onMutation = options.onMutation;
    this.#now = options.now ?? Date.now;
    this.#completeMs = options.completeMs ?? 4000;
    this.#activeLeaseMs = options.activeLeaseMs ?? 10 * 60_000;
    this.#attentionLeaseMs = options.attentionLeaseMs ?? 30 * 60_000;
    this.#subagentLeaseMs = options.subagentLeaseMs ?? 30 * 60_000;
    this.#retainedSessionMs = options.retainedSessionMs ?? 60 * 60_000;
    this.#restore(options.restored);
    this.sweep();
    const sweepMs = options.sweepMs ?? 5000;
    if (sweepMs > 0) this.#sweepTimer = setInterval(() => this.sweep(), sweepMs);
  }

  get state(): CharacterState {
    return this.#state;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get drivingAgents(): AgentId[] {
    return [...this.#drivingAgents];
  }

  agentBadgeRoles(): {
    working: AgentId[];
    attention: AgentId[];
    complete: AgentId[];
    active: AgentBadgeActive[];
  } {
    const now = this.#now();
    const sessions = [...this.#sessions.values()];
    const attention = this.#orderedAgents(sessions.filter(session => session.attentionUntil > now));
    const working = this.#orderedAgents(sessions.filter(session => session.activeUntil > now || session.subagents.size > 0));
    const complete = this.#state === 'complete' ? [...this.#drivingAgents] : [];
    const ids = this.#state === 'attention' ? attention
      : this.#state === 'working' ? working : this.#state === 'complete' ? complete : [];
    const role = this.#state === 'attention' ? 'a' : this.#state === 'complete' ? 'c' : 'w';
    return {
      working,
      attention,
      complete,
      active: ids.map(id => ({id, role})),
    };
  }

  // The "agent:session" ids of the sessions that count as active.
  activeSessionIds(): string[] {
    const now = this.#now();
    return [...this.#sessions.values()].filter(session => this.#isActive(session, now)).map(session => session.id);
  }

  agentActivity(): Map<AgentId, {activeSessions: number; driving: boolean}> {
    const now = this.#now();
    const activity = new Map<AgentId, {activeSessions: number; driving: boolean}>();
    for (const session of this.#sessions.values()) {
      const agent = this.#agentFromSession(session.id);
      if (!agent || !this.#isActive(session, now)) continue;
      const entry = activity.get(agent) ?? {activeSessions: 0, driving: false};
      entry.activeSessions += 1;
      entry.driving ||= this.#drivingAgents.has(agent);
      activity.set(agent, entry);
    }
    for (const agent of this.#drivingAgents) {
      const entry = activity.get(agent) ?? {activeSessions: 0, driving: true};
      entry.driving = true;
      activity.set(agent, entry);
    }
    return activity;
  }

  handle(event: HookEvent, payload: HookPayload): boolean {
    const now = this.#now();
    const occurredAt = this.#eventTime(payload, now);
    let sessionId = event === 'subagentStart' || event === 'subagentStop'
      ? this.#parentSessionId(payload) ?? this.#sessionId(payload)
      : this.#sessionId(payload);
    let agentIdentity = event === 'subagentStart' || event === 'subagentStop'
      ? this.#agentIdentity(payload)
      : undefined;
    if (event === 'subagentStop' && !this.#parentSessionId(payload) && agentIdentity) {
      let owner = this.#subagentOwner(agentIdentity.id);
      if (!owner) {
        const namedIdentity = this.#namedAgentIdentity(payload);
        const namedOwner = namedIdentity ? this.#subagentOwner(namedIdentity.id) : undefined;
        if (namedIdentity && namedOwner) {
          agentIdentity = namedIdentity;
          owner = namedOwner;
        }
      }
      sessionId = owner?.id ?? sessionId;
    }
    if (event === 'sessionEnd') {
      const session = this.#sessions.get(sessionId);
      if (session && (occurredAt < session.lastMainEventAt
          || [...session.subagents.values()].some(agent => occurredAt < agent.lastEventAt))) {
        return false;
      }
      this.#sessions.delete(sessionId);
      this.#changed();
      return true;
    }
    const session = this.#session(sessionId, now);
    if (event === 'subagentStart' || event === 'subagentStop') {
      const {id: agentId, counted} = agentIdentity!;
      const existing = session.subagents.get(agentId);
      if (existing && occurredAt < existing.lastEventAt) return false;
      if (event === 'subagentStart') {
        session.hadWork = true;
        session.subagents.set(agentId, {
          id: agentId,
          instances: counted ? (existing?.instances ?? 0) + 1 : 1,
          leaseUntil: occurredAt + this.#subagentLeaseMs,
          lastEventAt: occurredAt,
        });
      } else if (existing && existing.instances > 1) {
        session.subagents.set(agentId, {
          ...existing,
          instances: existing.instances - 1,
          lastEventAt: occurredAt,
        });
      } else {
        session.subagents.delete(agentId);
      }
      session.lastSeenAt = now;
      this.#changed();
      return true;
    }
    if (occurredAt < session.lastMainEventAt) return false;
    session.lastMainEventAt = occurredAt;
    session.lastSeenAt = now;
    switch (event) {
      case 'sessionStart':
        break;
      case 'userPromptSubmitted':
        session.activeUntil = occurredAt + this.#activeLeaseMs;
        endWait(session);
        session.hadWork = false;
        session.completionPending = false;
        this.#cancelComplete();
        break;
      case 'preToolUse':
      case 'postToolUse':
      case 'postToolUseFailure':
        session.activeUntil = occurredAt + this.#activeLeaseMs;
        session.hadWork = true;
        // A tool that runs beside a question, in the same batch, does not answer it.
        if (!session.waitingOn || (event !== 'preToolUse' && session.waitingOn.includes(toolName(payload)))) {
          endWait(session);
        }
        break;
      case 'notification':
      case 'errorOccurred': {
        session.activeUntil = 0;
        session.attentionUntil = occurredAt + this.#attentionLeaseMs;
        session.attentionReason = event === 'errorOccurred' ? 'error' : 'input';
        const waitingOn = Array.isArray(payload.waitingOn)
          ? payload.waitingOn.filter((name): name is string => typeof name === 'string') : [];
        if (waitingOn.length) session.waitingOn = waitingOn;
        else delete session.waitingOn;
        this.#cancelComplete();
        break;
      }
      case 'agentStop':
        session.activeUntil = 0;
        // A normal turn end after an error means the agent recovered. Agents report
        // turn-ending failures with their own error event instead of agentStop.
        if (payload.clearAttention === true || session.attentionReason === 'error') endWait(session);
        session.completionPending = session.hadWork && session.attentionUntil <= now;
        break;
      default:
        event satisfies never;
    }
    this.#changed();
    return true;
  }

  sweep(): void {
    const now = this.#now();
    let mutated = false;
    for (const [id, session] of this.#sessions) {
      if (session.activeUntil > 0 && session.activeUntil <= now) {
        session.activeUntil = 0;
        mutated = true;
      }
      if (session.attentionUntil > 0 && session.attentionUntil <= now) {
        endWait(session);
        mutated = true;
      }
      for (const [agentId, agent] of session.subagents) {
        if (agent.leaseUntil > now) continue;
        session.subagents.delete(agentId);
        mutated = true;
      }
      const active = session.activeUntil > now || session.attentionUntil > now
        || session.subagents.size > 0 || session.completionPending;
      if (!active && now - session.lastSeenAt >= this.#retainedSessionMs) {
        this.#sessions.delete(id);
        mutated = true;
      }
    }
    if (mutated) this.#changed();
    else this.#recompute(now);
  }

  snapshot(): PersistedCoordinatorState {
    return {
      version: 1,
      sessions: [...this.#sessions.values()].map(session => ({
        id: session.id,
        activeUntil: session.activeUntil,
        attentionUntil: session.attentionUntil,
        ...(session.attentionReason ? {attentionReason: session.attentionReason} : {}),
        ...(session.waitingOn ? {waitingOn: [...session.waitingOn]} : {}),
        lastMainEventAt: session.lastMainEventAt,
        lastSeenAt: session.lastSeenAt,
        hadWork: session.hadWork,
        completionPending: false,
        subagents: [...session.subagents.values()].map(agent => ({...agent})),
      })),
    };
  }

  close(): void {
    this.#cancelComplete();
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  #restore(restored: PersistedCoordinatorState | undefined): void {
    if (!restored || restored.version !== 1) return;
    let sanitized = false;
    for (const saved of restored.sessions) {
      if (!saved.id || !Number.isFinite(saved.lastSeenAt)) continue;
      const subagents = saved.subagents.filter(agent => !agent.id.startsWith('name:'));
      sanitized ||= subagents.length !== saved.subagents.length;
      // Sessions saved before multi-agent support were all Copilot and had no agent prefix.
      const id = this.#agentFromSession(saved.id) ? saved.id : `copilot:${saved.id}`;
      sanitized ||= id !== saved.id;
      const existing = this.#sessions.get(id);
      if (existing && existing.lastSeenAt >= saved.lastSeenAt) continue;
      this.#sessions.set(id, {
        ...saved,
        id,
        completionPending: false,
        subagents: new Map(subagents.map(agent => [agent.id, {...agent}])),
      });
    }
    if (sanitized) this.#onMutation?.(this.snapshot());
  }

  #session(id: string, now: number): SessionState {
    let session = this.#sessions.get(id);
    if (!session) {
      session = {
        id,
        activeUntil: 0,
        attentionUntil: 0,
        lastMainEventAt: 0,
        lastSeenAt: now,
        hadWork: false,
        completionPending: false,
        subagents: new Map(),
      };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #isActive(session: SessionState, now: number): boolean {
    return session.activeUntil > now || session.attentionUntil > now
      || session.subagents.size > 0 || session.completionPending;
  }

  #sessionId(payload: HookPayload): string {
    const value = payload.sessionId ?? payload.session_id;
    return typeof value === 'string' && value ? value : 'unknown-session';
  }

  #parentSessionId(payload: HookPayload): string | undefined {
    const value = payload.parentSessionId ?? payload.parent_session_id;
    return typeof value === 'string' && value ? value : undefined;
  }

  #agentIdentity(payload: HookPayload): {id: string; counted: boolean} {
    const unique = payload.subagentId ?? payload.subagent_id
      ?? payload.agentId ?? payload.agent_id;
    if (typeof unique === 'string' && unique) return {id: `id:${unique}`, counted: false};
    const toolCall = payload.toolCallId ?? payload.tool_call_id;
    if (typeof toolCall === 'string' && toolCall) return {id: `call:${toolCall}`, counted: false};
    return this.#namedAgentIdentity(payload) ?? {id: 'name:unknown-agent', counted: true};
  }

  #namedAgentIdentity(payload: HookPayload): {id: string; counted: true} | undefined {
    const name = payload.agentName ?? payload.agent_name;
    if (typeof name !== 'string' || !name) return undefined;
    return {
      id: `name:${name}`,
      counted: true,
    };
  }

  #subagentOwner(agentId: string): SessionState | undefined {
    let owner: SessionState | undefined;
    let latest = -1;
    for (const session of this.#sessions.values()) {
      const agent = session.subagents.get(agentId);
      if (!agent || agent.lastEventAt <= latest) continue;
      owner = session;
      latest = agent.lastEventAt;
    }
    return owner;
  }

  #eventTime(payload: HookPayload, fallback: number): number {
    const value = payload.timestamp;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value <= fallback + 60_000 ? value : fallback;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed <= fallback + 60_000) return parsed;
    }
    return fallback;
  }

  #changed(): void {
    this.#recompute(this.#now());
    this.#onMutation?.(this.snapshot());
  }

  #recompute(now: number): void {
    const sessions = [...this.#sessions.values()];
    const attention = sessions.filter(session => session.attentionUntil > now);
    if (attention.length) {
      this.#setDrivers(attention);
      this.#setState('attention');
      return;
    }
    const working = sessions.filter(session => session.activeUntil > now || session.subagents.size > 0);
    if (working.length) {
      this.#setDrivers(working);
      this.#setState('working');
      return;
    }
    const completed = sessions.filter(session => session.completionPending);
    if (completed.length > 0) {
      this.#setDrivers(completed);
      for (const session of completed) session.completionPending = false;
      this.#pulseComplete();
      return;
    }
    if (!this.#completeTimer) {
      this.#drivingAgents.clear();
      this.#setState('idle');
    }
  }

  #pulseComplete(): void {
    this.#cancelComplete();
    this.#setState('complete');
    this.#completeTimer = setTimeout(() => {
      this.#completeTimer = undefined;
      this.#recompute(this.#now());
      this.#onMutation?.(this.snapshot());
    }, this.#completeMs);
  }

  #cancelComplete(): void {
    if (!this.#completeTimer) return;
    clearTimeout(this.#completeTimer);
    this.#completeTimer = undefined;
  }

  #setState(state: CharacterState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState(state);
  }

  #setDrivers(sessions: SessionState[]): void {
    this.#drivingAgents = new Set(this.#orderedAgents(sessions));
  }

  #orderedAgents(sessions: SessionState[]): AgentId[] {
    const agents: AgentId[] = [];
    for (const session of sessions) {
      const agent = this.#agentFromSession(session.id);
      if (agent && !agents.includes(agent)) agents.push(agent);
    }
    return agents;
  }

  #agentFromSession(sessionId: string): AgentId | undefined {
    const prefix = sessionId.split(':', 1)[0] ?? '';
    return ['copilot', 'claude', 'codex', 'grok', 'hermes', 'openclaw'].includes(prefix)
      ? prefix as AgentId : undefined;
  }
}

function endWait(session: SessionState): void {
  session.attentionUntil = 0;
  delete session.waitingOn;
}

function toolName(payload: HookPayload): string {
  const name = payload.toolName ?? payload.tool_name;
  return typeof name === 'string' ? name : '';
}

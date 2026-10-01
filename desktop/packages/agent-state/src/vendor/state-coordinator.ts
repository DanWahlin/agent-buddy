import type {CharacterState, HookEvent, HookPayload} from './protocol.js';

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
        session.attentionUntil = 0;
        session.hadWork = false;
        session.completionPending = false;
        this.#cancelComplete();
        break;
      case 'preToolUse':
      case 'postToolUse':
      case 'postToolUseFailure':
        session.activeUntil = occurredAt + this.#activeLeaseMs;
        session.attentionUntil = 0;
        session.hadWork = true;
        break;
      case 'notification':
      case 'errorOccurred':
        session.activeUntil = 0;
        session.attentionUntil = occurredAt + this.#attentionLeaseMs;
        this.#cancelComplete();
        break;
      case 'agentStop':
        session.activeUntil = 0;
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
        session.attentionUntil = 0;
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
      this.#sessions.set(saved.id, {
        ...saved,
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
    if (sessions.some(session => session.attentionUntil > now)) {
      this.#setState('attention');
      return;
    }
    if (sessions.some(session => session.activeUntil > now || session.subagents.size > 0)) {
      this.#setState('working');
      return;
    }
    const completed = sessions.filter(session => session.completionPending);
    if (completed.length > 0) {
      for (const session of completed) session.completionPending = false;
      this.#pulseComplete();
      return;
    }
    if (!this.#completeTimer) this.#setState('idle');
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
}

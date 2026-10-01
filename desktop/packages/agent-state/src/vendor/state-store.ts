import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {PersistedCoordinatorState} from './state-coordinator.js';

export class StateStore {
  readonly #path: string;
  #pending: PersistedCoordinatorState | undefined;
  #timer: NodeJS.Timeout | undefined;
  #write = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<PersistedCoordinatorState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as unknown;
      if (!isPersistedState(parsed)) throw new Error('unsupported or malformed state schema');
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      const invalidPath = `${this.#path}.invalid-${Date.now()}`;
      await rename(this.#path, invalidPath).catch(() => undefined);
      console.error(`[state] ignored invalid persistence file: ${message(error)}; moved to ${invalidPath}`);
      return undefined;
    }
  }

  schedule(state: PersistedCoordinatorState): void {
    this.#pending = structuredClone(state);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#queueWrite();
    }, 50);
  }

  async flush(state?: PersistedCoordinatorState): Promise<void> {
    if (state) this.#pending = structuredClone(state);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queueWrite();
    await this.#write;
  }

  #queueWrite(): void {
    const state = this.#pending;
    this.#pending = undefined;
    if (!state) return;
    this.#write = this.#write
      .then(() => this.#writeState(state))
      .catch(error => console.error(`[state] persistence failed: ${message(error)}`));
  }

  async #writeState(state: PersistedCoordinatorState): Promise<void> {
    const directory = dirname(this.#path);
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {mode: 0o600});
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}

function isPersistedState(value: unknown): value is PersistedCoordinatorState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.sessions)) return false;
  return state.sessions.every((session: unknown) => {
    if (!session || typeof session !== 'object') return false;
    const candidate = session as Record<string, unknown>;
    return typeof candidate.id === 'string'
      && finite(candidate.activeUntil)
      && finite(candidate.attentionUntil)
      && finite(candidate.lastMainEventAt)
      && finite(candidate.lastSeenAt)
      && typeof candidate.hadWork === 'boolean'
      && typeof candidate.completionPending === 'boolean'
      && Array.isArray(candidate.subagents)
      && candidate.subagents.every(agent => {
        if (!agent || typeof agent !== 'object') return false;
        const item = agent as Record<string, unknown>;
        return typeof item.id === 'string'
          && Number.isInteger(item.instances) && (item.instances as number) > 0
          && finite(item.leaseUntil) && finite(item.lastEventAt);
      });
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

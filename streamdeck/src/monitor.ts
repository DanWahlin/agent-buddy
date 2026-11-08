import {
  fetchStatus, isAgent, readConnection, settingsPath,
  type AgentId, type Connection, type Status, stateFor,
} from './client.js';
import {keyImage, type KeyState} from './key-image.js';

export type KeySettings = {agent?: string; settingsFile?: string; pulse?: boolean};
export type KeyUpdate = {state: KeyState; image: string; message: string};
type Entry = {
  settings: KeySettings;
  render: (update: KeyUpdate) => Promise<void>;
  lastImage?: string;
  lastMessage?: string;
};
type Dependencies = {
  read: typeof readConnection;
  fetch: typeof fetchStatus;
  log: (message: string) => void;
};

export class Monitor {
  readonly #entries = new Map<string, Entry>();
  readonly #dependencies: Dependencies;
  readonly #errors = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #pulse = false;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.#dependencies = {
      read: readConnection, fetch: fetchStatus, log: console.error, ...dependencies,
    };
  }

  add(id: string, settings: KeySettings, render: Entry['render']): void {
    this.#entries.set(id, {settings, render});
    if (!this.#timer) this.#timer = setInterval(() => { void this.poll(); }, 1000);
    void this.poll();
  }

  remove(id: string): void {
    this.#entries.delete(id);
    if (!this.#entries.size) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#errors.clear();
    }
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    this.#pulse = !this.#pulse;
    try {
      const groups = new Map<string, Array<[string, Entry]>>();
      for (const [id, entry] of this.#entries) {
        const path = this.path(entry.settings);
        const group = groups.get(path) ?? [];
        group.push([id, entry]);
        groups.set(path, group);
      }
      await Promise.all([...groups].map(async ([path, entries]) => {
        let status: Status | undefined;
        let message = '';
        try {
          status = await this.#dependencies.fetch(await this.#dependencies.read(path));
          this.#errors.delete(path);
        } catch (error) {
          message = error instanceof Error ? error.message : 'Unable to read Agent Buddy status.';
          if (this.#errors.get(path) !== message) this.#dependencies.log(message);
          this.#errors.set(path, message);
        }
        await Promise.all(entries.map(async ([id, entry]) => {
          if (this.#entries.get(id) !== entry) return;
          const selected = entry.settings.agent ?? 'all';
          const agent: AgentId | 'all' = isAgent(selected) ? selected : 'all';
          const valid = selected === 'all' || isAgent(selected);
          const state = !valid ? 'setup' : status ? stateFor(status, agent) : 'offline';
          const image = keyImage(state, agent,
            state === 'attention' && entry.settings.pulse !== false && this.#pulse);
          const detail = valid
            ? message || (state === 'attention' ? 'Your agent needs you.' : `Agent Buddy: ${state}.`)
            : 'Select a supported agent in the key settings.';
          if (entry.lastImage === image && entry.lastMessage === detail) return;
          try {
            await entry.render({
              state, image,
              message: detail,
            });
            entry.lastImage = image;
            entry.lastMessage = detail;
          } catch {
            this.#dependencies.log('Cannot update a Stream Deck key. Reconnect Stream Deck.');
          }
        }));
      }));
    } finally {
      this.#polling = false;
    }
  }

  path(settings: KeySettings): string {
    return typeof settings.settingsFile === 'string' && settings.settingsFile.trim()
      ? settings.settingsFile.trim() : settingsPath();
  }

  connection(settings: KeySettings): Promise<Connection> {
    return this.#dependencies.read(this.path(settings));
  }
}

import {request as httpRequest} from 'node:http';
import type {CharacterState, InstallProgress} from './protocol.js';
import {
  activePacket,
  iconPacket,
  shouldSendBadges,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
} from './agent-badges.js';
import {discoverWifiDevices, loadWifiConfig, type WifiConfig} from './wifi-config.js';

const uploadChunkBytes = 16 * 1024;
const uploadIdleTimeoutMs = 30000;

export class WifiTransport {
  #config: WifiConfig | null = null;
  #endpoint: string | null = null;
  #desired: CharacterState = 'idle';
  #enabled = false;
  #connected = false;
  #boot: number | null = null;
  #protocol = 0;
  #iconSignature = '';
  #activeSignature = '';
  #scanTimer: NodeJS.Timeout | undefined;
  #scanActive = false;
  #commands = Promise.resolve();
  #character: string | null = null;
  #adaptivePatchRam = false;
  #installing = false;
  readonly #changed: () => void;

  constructor(changed: () => void = () => undefined) {
    this.#changed = changed;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get endpoint(): string | null {
    return this.#endpoint;
  }

  get character(): string | null {
    return this.#connected ? this.#character : null;
  }

  get adaptivePatchRam(): boolean {
    return this.#connected && this.#adaptivePatchRam;
  }

  async start(): Promise<void> {
    if (this.#scanTimer) return;
    await this.reload();
    void this.#scan();
    this.#scanTimer = setInterval(() => void this.#scan(), 3000);
  }

  stop(): void {
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    this.#scanTimer = undefined;
    this.#setConnection(false, null);
  }

  async reload(): Promise<void> {
    this.#config = await loadWifiConfig();
    this.#setConnection(false, null);
    if (this.#config) void this.#scan();
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  setState(state: CharacterState): void {
    this.#desired = state;
    if (this.#installing || !this.#enabled || !this.#config || !this.#endpoint) return;
    this.#commands = this.#commands
      .then(() => this.#sendState(state))
      .catch(error => {
        console.error(`[wifi] ${this.#message(error)}`);
        this.#setConnection(false, null);
      });
  }

  setAgentBadges(icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[]): void {
    const iconSignature = icons.map(icon => `${icon.id}:${icon.color}:${icon.mask.toString('base64')}`).join('|');
    const activeSignature = active.map(item => `${item.id}=${item.role}`).join(',');
    if (this.#installing || !this.#enabled || !this.#config || !this.#endpoint
        || !shouldSendBadges(this.#protocol) || (iconSignature === this.#iconSignature
        && activeSignature === this.#activeSignature)) return;
    this.#commands = this.#commands
      .then(() => this.#sendAgentBadges(icons, active, iconSignature, activeSignature))
      .catch(error => {
        console.error(`[wifi] ${this.#message(error)}`);
        this.#setConnection(false, null);
      });
  }

  async #scan(): Promise<void> {
    if (this.#scanActive || this.#installing || !this.#config) return;
    this.#scanActive = true;
    try {
      const known = this.#endpoint ?? (this.#config.address
          ? `http://${this.#config.address}:${this.#config.port ?? 80}` : null);
      if (known && await this.#probe(known)) return;
      const device = (await discoverWifiDevices()).find(
        candidate => candidate.deviceId.toLowerCase() === this.#config!.deviceId.toLowerCase());
      // The authenticated status probe also reports which character pack is installed.
      if (!device || !await this.#probe(`http://${device.address}:${device.port}`))
        this.#setConnection(false, null);
    } catch (error) {
      console.error(`[wifi] discovery failed: ${this.#message(error)}`);
      this.#setConnection(false, null);
    } finally {
      this.#scanActive = false;
    }
  }

  async #probe(endpoint: string): Promise<boolean> {
    if (!this.#config) return false;
    try {
      const response = await fetch(`${endpoint}/status`, {
        headers: {Authorization: `Bearer ${this.#config.token}`},
        signal: AbortSignal.timeout(1200),
      });
      if (!response.ok) return false;
      const status = await response.json() as {deviceId?: string; boot?: number; character?: string; protocol?: number;
                                               patchRam?: string};
      if (status.deviceId?.toLowerCase() !== this.#config.deviceId.toLowerCase()) return false;
      if (!Number.isInteger(status.boot) || Number(status.boot) < 0) return false;
      this.#character = typeof status.character === 'string' ? status.character : null;
      this.#adaptivePatchRam = status.patchRam === 'adaptive';
      const needsSync = !this.#connected || endpoint !== this.#endpoint || status.boot !== this.#boot;
      this.#endpoint = endpoint;
      this.#boot = status.boot!;
      this.#protocol = Number.isInteger(status.protocol) ? Number(status.protocol) : 0;
      if (needsSync) {
        this.#iconSignature = '';
        this.#activeSignature = '';
      }
      if (this.#enabled && needsSync) await this.#sendState(this.#desired);
      else this.#setConnection(true, endpoint);
      return true;
    } catch {
      return false;
    }
  }

  async installCharacter(pack: Buffer, progress: InstallProgress = () => undefined): Promise<string> {
    if (!this.#config || !this.#endpoint || !this.#connected)
      throw new Error('The Agent Companion is not reachable over Wi-Fi.');
    const endpoint = new URL(`${this.#endpoint}/character`);
    const token = this.#config.token;
    this.#installing = true;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': pack.length,
          },
        }, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { text += chunk; });
          response.on('end', () => resolve(text));
          response.on('error', reject);
        });
        request.setTimeout(uploadIdleTimeoutMs, () =>
          request.destroy(new Error('Wi-Fi character upload timed out.')));
        request.on('error', reject);
        void (async () => {
          for (let sent = 0; sent < pack.length; sent += uploadChunkBytes) {
            const chunk = pack.subarray(sent, sent + uploadChunkBytes);
            if (!request.write(chunk))
              await new Promise(drained => request.once('drain', drained));
            progress(sent + chunk.length, pack.length);
          }
          request.end();
        })().catch(reject);
      });
      const result = parseUploadResponse(body);
      this.#setConnection(false, null);
      return result;
    } finally {
      this.#installing = false;
    }
  }

  async #sendState(state: CharacterState): Promise<void> {
    if (!this.#config || !this.#endpoint) return;
    const response = await fetch(`${this.#endpoint}/state`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.#config.token}`},
      body: state,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Device rejected ${state}: ${await response.text()}`);
    this.#setConnection(true, this.#endpoint);
    console.log(`[state] ${state} via wifi`);
  }

  async #sendAgentBadges(
      icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[],
      iconSignature: string, activeSignature: string): Promise<void> {
    if (!this.#config || !this.#endpoint || !shouldSendBadges(this.#protocol)) return;
    if (iconSignature !== this.#iconSignature) {
      for (const icon of icons) await this.#postBadge('/icon', iconPacket(icon));
      this.#iconSignature = iconSignature;
      this.#activeSignature = '';
    }
    if (activeSignature !== this.#activeSignature) {
      await this.#postBadge('/agents', activePacket(active));
      this.#activeSignature = activeSignature;
      console.log(`[badges] ${active.length} agent badge(s) via wifi`);
    }
  }

  async #postBadge(path: '/icon' | '/agents', body: string): Promise<void> {
    if (!this.#config || !this.#endpoint) return;
    const response = await fetch(`${this.#endpoint}${path}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.#config.token}`, 'Content-Type': 'text/plain; charset=utf-8'},
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Device rejected badge packet: ${await response.text()}`);
  }

  #setConnection(connected: boolean, endpoint: string | null): void {
    const changed = connected !== this.#connected || endpoint !== this.#endpoint;
    this.#connected = connected;
    this.#endpoint = endpoint;
    if (!connected) this.#boot = null;
    if (!connected) {
      this.#protocol = 0;
      this.#iconSignature = '';
      this.#activeSignature = '';
    }
    if (changed) this.#changed();
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function parseUploadResponse(body: string): string {
  let result: {ok?: boolean; character?: unknown; error?: unknown};
  try {
    result = JSON.parse(body) as typeof result;
  } catch {
    throw new Error(`Device returned an invalid upload response: ${body.slice(0, 120)}`);
  }
  if (!result.ok)
    throw new Error(`Device rejected the character: ${String(result.error ?? 'unknown error')}`);
  return typeof result.character === 'string' ? result.character : 'unknown';
}

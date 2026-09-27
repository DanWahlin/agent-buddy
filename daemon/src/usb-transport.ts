import {SerialPort} from 'serialport';
import {deviceNetwork, type CharacterState, type DeviceNetwork, type InstallProgress} from './protocol.js';
import {
  activePacket,
  iconPacket,
  shouldSendBadges,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
} from './agent-badges.js';
import {
  parseWifiProvisioningResponse,
  wifiProvisioningPacket,
  type WifiConfig,
} from './wifi-config.js';

interface LineWaiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class UsbTransport {
  readonly #preferredPort = process.env.AGENT_COMPANION_PORT;
  #port: SerialPort | undefined;
  #path: string | null = null;
  #desired: CharacterState = 'idle';
  #scanTimer: NodeJS.Timeout | undefined;
  #scanActive = false;
  #buffer = '';
  #waiters: LineWaiter[] = [];
  #commands = Promise.resolve();
  #protocol = 0;
  #iconSignature = '';
  #activeSignature = '';
  #enabled = true;
  #character: string | null = null;
  #adaptivePatchRam = false;
  #network: DeviceNetwork | null = null;
  readonly #changed: () => void;

  constructor(changed: () => void = () => undefined) {
    this.#changed = changed;
  }

  get character(): string | null {
    return this.connected ? this.#character : null;
  }

  // Firmware that reports patch_ram=adaptive keeps enough internal RAM free for Wi-Fi with any pack.
  get adaptivePatchRam(): boolean {
    return this.connected && this.#adaptivePatchRam;
  }

  get network(): DeviceNetwork | null {
    return this.connected ? this.#network : null;
  }

  get connected(): boolean {
    return this.#port?.isOpen === true;
  }

  get path(): string | null {
    return this.#path;
  }

  get state(): CharacterState {
    return this.#desired;
  }

  start(): void {
    if (!this.#enabled || this.#scanTimer) return;
    void this.#scan();
    this.#scanTimer = setInterval(() => void this.#scan(), 2000);
  }

  async stop(): Promise<void> {
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    this.#scanTimer = undefined;
    this.#rejectWaiters(new Error('USB transport stopped.'));
    const port = this.#port;
    this.#port = undefined;
    this.#path = null;
    if (port?.isOpen) {
      await new Promise<void>(resolve => port.close(() => resolve()));
    }
    this.#changed();
  }

  setState(state: CharacterState): void {
    this.#desired = state;
    this.#commands = this.#commands
      .then(() => this.#sendState(state))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  setAgentBadges(icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[]): void {
    const iconSignature = icons.map(icon => `${icon.id}:${icon.color}:${icon.mask.toString('base64')}`).join('|');
    const activeSignature = active.map(item => `${item.id}=${item.role}`).join(',');
    if (!shouldSendBadges(this.#protocol) || (iconSignature === this.#iconSignature
        && activeSignature === this.#activeSignature)) return;
    this.#commands = this.#commands
      .then(() => this.#sendAgentBadges(icons, active, iconSignature, activeSignature))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  // Disabling releases the serial port so a cable can provide power only.
  async setEnabled(enabled: boolean): Promise<void> {
    this.#enabled = enabled;
    if (enabled) this.start();
    else await this.stop();
  }

  async #scan(): Promise<void> {
    if (!this.#enabled || this.#scanActive || this.connected) return;
    this.#scanActive = true;
    try {
      const ports = await SerialPort.list();
      const candidate = ports.find(port => port.path === this.#preferredPort)
        ?? ports.find(port => port.vendorId?.toLowerCase() === '303a'
          && isLikelyEsp32Port(port.path))
        ?? ports.find(port => isLikelyEsp32Port(port.path));
      if (!candidate) return;
      const path = process.platform === 'darwin'
        ? candidate.path.replace(/^\/dev\/tty\./, '/dev/cu.')
        : candidate.path;
      await this.#open(path);
    } catch (error) {
      console.error(`[usb] discovery failed: ${this.#message(error)}`);
    } finally {
      this.#scanActive = false;
    }
  }

  async #open(path: string): Promise<void> {
    const port = new SerialPort({
      path,
      baudRate: 115200,
      autoOpen: false,
      hupcl: false,
    });
    port.on('data', data => this.#onData(data as Buffer));
    port.on('error', error => console.error(`[usb] ${error.message}`));
    port.on('close', () => {
      console.log(`[usb] disconnected ${path}`);
      this.#rejectWaiters(new Error('USB device disconnected.'));
      if (this.#port === port) {
        this.#port = undefined;
        this.#path = null;
        this.#changed();
      }
    });
    await new Promise<void>((resolve, reject) => {
      port.open(error => error ? reject(error) : resolve());
    });
    this.#port = port;
    this.#path = path;
    try {
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      const protocol = Number(/^INFO protocol=(\d+)(?: |$)/.exec(info)?.[1]);
      if (!Number.isInteger(protocol) || protocol < 1 || protocol > 6) {
        throw new Error(`Unsupported device protocol: ${info}`);
      }
      this.#protocol = protocol;
      this.#adaptivePatchRam = /\bpatch_ram=adaptive\b/.test(info);
      this.#network = deviceNetwork(/\bssid_b64=([A-Za-z0-9+/=]*)/.exec(info)?.[1],
                                    /\bwifi_connected=1\b/.test(info));
      this.#iconSignature = '';
      this.#activeSignature = '';
      this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(info)?.[1] ?? null;
      console.log(`[usb] ${info}`);
      console.log(`[usb] connected ${path}`);
      this.#changed();
    } catch (error) {
      await new Promise<void>(resolve => port.close(() => resolve()));
      throw error;
    }
  }

  async #sendState(state: CharacterState): Promise<void> {
    if (!this.connected) return;
    await this.#request(`!${state}\n`, line => line === `COMMAND accepted=${state}`);
    console.log(`[state] ${state} via usb`);
  }

  async #sendAgentBadges(
      icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[],
      iconSignature: string, activeSignature: string): Promise<void> {
    if (!this.connected || !shouldSendBadges(this.#protocol)) return;
    if (iconSignature !== this.#iconSignature) {
      for (const icon of icons)
        await this.#request(iconPacket(icon), line => line === `ICON accepted=${icon.id}`);
      this.#iconSignature = iconSignature;
      this.#activeSignature = '';
    }
    if (activeSignature !== this.#activeSignature) {
      await this.#request(activePacket(active), line => line === `AGENTS accepted=${active.length}`);
      this.#activeSignature = activeSignature;
      console.log(`[badges] ${active.length} agent badge(s) via usb`);
    }
  }

  async configureWifi(ssid: string, password: string): Promise<WifiConfig> {
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error(this.#enabled
        ? 'Connect the Agent Companion over USB first.'
        : 'USB is turned off. Run "npm run connection auto" to use it again.');
      if (this.#protocol < 4)
        throw new Error('The connected device firmware does not support USB Wi-Fi setup.');
      const line = await this.#request(
        wifiProvisioningPacket(ssid, password),
        candidate => candidate.startsWith('WIFI configured ')
          || candidate.startsWith('WIFI_ERROR '));
      if (line.startsWith('WIFI_ERROR '))
        throw new Error(`Device rejected Wi-Fi setup: ${line.slice('WIFI_ERROR '.length)}`);
      const config = parseWifiProvisioningResponse(line);
      // The device joins the new network in the background; Wi-Fi discovery reports when it has.
      this.#network = {ssid, connected: false};
      this.#changed();
      return config;
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  installCharacter(pack: Buffer, progress: InstallProgress = () => undefined): Promise<string> {
    const operation = this.#commands.then(() => this.#installCharacter(pack, progress));
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #installCharacter(pack: Buffer, progress: InstallProgress): Promise<string> {
    if (!this.connected) throw new Error('Connect the Agent Companion over USB first.');
    if (this.#protocol < 5)
      throw new Error('The connected device firmware does not support character installation.');
    const ready = await this.#request(
      'u', line => line.startsWith('UPLOAD_READY ') || line.startsWith('UPLOAD_ERROR '), 10000);
    const limits = parseUploadReady(ready);
    if (pack.length > limits.maxBytes)
      throw new Error(`Character pack exceeds the device's ${limits.maxBytes}-byte partition.`);
    let sent = 0;
    let retries = 0;
    while (sent < pack.length) {
      const chunk = pack.subarray(sent, sent + limits.chunk);
      const last = sent + chunk.length === pack.length;
      // The final chunk is followed by flash verification rather than an acknowledgement.
      const response = await this.#request(chunk, line => line.startsWith('UPLOAD_ERROR ')
          || line.startsWith('UPLOAD_RETRY ')
          || (last ? line.startsWith('UPLOAD_OK ') : line.startsWith('UPLOAD_ACK ')), last ? 30000 : 15000);
      if (response.startsWith('UPLOAD_ERROR '))
        throw new Error(`Device rejected the character: ${response.slice('UPLOAD_ERROR '.length)}`);
      if (response.startsWith('UPLOAD_RETRY ')) {
        // The device is discarding a stalled chunk; resend only once it reports a quiet line.
        if (Number(/\breceived=(\d+)\b/.exec(response)?.[1]) !== sent || ++retries > 8)
          throw new Error(`Character upload could not recover: ${response}`);
        await this.#waitFor(line => line === `UPLOAD_RESEND received=${sent}`, 10000);
        console.error(`[usb] resending character chunk at ${sent}`);
        continue;
      }
      sent += chunk.length;
      if (!last && Number(/\breceived=(\d+)\b/.exec(response)?.[1]) !== sent)
        throw new Error(`Device acknowledged an unexpected byte count: ${response}`);
      progress(sent, pack.length);
      if (last) {
        console.log(`[usb] ${response}`);
        return /\bcharacter=([a-z0-9-]+)\b/.exec(response)?.[1] ?? 'unknown';
      }
    }
    throw new Error('Character pack is empty.');
  }

  async #request(text: string | Buffer, match: (line: string) => boolean,
                 timeoutMs = 5000): Promise<string> {
    const response = this.#waitFor(match, timeoutMs);
    try {
      await this.#write(text);
      return await response;
    } catch (error) {
      this.#rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async #write(text: string | Buffer): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen) throw new Error('USB device is not connected.');
    await new Promise<void>((resolve, reject) => {
      port.write(text, error => {
        if (error) reject(error);
        else port.drain(drainError => drainError ? reject(drainError) : resolve());
      });
    });
  }

  #onData(data: Buffer): void {
    this.#buffer += data.toString('utf8');
    if (this.#buffer.length > 65536) {
      console.error('[usb] discarded oversized unterminated serial response');
      this.#buffer = '';
      this.#rejectWaiters(new Error('USB device returned an oversized response.'));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      // Software restarts keep the USB port open, so the boot banner marks a new session.
      if (line.startsWith('READY:')) this.#rebooted(line);
      const waiter = this.#waiters.find(candidate => candidate.match(line));
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  }

  #rebooted(line: string): void {
    this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(line)?.[1] ?? null;
    this.#iconSignature = '';
    this.#activeSignature = '';
    console.log(`[usb] device restarted character=${this.#character ?? 'unknown'}`);
    this.#changed();
  }

  #waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new Error('Timed out waiting for device acknowledgement.'));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function parseUploadReady(line: string): {maxBytes: number; chunk: number} {
  const maxBytes = Number(/\bmax_bytes=(\d+)\b/.exec(line)?.[1]);
  const chunk = Number(/\bchunk=(\d+)\b/.exec(line)?.[1]);
  if (line.startsWith('UPLOAD_ERROR ')) throw new Error(`Device cannot install a character: ${line}`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(chunk)
      || chunk < 256 || chunk > 65536)
    throw new Error(`Device sent an invalid upload response: ${line}`);
  return {maxBytes, chunk};
}

export function isLikelyEsp32Port(
    path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return /^\/dev\/(?:cu|tty)\.usbmodem/i.test(path);
  return /^\/dev\/tty(?:ACM|USB)\d+$/i.test(path);
}

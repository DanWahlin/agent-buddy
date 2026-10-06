import {request as httpRequest} from 'node:http';
import {
  isOrientationOffset, isOrientationTenths, orientationFromTenths, orientationProtocol,
  type DeviceOrientation,
} from './orientation-settings.js';
import {deviceNetwork, type CharacterState, type DeviceNetwork, type InstallProgress} from './protocol.js';
import {
  activePacket,
  iconPacket,
  shouldSendBadges,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
} from './agent-badges.js';
import {shouldSendUsage, usagePacket} from './usage-tracker.js';
import {discoverWifiDevices, loadWifiConfig, type WifiConfig} from './wifi-config.js';

const uploadChunkBytes = 16 * 1024;
const uploadIdleTimeoutMs = 30000;
// The device waits this long for the BOOT press; the daemon waits a little longer.
const firmwareApprovalMs = 62000;
const firmwareApprovalPollMs = 500;
const speechProtocol = 13;

export type FirmwareApproval = 'none' | 'waiting' | 'allowed';

// Protocol 11 and later firmware takes a Wi-Fi update only after a BOOT press on the device,
// because the token alone travels over plain HTTP.
export function needsFirmwareApproval(protocol: number): boolean {
  return protocol >= 11;
}

// Polls the device until the person presses BOOT. `null` is a failed read, which is tried again;
// `none` means the device stopped waiting.
export async function waitForFirmwareApproval(
    read: () => Promise<FirmwareApproval | null>, timeoutMs = firmwareApprovalMs,
    intervalMs = firmwareApprovalPollMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const approval = await read().catch(() => null);
    if (approval === 'allowed') return;
    if (approval === 'none' || Date.now() >= deadline)
      throw new Error('Nobody pressed the BOOT button on the device in 60 seconds, so the update stopped. '
        + 'Click Update again, then press BOOT on the device.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

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
  #usageSignature: string | null = null;
  #scanTimer: NodeJS.Timeout | undefined;
  #scanActive = false;
  #commands = Promise.resolve();
  #character: string | null = null;
  #adaptivePatchRam = false;
  #firmware: string | null = null;
  #orientation: DeviceOrientation | null = null;
  #ssidBase64: string | undefined;
  #installing = false;
  #buttons: ButtonCount | null = null;
  readonly #changed: () => void;
  readonly #button: (presses: number) => void;

  // `button` runs when the device's BOOT button count goes up, with the count since the device started.
  constructor(changed: () => void = () => undefined, button: (presses: number) => void = () => undefined) {
    this.#changed = changed;
    this.#button = button;
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

  // The first 16 hex digits of the firmware's ELF SHA-256; null before protocol 9.
  get firmware(): string | null {
    return this.#connected ? this.#firmware : null;
  }

  get orientation(): DeviceOrientation | null {
    return this.#connected ? this.#orientation : null;
  }

  get adaptivePatchRam(): boolean {
    return this.#connected && this.#adaptivePatchRam;
  }

  // Reachable over Wi-Fi means the device is on this network right now.
  get network(): DeviceNetwork | null {
    return this.#connected ? deviceNetwork(this.#ssidBase64, true) : null;
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
                                               patchRam?: string; ssidBase64?: string; firmware?: string;
                                               buttonPresses?: number; orientationOffsetTenths?: unknown};
      if (status.deviceId?.toLowerCase() !== this.#config.deviceId.toLowerCase()) return false;
      if (!Number.isInteger(status.boot) || Number(status.boot) < 0) return false;
      const protocol = Number.isInteger(status.protocol) ? Number(status.protocol) : 0;
      const previousOffset = this.#orientation?.offsetDegrees;
      if (protocol >= orientationProtocol && status.orientationOffsetTenths !== null) {
        if (!isOrientationTenths(status.orientationOffsetTenths)) {
          console.error('[wifi] The device sent an invalid orientation offset.');
          return false;
        }
        this.#orientation = orientationFromTenths(status.orientationOffsetTenths);
      } else {
        this.#orientation = null;
      }
      this.#character = typeof status.character === 'string' ? status.character : null;
      this.#adaptivePatchRam = status.patchRam === 'adaptive';
      this.#firmware = typeof status.firmware === 'string' && /^[0-9a-f]{16}$/.test(status.firmware)
        ? status.firmware : null;
      this.#ssidBase64 = typeof status.ssidBase64 === 'string' ? status.ssidBase64 : undefined;
      const needsSync = !this.#connected || endpoint !== this.#endpoint || status.boot !== this.#boot;
      // Protocol 10 and later count BOOT button presses.
      if (Number.isInteger(status.buttonPresses) && Number(status.buttonPresses) >= 0) {
        const buttons = {boot: status.boot!, presses: Number(status.buttonPresses)};
        const pressed = buttonPressed(this.#buttons, buttons);
        this.#buttons = buttons;
        if (pressed) this.#button(buttons.presses);
      }
      this.#endpoint = endpoint;
      this.#boot = status.boot!;
      this.#protocol = protocol;
      if (needsSync) {
        this.#iconSignature = '';
        this.#activeSignature = '';
        this.#usageSignature = null;
      }
      if (this.#enabled && needsSync) await this.#sendState(this.#desired);
      else this.#setConnection(true, endpoint);
      if (previousOffset !== this.#orientation?.offsetDegrees) this.#changed();
      return true;
    } catch {
      return false;
    }
  }

  async installCharacter(pack: Buffer, progress: InstallProgress = () => undefined): Promise<string> {
    return parseUploadResponse(await this.#upload('/character', pack, {}, progress));
  }

  async speak(packet: Buffer): Promise<void> {
    if (!this.#config || !this.#endpoint || !this.#connected)
      throw new Error('Speech needs the Agent Companion to be reachable over Wi-Fi.');
    if (this.#protocol < speechProtocol)
      throw new Error('Update the device firmware before using speech.');
    const endpoint = new URL(`${this.#endpoint}/speech`);
    const token = this.#config.token;
    const response = await new Promise<{status: number; body: string}>((resolve, reject) => {
      const request = httpRequest(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/vnd.agent-companion.pcm',
          'Content-Length': packet.length,
        },
      }, result => {
        let body = '';
        result.setEncoding('utf8');
        result.on('data', chunk => {
          if (body.length < 4096) body += chunk.slice(0, 4096 - body.length);
        });
        result.on('end', () => resolve({status: result.statusCode ?? 0, body}));
        result.on('error', reject);
      });
      request.setTimeout(uploadIdleTimeoutMs, () =>
        request.destroy(new Error('Wi-Fi speech upload timed out.')));
      request.on('error', reject);
      void (async () => {
        for (let sent = 0; sent < packet.length; sent += uploadChunkBytes) {
          const chunk = packet.subarray(sent, sent + uploadChunkBytes);
          if (!request.write(chunk))
            await new Promise(drained => request.once('drain', drained));
        }
        request.end();
      })().catch(reject);
    });
    parseSpeechResponse(response.status, response.body);
  }

  async setOrientationOffset(offsetDegrees: number): Promise<DeviceOrientation> {
    if (!isOrientationOffset(offsetDegrees))
      throw new Error('Orientation offset must be from -15 to 15 degrees in half-degree steps.');
    const operation = this.#commands.then(async () => {
      if (!this.#connected || !this.#config || !this.#endpoint)
        throw new Error('Connect the Agent Companion first.');
      if (this.#protocol < orientationProtocol || !this.#orientation)
        throw new Error('Update the device firmware to adjust orientation.');
      if (this.#installing) throw new Error('Wait for the current installation to finish.');
      const response = await this.#postBadge('/orientation', String(Math.round(offsetDegrees * 10)));
      const body = await response.json() as {orientationOffsetTenths?: unknown};
      const orientation = orientationFromTenths(body.orientationOffsetTenths);
      if (orientation.offsetDegrees !== offsetDegrees)
        throw new Error('The device did not apply the requested orientation offset.');
      this.#orientation = orientation;
      this.#changed();
      return orientation;
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // Sends a firmware image (the app .bin). The device checks the MD5, restarts into it, and goes
  // back to the old firmware if the new one cannot reach Wi-Fi.
  async installFirmware(image: Buffer, md5: string, progress: InstallProgress = () => undefined,
                        waitingForButton: () => void = () => undefined): Promise<void> {
    if (needsFirmwareApproval(this.#protocol)) {
      if (!this.#config || !this.#endpoint || !this.#connected)
        throw new Error('The Agent Companion is not reachable over Wi-Fi.');
      // Keeps the background scan from changing the endpoint during the wait.
      this.#installing = true;
      try {
        await this.#requestFirmwareApproval(this.#endpoint, this.#config.token);
        waitingForButton();
        await waitForFirmwareApproval(() => this.#firmwareApproval(this.#endpoint!, this.#config!.token));
      } finally {
        this.#installing = false;
      }
    }
    const body = await this.#upload('/firmware', image, {'X-Firmware-MD5': md5}, progress);
    let result: {ok?: unknown; error?: unknown};
    try {
      result = JSON.parse(body) as typeof result;
    } catch {
      throw new Error('The device sent an invalid reply to the firmware update.');
    }
    if (result.ok !== true)
      throw new Error(typeof result.error === 'string' ? result.error : 'The device did not accept the firmware.');
  }

  async #requestFirmwareApproval(endpoint: string, token: string): Promise<void> {
    const response = await fetch(`${endpoint}/firmware/approval`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`The device did not start the firmware update: ${await response.text()}`);
  }

  async #firmwareApproval(endpoint: string, token: string): Promise<FirmwareApproval | null> {
    const response = await fetch(`${endpoint}/status`, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const approval = (await response.json() as {firmwareApproval?: unknown}).firmwareApproval;
    return approval === 'none' || approval === 'waiting' || approval === 'allowed' ? approval : null;
  }

  async #upload(path: '/character' | '/firmware', data: Buffer, headers: Record<string, string>,
                progress: InstallProgress): Promise<string> {
    if (!this.#config || !this.#endpoint || !this.#connected)
      throw new Error('The Agent Companion is not reachable over Wi-Fi.');
    const endpoint = new URL(`${this.#endpoint}${path}`);
    const token = this.#config.token;
    const what = path === '/firmware' ? 'firmware' : 'character';
    this.#installing = true;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
            ...headers,
          },
        }, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { text += chunk; });
          response.on('end', () => resolve(text));
          response.on('error', reject);
        });
        request.setTimeout(uploadIdleTimeoutMs, () =>
          request.destroy(new Error(`Wi-Fi ${what} upload timed out.`)));
        request.on('error', reject);
        void (async () => {
          for (let sent = 0; sent < data.length; sent += uploadChunkBytes) {
            const chunk = data.subarray(sent, sent + uploadChunkBytes);
            if (!request.write(chunk))
              await new Promise(drained => request.once('drain', drained));
            progress(sent + chunk.length, data.length);
          }
          request.end();
        })().catch(reject);
      });
      // The device restarts after an upload; the scan finds it again.
      this.#setConnection(false, null);
      return body;
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

  setUsage(lines: readonly string[]): void {
    const signature = lines.join('|');
    if (this.#installing || !this.#enabled || !this.#config || !this.#endpoint
        || !shouldSendUsage(this.#protocol) || signature === this.#usageSignature) return;
    this.#commands = this.#commands
      .then(async () => {
        if (!this.#config || !this.#endpoint || !shouldSendUsage(this.#protocol)
            || signature === this.#usageSignature) return;
        await this.#postBadge('/usage', usagePacket(signature ? signature.split('|') : []));
        this.#usageSignature = signature;
      })
      .catch(error => {
        console.error(`[wifi] ${this.#message(error)}`);
        this.#setConnection(false, null);
      });
  }

  async #postBadge(path: '/icon' | '/agents' | '/usage' | '/orientation', body: string): Promise<Response> {
    if (!this.#config || !this.#endpoint) throw new Error('The Wi-Fi device is not connected.');
    const response = await fetch(`${this.#endpoint}${path}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.#config.token}`, 'Content-Type': 'text/plain; charset=utf-8'},
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Device rejected ${path === '/orientation'
      ? 'orientation settings' : 'badge packet'}: ${await response.text()}`);
    return response;
  }

  #setConnection(connected: boolean, endpoint: string | null): void {
    const changed = connected !== this.#connected || endpoint !== this.#endpoint;
    this.#connected = connected;
    this.#endpoint = endpoint;
    if (!connected) this.#boot = null;
    // Presses made while the device could not be reached are old news when it comes back.
    if (!connected) this.#buttons = null;
    if (!connected) {
      this.#protocol = 0;
      this.#iconSignature = '';
      this.#activeSignature = '';
      this.#usageSignature = null;
    }
    if (changed) this.#changed();
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

interface ButtonCount {
  boot: number;
  presses: number;
}

// The first status after a connection only sets the baseline; a restart sets the count back to 0.
export function buttonPressed(previous: ButtonCount | null, current: ButtonCount): boolean {
  return previous !== null && previous.boot === current.boot && current.presses > previous.presses;
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

export function parseSpeechResponse(status: number, body: string): void {
  let result: {ok?: unknown; error?: unknown};
  try {
    result = JSON.parse(body) as typeof result;
  } catch {
    throw new Error(`The device returned an invalid speech response (${status}).`);
  }
  if (status !== 202 || result.ok !== true)
    throw new Error(typeof result.error === 'string'
      ? result.error : `The device rejected speech (${status}).`);
}

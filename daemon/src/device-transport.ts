import type {CharacterState, InstallProgress} from './protocol.js';
import {UsbTransport} from './usb-transport.js';
import {WifiTransport} from './wifi-transport.js';
import type {WifiConfig} from './wifi-config.js';
import type {ConnectionMode} from './connection-mode.js';
import type {AgentBadgeActive, AgentBadgeIconDefinition} from './agent-badges.js';

export interface CharacterInstallResult {
  character: string;
  transport: 'usb' | 'wifi';
}

export class DeviceTransport {
  #desired: CharacterState = 'idle';
  #badgeIcons: readonly AgentBadgeIconDefinition[] = [];
  #activeBadges: readonly AgentBadgeActive[] = [];
  #installing = false;
  #mode: ConnectionMode = 'auto';
  readonly #missing: () => void;
  readonly #usb = new UsbTransport(() => this.#route());
  readonly #wifi = new WifiTransport(() => this.#route());

  // missingCharacter runs whenever a connected device reports that no pack is installed.
  constructor(missingCharacter: () => void = () => undefined) {
    this.#missing = missingCharacter;
  }

  get state(): CharacterState {
    return this.#desired;
  }

  get connected(): boolean {
    return this.#usb.connected || this.#wifi.connected;
  }

  get transport(): 'usb' | 'wifi' | null {
    return this.#usb.connected ? 'usb' : this.#wifi.connected ? 'wifi' : null;
  }

  get address(): string | null {
    return this.#usb.connected ? this.#usb.path : this.#wifi.endpoint;
  }

  get character(): string | null {
    return this.#usb.connected ? this.#usb.character : this.#wifi.character;
  }

  get adaptivePatchRam(): boolean {
    return this.#usb.connected ? this.#usb.adaptivePatchRam : this.#wifi.adaptivePatchRam;
  }

  get installing(): boolean {
    return this.#installing;
  }

  get mode(): ConnectionMode {
    return this.#mode;
  }

  async start(mode: ConnectionMode = 'auto'): Promise<void> {
    await this.setMode(mode);
  }

  async setMode(mode: ConnectionMode): Promise<void> {
    if (this.#installing) throw new Error('Wait for the character installation to finish.');
    this.#mode = mode;
    if (mode === 'usb') this.#wifi.stop();
    else await this.#wifi.start();
    await this.#usb.setEnabled(mode !== 'wifi');
    this.#route();
  }

  async stop(): Promise<void> {
    this.#wifi.stop();
    await this.#usb.stop();
  }

  setState(state: CharacterState): void {
    this.#desired = state;
    this.#route();
  }

  setAgentBadges(icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[]): void {
    this.#badgeIcons = icons;
    this.#activeBadges = active;
    this.#route();
  }

  async reloadWifi(): Promise<void> {
    await this.#wifi.reload();
    this.#route();
  }

  configureWifi(ssid: string, password: string): Promise<WifiConfig> {
    return this.#usb.configureWifi(ssid, password);
  }

  // USB is preferred; the device restarts after every attempt and reconnects automatically.
  async installCharacter(pack: Buffer, progress?: InstallProgress): Promise<CharacterInstallResult> {
    if (this.#installing) throw new Error('A character installation is already in progress.');
    const transport = this.transport;
    if (!transport) throw new Error('Connect the Agent Companion over USB or Wi-Fi first.');
    this.#installing = true;
    try {
      const character = transport === 'usb'
        ? await this.#usb.installCharacter(pack, progress)
        : await this.#wifi.installCharacter(pack, progress);
      return {character, transport};
    } finally {
      this.#installing = false;
    }
  }

  #route(): void {
    if (this.#installing) return;
    if (this.#usb.connected) {
      this.#wifi.setEnabled(false);
      this.#usb.setState(this.#desired);
      this.#usb.setAgentBadges(this.#badgeIcons, this.#activeBadges);
    } else {
      this.#wifi.setEnabled(true);
      this.#wifi.setState(this.#desired);
      this.#wifi.setAgentBadges(this.#badgeIcons, this.#activeBadges);
    }
    if (this.connected && this.character === 'none') this.#missing();
  }
}

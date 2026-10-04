import type {CharacterState, DeviceNetwork, InstallProgress, WifiNetwork} from './protocol.js';
import {UsbTransport, type UsbPort} from './usb-transport.js';
import {WifiTransport} from './wifi-transport.js';
import type {WifiConfig} from './wifi-config.js';
import type {ConnectionMode} from './connection-mode.js';
import type {AgentBadgeActive, AgentBadgeIconDefinition} from './agent-badges.js';

export interface CharacterInstallResult {
  character: string;
  transport: 'usb' | 'wifi';
}

// USB reports a press at once and Wi-Fi a little later, with the same count.
const samePressWithinMs = 10_000;

export class DeviceTransport {
  #desired: CharacterState = 'idle';
  #badgeIcons: readonly AgentBadgeIconDefinition[] = [];
  #activeBadges: readonly AgentBadgeActive[] = [];
  #usage: readonly string[] = [];
  #installing = false;
  #mode: ConnectionMode = 'auto';
  #lastPress: {presses: number; at: number} | null = null;
  readonly #missing: () => void;
  readonly #button: () => void;
  readonly #usb = new UsbTransport(() => this.#route(), presses => this.#pressed(presses));
  readonly #wifi = new WifiTransport(() => this.#route(), presses => this.#pressed(presses));

  // missingCharacter runs whenever a connected device reports that no pack is installed.
  // buttonPressed runs one time for each press of the device's BOOT button.
  constructor(missingCharacter: () => void = () => undefined, buttonPressed: () => void = () => undefined) {
    this.#missing = missingCharacter;
    this.#button = buttonPressed;
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

  get firmware(): string | null {
    return (this.#usb.connected ? this.#usb.firmware : null) ?? this.#wifi.firmware;
  }

  // Firmware updates go over Wi-Fi, to protocol 9 or later firmware, which reports its ID there.
  get firmwareOverWifi(): boolean {
    return this.#wifi.connected && this.#wifi.firmware !== null;
  }

  get adaptivePatchRam(): boolean {
    return this.#usb.connected ? this.#usb.adaptivePatchRam : this.#wifi.adaptivePatchRam;
  }

  // Wi-Fi discovery keeps checking in the background, so it's the live answer when it can reach the device.
  get network(): DeviceNetwork | null {
    return this.#wifi.network ?? this.#usb.network;
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
    if (this.#installing) throw new Error('Wait for the installation to finish.');
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

  // The lines shown at the bottom of the screen; none hides them.
  setUsage(lines: readonly string[]): void {
    this.#usage = lines;
    this.#route();
  }

  async reloadWifi(): Promise<void> {
    await this.#wifi.reload();
    this.#route();
  }

  configureWifi(ssid: string, password: string): Promise<WifiConfig> {
    return this.#usb.configureWifi(ssid, password);
  }

  scanWifi(): Promise<WifiNetwork[]> {
    return this.#usb.scanWifi();
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

  async installFirmware(image: Buffer, md5: string, progress?: InstallProgress,
                        waitingForButton?: () => void): Promise<void> {
    if (this.#installing) throw new Error('Wait for the current installation to finish.');
    if (!this.firmwareOverWifi)
      throw new Error('Firmware updates need the device on Wi-Fi with firmware protocol 9 or later. '
        + 'Over USB, run: bash tools/arduino.sh upload-code');
    this.#installing = true;
    // The device stops reading USB during the upload. USB commands would time out, and the port
    // would be opened again, which can reset the device in the middle of the update.
    const usb = this.#mode !== 'wifi';
    try {
      if (usb) await this.#usb.setEnabled(false);
      await this.#wifi.installFirmware(image, md5, progress, waitingForButton);
    } finally {
      if (usb) await this.#usb.setEnabled(true);
      this.#installing = false;
      this.#route();
    }
  }

  // An ESP32 on USB that does not answer as an Agent Companion: a new board, or other firmware.
  get usbUnanswered(): UsbPort | null {
    return this.#mode === 'wifi' ? null : this.#usb.unanswered;
  }

  findUsbPort(): Promise<UsbPort | null> {
    return this.#usb.findPort();
  }

  // Closes the USB port while `run` uses it (to install firmware), then opens it again.
  async withUsbReleased<T>(run: () => Promise<T>): Promise<T> {
    if (this.#installing) throw new Error('Wait for the current installation to finish.');
    this.#installing = true;
    try {
      await this.#usb.setEnabled(false);
      return await run();
    } finally {
      await this.#usb.setEnabled(this.#mode !== 'wifi');
      this.#installing = false;
      this.#route();
    }
  }

  #pressed(presses: number): void {
    const now = Date.now();
    if (this.#lastPress?.presses === presses && now - this.#lastPress.at < samePressWithinMs) return;
    this.#lastPress = {presses, at: now};
    console.log(`[device] BOOT button pressed (${presses} since the device started)`);
    this.#button();
  }

  #route(): void {
    if (this.#installing) return;
    if (this.#usb.connected) {
      this.#wifi.setEnabled(false);
      this.#usb.setState(this.#desired);
      this.#usb.setAgentBadges(this.#badgeIcons, this.#activeBadges);
      this.#usb.setUsage(this.#usage);
    } else {
      this.#wifi.setEnabled(true);
      this.#wifi.setState(this.#desired);
      this.#wifi.setAgentBadges(this.#badgeIcons, this.#activeBadges);
      this.#wifi.setUsage(this.#usage);
    }
    if (this.connected && this.character === 'none') this.#missing();
  }
}

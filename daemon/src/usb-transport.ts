import {SerialPort, type SerialPortMock} from 'serialport';
import {
  orientationPacket, orientationProtocol, parseOrientationLine, type DeviceOrientation,
} from './orientation-settings.js';
import {
  deviceNetwork,
  parseWifiNetworkLine,
  uniqueWifiNetworks,
  type CharacterState,
  type DeviceNetwork,
  type InstallProgress,
  type WifiNetwork,
} from './protocol.js';
import {
  activePacket,
  iconPacket,
  shouldSendBadges,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
} from './agent-badges.js';
import {shouldSendUsage, usagePacket} from './usage-tracker.js';
import {parseBoardLine} from './firmware-release.js';
import {
  parseWifiProvisioningResponse,
  wifiProvisioningPacket,
  type WifiConfig,
} from './wifi-config.js';

const networkRefreshMs = 5000;
// The newest firmware protocol this daemon knows; see kDeviceProtocol in DeviceCommands.h.
const maxProtocol = 12;
// Requests in a row without an answer before the port counts as dead. A device that restarts
// can leave the old port open but silent; closing it lets discovery or Wi-Fi take over.
const deadLinkTimeouts = 3;

// serialport's SerialPortMock in tests.
export type SerialPortClass = typeof SerialPort | typeof SerialPortMock;

export interface UsbTransportOptions {
  serial?: SerialPortClass;
  requestTimeoutMs?: number;
  // How often a connection to another device than the chosen one looks for the chosen device.
  chosenCheckMs?: number;
}

class AcknowledgementTimeout extends Error {
  constructor() {
    super('Timed out waiting for device acknowledgement.');
  }
}

interface LineWaiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class UsbTransport {
  readonly #preferredPort = process.env.AGENT_COMPANION_PORT;
  #selectedPort: string | null = null;
  #selectedSerial: string | null = null;
  #port: SerialPort | SerialPortMock | undefined;
  #path: string | null = null;
  // True once the open port answered INFO. An open port that does not answer is not a connection.
  #answered = false;
  #desired: CharacterState = 'idle';
  #scanTimer: NodeJS.Timeout | undefined;
  #networkTimer: NodeJS.Timeout | undefined;
  #scanActive = false;
  // Why the last attempt to reach the device on its port failed, or null.
  #lastError: string | null = null;
  #networkRefreshActive = false;
  #buffer = '';
  #waiters: LineWaiter[] = [];
  #commands = Promise.resolve();
  #protocol = 0;
  #iconSignature = '';
  #activeSignature = '';
  // What the device shows now; null until it is sent after a connect or restart.
  #usageSignature: string | null = null;
  #enabled = true;
  #character: string | null = null;
  #adaptivePatchRam = false;
  #firmware: string | null = null;
  // The board the firmware is built for, from the BOARD line after INFO; null until it arrives.
  // Firmware without the line can't say: firmware from before boards, and LCD-1.54 builds from
  // before the line, so the person chooses the board before a firmware install.
  #board: string | null = null;
  // The hardware variant on the BOARD line (for example the 1.75's standard or c); null without one.
  #variant: string | null = null;
  #network: DeviceNetwork | null = null;
  #orientation: DeviceOrientation | null = null;
  // The ESP32 port the last scan chose (the connected device's port once it answers), and how many
  // handshakes in a row it failed.
  #seen: UsbPort | null = null;
  #failures = 0;
  // The device the person chose when several Agent Buddy devices answered on USB.
  #chosen: UsbDeviceChoice | null = null;
  // Agent Buddy devices that answered in the last check when using one of them would be a guess, so
  // nothing connects: the person chooses one.
  #choices: UsbDeviceSummary[] = [];
  // Agent Buddy devices that did not answer in the last check: the chosen device, or one that
  // answered before (busy for a moment, for example while it installs a character over Wi-Fi).
  #waiting: UsbPort[] = [];
  // Other Espressif ports that did not answer in the last check of several ports.
  #silent: UsbPort[] = [];
  // Devices (see deviceKey) that answered as an Agent Buddy since the service started.
  readonly #answeredDevices = new Set<string>();
  // Each stop() ends the scans that run then: they connect nothing after it.
  #runs = 0;
  #nextChosenCheck = 0;
  // A switch to the chosen device waits in the command queue (see #checkChosen).
  #switchPending = false;
  readonly #chosenCheckMs: number;
  #timeouts = 0;
  readonly #serial: SerialPortClass;
  readonly #requestTimeoutMs: number;
  readonly #changed: () => void;
  readonly #button: (presses: number) => void;

  // `button` runs when the device's BOOT button is pressed, with the count since the device started.
  constructor(changed: () => void = () => undefined, button: (presses: number) => void = () => undefined,
              options: UsbTransportOptions = {}) {
    this.#changed = changed;
    this.#button = button;
    this.#serial = options.serial ?? SerialPort;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.#chosenCheckMs = options.chosenCheckMs ?? 10_000;
  }

  get character(): string | null {
    return this.connected ? this.#character : null;
  }

  // Firmware that reports patch_ram=adaptive keeps enough internal RAM free for Wi-Fi with any pack.
  // The first 16 hex digits of the firmware's ELF SHA-256; null before protocol 9.
  get firmware(): string | null {
    return this.connected ? this.#firmware : null;
  }

  get board(): string | null {
    return this.connected ? this.#board : null;
  }

  get variant(): string | null {
    return this.connected ? this.#variant : null;
  }

  // The connected device's USB serial number; the ESP32-S3 uses its MAC address.
  get serialNumber(): string | null {
    return this.connected ? this.#seen?.serialNumber ?? null : null;
  }

  get protocol(): number | null {
    return this.connected ? this.#protocol : null;
  }

  // Agent Buddy devices to choose from, because using one of them would be a guess.
  get choices(): UsbDeviceSummary[] {
    return this.connected ? [] : this.#choices;
  }

  // Agent Buddy devices on USB that do not answer now: the chosen one, or one that answered before.
  get waiting(): UsbPort[] {
    return this.connected ? [] : this.#waiting;
  }

  // Other Espressif ports that did not answer in the last check of several ports.
  get silentPorts(): UsbPort[] {
    return this.connected ? [] : this.#silent;
  }

  // The person's choice among the devices that answer. A scan uses it now and whenever several answer.
  async chooseDevice(choice: UsbDeviceChoice): Promise<void> {
    this.#chosen = choice;
    this.#choices = [];
    this.#waiting = [];
    this.#changed();
    await this.scanNow();
  }

  // The saved choice, before the transport starts.
  setChosenDevice(choice: UsbDeviceChoice | null): void {
    this.#chosen = choice;
  }

  get adaptivePatchRam(): boolean {
    return this.connected && this.#adaptivePatchRam;
  }

  get network(): DeviceNetwork | null {
    return this.connected ? this.#network : null;
  }

  get orientation(): DeviceOrientation | null {
    return this.connected ? this.#orientation : null;
  }

  get connected(): boolean {
    return this.#answered && this.#port?.isOpen === true;
  }

  get path(): string | null {
    return this.#path;
  }

  // An ESP32 port that is there but does not answer: a new board, or other firmware.
  get unanswered(): UsbPort | null {
    return !this.connected && this.#failures >= 2 ? this.#seen : null;
  }

  // The port to install firmware on: the connected device's, else the first ESP32 port found now.
  async ports(): Promise<UsbPort[]> {
    return candidatePorts(await this.#serial.list(), this.#preferredPort);
  }

  async selectPort(path: string | null, allowMissing = false): Promise<void> {
    const port = path && !allowMissing ? (await this.ports()).find(port => port.path === path) : null;
    if (path && !port && !allowMissing)
      throw new Error('The selected USB device is no longer connected. Detect the device again.');
    this.#selectedPort = path;
    this.#selectedSerial = port?.serialNumber ?? null;
    if (path && ((this.connected && this.#path !== path) || this.#scanActive)) {
      const enabled = this.#enabled;
      await this.setEnabled(false);
      if (enabled) await this.setEnabled(true);
    }
  }

  matches(port: UsbPort): boolean {
    return this.connected && (port.serialNumber
      ? port.serialNumber === this.#seen?.serialNumber : this.#path === port.path);
  }

  async findPort(selected?: string | null): Promise<UsbPort | null> {
    const ports = await this.ports();
    if (selected) {
      const port = ports.find(port => port.path === selected);
      if (!port) throw new Error('The selected USB device is no longer connected. Detect the device again.');
      return port;
    }
    if (this.connected && this.#path) return {path: this.#path, pid: this.#seen?.path === this.#path ? this.#seen.pid : null};
    if (ports.length > 1) throw new Error('Several USB devices were found. Select the device to install.');
    return ports[0] ?? null;
  }

  get state(): CharacterState {
    return this.#desired;
  }

  start(): void {
    if (!this.#enabled || this.#scanTimer) return;
    void this.#scan();
    this.#scanTimer = setInterval(() => void this.#scan(), 2000);
    this.#networkTimer = setInterval(() => this.#refreshNetwork(), networkRefreshMs);
  }

  async stop(): Promise<void> {
    this.#runs++;
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    if (this.#networkTimer) clearInterval(this.#networkTimer);
    this.#scanTimer = undefined;
    this.#networkTimer = undefined;
    this.#rejectWaiters(new Error('USB transport stopped.'));
    const port = this.#port;
    this.#port = undefined;
    this.#path = null;
    this.#answered = false;
    this.#orientation = null;
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

  setUsage(lines: readonly string[]): void {
    const signature = lines.join('|');
    if (!shouldSendUsage(this.#protocol) || signature === this.#usageSignature) return;
    this.#commands = this.#commands
      .then(() => this.#sendUsage(signature))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  // Disabling releases the serial port so a cable can provide power only.
  async setEnabled(enabled: boolean): Promise<void> {
    this.#enabled = enabled;
    if (enabled) {
      this.start();
      return;
    }
    await this.stop();
    // A scan that was opening the port when this stopped closes it again (see #open).
    for (let waited = 0; this.#scanActive && waited < 15_000; waited += 50)
      await new Promise(resolve => setTimeout(resolve, 50));
    this.#failures = 0;
  }

  // Looks for the device now, instead of at the next scan, and says why it is not reached.
  async scanNow(): Promise<{ports: UsbPort[]; error: string | null}> {
    for (let waited = 0; this.#scanActive && waited < 15_000; waited += 50)
      await new Promise(resolve => setTimeout(resolve, 50));
    if (this.#enabled && !this.connected) await this.#scan();
    return {ports: await this.ports(), error: this.connected ? null : this.#lastError};
  }

  async #scan(): Promise<void> {
    if (!this.#enabled || this.#scanActive) return;
    // While connected, only a chosen device that is not the connected one needs a look.
    if (this.connected && !this.#chosenCheckDue()) return;
    this.#scanActive = true;
    const run = this.#runs;
    const before = this.#scanSignature();
    try {
      const ports = await this.#serial.list();
      if (this.connected) {
        await this.#checkChosen(espressifPorts(ports), run);
        return;
      }
      const candidates = candidatePorts(ports, this.#preferredPort);
      const espressif = espressifPorts(ports);
      const preferred = this.#preferredPort ? normalizedPortPath(this.#preferredPort) : null;
      if (this.#selectedPort) {
        // Setup or an install selected this device: use only it.
        const candidate = selectedUsbCandidate(candidates, this.#selectedPort, this.#selectedSerial);
        if (candidate && !this.#selectedSerial && this.#selectedPort === candidate.path)
          this.#selectedSerial = candidate.serialNumber ?? null;
        this.#clearChoices();
        await this.#tryPort(candidate, run);
      } else if (preferred) {
        // AGENT_COMPANION_PORT names the only port to use.
        this.#clearChoices();
        await this.#tryPort(candidates.find(port => port.path === preferred) ?? null, run);
      } else if (espressif.length < 2) {
        // One device to try: the only ESP32 port.
        this.#clearChoices();
        await this.#tryPort(pickPort(ports), run);
      } else {
        await this.#checkEach(espressif, run);
      }
    } catch (error) {
      this.#lastError = this.#message(error);
      console.error(`[usb] discovery failed: ${this.#message(error)}`);
    } finally {
      this.#scanActive = false;
      if (this.#scanSignature() !== before) this.#changed();
    }
  }

  #clearChoices(): void {
    this.#choices = [];
    this.#waiting = [];
    this.#silent = [];
  }

  // Opens the device on `candidate` as the connection. A failure counts toward `unanswered`.
  async #tryPort(candidate: UsbPort | null, run: number): Promise<void> {
    if (candidate?.path !== this.#seen?.path) this.#failures = 0;
    this.#seen = candidate;
    if (!candidate) {
      this.#lastError = null;
      return;
    }
    try {
      await this.#open(candidate.path, run);
      if (this.connected) this.#answeredDevices.add(deviceKey(candidate));
      this.#failures = 0;
      this.#lastError = null;
    } catch (error) {
      if (this.#enabled && run === this.#runs) this.#failures++;
      throw error;
    }
  }

  // Several Espressif ports: asks each device what it is. The chosen device, or one that answered
  // before, is still an Agent Buddy while it is busy for a moment, so it counts also when it is silent.
  // Uses the chosen device when it is there and answers, else the only Agent Buddy device. Anything
  // else would be a guess: nothing connects, and the person chooses (see choices and waiting).
  async #checkEach(ports: readonly UsbPort[], run: number): Promise<void> {
    const answered: UsbDeviceSummary[] = [];
    const silent: UsbPort[] = [];
    let lastError: string | null = null;
    for (const port of ports) {
      if (!this.#enabled || run !== this.#runs) return;
      try {
        answered.push({...port, ...await this.#probe(port.path)});
      } catch (error) {
        silent.push(port);
        lastError = `${port.path}: ${this.#message(error)}`;
      }
    }
    if (!this.#enabled || run !== this.#runs) return;
    for (const device of answered) this.#answeredDevices.add(deviceKey(device));
    const chosen = ports.find(port => this.#isChosen(port)) ?? null;
    const waiting = silent.filter(port => port === chosen || this.#answeredDevices.has(deviceKey(port)));
    const target = chosen ? answered.find(device => device.path === chosen.path) ?? null
      : answered.length === 1 && waiting.length === 0 ? answered[0]! : null;
    this.#silent = silent.filter(port => !waiting.includes(port));
    this.#waiting = target ? [] : waiting;
    if (target) {
      this.#choices = [];
      await this.#tryPort(plainPort(target), run);
      return;
    }
    if (answered.length > 0) {
      this.#choices = answered;
      this.#seen = null;
      this.#failures = 0;
      this.#lastError = waiting.length
        ? `An Agent Buddy device does not answer now on ${waiting.map(port => port.path).join(', ')}. `
          + 'Choose the device to use in Settings.'
        : 'Several Agent Buddy devices answer on USB. Choose the one to use in Settings.';
      return;
    }
    // None answered: the round counts against the first port, as one port's handshake does.
    this.#choices = [];
    const first = silent[0] ?? null;
    if (first?.path !== this.#seen?.path) this.#failures = 0;
    this.#seen = first;
    this.#failures++;
    this.#lastError = lastError;
  }

  // Connected to another device than the chosen one, on a port that no selection (setup or an
  // install) and no AGENT_COMPANION_PORT fixes, with no switch waiting: time to look for the chosen one.
  #chosenCheckDue(): boolean {
    return this.#chosen !== null && !this.#selectedPort && !this.#preferredPort && !this.#switchPending
      && !this.#isChosen(this.#seen) && Date.now() >= this.#nextChosenCheck;
  }

  // Connected to another device than the chosen one, which was not there or not answering then:
  // when the chosen device answers, switch to it, because the person chose it. The switch waits for
  // the command that runs on the connected device, such as a character upload, to finish.
  async #checkChosen(ports: readonly UsbPort[], run: number): Promise<void> {
    this.#nextChosenCheck = Date.now() + this.#chosenCheckMs;
    const chosen = ports.find(port => this.#isChosen(port) && port.path !== this.#path);
    if (!chosen) return;
    try {
      await this.#probe(chosen.path);
    } catch {
      return;
    }
    const port = this.#port;
    if (run !== this.#runs || !this.connected || !port) return;
    this.#answeredDevices.add(deviceKey(chosen));
    this.#switchPending = true;
    this.#commands = this.#commands.then(async () => {
      if (run !== this.#runs || this.#port !== port || !port.isOpen) return;
      console.log(`[usb] the chosen device answers on ${chosen.path}; switching to it from ${this.#path}`);
      await new Promise<void>(resolve => port.close(() => resolve()));
    }).catch(error => console.error(`[usb] ${this.#message(error)}`))
      .finally(() => { this.#switchPending = false; });
  }

  #isChosen(port: UsbPort | null): boolean {
    const chosen = this.#chosen;
    if (!chosen || !port) return false;
    return chosen.serialNumber ? port.serialNumber === chosen.serialNumber : port.path === chosen.path;
  }

  // Asks the device on `path` what it is, without connecting, then closes the port. Throws when it
  // does not answer as an Agent Buddy.
  async #probe(path: string): Promise<Omit<UsbDeviceSummary, keyof UsbPort>> {
    const port = new this.#serial({path, baudRate: 115200, autoOpen: false, hupcl: false});
    port.on('error', error => console.error(`[usb] ${path}: ${error.message}`));
    await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
    try {
      const {info, board} = await new Promise<{info: string; board: string | null}>((resolve, reject) => {
        let buffer = '';
        let info: string | null = null;
        let settle: NodeJS.Timeout | undefined;
        const finish = (result: {info: string; board: string | null} | Error) => {
          clearTimeout(timer);
          clearTimeout(settle);
          port.off('data', onData);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (data: Buffer) => {
          buffer += data.toString('utf8');
          if (buffer.length > 65536) return finish(new Error('The device sent an oversized response.'));
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.startsWith('INFO protocol=')) {
              info = line;
              // Firmware from before the BOARD line sends none after INFO.
              settle = setTimeout(() => finish({info: line, board: null}), 250);
            } else if (info !== null && parseBoardLine(line) !== null) {
              return finish({info, board: line});
            }
          }
        };
        const timer = setTimeout(() => finish(new AcknowledgementTimeout()), this.#requestTimeoutMs);
        port.on('data', onData);
        port.write('i', error => { if (error) finish(error); });
      });
      return deviceSummary(info, board);
    } finally {
      await new Promise<void>(resolve => port.isOpen ? port.close(() => resolve()) : resolve());
    }
  }

  #scanSignature(): string {
    return JSON.stringify([this.unanswered, this.#choices, this.#waiting, this.#silent]);
  }

  async #open(path: string, run: number): Promise<void> {
    const port = new this.#serial({
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
        const wasConnected = this.#answered;
        this.#port = undefined;
        this.#path = null;
        this.#answered = false;
        if (wasConnected) this.#changed();
      }
    });
    await new Promise<void>((resolve, reject) => {
      port.open(error => error ? reject(error) : resolve());
    });
    if (!this.#enabled || run !== this.#runs) {
      await new Promise<void>(resolve => port.close(() => resolve()));
      return;
    }
    this.#port = port;
    this.#path = path;
    this.#timeouts = 0;
    // The BOARD line, when the firmware sends one, follows the INFO reply below.
    this.#board = null;
    this.#variant = null;
    try {
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      this.#applyInfo(info);
      await this.#readOrientation();
      this.#iconSignature = '';
      this.#activeSignature = '';
      this.#usageSignature = null;
      this.#answered = true;
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

  async #sendUsage(signature: string): Promise<void> {
    if (!this.connected || !shouldSendUsage(this.#protocol) || signature === this.#usageSignature) return;
    const lines = signature ? signature.split('|') : [];
    await this.#request(usagePacket(lines), line => line === `USAGE accepted=${lines.length}`);
    this.#usageSignature = signature;
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

  async setOrientationOffset(offsetDegrees: number): Promise<DeviceOrientation> {
    const packet = orientationPacket(offsetDegrees);
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error('Connect the Agent Companion first.');
      if (this.#protocol < orientationProtocol)
        throw new Error('Update the device firmware to adjust orientation.');
      const expected = `ORIENTATION_SETTINGS offset_tenths=${Math.round(offsetDegrees * 10)}`;
      const line = await this.#request(packet,
          candidate => candidate === expected || candidate.startsWith('COMMAND_ERROR '));
      if (line.startsWith('COMMAND_ERROR ')) throw new Error(line.slice('COMMAND_ERROR '.length));
      const orientation = parseOrientationLine(line);
      this.#orientation = orientation;
      this.#changed();
      return orientation;
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #readOrientation(): Promise<void> {
    if (this.#protocol < orientationProtocol) {
      this.#orientation = null;
      return;
    }
    const line = await this.#request('o', candidate => candidate.startsWith('ORIENTATION_SETTINGS ')
        || candidate.startsWith('COMMAND_ERROR '));
    if (line.startsWith('COMMAND_ERROR ')) throw new Error(line.slice('COMMAND_ERROR '.length));
    this.#orientation = parseOrientationLine(line);
  }

  // The device scans with its own radio, so the list holds only networks it can actually join.
  scanWifi(): Promise<WifiNetwork[]> {
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error('Connect the Agent Companion over USB to scan for networks.');
      if (this.#protocol < 7)
        throw new Error('Update the device firmware to scan for Wi-Fi networks.');
      const networks: WifiNetwork[] = [];
      const end = await this.#request('w', line => {
        const network = parseWifiNetworkLine(line);
        if (network) networks.push(network);
        return line.startsWith('WIFI_SCAN_END ') || line.startsWith('WIFI_SCAN_ERROR ');
      }, 20000);
      if (end.startsWith('WIFI_SCAN_ERROR '))
        throw new Error(`Device could not scan for networks: ${end.slice('WIFI_SCAN_ERROR '.length)}`);
      return uniqueWifiNetworks(networks);
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #applyInfo(info: string): void {
    const protocol = Number(/^INFO protocol=(\d+)(?: |$)/.exec(info)?.[1]);
    if (!Number.isInteger(protocol) || protocol < 1 || protocol > maxProtocol) {
      throw new Error(`Unsupported device protocol: ${info}`);
    }
    this.#protocol = protocol;
    if (protocol < orientationProtocol) this.#orientation = null;
    this.#adaptivePatchRam = /\bpatch_ram=adaptive\b/.test(info);
    this.#firmware = /\bfirmware=([0-9a-f]{16})\b/.exec(info)?.[1] ?? null;
    this.#network = deviceNetwork(/\bssid_b64=([A-Za-z0-9+/=]*)/.exec(info)?.[1],
                                  /\bwifi_connected=1\b/.test(info));
    this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(info)?.[1] ?? null;
  }

  // A restart can bring new firmware (a Wi-Fi update), so ask again what the device runs.
  #refreshInfo(): void {
    const operation = this.#commands.then(async () => {
      if (!this.connected) return;
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      this.#applyInfo(info);
      await this.#readOrientation();
      console.log(`[usb] ${info}`);
      this.#changed();
    }).catch(error => console.error(`[usb] ${this.#message(error)}`));
    this.#commands = operation;
  }

  // A newly saved network joins in the background, so keep asking until the device reports it joined.
  #refreshNetwork(): void {
    if (!this.connected || this.#networkRefreshActive || this.#protocol < 4
        || (this.#protocol < orientationProtocol && (!this.#network || this.#network.connected))) return;
    this.#networkRefreshActive = true;
    const operation = this.#commands.then(async () => {
      if (!this.connected) return;
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      const previousOrientation = this.#orientation?.offsetDegrees;
      const previousNetwork = this.#network;
      this.#applyInfo(info);
      await this.#readOrientation();
      const network = deviceNetwork(/\bssid_b64=([A-Za-z0-9+/=]*)/.exec(info)?.[1],
                                    /\bwifi_connected=1\b/.test(info));
      if (network?.ssid !== previousNetwork?.ssid || network?.connected !== previousNetwork?.connected
          || previousOrientation !== this.#orientation?.offsetDegrees) {
        this.#network = network;
        this.#changed();
      }
    }).catch(error => console.error(`[usb] ${this.#message(error)}`))
      .finally(() => { this.#networkRefreshActive = false; });
    this.#commands = operation;
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
        const character = /\bcharacter=([a-z0-9-]+)\b/.exec(response)?.[1] ?? 'unknown';
        // The device restarts into the new character. Its boot banner confirms it, but until
        // then the INFO from before the upload would still name the old character.
        this.#character = character;
        this.#changed();
        return character;
      }
    }
    throw new Error('Character pack is empty.');
  }

  async #request(text: string | Buffer, match: (line: string) => boolean,
                 timeoutMs = this.#requestTimeoutMs): Promise<string> {
    const response = this.#waitFor(match, timeoutMs);
    try {
      // Wait for both together: the answer can time out while the write is still pending.
      const [, line] = await Promise.all([this.#write(text), response]);
      this.#timeouts = 0;
      return line;
    } catch (error) {
      this.#rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof AcknowledgementTimeout && ++this.#timeouts >= deadLinkTimeouts) this.#closeDeadPort();
      throw error;
    }
  }

  #closeDeadPort(): void {
    const port = this.#port;
    if (!port?.isOpen) return;
    console.error(`[usb] ${this.#path} stopped answering; closing it`);
    port.close();
  }

  async #write(text: string | Buffer): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen) throw new Error('USB device is not connected.');
    await new Promise<void>((resolve, reject) => {
      // No drain: on macOS, tcdrain blocks a libuv thread for good when the device stops reading,
      // and then the process cannot exit. Every request waits for an answer, which is enough.
      port.write(text, error => error ? reject(error) : resolve());
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
      const board = parseBoardLine(line);
      if (board !== null) {
        const variant = boardVariant(line);
        if (board !== this.#board || variant !== this.#variant) {
          this.#board = board;
          this.#variant = variant;
          if (this.#answered) this.#changed();
        }
        continue;
      }
      const presses = parseButtonLine(line);
      if (presses !== null) {
        this.#button(presses);
        continue;
      }
      const waiter = this.#waiters.find(candidate => candidate.match(line));
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  }

  #rebooted(line: string): void {
    this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(line)?.[1] ?? null;
    // A restart can bring firmware for another board; the INFO reply below names it again.
    this.#board = null;
    this.#variant = null;
    this.#iconSignature = '';
    this.#activeSignature = '';
    this.#usageSignature = null;
    console.log(`[usb] device restarted character=${this.#character ?? 'unknown'}`);
    this.#changed();
    this.#refreshInfo();
  }

  #waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new AcknowledgementTimeout());
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

// The device sends `BUTTON settings presses=N` without a request when its BOOT button is pressed.
export function parseButtonLine(line: string): number | null {
  const match = /^BUTTON settings presses=(\d{1,10})$/.exec(line);
  if (!match) return null;
  const presses = Number(match[1]);
  return presses > 0 && presses <= 0xFFFFFFFF ? presses : null;
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

type PortInfo = Awaited<ReturnType<SerialPortClass['list']>>[number];

export interface UsbPort {
  path: string;
  // The USB product ID; 0x1001 is the ESP32-S3's own USB port.
  pid: number | null;
  serialNumber?: string;
}

// A device on a USB port that answered as an Agent Buddy.
export interface UsbDeviceSummary extends UsbPort {
  board: string | null;
  variant: string | null;
  character: string | null;
  firmware: string | null;
}

// The device the person chose among several that answer: its USB serial number, or its port when
// the system gives no serial number.
export interface UsbDeviceChoice {
  serialNumber: string | null;
  path: string;
}

// One device across scans: its USB serial number, or its port when the system gives none.
export function deviceKey(port: UsbPort): string {
  return port.serialNumber ? `serial:${port.serialNumber}` : `path:${port.path}`;
}

function plainPort(port: UsbPort): UsbPort {
  return {path: port.path, pid: port.pid, ...(port.serialNumber ? {serialNumber: port.serialNumber} : {})};
}

// What a device's INFO reply and BOARD line (null when it sends none) say about it.
export function deviceSummary(info: string, boardLine: string | null): Omit<UsbDeviceSummary, keyof UsbPort> {
  return {
    board: boardLine === null ? null : parseBoardLine(boardLine),
    variant: boardLine === null ? null : boardVariant(boardLine),
    character: /\bcharacter=([a-z0-9-]+)\b/.exec(info)?.[1] ?? null,
    firmware: /\bfirmware=([0-9a-f]{16})\b/.exec(info)?.[1] ?? null,
  };
}

// The variant on a `BOARD id=<board> variant=<variant>` line, or null.
export function boardVariant(line: string): string | null {
  return /^BOARD id=[a-z0-9-]+ (?:\S+ )*variant=([a-z0-9-]{1,32})(?: |$)/.exec(line)?.[1] ?? null;
}

export function selectedUsbCandidate(ports: readonly UsbPort[], path: string, serial: string | null): UsbPort | null {
  if (!serial) return ports.find(port => port.path === path) ?? null;
  const matches = ports.filter(port => port.serialNumber === serial);
  return matches.find(port => port.path === path) ?? (matches.length === 1 ? matches[0]! : null);
}

// macOS lists each USB serial port twice, as /dev/tty.* and /dev/cu.*; the service uses /dev/cu.*.
export function normalizedPortPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? path.replace(/^\/dev\/tty\./, '/dev/cu.') : path;
}

export function candidatePorts(ports: readonly PortInfo[], preferred?: string,
                               platform: NodeJS.Platform = process.platform): UsbPort[] {
  const wanted = preferred === undefined ? undefined : normalizedPortPath(preferred, platform);
  const candidates = ports.filter(port => normalizedPortPath(port.path, platform) === wanted
    || (isLikelyEsp32Port(port.path, platform) && (platform !== 'win32' || Boolean(port.vendorId))));
  const normalized = candidates.map(port => pickPort([port], port.path, platform)!);
  return [...new Map(normalized.map(port => [port.path, port])).values()];
}

// The ports of Espressif USB devices (vendor 303a), such as the ESP32-S3 of every supported board.
export function espressifPorts(ports: readonly PortInfo[], platform: NodeJS.Platform = process.platform): UsbPort[] {
  return candidatePorts(ports.filter(port => port.vendorId?.toLowerCase() === '303a'), undefined, platform);
}

// The preferred port, else an Espressif one, else any port that looks like an ESP32 board.
export function pickPort(ports: readonly PortInfo[], preferred?: string,
                         platform: NodeJS.Platform = process.platform): UsbPort | null {
  const wanted = preferred === undefined ? undefined : normalizedPortPath(preferred, platform);
  const candidate = ports.find(port => normalizedPortPath(port.path, platform) === wanted)
    ?? ports.find(port => port.vendorId?.toLowerCase() === '303a' && isLikelyEsp32Port(port.path, platform))
    // Windows lists Bluetooth links as COM ports too; only a USB port has a vendor ID.
    ?? ports.find(port => isLikelyEsp32Port(port.path, platform) && (platform !== 'win32' || Boolean(port.vendorId)));
  if (!candidate) return null;
  const pid = Number.parseInt(candidate.productId ?? '', 16);
  return {
    path: normalizedPortPath(candidate.path, platform),
    pid: Number.isFinite(pid) ? pid : null,
    ...(candidate.serialNumber ? {serialNumber: candidate.serialNumber} : {}),
  };
}

export function isLikelyEsp32Port(
    path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return /^\/dev\/(?:cu|tty)\.usbmodem/i.test(path);
  if (platform === 'win32') return /^COM\d+$/i.test(path);
  return /^\/dev\/tty(?:ACM|USB)\d+$/i.test(path);
}

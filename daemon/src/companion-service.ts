import {existsSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {homedir, userInfo} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  agentStatuses,
  markAgentSeen,
  defaultAgentContext,
  installAgent,
  isAgentEnabled,
  namespaceAgentPayload,
  removeAllAgentHooks,
  setAgentEnabled,
  setAgentHookRemoved,
  uninstallAgent,
  type AgentContext,
  type AgentId,
  type AgentStatus,
} from './agents/index.js';
import {copilotHome} from './agents/homes.js';
import {
  addCharacterPack,
  isCharacterName,
  listCharacters,
  loadCharacterPreference,
  packNeedsFirmwareUpdate,
  readCharacterPack,
  removeCharacterPack,
  resolveCharacterPack,
  saveCharacterPreference,
  type CharacterEntry,
} from './character-pack.js';
import {CharacterPackBuilder} from './character-build.js';
import {DesktopApp, type DesktopAppReport, type DesktopAppStatus, type DesktopCommand} from './desktop-app.js';
import {openBrowser} from './browser.js';
import {FirmwareReleases, type ReleaseFirmware} from './firmware-release.js';
import {runUsbFlasher, type UsbFlasher, type UsbFlashStage} from './usb-flasher.js';
import {saveConnectionMode, type ConnectionMode} from './connection-mode.js';
import type {DeviceTransport} from './device-transport.js';
import {
  roleName,
  statusIcons,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
  type AgentBadgeStatusIcon,
} from './agent-badges.js';
import {
  loadDisplaySettingsSync, saveDisplaySettings, type DesktopBackdrop, type DisplaySettings,
} from './display-settings.js';
import {defaultDataDirectory, serviceInfo, socketPath, type ServiceInfo} from './paths.js';
import {createUninstallPlan, runUninstall, type UninstallPlan} from './uninstaller.js';
import type {DaemonStatus, HookEvent, HookPayload, InstallProgress, WifiNetwork} from './protocol.js';
import type {StateCoordinator} from './state-coordinator.js';
import {builtFirmwareReader, type FirmwareImage} from './firmware-image.js';
import {deviceUsageLines, UsageTracker, usageLines, type UsageTotals, type UsageWindow} from './usage-tracker.js';
import {loadWifiConfig, saveWifiConfig, validateWifiCredentials} from './wifi-config.js';

export interface InstallState {
  character: string;
  name: string;
  percent: number;
}

export interface InstallResult {
  ok: boolean;
  character: string;
  name: string;
  transport?: 'usb' | 'wifi';
  error?: string;
}

export interface FirmwareStatus {
  // What the device runs and what the last `bash tools/arduino.sh build` made (16 hex digits).
  device: string | null;
  built: string | null;
  // The device can take an update over Wi-Fi now, and the built firmware is different.
  canUpdate: boolean;
  // `button` is true while the device waits for a BOOT press that allows the update.
  updating: {percent: number; button: boolean} | null;
  // `at` is when the upload ended, in ms; the device then restarts.
  last: {ok: boolean; id: string; at: number; error?: string} | null;
  usb: UsbFirmwareStatus;
}

// Installing the release firmware over USB, which the desktop app writes. It works on any ESP32-S3
// board, also one that has no Agent Companion firmware yet.
export interface UsbFirmwareStatus {
  // The release with this service's version, and its firmware ID once it is downloaded.
  release: string | null;
  releaseId: string | null;
  // The desktop app that ran last can write firmware.
  flasher: boolean;
  // The USB port with the device: connected, or an ESP32 that does not answer as an Agent Companion.
  port: string | null;
  unanswered: boolean;
  installing: {stage: 'downloading' | UsbFlashStage; percent: number | null} | null;
  // `at` is when the install ended; the device then restarts into `id`.
  last: {ok: boolean; version: string; id: string | null; at: number; error?: string} | null;
}

export interface UsbFirmwareInstaller {
  releases: Pick<FirmwareReleases, 'saved' | 'prepare'>;
  flash: UsbFlasher;
}

export interface CompanionStatus extends DaemonStatus {
  service: ServiceInfo;
  wifiPaired: boolean;
  firmware: FirmwareStatus;
  installing: InstallState | null;
  lastInstall: InstallResult | null;
  agents: AgentStatus[];
  drivingAgents: AgentId[];
  badges: {
    enabled: boolean;
    active: Array<{id: AgentId; role: ReturnType<typeof roleName>}>;
    icons: AgentBadgeStatusIcon[];
  };
  // What the desktop app should show; the device's own character wins when one is connected.
  desktop: {
    visible: boolean;
    backdrop: DesktopBackdrop;
    // Whether the desktop app plays sounds; the device keeps its own volume.
    sounds: boolean;
    // The desktop app's sound volume, 0 to 100.
    volume: number;
    character: string;
    // The .acpk the desktop renders, the same file the device installs; null if it is missing.
    pack: string | null;
    // Whether the desktop app runs, which is apart from whether it shows the character.
    app: DesktopAppStatus;
  };
  // AI credits (GitHub Copilot) and tokens (all agents) for the chosen window.
  usage: UsageTotals & {
    enabled: boolean;
    window: UsageWindow;
    // What the device and desktop show now: AIC while Copilot runs, else Tokens while
    // another agent runs. Empty when usage is off or no agent runs.
    lines: string[];
    // Both values, for the settings page.
    summary: string[];
  };
}

// How often the agents' session logs are checked for new usage.
const USAGE_REFRESH_MS = 30_000;
// After a hook, wait this long so the agent has written its usage first.
const USAGE_HOOK_DELAY_MS = 3_000;
const settingsRepeatMs = 3_000;
// After an uninstall request, the settings page has this long to show the result before the
// desktop app closes, and the app has this long to close before its files go.
const uninstallDelayMs = 3_000;
const uninstallAppWaitMs = 6_000;

export interface DesktopChange {
  visible?: boolean;
  backdrop?: DesktopBackdrop;
  sounds?: boolean;
  volume?: number;
  character?: string;
}

export interface UninstallResult {
  keptData: boolean;
  // What the user must do, because the service cannot do it.
  manual: string[];
}

// Actions shared by the CLI socket and the settings page; 'change' fires when status may differ.
export class CompanionService extends EventEmitter {
  #installing: InstallState | null = null;
  // Claimed before the first await so concurrent requests can't both start an upload.
  #installBusy = false;
  #lastInstall: InstallResult | null = null;
  #wifiPaired = false;
  readonly #service = serviceInfo();
  readonly #transport: DeviceTransport;
  readonly #coordinator: StateCoordinator;
  readonly #agentContext: AgentContext;
  // Warnings from the last hook install or removal, shown in Settings until the next one.
  readonly #agentWarnings = new Map<AgentId, string>();
  readonly #lastAgentEvents = new Map<AgentId, number>();
  readonly #badgeIcons: AgentBadgeIconDefinition[];
  readonly #characterBuilder: Pick<CharacterPackBuilder, 'refresh'>;
  readonly #desktopApp: DesktopApp;
  #settingsOpenedAt = 0;
  #display: DisplaySettings;
  #characterPreference = 'copilot';
  readonly #usageTracker: Pick<UsageTracker, 'refresh' | 'totals'>;
  #usageTotals: UsageTotals = {aic: null, tokens: null};
  #usageTimer: NodeJS.Timeout | null = null;
  #usageSoon: NodeJS.Timeout | null = null;
  readonly #firmwareImage: () => FirmwareImage | null;
  #firmwareUpdating: FirmwareStatus['updating'] = null;
  #lastFirmware: FirmwareStatus['last'] = null;
  readonly #usbInstaller: UsbFirmwareInstaller;
  #release: ReleaseFirmware | null = null;
  #usbInstalling: UsbFirmwareStatus['installing'] = null;
  #lastUsbFirmware: UsbFirmwareStatus['last'] = null;
  #uninstalling = false;

  constructor(transport: DeviceTransport, coordinator: StateCoordinator, agentContext = defaultAgentContext(),
              badgeIcons: AgentBadgeIconDefinition[] = [],
              characterBuilder: Pick<CharacterPackBuilder, 'refresh'> = new CharacterPackBuilder(),
              desktopApp = new DesktopApp(),
              usageTracker: Pick<UsageTracker, 'refresh' | 'totals'> = new UsageTracker(),
              firmwareImage: () => FirmwareImage | null = builtFirmwareReader(),
              usbInstaller: UsbFirmwareInstaller = {releases: new FirmwareReleases(), flash: runUsbFlasher}) {
    super();
    this.#transport = transport;
    this.#coordinator = coordinator;
    this.#agentContext = agentContext;
    this.#badgeIcons = badgeIcons;
    this.#characterBuilder = characterBuilder;
    this.#desktopApp = desktopApp;
    this.#display = loadDisplaySettingsSync();
    this.#usageTracker = usageTracker;
    this.#firmwareImage = firmwareImage;
    this.#usbInstaller = usbInstaller;
  }

  // Finds a release firmware that an earlier install downloaded, so status can say if it is current.
  async loadSavedRelease(): Promise<void> {
    const version = this.#service.version;
    this.#release = version ? await this.#usbInstaller.releases.saved(version).catch(() => null) : null;
    if (this.#release) this.emit('change');
  }

  // Reads usage now and then every USAGE_REFRESH_MS; the first read of a large log takes seconds.
  startUsage(): void {
    if (this.#usageTimer) return;
    this.#usageTimer = setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS);
    this.#usageTimer.unref();
    void this.refreshUsage();
  }

  stopUsage(): void {
    if (this.#usageTimer) clearInterval(this.#usageTimer);
    if (this.#usageSoon) clearTimeout(this.#usageSoon);
    this.#usageTimer = this.#usageSoon = null;
  }

  async refreshUsage(): Promise<void> {
    if (!this.#display.showUsage) return;
    try {
      await this.#usageTracker.refresh(this.#coordinator.activeSessionIds());
    } catch (error) {
      console.error(`[usage] ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#updateUsage();
  }

  #updateUsage(): void {
    const totals = this.#display.showUsage
      ? this.#usageTracker.totals(this.#display.usageWindow, this.#coordinator.activeSessionIds())
      : {aic: null, tokens: null};
    const changed = totals.aic !== this.#usageTotals.aic || totals.tokens !== this.#usageTotals.tokens;
    this.#usageTotals = totals;
    this.syncUsage();
    if (changed) this.emit('change');
  }

  // Also called when sessions start and stop, since the line follows what is running.
  syncUsage(): void {
    this.#transport.setUsage(this.#deviceUsageLines());
  }

  #deviceUsageLines(): string[] {
    if (!this.#display.showUsage) return [];
    const agents = [...this.#coordinator.agentActivity().keys()];
    return deviceUsageLines(this.#usageTotals, {
      copilot: agents.includes('copilot'),
      others: agents.some(agent => agent !== 'copilot'),
    });
  }

  async setUsage(change: {enabled?: boolean; window?: UsageWindow}): Promise<void> {
    this.#display = {
      ...this.#display,
      ...(change.enabled === undefined ? {} : {showUsage: change.enabled}),
      ...(change.window === undefined ? {} : {usageWindow: change.window}),
    };
    await saveDisplaySettings(this.#display);
    this.#updateUsage();
    this.emit('change');
    if (this.#display.showUsage) await this.refreshUsage();
  }

  async refreshWifiPairing(): Promise<void> {
    this.#wifiPaired = (await loadWifiConfig().catch(() => null)) !== null;
  }

  refreshCharacterPacks(): Promise<void> {
    return this.#characterBuilder.refresh();
  }

  status(): CompanionStatus {
    return {
      state: this.#transport.state,
      transport: this.#transport.transport,
      connected: this.#transport.connected,
      port: this.#transport.address,
      character: this.#transport.character,
      network: this.#transport.network,
      mode: this.#transport.mode,
      sessions: this.#coordinator.sessionCount,
      agents: this.agentStatuses(),
      drivingAgents: this.#coordinator.drivingAgents,
      badges: {
        enabled: this.#display.showAgentBadges,
        active: this.#coordinator.agentBadgeRoles().active.map(item => ({id: item.id, role: roleName(item.role)})),
        icons: statusIcons(this.#badgeIcons),
      },
      desktop: {
        visible: this.#display.showDesktopCompanion,
        backdrop: this.#display.desktopBackdrop,
        sounds: this.#display.desktopSounds,
        volume: this.#display.desktopVolume,
        character: this.desktopCharacter(),
        pack: desktopPackPath(this.desktopCharacter()),
        app: this.#desktopApp.status(),
      },
      usage: {
        enabled: this.#display.showUsage,
        window: this.#display.usageWindow,
        ...this.#usageTotals,
        lines: this.#deviceUsageLines(),
        summary: this.#display.showUsage ? usageLines(this.#usageTotals) : [],
      },
      service: this.#service,
      wifiPaired: this.#wifiPaired,
      firmware: this.#firmwareStatus(),
      installing: this.#installing,
      lastInstall: this.#lastInstall,
    };
  }

  // The desktop renders packs itself, so it switches as soon as an install starts rather than
  // waiting the minute the device takes, and keeps the new character while the device restarts.
  desktopCharacter(): string {
    return pickDesktopCharacter({
      installing: this.#installing?.character,
      installed: this.#lastInstall?.ok ? this.#lastInstall.character : undefined,
      device: this.#transport.character,
      preference: this.#characterPreference,
    });
  }

  async refreshCharacterPreference(): Promise<void> {
    this.#characterPreference = await loadCharacterPreference().catch(() => 'copilot');
  }

  agentStatuses(): AgentStatus[] {
    return agentStatuses(this.#agentContext, this.#coordinator.agentActivity(), this.#lastAgentEvents)
      .map(agent => this.#agentWarnings.has(agent.id) ? {...agent, warning: this.#agentWarnings.get(agent.id)} : agent);
  }

  #setAgentWarnings(id: AgentId, warnings: string[]): void {
    if (warnings.length) this.#agentWarnings.set(id, warnings.join(' '));
    else this.#agentWarnings.delete(id);
  }

  handleHook(agent: AgentId, event: HookEvent, payload: HookPayload): boolean {
    if (!isAgentEnabled(agent, true)) return false;
    const accepted = this.#coordinator.handle(event, namespaceAgentPayload(agent, payload));
    if (accepted) {
      if (!this.#lastAgentEvents.has(agent))
        void markAgentSeen(agent).catch(error => console.error(`[agents] ${error instanceof Error ? error.message : String(error)}`));
      this.#lastAgentEvents.set(agent, Date.now());
      this.syncBadges();
      this.#usageAfterHook();
      this.emit('change');
    }
    return accepted;
  }

  // Hooks come in bursts; read usage once, shortly after the last one.
  #usageAfterHook(): void {
    if (!this.#usageTimer || !this.#display.showUsage) return;
    if (this.#usageSoon) clearTimeout(this.#usageSoon);
    this.#usageSoon = setTimeout(() => {
      this.#usageSoon = null;
      void this.refreshUsage();
    }, USAGE_HOOK_DELAY_MS);
    this.#usageSoon.unref();
  }

  async setAgentEnabled(id: AgentId, enabled: boolean): Promise<AgentStatus[]> {
    await setAgentEnabled(id, enabled);
    this.emit('change');
    return this.agentStatuses();
  }

  async installAgentHook(id: AgentId): Promise<AgentStatus[]> {
    this.#setAgentWarnings(id, await installAgent(id, this.#agentContext));
    await setAgentHookRemoved(id, false);
    this.emit('change');
    return this.agentStatuses();
  }

  async uninstallAgentHook(id: AgentId): Promise<AgentStatus[]> {
    this.#setAgentWarnings(id, await uninstallAgent(id, this.#agentContext));
    await setAgentHookRemoved(id, true);
    this.emit('change');
    return this.agentStatuses();
  }

  async characters(): Promise<Array<CharacterEntry & {installed: boolean}>> {
    const installed = this.#transport.character;
    await this.#characterBuilder.refresh();
    return (await listCharacters()).map(entry => ({...entry, installed: entry.id === installed}));
  }

  async configureWifi(ssid: string, password: string): Promise<string> {
    validateWifiCredentials(ssid, password);
    const config = await this.#transport.configureWifi(ssid, password);
    await saveWifiConfig(config);
    await this.#transport.reloadWifi();
    this.#wifiPaired = true;
    this.emit('change');
    return config.deviceId;
  }

  scanWifi(): Promise<WifiNetwork[]> {
    return this.#transport.scanWifi();
  }

  async setConnection(mode: ConnectionMode): Promise<void> {
    await this.#transport.setMode(mode);
    await saveConnectionMode(mode);
    this.emit('change');
  }

  syncBadges(): void {
    const active: AgentBadgeActive[] = this.#display.showAgentBadges
      ? this.#coordinator.agentBadgeRoles().active.slice(0, 4) : [];
    this.#transport.setAgentBadges(this.#badgeIcons, active);
  }

  async setAgentBadgesEnabled(enabled: boolean): Promise<void> {
    this.#display = {...this.#display, showAgentBadges: enabled};
    await saveDisplaySettings(this.#display);
    this.syncBadges();
    this.emit('change');
  }

  async setDesktop(change: DesktopChange): Promise<void> {
    if (change.character !== undefined) {
      // A connected device decides the character; this is for when there is none.
      if (this.#transport.connected) throw new Error('The device is connected; install the character instead.');
      if (!isCharacterName(change.character) || !desktopPackPath(change.character))
        throw new Error('Unknown character.');
      await saveCharacterPreference(change.character);
      this.#characterPreference = change.character;
    }
    if (change.visible !== undefined || change.backdrop !== undefined || change.sounds !== undefined
      || change.volume !== undefined) {
      this.#display = {
        ...this.#display,
        ...(change.visible === undefined ? {} : {showDesktopCompanion: change.visible}),
        ...(change.backdrop === undefined ? {} : {desktopBackdrop: change.backdrop}),
        ...(change.sounds === undefined ? {} : {desktopSounds: change.sounds}),
        ...(change.volume === undefined ? {} : {desktopVolume: change.volume}),
      };
      await saveDisplaySettings(this.#display);
    }
    this.emit('change');
  }

  // The desktop app asks for status often; the reply tells it when to close or open Settings.
  desktopSeen(report: DesktopAppReport): DesktopCommand | null {
    const {command, changed} = this.#desktopApp.seen(report);
    if (changed) this.emit('change');
    return command;
  }

  // For the device's BOOT button: the desktop app opens its Settings window if it runs, else the
  // browser opens the settings page. Quick repeat presses do not open more browser tabs.
  async openSettings(url: string | null, open = openBrowser): Promise<'desktop' | 'browser' | null> {
    const now = Date.now();
    if (now - this.#settingsOpenedAt < settingsRepeatMs) return null;
    this.#settingsOpenedAt = now;
    if (this.#desktopApp.openSettings()) {
      console.log('[settings] the desktop app opens Settings');
      return 'desktop';
    }
    if (!url) {
      console.error('[settings] the settings page is not available');
      return null;
    }
    if (!await open(url, this.#desktopApp.environment)) {
      console.error('[settings] could not open the settings page in a browser');
      return null;
    }
    console.log('[settings] opened the settings page in the browser');
    return 'browser';
  }

  async startDesktop(): Promise<void> {
    await this.#desktopApp.start();
    this.emit('change');
  }

  stopDesktop(): void {
    this.#desktopApp.stop();
    this.emit('change');
  }

  // Removes the agent hooks now. Then, after a short time, closes the desktop app and starts a
  // script that removes the app, this service and (unless keepData) its data, and stops the service.
  async uninstall(keepData: boolean, run: (plan: UninstallPlan) => void = runUninstall): Promise<UninstallResult> {
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
      throw new Error('Uninstall from Settings works on macOS, Linux and Windows only. See "Uninstall" in the README.');
    if (this.#uninstalling) throw new Error('The uninstall is already in progress.');
    this.#uninstalling = true;
    const manual = await removeAllAgentHooks(this.#agentContext);
    const home = homedir();
    const plan = createUninstallPlan({
      platform,
      home,
      uid: process.getuid?.() ?? userInfo().uid,
      dataDir: defaultDataDirectory(process.platform, home, process.env),
      socketPath: socketPath(),
      serviceRoot: this.#service.root,
      app: this.#desktopApp.location(),
      keepData,
      copilotHome: copilotHome(home, process.env),
      configHome: process.env.XDG_CONFIG_HOME,
      dataHome: process.env.XDG_DATA_HOME,
      cacheHome: process.env.XDG_CACHE_HOME,
      appData: process.env.APPDATA,
      localAppData: process.env.LOCALAPPDATA,
    });
    console.log(`[uninstall] hooks removed; removing ${plan.remove.length} paths in ${uninstallDelayMs} ms`);
    setTimeout(() => void this.#finishUninstall(plan, run), uninstallDelayMs);
    this.emit('change');
    return {keptData: keepData, manual: [...manual, ...plan.manual]};
  }

  async #finishUninstall(plan: UninstallPlan, run: (plan: UninstallPlan) => void): Promise<void> {
    this.#desktopApp.stop();
    const until = Date.now() + uninstallAppWaitMs;
    while (this.#desktopApp.running && Date.now() < until) await sleep(200);
    run(plan);
  }

  get installBusy(): boolean {
    return this.#installBusy;
  }

  async installCharacter(character: string, progress?: InstallProgress): Promise<InstallResult> {
    if (this.#installBusy) throw new Error('A character installation is already in progress.');
    this.#installBusy = true;
    let pack: Awaited<ReturnType<typeof readCharacterPack>>;
    let name = character;
    try {
      await this.#characterBuilder.refresh();
      pack = await readCharacterPack(character);
      name = pack.name;
      if (this.#transport.connected && packNeedsFirmwareUpdate(pack, this.#transport.adaptivePatchRam))
        throw new Error(`${pack.name} needs newer device firmware. Update the firmware (see "Update" in `
          + `the README), then install ${pack.name} again.`);
    } catch (error) {
      this.#installBusy = false;
      // The settings page learns about failures from lastInstall, so report ones that happen before the transfer too.
      this.#lastInstall = {ok: false, character, name,
                           error: error instanceof Error ? error.message : String(error)};
      this.emit('change');
      throw error;
    }
    this.#installing = {character: pack.id, name: pack.name, percent: 0};
    this.#lastInstall = null;
    this.emit('change');
    try {
      const result = await this.#transport.installCharacter(pack.data, (sent, total) => {
        const percent = Math.floor(sent * 100 / total);
        progress?.(sent, total);
        if (this.#installing && percent !== this.#installing.percent) {
          this.#installing = {...this.#installing, percent};
          this.emit('change');
        }
      });
      await saveCharacterPreference(character);
      this.#characterPreference = character;
      console.log(`[character] installed ${result.character} via ${result.transport}`);
      this.#lastInstall = {ok: true, character: pack.id, name: pack.name, transport: result.transport};
      return this.#lastInstall;
    } catch (error) {
      this.#lastInstall = {ok: false, character: pack.id, name: pack.name,
                           error: error instanceof Error ? error.message : String(error)};
      throw error;
    } finally {
      this.#installing = null;
      this.#installBusy = false;
      this.emit('change');
    }
  }

  #firmwareStatus(): FirmwareStatus {
    const device = this.#transport.firmware ?? null;
    const built = this.#firmwareImage()?.id ?? null;
    return {
      device,
      built,
      canUpdate: !this.#firmwareUpdating && !this.#installBusy && !this.#usbInstalling && built !== null && device !== null
        && built !== device && this.#transport.firmwareOverWifi === true,
      updating: this.#firmwareUpdating,
      last: this.#lastFirmware,
      usb: this.#usbFirmwareStatus(),
    };
  }

  #usbFirmwareStatus(): UsbFirmwareStatus {
    const unanswered = this.#transport.usbUnanswered;
    return {
      release: this.#service.version,
      releaseId: this.#release?.id ?? null,
      flasher: this.#desktopApp.flasher() !== null,
      port: this.#transport.transport === 'usb' ? this.#transport.address : unanswered?.path ?? null,
      unanswered: unanswered !== null,
      installing: this.#usbInstalling,
      last: this.#lastUsbFirmware,
    };
  }

  // Downloads this service's release firmware from GitHub and has the desktop app write it over
  // USB: bootloader, partition table, app and the Copilot character. Wi-Fi settings stay.
  async installFirmwareOverUsb(): Promise<void> {
    if (this.#installBusy || this.#firmwareUpdating || this.#usbInstalling)
      throw new Error('Wait for the current installation to finish.');
    const version = this.#service.version;
    if (!version) throw new Error('The companion service has no VERSION file, so it cannot choose a release.');
    const program = this.#desktopApp.flasher();
    if (!program) throw new Error('Installing firmware over USB needs the desktop app. Open the desktop app, '
      + 'then try again.');
    this.#installBusy = true;
    this.#usbInstalling = {stage: 'downloading', percent: null};
    this.#lastUsbFirmware = null;
    this.emit('change');
    const set = (next: NonNullable<UsbFirmwareStatus['installing']>) => {
      if (JSON.stringify(next) === JSON.stringify(this.#usbInstalling)) return;
      this.#usbInstalling = next;
      this.emit('change');
    };
    let id: string | null = null;
    try {
      const release = await this.#usbInstaller.releases.prepare(version, (received, total) =>
        set({stage: 'downloading', percent: total ? Math.floor(received * 100 / total) : null}));
      this.#release = release;
      id = release.id;
      const port = await this.#transport.findUsbPort();
      if (!port) throw new Error('No device is on USB. Connect the device with a USB data cable, then try again.');
      console.log(`[firmware] installing release v${version} (${release.id}) over USB on ${port.path}`);
      await this.#transport.withUsbReleased(() => this.#usbInstaller.flash(program, release.dir, port, {
        stage: stage => set({stage, percent: stage === 'writing' ? 0 : null}),
        progress: percent => set({stage: 'writing', percent}),
      }));
      console.log(`[firmware] installed release v${version} over USB; the device restarts`);
      this.#lastUsbFirmware = {ok: true, version, id, at: Date.now()};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[firmware] USB install failed: ${message}`);
      this.#lastUsbFirmware = {ok: false, version, id, at: Date.now(), error: message};
      throw error;
    } finally {
      this.#usbInstalling = null;
      this.#installBusy = false;
      this.emit('change');
    }
  }

  // Sends the built firmware over Wi-Fi. The device restarts into it, and goes back to its old
  // firmware if the new one does not reach Wi-Fi within 90 seconds.
  async updateFirmware(): Promise<void> {
    if (this.#installBusy || this.#firmwareUpdating || this.#usbInstalling)
      throw new Error('Wait for the current installation to finish.');
    const image = this.#firmwareImage();
    if (!image) throw new Error('No firmware is built. Run: bash tools/arduino.sh build');
    if (image.id === this.#transport.firmware) throw new Error('The device already runs this firmware.');
    this.#installBusy = true;
    this.#firmwareUpdating = {percent: 0, button: false};
    this.#lastFirmware = null;
    this.emit('change');
    try {
      await this.#transport.installFirmware(image.data, image.md5, (sent, total) => {
        const percent = Math.floor(sent * 100 / total);
        if (this.#firmwareUpdating && (percent !== this.#firmwareUpdating.percent || this.#firmwareUpdating.button)) {
          this.#firmwareUpdating = {percent, button: false};
          this.emit('change');
        }
      }, () => {
        this.#firmwareUpdating = {percent: 0, button: true};
        this.emit('change');
      });
      console.log(`[firmware] sent ${image.id}; the device restarts`);
      this.#lastFirmware = {ok: true, id: image.id, at: Date.now()};
    } catch (error) {
      this.#lastFirmware = {ok: false, id: image.id, at: Date.now(), error: error instanceof Error ? error.message : String(error)};
      throw error;
    } finally {
      this.#firmwareUpdating = null;
      this.#installBusy = false;
      this.emit('change');
    }
  }

  // Restores the remembered character when a connected device reports that it has none.
  async restoreCharacter(): Promise<void> {
    if (this.#installBusy) return;
    const character = await loadCharacterPreference();
    if (this.#installBusy) return;
    console.log(`[character] device has no character; installing ${character}`);
    await this.installCharacter(character);
  }

  async addCharacter(data: Buffer): Promise<CharacterEntry> {
    const entry = await addCharacterPack(data);
    this.emit('change');
    return entry;
  }

  async removeCharacter(id: string): Promise<void> {
    if (id === this.#transport.character) throw new Error('That character is installed on the device.');
    await removeCharacterPack(id);
    this.emit('change');
  }
}

function desktopPackPath(character: string): string | null {
  try {
    const path = resolveCharacterPack(character);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

// Which character the desktop shows: one being installed, else the one just installed (the
// device is still restarting), else the device's own, else the saved choice.
export function pickDesktopCharacter(sources: {
  installing?: string | null;
  installed?: string | null;
  device?: string | null;
  preference?: string | null;
}): string {
  for (const candidate of [sources.installing, sources.installed, sources.device, sources.preference]) {
    if (candidate && candidate !== 'none' && isCharacterName(candidate)) return candidate;
  }
  return 'copilot';
}

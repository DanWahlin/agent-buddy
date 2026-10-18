import {existsSync, readFileSync} from 'node:fs';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {homedir, userInfo} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  agentStatuses,
  adapters,
  markAgentSeen,
  rememberHookApproval,
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
import {isHookCurrent} from './agents/hook-config.js';
import {
  addCharacterPack,
  isCharacterName,
  keepInstalledPack,
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
import {
  defaultDataDirectory, deviceHistoryPath, serviceInfo, serviceStoppedPath, socketPath, type ServiceInfo,
} from './paths.js';
import {
  createServiceRestartPlan, createServiceStopPlan, createUninstallPlan, runUninstall, type UninstallPlan,
} from './uninstaller.js';
import type {DaemonStatus, HookEvent, HookPayload, InstallProgress, WifiNetwork} from './protocol.js';
import type {StateCoordinator} from './state-coordinator.js';
import {builtFirmwareReader, type FirmwareImage} from './firmware-image.js';
import {isOrientationOffset, type DeviceOrientation} from './orientation-settings.js';
import {deviceUsageLines, UsageTracker, usageLines, type UsageTotals, type UsageWindow} from './usage-tracker.js';
import {loadWifiConfig, saveWifiConfig, validateWifiCredentials} from './wifi-config.js';
import {OnboardingStore, SetupError, type OnboardingChange, type OnboardingState, type OnboardingStep} from './onboarding.js';

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
  // The release with this service's version, and its firmware ID: from the desktop build, or once it is downloaded.
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
  // Whether this computer has used a device. Without one, quitting the desktop app stops the service.
  deviceUsed: boolean;
  deviceEnabled: boolean;
  onboarding: OnboardingState & {
    busy: boolean;
    phase: string | null;
    error: string | null;
    deviceSetup: {flash: boolean; transport: 'usb' | 'wifi' | null} | null;
  };
  charactersRevision: number;
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
// Time for the reply, and for the device to get the idle state, before the service stops.
const stopDelayMs = 500;
// How long a firmware install keeps the previous character for a device that has not started yet.
const pendingRestoreMs = 30 * 60_000;

function loadDeviceUsed(path = deviceHistoryPath()): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as {used?: unknown}).used === true;
  } catch {
    return false;
  }
}

async function saveDeviceUsed(path = deviceHistoryPath()): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify({used: true})}\n`, {mode: 0o600});
  await rename(tmp, path);
}

export interface DesktopChange {
  visible?: boolean;
  backdrop?: DesktopBackdrop;
  sounds?: boolean;
  volume?: number;
  character?: string;
  deviceEnabled?: boolean;
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
  // A character to install again when the device starts the new firmware later, for example after
  // the user power-cycles a device that stayed in download mode.
  #pendingRestore: symbol | null = null;
  // How long a firmware install waits for the device to restart; tests make it shorter.
  firmwareRestartMs = 120_000;
  #usbInstalling: UsbFirmwareStatus['installing'] = null;
  #lastUsbFirmware: UsbFirmwareStatus['last'] = null;
  #uninstalling = false;
  #stopping = false;
  #restarting = false;
  #deviceUsed = loadDeviceUsed();
  readonly #onboarding: OnboardingStore;
  #onboardingPhase: string | null = null;
  #onboardingError: string | null = null;
  #onboardingDeviceSetup: CompanionStatus['onboarding']['deviceSetup'] = null;
  #operation: symbol | null = null;
  // What the running operation is, for the busy message: "the Wi-Fi scan".
  #operationTask = 'the current change';
  readonly #operationContext = new AsyncLocalStorage<symbol>();
  #charactersRevision = 0;

  constructor(transport: DeviceTransport, coordinator: StateCoordinator, agentContext = defaultAgentContext(),
              badgeIcons: AgentBadgeIconDefinition[] = [],
              characterBuilder: Pick<CharacterPackBuilder, 'refresh'> = new CharacterPackBuilder(),
              desktopApp = new DesktopApp(),
              usageTracker: Pick<UsageTracker, 'refresh' | 'totals'> = new UsageTracker(),
              firmwareImage: () => FirmwareImage | null = builtFirmwareReader(),
              usbInstaller: UsbFirmwareInstaller = {releases: new FirmwareReleases(), flash: runUsbFlasher},
              onboarding = new OnboardingStore(process.env.AGENT_COMPANION_ONBOARDING
                ?? join(agentContext.dataDir, 'onboarding.json'))) {
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
    this.#onboarding = onboarding;
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
    return this.#mutate(async () => {
      this.#display = {
        ...this.#display,
        ...(change.enabled === undefined ? {} : {showUsage: change.enabled}),
        ...(change.window === undefined ? {} : {usageWindow: change.window}),
      };
      await saveDisplaySettings(this.#display);
      this.#updateUsage();
      this.emit('change');
      if (this.#display.showUsage) await this.refreshUsage();
    });
  }

  async refreshWifiPairing(): Promise<void> {
    this.#wifiPaired = (await loadWifiConfig().catch(() => null)) !== null;
  }

  refreshCharacterPacks(): Promise<void> {
    return this.#characterBuilder.refresh();
  }

  status(): CompanionStatus {
    this.#noteDevice();
    return {
      state: this.#transport.state,
      transport: this.#transport.transport,
      connected: this.#transport.connected,
      port: this.#transport.address,
      character: this.#transport.character,
      charactersRevision: this.#charactersRevision,
      network: this.#transport.network,
      orientation: this.#transport.orientation,
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
      deviceUsed: this.deviceUsed,
      deviceEnabled: this.deviceEnabled,
      onboarding: this.onboardingStatus(),
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
    return this.#mutate(async () => {
      await setAgentEnabled(id, enabled);
      this.emit('change');
      return this.agentStatuses();
    });
  }

  async installAgentHook(id: AgentId, onlyNeeded = false): Promise<AgentStatus[]> {
    return this.#mutate(async () => {
      this.#setAgentWarnings(id, await installAgent(id, this.#agentContext, onlyNeeded));
      await setAgentHookRemoved(id, false);
      this.emit('change');
      return this.agentStatuses();
    });
  }

  async uninstallAgentHook(id: AgentId, allLocations = false): Promise<AgentStatus[]> {
    return this.#mutate(async () => {
      this.#setAgentWarnings(id, await uninstallAgent(id, this.#agentContext, allLocations));
      await setAgentHookRemoved(id, true);
      this.emit('change');
      return this.agentStatuses();
    });
  }

  async characters(): Promise<Array<CharacterEntry & {installed: boolean}>> {
    const installed = this.#transport.character;
    await this.#characterBuilder.refresh();
    return (await listCharacters()).map(entry => ({...entry, installed: entry.id === installed}));
  }

  async configureWifi(ssid: string, password: string): Promise<string> {
    return this.#mutate(async () => {
      validateWifiCredentials(ssid, password);
      const config = await this.#transport.configureWifi(ssid, password);
      await saveWifiConfig(config);
      await this.#transport.reloadWifi();
      this.#wifiPaired = true;
      this.emit('change');
      return config.deviceId;
    }, null, 'the Wi-Fi setup');
  }

  scanWifi(): Promise<WifiNetwork[]> {
    return this.#mutate(() => this.#transport.scanWifi(), null, 'the Wi-Fi scan');
  }

  reloadWifi(): Promise<void> {
    return this.#mutate(async () => {
      await this.refreshWifiPairing();
      await this.#transport.reloadWifi();
      this.emit('change');
    });
  }

  async setConnection(mode: ConnectionMode): Promise<void> {
    return this.#mutate(async () => {
      if (!this.deviceEnabled) await this.setDesktop({deviceEnabled: true});
      await this.#transport.setMode(mode);
      await saveConnectionMode(mode);
      this.emit('change');
    });
  }

  syncBadges(): void {
    const active: AgentBadgeActive[] = this.#display.showAgentBadges
      ? this.#coordinator.agentBadgeRoles().active.slice(0, 4) : [];
    this.#transport.setAgentBadges(this.#badgeIcons, active);
  }

  async setAgentBadgesEnabled(enabled: boolean): Promise<void> {
    return this.#mutate(async () => {
      this.#display = {...this.#display, showAgentBadges: enabled};
      await saveDisplaySettings(this.#display);
      this.syncBadges();
      this.emit('change');
    });
  }

  async setDesktop(change: DesktopChange): Promise<void> {
    return this.#mutate(() => this.#setDesktop(change));
  }

  async #setDesktop(change: DesktopChange): Promise<void> {
    if (change.deviceEnabled !== undefined) {
      if (this.#installBusy) throw new Error('Wait for the current installation to finish.');
      await this.#transport.setEnabled(change.deviceEnabled);
      this.#display = {...this.#display, useDevice: change.deviceEnabled};
      await saveDisplaySettings(this.#display);
    }
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

  get deviceEnabled(): boolean {
    return this.#display.useDevice;
  }

  onboardingStatus(): CompanionStatus['onboarding'] {
    return {...this.#onboarding.state, busy: this.#operation !== null,
            phase: this.#onboardingPhase, error: this.#onboardingError ?? this.#onboarding.problem,
            deviceSetup: this.#onboardingDeviceSetup ? {...this.#onboardingDeviceSetup} : null};
  }

  #setupAvailable(): void {
    if (this.#operation || this.#installBusy || this.#firmwareUpdating || this.#usbInstalling)
      throw new SetupError(`Wait for ${this.#busyTask()} to finish.`);
    if (this.#stopping || this.#restarting || this.#uninstalling)
      throw new SetupError('The companion service is stopping.');
  }

  #requireSetup(): void {
    if (this.#onboarding.state.completed)
      throw new SetupError('Run setup again before changing its choices.');
  }

  #busyTask(): string {
    if (this.#operation) return this.#operationTask;
    return this.#firmwareUpdating || this.#usbInstalling ? 'the firmware install' : 'the character install';
  }

  // `task` names the operation in the message that other requests get while it runs.
  #mutate<T>(work: () => Promise<T>, phase: string | null = null,
             task = phase ? `setup (${phase.charAt(0).toLowerCase()}${phase.slice(1)})` : 'the current change'): Promise<T> {
    // Nested setup actions retain ownership across awaits; other requests cannot share it.
    if (this.#operation && this.#operationContext.getStore() === this.#operation) return work();
    this.#setupAvailable();
    const owner = Symbol();
    this.#operation = owner;
    this.#operationTask = task;
    if (phase) {
      this.#onboardingPhase = phase;
      this.#onboardingError = null;
      this.emit('change');
    }
    const failed = (error: unknown) => {
      if (phase) this.#onboardingError = error instanceof Error ? error.message : String(error);
      throw error;
    };
    const finished = () => {
      this.#operation = null;
      if (phase) {
        this.#onboardingPhase = null;
        this.#onboardingDeviceSetup = null;
      }
      this.emit('change');
    };
    try {
      return this.#operationContext.run(owner, work).catch(failed).finally(finished);
    } catch (error) {
      if (phase) this.#onboardingError = error instanceof Error ? error.message : String(error);
      finished();
      throw error;
    }
  }

  async updateOnboarding(change: OnboardingChange): Promise<OnboardingState> {
    return this.#mutate(async () => {
      this.#requireSetup();
      if (change.character !== undefined && !(await this.characters()).some(entry => entry.id === change.character))
        throw new SetupError('Unknown character.', 400);
      return this.#onboarding.update(change);
    }, 'Saving setup choices');
  }

  async navigateOnboarding(step: OnboardingStep): Promise<OnboardingState> {
    return this.#mutate(async () => {
      const state = this.#onboarding.state;
      if (state.completed) throw new SetupError('Run setup again before opening its steps.');
      if (!state.visitedSteps.includes(step))
        throw new SetupError('This setup step has not been reached yet.');
      if (step === 'firmware' && (state.display === 'desktop' || state.deviceDeferred))
        throw new SetupError('The device step is not part of your selected setup.');
      return this.updateOnboarding({step, ...(step === 'agents' ? {agentStage: 'select'} : {})});
    }, 'Opening setup step');
  }

  async restartOnboarding(): Promise<OnboardingState> {
    return this.#mutate(() => this.#restartOnboarding(), 'Opening setup');
  }

  async #restartOnboarding(): Promise<OnboardingState> {
    const available = await this.characters();
    const current = this.desktopCharacter();
    const previous = this.#onboarding.state;
    const selected = previous.completed && previous.step === 'welcome' ? current : previous.character;
    const state = await this.#onboarding.reset({
      agents: [...new Set([...previous.agents,
        ...this.agentStatuses().filter(agent => agent.enabled && agent.installed).map(agent => agent.id)])],
      character: available.some(entry => entry.id === selected) ? selected
        : available.some(entry => entry.id === current) ? current : 'copilot',
      display: previous.deviceDeferred ? previous.display
        : !this.deviceEnabled ? 'desktop' : this.#display.showDesktopCompanion ? 'both' : 'device',
    }, true);
    this.#onboardingError = null;
    this.emit('change');
    return state;
  }

  async rescanAgents(): Promise<AgentStatus[]> {
    return this.#mutate(async () => {
      await this.#agentContext.locations?.refresh({force: true});
      return this.agentStatuses();
    }, 'Checking installed agents');
  }

  async removeOnboardingAgent(id: AgentId): Promise<{state: OnboardingState; warning?: string}> {
    return this.#mutate(() => this.#removeOnboardingAgent(id), 'Removing selected agent hooks');
  }

  async #removeOnboardingAgent(id: AgentId): Promise<{state: OnboardingState; warning?: string}> {
    this.#requireSetup();
    const previous = this.#onboarding.state;
    if (!previous.agents.includes(id)) throw new SetupError('Agent selection changed. Review the removal again.');
    const agents = await this.uninstallAgentHook(id, true);
    const removed = agents.find(agent => agent.id === id);
    await this.setAgentEnabled(id, false);
    const state = await this.#onboarding.update({
      agents: previous.agents.filter(agent => agent !== id),
      deferredAgents: previous.deferredAgents.filter(agent => agent !== id),
      agentStage: 'select',
    });
    const warning = removed?.warning ?? (removed?.installed
      ? 'Some hooks remain. The agent is disabled. Check its configuration locations in Settings.' : undefined);
    return {state, ...(warning ? {warning} : {})};
  }

  async installOnboardingAgents(approved: AgentId[] = []): Promise<Array<{id: AgentId; ok: boolean; warning?: string; error?: string}>> {
    return this.#mutate(() => this.#installOnboardingAgents(approved), 'Checking selected hooks');
  }

  async #installOnboardingAgents(approved: AgentId[]): Promise<Array<{id: AgentId; ok: boolean; warning?: string; error?: string}>> {
    this.#requireSetup();
    const selected = this.#onboarding.state.agents;
    if (!selected.length) throw new SetupError('Select an agent or choose Set up later.', 400);
    const results: Array<{id: AgentId; ok: boolean; warning?: string; error?: string}> = [];
    await this.#agentContext.locations?.refresh({force: true});
    const unapproved = this.agentStatuses().filter(agent => selected.includes(agent.id)
      && (!agent.installed || !isHookCurrent(agent.hookStatus)) && !approved.includes(agent.id));
    if (unapproved.length)
      throw new SetupError(`Hooks changed for ${unapproved.map(agent => agent.name).join(', ')}. Review and approve the required installation.`);
    for (const id of selected) {
      const found = this.agentStatuses().find(agent => agent.id === id)!;
      const current = found.installed && isHookCurrent(found.hookStatus);
      if (!current && !approved.includes(id))
        throw new SetupError(`Hooks changed for ${found.name}. Review and approve the required installation.`);
      try {
        if (!found.detected && id !== 'copilot') throw new Error(`${found.name} was not detected. Install the agent and rescan.`);
        if (current) await rememberHookApproval(this.#agentContext, [id]);
        else await this.installAgentHook(id, true);
        await this.setAgentEnabled(id, true);
        const status = this.agentStatuses().find(agent => agent.id === id)!;
        const ok = isHookCurrent(status.hookStatus);
        results.push({id, ok, ...(status.warning ? {warning: status.warning} : {}),
                      ...(!ok ? {error: status.warning ?? 'Some hooks could not be installed.'} : {})});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[onboarding] ${id} hook installation failed: ${message}`);
        results.push({id, ok: false, error: message});
      }
    }
    for (const adapter of adapters) {
      if (!selected.includes(adapter.id)) await this.setAgentEnabled(adapter.id, false);
    }
    await this.#onboarding.update({agentsDeferred: false, agentStage: 'connect'});
    return results;
  }

  async detectUsbDevices(): Promise<{ports: Awaited<ReturnType<DeviceTransport['usbPorts']>>; connected: string | null}> {
    this.#setupAvailable();
    return {ports: await this.#transport.usbPorts(),
            connected: this.#transport.transport === 'usb' ? this.#transport.address : null};
  }

  async applyOnboardingDisplay(): Promise<void> {
    return this.#mutate(async () => {
      this.#requireSetup();
      await this.#applySetupDisplay(await this.#setupState());
    }, 'Applying display choice');
  }

  async #setupState(preferWifi = true): Promise<OnboardingState> {
    let state = this.#onboarding.state;
    if (!(await this.characters()).some(entry => entry.id === state.character))
      throw new SetupError('The selected character is unavailable. Return to Character and select an available pack.');
    if (preferWifi && state.port && this.#transport.connected && this.#transport.transport === 'wifi') {
      await this.#transport.selectUsbPort(null);
      state = await this.#onboarding.update({port: null});
    }
    return state;
  }

  async #applySetupDisplay(state: OnboardingState): Promise<void> {
    const device = state.display !== 'desktop' && !state.deviceDeferred;
    if (device && state.port && this.#transport.mode === 'wifi') await this.#transport.setMode('auto');
    await this.setDesktop({deviceEnabled: device, visible: state.display !== 'device' || state.deviceDeferred});
    if (!device) await this.setDesktop({character: state.character});
  }

  setupOnboardingDevice(flash: boolean): Promise<void> {
    return this.#mutate(() => {
      const state = this.#onboarding.state;
      if (state.completed || state.display === 'desktop' || state.deviceDeferred)
        throw new SetupError('Device setup is not selected.');
      if (flash && !state.port) throw new SetupError('Detect and select the USB device first.');
      return this.#setupOnboardingDevice(flash);
    }, 'Connecting to the device');
  }

  async #setupOnboardingDevice(flash: boolean): Promise<void> {
    const state = await this.#setupState(!flash);
    const usbPath = state.port ?? (this.#transport.transport === 'usb' ? this.#transport.address : null);
    const target = usbPath ? await this.#transport.findUsbPort(usbPath) : null;
    this.#onboardingDeviceSetup = {flash, transport: flash || target ? 'usb' : this.#transport.transport};
    this.emit('change');
    if (target) await this.#transport.selectUsbPort(target.path);
    await this.#applySetupDisplay(state);
    if (flash) {
      if (!target) throw new Error('The selected USB device disconnected.');
      // Setup installs its selected character itself, below.
      await this.#installFirmwareOverUsb(state.port);
      this.#onboardingPhase = 'Waiting for the device to restart';
      this.emit('change');
      const firmware = this.#lastUsbFirmware?.id;
      await this.#waitForDevice(() => this.#transport.firmware === firmware && this.#transport.matchesUsbPort(target));
      if (this.#transport.address !== state.port)
        await this.#onboarding.update({port: this.#transport.address});
    } else {
      await this.#waitForDevice(() => !target || this.#transport.matchesUsbPort(target), 15_000);
    }
    if (this.#transport.character !== state.character) {
      this.#onboardingDeviceSetup.transport = this.#transport.transport;
      this.#onboardingPhase = 'Installing the selected character';
      this.emit('change');
      await this.installCharacter(state.character);
      this.#onboardingPhase = 'Waiting for the character to start';
      this.emit('change');
      await this.#waitForDevice(() => this.#transport.character === state.character
        && (!target || this.#transport.matchesUsbPort(target)));
    }
    if (target && this.#transport.address !== this.#onboarding.state.port)
      await this.#onboarding.update({port: this.#transport.address});
  }

  async #waitForDevice(ready: () => boolean, timeout = 120_000): Promise<void> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (this.#transport.connected && ready()) return;
      await sleep(250);
    }
    throw new Error('The device did not reconnect. Check its power and USB or Wi-Fi connection, then detect the device and retry.');
  }

  async finishOnboarding(): Promise<OnboardingState> {
    return this.#mutate(() => this.#finishOnboarding(), 'Finishing setup');
  }

  async #finishOnboarding(): Promise<OnboardingState> {
    if (this.#onboarding.state.completed) return this.#onboarding.state;
    const state = await this.#setupState();
    if (!state.agentsDeferred) {
      for (const id of state.agents) {
        if (state.deferredAgents.includes(id)) continue;
        const agent = this.agentStatuses().find(entry => entry.id === id)!;
        if (!agent.enabled || !agent.installed || !['installed', 'needs-approval'].includes(agent.hookStatus))
          throw new SetupError(`Install the ${agent.name} hooks or choose Set up agents later.`);
        if (agent.action)
          throw new SetupError(`Finish connecting ${agent.name} or choose Set up later in its guide.`);
      }
    }
    if (state.display !== 'desktop' && !state.deviceDeferred
      && (!this.#transport.connected || this.#transport.character !== state.character
        || (state.port && this.#transport.address !== state.port)))
      throw new SetupError('Finish preparing the selected device or choose Use desktop for now.');
    await this.#applySetupDisplay(state);
    if (state.display !== 'desktop' && !state.deviceDeferred && state.port) await this.setConnection('auto');
    await this.#transport.selectUsbPort(null);
    const completed = await this.#onboarding.finish();
    this.emit('change');
    return completed;
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
    this.#checkCanStop();
    this.#desktopApp.stop();
    this.emit('change');
  }

  // Removes the agent hooks now. Then, after a short time, closes the desktop app and starts a
  // script that removes the app, this service and (unless keepData) its data, and stops the service.
  async uninstall(keepData: boolean, run: (plan: UninstallPlan) => void = runUninstall): Promise<UninstallResult> {
    this.#checkCanStop();
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

  // Whether this computer has used a device: a Wi-Fi pairing, or a device that connected one time.
  get deviceUsed(): boolean {
    return this.#deviceUsed || this.#wifiPaired;
  }

  // True from a stop request until the service exits, so agent events no longer move the device.
  get stopping(): boolean {
    return this.#stopping;
  }

  // Status is asked for a few times a second, so it sees a connected device soon enough.
  #noteDevice(): void {
    if (this.#deviceUsed || !this.#transport.connected) return;
    this.#deviceUsed = true;
    saveDeviceUsed().catch(error => console.error(`[device] could not save that a device was used: ${
      error instanceof Error ? error.message : String(error)}`));
  }

  // Stops this service, for the desktop app's Quit or the Stop button in Settings. The device goes
  // idle and the desktop app closes first. The service starts again when the user signs in, or
  // when the desktop app opens. It emits 'stop' when the service should exit.
  async stopService(run: (plan: UninstallPlan, exit: () => void) => void = runUninstall): Promise<void> {
    this.#checkCanStop();
    this.#stopping = true;
    await writeFile(serviceStoppedPath(), '', {mode: 0o600}).catch(() => undefined);
    this.#transport.setState('idle');
    console.log(`[service] stopping on request in ${stopDelayMs} ms`);
    setTimeout(() => void this.#finishStop(run), stopDelayMs);
    this.emit('change');
  }

  // Restarts this service, for Restart in Settings. The desktop app stays open and reconnects.
  restartService(run: (plan: UninstallPlan, exit: () => void) => void = runUninstall): void {
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
      throw new Error('Restart from Settings works on macOS, Linux and Windows only.');
    this.#checkCanStop();
    this.#restarting = true;
    console.log(`[service] restarting on request in ${stopDelayMs} ms`);
    setTimeout(() => {
      // The Windows launcher starts the service again when it exits.
      if (platform === 'win32') this.emit('stop');
      // The service manager stops this process. If no manager runs it, nothing happens.
      else run(createServiceRestartPlan(platform, process.getuid?.() ?? userInfo().uid), () => {
        this.#restarting = false;
      });
    }, stopDelayMs);
  }

  #checkCanStop(): void {
    if (this.#uninstalling || this.#stopping || this.#restarting)
      throw new Error('The companion service is already stopping or restarting.');
    if (this.#operation || this.#installBusy || this.#installing || this.#usbInstalling)
      throw new Error('Wait for the install to finish, then stop or restart the companion service.');
  }

  async #finishStop(run: (plan: UninstallPlan, exit: () => void) => void): Promise<void> {
    this.#desktopApp.stop();
    const until = Date.now() + uninstallAppWaitMs;
    while (this.#desktopApp.running && Date.now() < until) await sleep(200);
    const platform = process.platform;
    const exit = () => this.emit('stop');
    if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
      run(createServiceStopPlan(platform, process.getuid?.() ?? userInfo().uid), exit);
    else exit();
  }

  get installBusy(): boolean {
    return this.#installBusy;
  }

  installCharacter(character: string, progress?: InstallProgress): Promise<InstallResult> {
    return this.#mutate(() => this.#installCharacter(character, progress), null, 'the character install');
  }

  async #installCharacter(character: string, progress?: InstallProgress): Promise<InstallResult> {
    // A character the user installs replaces one that was waiting to be installed again.
    this.#pendingRestore = null;
    this.#installBusy = true;
    let pack: Awaited<ReturnType<typeof readCharacterPack>>;
    let name = character;
    let remembered = character;
    try {
      await this.#characterBuilder.refresh();
      pack = await readCharacterPack(character);
      name = pack.name;
      if (this.#transport.connected && packNeedsFirmwareUpdate(pack, this.#transport.adaptivePatchRam))
        throw new Error(`${pack.name} needs newer device firmware. Update the firmware (see "Update" in `
          + `the README), then install ${pack.name} again.`);
      // Before the transfer: the desktop app switches to the pack as soon as the install starts.
      remembered = await keepInstalledPack(character, pack);
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
      await saveCharacterPreference(remembered);
      this.#characterPreference = remembered;
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

  async setOrientationOffset(offsetDegrees: number): Promise<DeviceOrientation> {
    return this.#mutate(async () => {
      if (!isOrientationOffset(offsetDegrees))
        throw new Error('Orientation offset must be from -15 to 15 degrees in half-degree steps.');
      const orientation = await this.#transport.setOrientationOffset(offsetDegrees);
      this.emit('change');
      return orientation;
    });
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
      releaseId: this.#release?.id ?? this.#service.releaseFirmwareId,
      flasher: this.#desktopApp.flasher() !== null,
      port: this.#transport.transport === 'usb' ? this.#transport.address : unanswered?.path ?? null,
      unanswered: unanswered !== null,
      installing: this.#usbInstalling,
      last: this.#lastUsbFirmware,
    };
  }

  // Downloads this service's release firmware from GitHub and has the desktop app write it over
  // USB: bootloader, partition table, app and the Copilot character. Wi-Fi settings stay. The
  // device then gets its previous character back, so an update does not reset the character.
  installFirmwareOverUsb(selectedPort?: string | null): Promise<void> {
    return this.#mutate(async () => {
      const character = this.#transport.character ?? this.#characterPreference;
      await this.#installFirmwareOverUsb(selectedPort);
      await this.#restoreCharacterAfterFirmware(character);
    }, null, 'the firmware install');
  }

  async #restoreCharacterAfterFirmware(character: string): Promise<void> {
    const firmware = this.#lastUsbFirmware?.id;
    try {
      await this.#waitForDevice(() => this.#transport.firmware === firmware, this.firmwareRestartMs);
    } catch {
      console.error(`[character] the device did not restart after the firmware install; ${character} is installed `
        + 'when it starts');
      void this.#restoreWhenDeviceStarts(character, firmware);
      return;
    }
    await this.#restoreAfterFirmware(character);
  }

  async #restoreAfterFirmware(character: string): Promise<void> {
    if (this.#transport.character === character) return;
    console.log(`[character] installing ${character} again after the firmware install`);
    await this.installCharacter(character).catch(error => console.error(
      `[character] install after the firmware install failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // Not inside #mutate, so Settings stays usable while the device waits for a power cycle.
  async #restoreWhenDeviceStarts(character: string, firmware: string | null | undefined): Promise<void> {
    const token = Symbol();
    this.#pendingRestore = token;
    const until = Date.now() + pendingRestoreMs;
    while (this.#pendingRestore === token && Date.now() < until) {
      if (this.#transport.connected && this.#transport.firmware === firmware && !this.#operation && !this.#installBusy) {
        this.#pendingRestore = null;
        await this.#restoreAfterFirmware(character);
        return;
      }
      await sleep(1000, undefined, {ref: false});
    }
    if (this.#pendingRestore === token) this.#pendingRestore = null;
  }

  async #installFirmwareOverUsb(selectedPort?: string | null): Promise<void> {
    this.#pendingRestore = null;
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
      const target = await this.#transport.findUsbPort(selectedPort);
      if (!target) throw new Error('No device is on USB. Connect the device with a USB data cable, then try again.');
      const release = await this.#usbInstaller.releases.prepare(version, (received, total) =>
        set({stage: 'downloading', percent: total ? Math.floor(received * 100 / total) : null}));
      this.#release = release;
      id = release.id;
      const port = await this.#transport.findUsbPort(target.path);
      if (!port) throw new Error('No device is on USB. Connect the device with a USB data cable, then try again.');
      if (target.serialNumber && target.serialNumber !== port.serialNumber)
        throw new Error('The selected USB device changed during the download. Detect and confirm the device again.');
      await this.#transport.selectUsbPort(port.path);
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
  updateFirmware(): Promise<void> {
    return this.#mutate(() => this.#updateFirmware(), null, 'the firmware update');
  }

  async #updateFirmware(): Promise<void> {
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
    if (this.#operation || this.#installBusy) return;
    const character = await loadCharacterPreference();
    if (this.#operation || this.#installBusy) return;
    console.log(`[character] device has no character; installing ${character}`);
    await this.installCharacter(character);
  }

  async addCharacter(data: Buffer): Promise<CharacterEntry> {
    return this.#mutate(async () => {
      const entry = await addCharacterPack(data);
      this.#charactersRevision++;
      this.emit('change');
      return entry;
    });
  }

  async removeCharacter(id: string): Promise<void> {
    return this.#mutate(async () => {
      if (id === this.#transport.character) throw new Error('That character is installed on the device.');
      await removeCharacterPack(id);
      this.#charactersRevision++;
      this.emit('change');
    });
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

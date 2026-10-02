import {existsSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {
  agentStatuses,
  markAgentSeen,
  defaultAgentContext,
  installAgent,
  isAgentEnabled,
  namespaceAgentPayload,
  setAgentEnabled,
  uninstallAgent,
  type AgentContext,
  type AgentId,
  type AgentStatus,
} from './agents/index.js';
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
import type {DaemonStatus, HookEvent, HookPayload, InstallProgress, WifiNetwork} from './protocol.js';
import type {StateCoordinator} from './state-coordinator.js';
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

export interface CompanionStatus extends DaemonStatus {
  wifiPaired: boolean;
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
    character: string;
    // The .acpk the desktop renders, the same file the device installs; null if it is missing.
    pack: string | null;
  };
}

// Actions shared by the CLI socket and the settings page; 'change' fires when status may differ.
export class CompanionService extends EventEmitter {
  #installing: InstallState | null = null;
  // Claimed before the first await so concurrent requests can't both start an upload.
  #installBusy = false;
  #lastInstall: InstallResult | null = null;
  #wifiPaired = false;
  readonly #transport: DeviceTransport;
  readonly #coordinator: StateCoordinator;
  readonly #agentContext: AgentContext;
  readonly #lastAgentEvents = new Map<AgentId, number>();
  readonly #badgeIcons: AgentBadgeIconDefinition[];
  readonly #characterBuilder: Pick<CharacterPackBuilder, 'refresh'>;
  #display: DisplaySettings;
  #characterPreference = 'copilot';

  constructor(transport: DeviceTransport, coordinator: StateCoordinator, agentContext = defaultAgentContext(),
              badgeIcons: AgentBadgeIconDefinition[] = [],
              characterBuilder: Pick<CharacterPackBuilder, 'refresh'> = new CharacterPackBuilder()) {
    super();
    this.#transport = transport;
    this.#coordinator = coordinator;
    this.#agentContext = agentContext;
    this.#badgeIcons = badgeIcons;
    this.#characterBuilder = characterBuilder;
    this.#display = loadDisplaySettingsSync();
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
        character: this.desktopCharacter(),
        pack: desktopPackPath(this.desktopCharacter()),
      },
      wifiPaired: this.#wifiPaired,
      installing: this.#installing,
      lastInstall: this.#lastInstall,
    };
  }

  desktopCharacter(): string {
    const device = this.#transport.character;
    if (device && device !== 'none' && isCharacterName(device)) return device;
    return isCharacterName(this.#characterPreference) ? this.#characterPreference : 'copilot';
  }

  async refreshCharacterPreference(): Promise<void> {
    this.#characterPreference = await loadCharacterPreference().catch(() => 'copilot');
  }

  agentStatuses(): AgentStatus[] {
    return agentStatuses(this.#agentContext, this.#coordinator.agentActivity(), this.#lastAgentEvents);
  }

  handleHook(agent: AgentId, event: HookEvent, payload: HookPayload): boolean {
    if (!isAgentEnabled(agent, true)) return false;
    const accepted = this.#coordinator.handle(event, namespaceAgentPayload(agent, payload));
    if (accepted) {
      if (!this.#lastAgentEvents.has(agent))
        void markAgentSeen(agent).catch(error => console.error(`[agents] ${error instanceof Error ? error.message : String(error)}`));
      this.#lastAgentEvents.set(agent, Date.now());
      this.syncBadges();
      this.emit('change');
    }
    return accepted;
  }

  async setAgentEnabled(id: AgentId, enabled: boolean): Promise<AgentStatus[]> {
    await setAgentEnabled(id, enabled);
    this.emit('change');
    return this.agentStatuses();
  }

  async installAgentHook(id: AgentId): Promise<AgentStatus[]> {
    await installAgent(id, this.#agentContext);
    this.emit('change');
    return this.agentStatuses();
  }

  async uninstallAgentHook(id: AgentId): Promise<AgentStatus[]> {
    await uninstallAgent(id, this.#agentContext);
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

  async setDesktop(change: {visible?: boolean; backdrop?: DesktopBackdrop; character?: string}): Promise<void> {
    if (change.character !== undefined) {
      // A connected device decides the character; this is for when there is none.
      if (this.#transport.connected) throw new Error('The device is connected; install the character instead.');
      if (!isCharacterName(change.character) || !desktopPackPath(change.character))
        throw new Error('Unknown character.');
      await saveCharacterPreference(change.character);
      this.#characterPreference = change.character;
    }
    if (change.visible !== undefined || change.backdrop !== undefined) {
      this.#display = {
        ...this.#display,
        ...(change.visible === undefined ? {} : {showDesktopCompanion: change.visible}),
        ...(change.backdrop === undefined ? {} : {desktopBackdrop: change.backdrop}),
      };
      await saveDisplaySettings(this.#display);
    }
    this.emit('change');
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

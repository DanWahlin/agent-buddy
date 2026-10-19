import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CompanionService, type DesktopChange, type UsbFirmwareInstaller} from '../src/companion-service.js';
import {DeviceTransport} from '../src/device-transport.js';
import {DesktopApp} from '../src/desktop-app.js';
import {defaultAgentContext, type AgentId, type AgentStatus} from '../src/agents/index.js';
import {OnboardingStore} from '../src/onboarding.js';
import {parseCharacterPackHeader} from '../src/character-pack.js';
import {StateCoordinator} from '../src/state-coordinator.js';

class FakeTransport extends DeviceTransport {
  active = false;
  enabled = true;
  selected: string | null = null;
  characterId = 'copilot';
  firmwareId: string | null = null;
  link: 'usb' | 'wifi' = 'usb';
  usbAvailable = true;
  wifiAddress = 'http://192.0.2.7';
  usbPath = process.platform === 'win32' ? 'COM7' : '/dev/cu.usbmodem7';
  serialNumber = 'test-board';
  connectionMode: 'auto' | 'usb' | 'wifi' = 'auto';
  override get mode() { return this.connectionMode; }
  override async setMode(mode: 'auto' | 'usb' | 'wifi') { this.connectionMode = mode; }
  override get connected() { return this.active; }
  override get character() { return this.active ? this.characterId : null; }
  override get firmware() { return this.firmwareId; }
  boardId = 'waveshare-amoled-175';
  override get board() { return this.active ? this.boardId : null; }
  override get address() { return this.active ? this.link === 'wifi' ? this.wifiAddress : this.usbPath : null; }
  override get transport(): 'usb' | 'wifi' | null { return this.active ? this.link : null; }
  override async setEnabled(enabled: boolean) { this.enabled = enabled; if (!enabled) this.active = false; }
  override async usbPorts() { return this.usbAvailable ? [{path: this.usbPath, pid: 0x1001, serialNumber: this.serialNumber}] : []; }
  override async findUsbPort(path?: string | null) {
    if (path && path !== this.usbPath) throw new Error('Selected device disconnected.');
    return {path: this.usbPath, pid: 0x1001, serialNumber: this.serialNumber};
  }
  override async selectUsbPort(path: string | null) { this.selected = path; }
  override matchesUsbPort(port: {path: string; serialNumber?: string}) {
    return this.active && (port.serialNumber ? this.serialNumber === port.serialNumber : this.usbPath === port.path);
  }
  override async withUsbReleased<T>(run: () => Promise<T>) { return run(); }
}

class FakeDesktop extends DesktopApp {
  override flasher() { return '/test/desktop-app'; }
}

class SetupService extends CompanionService {
  agentList: AgentStatus[] = [];
  installedCharacters: string[] = [];
  displayChanges: DesktopChange[] = [];
  removals: Array<{id: string; allLocations: boolean}> = [];
  hookInstalls: Array<{id: AgentId; onlyNeeded: boolean}> = [];
  constructor(readonly device: FakeTransport, coordinator: StateCoordinator, root: string,
              store: OnboardingStore, installer: UsbFirmwareInstaller) {
    super(device, coordinator, defaultAgentContext({home: root, dataDir: root,
      env: {PATH: '', AGENT_COMPANION_AGENTS_CONFIG: join(root, 'agents.json')}}), [],
      {refresh: async () => undefined}, new FakeDesktop(), {refresh: async () => false,
        totals: () => ({aic: null, tokens: null})}, () => null, installer, store);
  }
  override agentStatuses() { return this.agentList; }
  override async setAgentEnabled(id: string, enabled: boolean) {
    const agent = this.agentList.find(agent => agent.id === id);
    if (agent) agent.enabled = enabled;
    return this.agentList;
  }
  override async installAgentHook(id: AgentId, onlyNeeded = false) {
    this.hookInstalls.push({id, onlyNeeded});
    const agent = this.agentList.find(agent => agent.id === id);
    if (agent) { agent.installed = true; agent.hookStatus = 'installed'; }
    return this.agentList;
  }
  override async uninstallAgentHook(id: string, allLocations = false) {
    this.removals.push({id, allLocations});
    const agent = this.agentList.find(agent => agent.id === id);
    if (agent) { agent.installed = false; agent.hookStatus = 'missing'; delete agent.action; }
    return this.agentList;
  }
  override async characters() {
    return ['copilot', 'claude'].map(id =>
      ({id, name: id, builtIn: true, bytes: 100, thumbnail: true, installed: this.device.character === id}));
  }
  override async setDesktop(change: DesktopChange) {
    this.displayChanges.push(change);
    if (change.deviceEnabled !== undefined) await this.device.setEnabled(change.deviceEnabled);
    if (change.character) this.device.characterId = change.character;
  }
  override async installCharacter(character: string) {
    this.installedCharacters.push(character);
    this.device.characterId = character;
    return {ok: true, character, name: character, transport: this.device.link};
  }
  override async setConnection(mode: 'auto' | 'usb' | 'wifi') { await this.device.setMode(mode); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-service-'));
  const environment = {
    AGENT_COMPANION_AGENTS_CONFIG: join(root, 'agents.json'),
    AGENT_COMPANION_DISPLAY_CONFIG: join(root, 'display.json'),
    AGENT_COMPANION_CHARACTER_CONFIG: join(root, 'character.json'),
    AGENT_COMPANION_CONNECTION_CONFIG: join(root, 'connection.json'),
    AGENT_COMPANION_DESKTOP_APP: join(root, 'desktop-app.json'),
    AGENT_COMPANION_DEVICE_HISTORY: join(root, 'device.json'),
    AGENT_COMPANION_SERVICE_STOPPED: join(root, 'service-stopped'),
    AGENT_COMPANION_CHARACTERS: join(root, 'packs'),
    AGENT_COMPANION_USER_CHARACTERS: join(root, 'user-packs'),
  };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const device = new FakeTransport();
  const coordinator = new StateCoordinator(() => undefined);
  const store = new OnboardingStore(join(root, 'onboarding.json'));
  const flashes: string[] = [];
  const installer: UsbFirmwareInstaller = {
    releases: {saved: async () => null, prepare: async (version, _progress, board = 'waveshare-amoled-175') =>
      ({version, board, dir: root, id: 'aaaaaaaaaaaaaaaa'})},
    flash: async (_program, _dir, port) => {
      flashes.push(port.path);
      device.active = true;
      device.firmwareId = 'aaaaaaaaaaaaaaaa';
      device.characterId = 'copilot';
    },
  };
  const service = new SetupService(device, coordinator, root, store, installer);
  return {service, device, store, flashes, installer, coordinator,
    root,
    cleanup: async () => {
      coordinator.close();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, {recursive: true, force: true});
    }};
}

function gate() {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  return {enter, resume, entered, resumed};
}

test('real service methods retain setup ownership through hook, display, character, and Finish operations', async () => {
  const {device, store, installer, coordinator, root, cleanup} = await fixture();
  try {
    await mkdir(join(root, 'packs'));
    for (const id of ['copilot', 'claude']) {
      const pack = Buffer.alloc(256);
      pack.write('ACPK', 0, 'ascii');
      pack.writeUInt16LE(1, 4);
      pack.writeUInt16LE(256, 6);
      pack.writeUInt32LE(pack.length, 8);
      pack.write(id, 16, 'ascii');
      pack.write(id, 32, 'ascii');
      await writeFile(join(root, 'packs', `${id}.acpk`), pack);
    }
    device.active = true;
    device.installCharacter = async pack => {
      device.characterId = parseCharacterPackHeader(pack).id;
      return {character: device.characterId, transport: device.link};
    };
    const context = defaultAgentContext({home: root, dataDir: root, env: {
      PATH: '', AGENT_COMPANION_AGENTS_CONFIG: join(root, 'agents.json'),
    }});
    const service = new CompanionService(device, coordinator, context, [], {refresh: async () => undefined},
      new FakeDesktop(), {refresh: async () => false, totals: () => ({aic: null, tokens: null})},
      () => null, installer, store);
    await store.reset({agents: ['copilot'], character: 'claude', display: 'both', port: device.usbPath});
    const hooks = await service.installOnboardingAgents(['copilot']);
    assert.equal(hooks[0]?.ok, true);
    assert.equal(service.agentStatuses().find(agent => agent.id === 'copilot')?.enabled, true);
    const config = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'));
    assert.equal(config.approved.copilot, true);
    await store.update({deferredAgents: ['copilot']});
    await service.setupOnboardingDevice(false);
    assert.equal(device.characterId, 'claude');
    assert.equal(service.onboardingStatus().busy, false);
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
    assert.equal(service.onboardingStatus().busy, false);
  } finally {
    await cleanup();
  }
});

test('setup that runs again after it was finished can be left without changes; a first setup cannot', async () => {
  const {service, store, device, cleanup} = await fixture();
  try {
    await store.reset({display: 'both', character: 'claude'});
    await assert.rejects(service.exitOnboarding(), /Finish setup first/);
    assert.equal(store.state.completed, false);

    await store.finish();
    const restarted = await service.restartOnboarding();
    assert.equal(restarted.rerun, true);
    assert.equal(restarted.completed, false);
    device.selected = '/dev/selected';
    const left = await service.exitOnboarding();
    assert.equal(left.completed, true);
    assert.equal(left.rerun, false);
    assert.equal(store.state.completed, true);
    assert.equal(device.selected, null);
    assert.deepEqual(service.displayChanges, []);
    assert.deepEqual(service.installedCharacters, []);
    // Leaving finished setup again changes nothing.
    assert.deepEqual(await service.exitOnboarding(), store.state);
    // A restart of a rerun is still a rerun.
    await service.restartOnboarding();
    assert.equal((await service.restartOnboarding()).rerun, true);
  } finally {
    await cleanup();
  }
});

test('a Wi-Fi scan blocks setup with a message that names the scan', async () => {
  const {service, device, cleanup} = await fixture();
  const pending = gate();
  let scan: Promise<unknown> | undefined;
  try {
    device.scanWifi = async () => { pending.enter(); await pending.resumed; return []; };
    scan = service.scanWifi();
    await pending.entered;
    await assert.rejects(service.restartOnboarding(), /: Wait for the Wi-Fi scan to finish\.$/);
    pending.resume();
    await scan;
    await service.restartOnboarding();
  } finally {
    pending.resume();
    await scan;
    await cleanup();
  }
});

test('saving a character claims setup before catalog work and blocks concurrent setup or Settings changes', async () => {
  const {service, store, cleanup} = await fixture();
  const pending = gate();
  let save: Promise<unknown> | undefined;
  try {
    await store.reset({display: 'both'});
    const characters = service.characters.bind(service);
    service.characters = async () => { pending.enter(); await pending.resumed; return characters(); };
    save = service.updateOnboarding({character: 'claude'});
    await pending.entered;
    assert.equal(service.onboardingStatus().busy, true);
    await assert.rejects(service.navigateOnboarding('welcome'), /: Wait for setup \(saving setup choices\) to finish\.$/);
    assert.throws(() => service.setupOnboardingDevice(false), /setup \(saving setup choices\)/);
    await assert.rejects(CompanionService.prototype.setDesktop.call(service, {}), /setup \(saving setup choices\)/);
    await assert.rejects(service.setUsage({enabled: false}), /setup \(saving setup choices\)/);
    assert.equal(store.state.character, 'copilot');
    pending.resume();
    await save;
    assert.equal(store.state.character, 'claude');
    assert.equal(service.onboardingStatus().busy, false);
  } finally {
    pending.resume();
    await save;
    await cleanup();
  }
});

test('a running device setup rejects external character, hook, Wi-Fi, and shutdown actions', async () => {
  const {service, device, store, cleanup} = await fixture();
  const pending = gate();
  let operation: Promise<void> | undefined;
  try {
    device.active = true;
    device.link = 'wifi';
    await store.reset({display: 'both', character: 'claude'});
    const install = service.installCharacter.bind(service);
    service.installCharacter = async character => {
      pending.enter();
      await pending.resumed;
      return install(character);
    };
    operation = service.setupOnboardingDevice(false);
    await pending.entered;
    const actions: Array<() => Promise<unknown>> = [
      () => CompanionService.prototype.installCharacter.call(service, 'missing'),
      () => CompanionService.prototype.setAgentEnabled.call(service, 'copilot', false),
      () => CompanionService.prototype.installAgentHook.call(service, 'copilot'),
      () => CompanionService.prototype.uninstallAgentHook.call(service, 'copilot'),
      () => service.configureWifi('Test', ''),
      () => service.scanWifi(),
      () => service.setOrientationOffset(0),
      () => service.setAgentBadgesEnabled(false),
      () => service.removeCharacter('custom'),
      () => service.stopService(),
    ];
    for (const action of actions)
      await assert.rejects(Promise.resolve().then(action), /setup \(connecting to the device\)|install to finish/);
    assert.throws(() => service.stopDesktop(), /install to finish/);
    pending.resume();
    await operation;
    assert.equal(device.characterId, 'claude');
  } finally {
    pending.resume();
    await operation;
    await cleanup();
  }
});

test('character-only USB setup follows the same board after its character restart changes the port', async () => {
  const {service, device, store, cleanup} = await fixture();
  try {
    device.active = true;
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    const install = service.installCharacter.bind(service);
    service.installCharacter = async character => {
      const result = await install(character);
      device.usbPath = process.platform === 'win32' ? 'COM8' : '/dev/cu.usbmodem8';
      return result;
    };
    await service.setupOnboardingDevice(false);
    assert.equal(store.state.port, device.usbPath);
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('a live Wi-Fi device supersedes a stale saved USB port without replacing firmware', async () => {
  const {service, device, store, flashes, cleanup} = await fixture();
  try {
    device.active = true;
    device.link = 'wifi';
    device.connectionMode = 'wifi';
    await store.reset({display: 'both', character: 'copilot', port: '/dev/old-device'});
    await service.finishOnboarding();
    assert.equal(store.state.port, null);
    assert.equal(store.state.completed, true);
    assert.equal(device.connectionMode, 'wifi');
    assert.deepEqual(flashes, []);
  } finally {
    await cleanup();
  }
});

test('Finish validates a removed character before changing the display or marking setup complete', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    await store.reset({character: 'custom', agentsDeferred: true});
    await assert.rejects(service.finishOnboarding(), /character.*(unavailable|available)/);
    assert.equal(store.state.completed, false);
    assert.deepEqual(service.displayChanges, []);
  } finally {
    await cleanup();
  }
});

test('completed setup rejects stale wizard actions and a rerun retains an available selected character', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    await store.reset({agentsDeferred: true, character: 'claude'});
    await store.finish();
    const state = store.state;
    await assert.rejects(service.updateOnboarding({character: 'copilot'}), /Run setup again/);
    await assert.rejects(service.applyOnboardingDisplay(), /Run setup again/);
    await assert.rejects(service.installOnboardingAgents(), /Run setup again/);
    await assert.rejects(service.removeOnboardingAgent('copilot'), /Run setup again/);
    await service.finishOnboarding();
    assert.deepEqual(store.state, state);
    assert.deepEqual(service.displayChanges, []);
    assert.equal((await service.restartOnboarding()).character, 'claude');
  } finally {
    await cleanup();
  }
});

test('an older installation without a setup record starts the wizard with its current character', async () => {
  const {service, device, cleanup} = await fixture();
  try {
    device.active = true;
    device.characterId = 'claude';
    assert.equal(service.onboardingStatus().completed, true);
    assert.equal((await service.restartOnboarding()).character, 'claude');
  } finally {
    await cleanup();
  }
});

test('Finish owns setup until completion is saved, and external setting changes also block setup', async () => {
  const {service, device, store, cleanup} = await fixture();
  const pending = gate();
  let finish: Promise<unknown> | undefined;
  try {
    await store.reset({agentsDeferred: true});
    const display = service.setDesktop.bind(service);
    service.setDesktop = async change => { pending.enter(); await pending.resumed; await display(change); };
    finish = service.finishOnboarding();
    await pending.entered;
    assert.equal(service.onboardingStatus().busy, true);
    await assert.rejects(service.updateOnboarding({display: 'both'}), /setup \(finishing setup\)/);
    await assert.rejects(service.restartOnboarding(), /setup \(finishing setup\)/);
    assert.equal(store.state.completed, false);
    pending.resume();
    await finish;
    assert.equal(store.state.completed, true);

    await store.reset();
    const setting = gate();
    const mode = device.setMode.bind(device);
    device.setMode = async change => { setting.enter(); await setting.resumed; await mode(change); };
    const connection = CompanionService.prototype.setConnection.call(service, 'usb');
    await setting.entered;
    try {
      await assert.rejects(service.finishOnboarding(), /: Wait for the current change to finish\.$/);
      await assert.rejects(service.updateOnboarding({display: 'both'}), /the current change/);
    } finally {
      setting.resume();
      await connection;
    }
    assert.equal(store.state.completed, false);
  } finally {
    pending.resume();
    await finish;
    await cleanup();
  }
});

test('current hooks and pending agent-side approval continue without installation consent or hook writes', async () => {
  const {service, store, root, cleanup} = await fixture();
  try {
    service.agentList = [
      {id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
        enabled: false, hookStatus: 'installed', activeSessions: 0, driving: false},
      {id: 'codex', name: 'Codex CLI', detected: true, installed: true,
        enabled: false, hookStatus: 'needs-approval', activeSessions: 0, driving: false,
        action: {kind: 'approve', title: 'Approve hooks', steps: ['Enter /hooks.']}},
      {id: 'claude', name: 'Claude Code', detected: true, installed: true,
        enabled: true, hookStatus: 'installed', activeSessions: 0, driving: false},
    ];
    await store.reset({agents: ['copilot', 'codex'], step: 'agents'});
    const results = await service.installOnboardingAgents();
    assert.deepEqual(results, [{id: 'copilot', ok: true}, {id: 'codex', ok: true}]);
    assert.deepEqual(service.hookInstalls, []);
    assert.deepEqual(service.agentList.map(agent => agent.enabled), [true, true, false]);
    assert.equal(service.agentList[1]?.hookStatus, 'needs-approval');
    assert.equal(service.agentList[1]?.action?.kind, 'approve');
    assert.equal(store.state.agentStage, 'connect');
    const config = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'));
    assert.equal(config.approved.copilot, true);
    assert.equal(config.approved.codex, true);
  } finally {
    await cleanup();
  }
});

test('step navigation preserves choices, returns to agent selection, and rejects future or hidden steps', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    await store.reset({agents: ['copilot'], character: 'claude', display: 'both'});
    for (const step of ['agents', 'character', 'display', 'firmware'] as const) await store.update({step});
    const before = store.state;
    await service.navigateOnboarding('character');
    assert.equal(store.state.step, 'character');
    assert.deepEqual(store.state.visitedSteps, before.visitedSteps);
    assert.deepEqual(store.state.agents, before.agents);
    assert.equal(store.state.character, 'claude');
    assert.equal(store.state.display, 'both');
    await service.navigateOnboarding('firmware');
    assert.equal(store.state.step, 'firmware');
    await store.update({step: 'agents', agentStage: 'connect'});
    await service.navigateOnboarding('agents');
    assert.equal(store.state.agentStage, 'select');
    await assert.rejects(service.navigateOnboarding('complete'), /not been reached/);
    await store.update({display: 'desktop'});
    await assert.rejects(service.navigateOnboarding('firmware'), /not part/);
    await store.finish();
    await assert.rejects(service.navigateOnboarding('welcome'), /Run setup again/);
    const restarted = await service.restartOnboarding();
    assert.deepEqual(restarted.visitedSteps, [...before.visitedSteps, 'complete']);
    assert.deepEqual(service.hookInstalls, []);
    assert.deepEqual(service.removals, []);
    assert.deepEqual(service.installedCharacters, []);
  } finally {
    await cleanup();
  }
});

test('mixed hook setup installs only approved missing or outdated hooks', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    service.agentList = [
      {id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
        enabled: false, hookStatus: 'installed', activeSessions: 0, driving: false},
      {id: 'claude', name: 'Claude Code', detected: true, installed: false,
        enabled: false, hookStatus: 'missing', activeSessions: 0, driving: false},
      {id: 'codex', name: 'Codex CLI', detected: true, installed: true,
        enabled: false, hookStatus: 'needs-approval', activeSessions: 0, driving: false},
      {id: 'grok', name: 'Grok Build', detected: true, installed: true,
        enabled: false, hookStatus: 'outdated', activeSessions: 0, driving: false},
    ];
    await store.reset({agents: ['copilot', 'claude', 'codex', 'grok'], step: 'agents'});
    assert.ok((await service.installOnboardingAgents(['claude', 'grok'])).every(result => result.ok));
    assert.deepEqual(service.hookInstalls, [{id: 'claude', onlyNeeded: true}, {id: 'grok', onlyNeeded: true}]);
    assert.equal(service.agentList[2]?.hookStatus, 'needs-approval');
    assert.equal(store.state.agentStage, 'connect');
  } finally {
    await cleanup();
  }
});

test('changed hooks outside the approval stop setup before any installation or enable change', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    service.agentList = [
      {id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
        enabled: false, hookStatus: 'installed', activeSessions: 0, driving: false},
      {id: 'claude', name: 'Claude Code', detected: true, installed: true,
        enabled: false, hookStatus: 'outdated', activeSessions: 0, driving: false},
    ];
    await store.reset({agents: ['copilot', 'claude'], step: 'agents'});
    for (const approved of [[], ['copilot'] as AgentId[]]) {
      await assert.rejects(service.installOnboardingAgents(approved), /Hooks changed for Claude Code/);
      assert.deepEqual(service.hookInstalls, []);
      assert.ok(service.agentList.every(agent => !agent.enabled));
      assert.equal(store.state.agentStage, 'select');
      assert.equal(service.onboardingStatus().busy, false);
      assert.match(service.onboardingStatus().error ?? '', /Review and approve/);
    }
  } finally {
    await cleanup();
  }
});

test('desktop-only and deferred-device setup complete without any firmware operation', async () => {
  const {service, store, flashes, device, cleanup} = await fixture();
  try {
    await store.reset({character: 'claude', agentsDeferred: true});
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
    assert.equal(device.enabled, false);
    assert.equal(device.characterId, 'claude');
    assert.deepEqual(flashes, []);
    await store.reset({display: 'device', deviceDeferred: true});
    await service.finishOnboarding();
    assert.ok(service.displayChanges.some(change => change.visible === true && change.deviceEnabled === false));
    assert.deepEqual(flashes, []);
  } finally {
    await cleanup();
  }
});

test('pending hook approval is not reported as ready unless the user defers it', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    service.agentList = [{id: 'codex', name: 'Codex CLI', detected: true, installed: true,
      enabled: true, hookStatus: 'needs-approval', activeSessions: 0, driving: false,
      action: {kind: 'approve', title: 'Approve hooks', steps: ['Enter /hooks.']}}];
    await store.reset({agents: ['codex']});
    await assert.rejects(service.finishOnboarding(), /Finish connecting Codex/);
    assert.equal(store.state.completed, false);
    await store.update({deferredAgents: ['codex']});
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('device completion requires a responding device with the selected character', async () => {
  const {service, store, device, flashes, cleanup} = await fixture();
  try {
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    await assert.rejects(service.finishOnboarding(), /Finish preparing/);
    device.active = true;
    await assert.rejects(service.finishOnboarding(), /Finish preparing/);
    await service.setupOnboardingDevice(false);
    assert.deepEqual(service.installedCharacters, ['claude']);
    assert.deepEqual(flashes, []);
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('firmware setup targets the selected port and restores the chosen character after flashing', async () => {
  const {service, store, device, flashes, cleanup} = await fixture();
  try {
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    await service.setupOnboardingDevice(true, 'waveshare-amoled-175');
    assert.deepEqual(flashes, [device.usbPath]);
    assert.equal(device.characterId, 'claude');
    assert.equal(service.onboardingStatus().busy, false);
    assert.equal(service.onboardingStatus().error, null);
    assert.equal(store.state.completed, false);
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('a Settings USB firmware install gives the device its previous character back', async () => {
  const {service, device, flashes, cleanup} = await fixture();
  try {
    device.active = true;
    device.characterId = 'claude';
    await service.installFirmwareOverUsb(device.usbPath);
    assert.deepEqual(flashes, [device.usbPath]);
    assert.deepEqual(service.installedCharacters, ['claude']);
    assert.equal(device.characterId, 'claude');
  } finally {
    await cleanup();
  }
});

test('a Settings USB firmware install does not reinstall the character that the firmware brings', async () => {
  const {service, device, cleanup} = await fixture();
  try {
    device.active = true;
    await service.installFirmwareOverUsb(device.usbPath);
    assert.deepEqual(service.installedCharacters, []);
    assert.equal(device.characterId, 'copilot');
  } finally {
    await cleanup();
  }
});

test('USB installs write the firmware for the board the device is, and never another board', async () => {
  const {service, device, flashes, installer, cleanup} = await fixture();
  try {
    const prepared: string[] = [];
    const flashed: string[] = [];
    installer.releases.prepare = async (version, _progress, board = 'waveshare-amoled-175') => {
      prepared.push(board);
      return {version, board, dir: '/test', id: 'aaaaaaaaaaaaaaaa'};
    };
    const flash = installer.flash;
    installer.flash = async (program, dir, port, events, board) => {
      flashed.push(board);
      await flash(program, dir, port, events, board);
    };
    device.active = true;
    device.boardId = 'waveshare-lcd-154';
    const usb = service.status().firmware.usb;
    assert.equal(service.status().firmware.board, 'waveshare-lcd-154');
    assert.deepEqual(usb.boards.map(board => board.id), ['waveshare-amoled-175', 'waveshare-lcd-154']);

    // A device that answers decides the board.
    await service.installFirmwareOverUsb(device.usbPath);
    assert.deepEqual([prepared, flashed], [['waveshare-lcd-154'], ['waveshare-lcd-154']]);
    assert.equal(service.status().firmware.usb.last?.board, 'waveshare-lcd-154');
    assert.equal(service.status().firmware.usb.releaseId, 'aaaaaaaaaaaaaaaa');
    assert.equal(service.status().firmware.usb.boards[1]!.releaseId, 'aaaaaaaaaaaaaaaa');
    assert.equal(service.status().firmware.usb.boards[0]!.releaseId, null);

    // A different choice for a device that answers is refused before any download.
    await assert.rejects(service.installFirmwareOverUsb(device.usbPath, 'waveshare-amoled-175'),
                         /reports that it is a Waveshare ESP32-S3-Touch-LCD-1\.54/);
    // A board that releases have no firmware for is refused.
    device.boardId = 'custom-board';
    await assert.rejects(service.installFirmwareOverUsb(device.usbPath), /BOARD=custom-board/);
    assert.match(service.status().firmware.usb.last?.error ?? '', /no firmware for it/);
    assert.equal(prepared.length, 1);

    // A device that does not answer needs the person to choose its board.
    device.active = false;
    await assert.rejects(service.installFirmwareOverUsb(device.usbPath), /Choose its board/);
    assert.equal(prepared.length, 1);
    device.boardId = 'waveshare-amoled-175';
    await service.installFirmwareOverUsb(device.usbPath, 'waveshare-amoled-175');
    assert.deepEqual(flashed, ['waveshare-lcd-154', 'waveshare-amoled-175']);
    assert.deepEqual(flashes, [device.usbPath, device.usbPath]);
  } finally {
    await cleanup();
  }
});

test('a device that starts answering as another board during the download is not flashed', async () => {
  const {service, device, installer, flashes, cleanup} = await fixture();
  try {
    installer.releases.prepare = async (version, _progress, board = 'waveshare-amoled-175') => {
      device.active = true;
      device.boardId = 'waveshare-lcd-154';
      return {version, board, dir: '/test', id: 'aaaaaaaaaaaaaaaa'};
    };
    await assert.rejects(service.installFirmwareOverUsb(device.usbPath, 'waveshare-amoled-175'),
                         /reports that it is a Waveshare ESP32-S3-Touch-LCD-1\.54/);
    assert.deepEqual(flashes, []);
  } finally {
    await cleanup();
  }
});

async function eventually(ready: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the test condition.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a device that starts the new firmware after the restart wait still gets its previous character back', async () => {
  const {service, device, installer, cleanup} = await fixture();
  try {
    device.active = true;
    device.characterId = 'claude';
    service.firmwareRestartMs = 50;
    // The device stays in download mode until the user power-cycles it.
    installer.flash = async () => { device.active = false; };
    await service.installFirmwareOverUsb(device.usbPath);
    assert.deepEqual(service.installedCharacters, []);
    device.active = true;
    device.firmwareId = 'aaaaaaaaaaaaaaaa';
    device.characterId = 'copilot';
    await eventually(() => service.installedCharacters.length > 0);
    assert.deepEqual(service.installedCharacters, ['claude']);
    assert.equal(device.characterId, 'claude');
  } finally {
    await cleanup();
  }
});

test('a character the user installs while the device has not started replaces the pending one', async () => {
  const {service, device, installer, cleanup} = await fixture();
  try {
    device.active = true;
    device.characterId = 'claude';
    service.firmwareRestartMs = 50;
    installer.flash = async () => { device.active = false; };
    await service.installFirmwareOverUsb(device.usbPath);
    // SetupService replaces installCharacter, so call the real one, which clears the pending character.
    await CompanionService.prototype.installCharacter.call(service, 'missing').catch(() => undefined);
    device.active = true;
    device.firmwareId = 'aaaaaaaaaaaaaaaa';
    device.characterId = 'copilot';
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(service.installedCharacters, []);
  } finally {
    await cleanup();
  }
});

test('firmware setup installs only the selected character, not the previous one', async () => {
  const {service, store, device, cleanup} = await fixture();
  try {
    device.active = true;
    device.characterId = 'claude';
    await store.reset({display: 'both', character: 'copilot', port: device.usbPath});
    await service.setupOnboardingDevice(true);
    assert.deepEqual(service.installedCharacters, []);
    assert.equal(device.characterId, 'copilot');
  } finally {
    await cleanup();
  }
});

test('a failed firmware write stays incomplete and exposes the error', async () => {
  const {service, store, device, installer, cleanup} = await fixture();
  try {
    installer.flash = async () => { throw new Error('Test write failed.'); };
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    await assert.rejects(service.setupOnboardingDevice(true, 'waveshare-amoled-175'), /Test write failed/);
    assert.equal(store.state.completed, false);
    assert.equal(service.onboardingStatus().busy, false);
    assert.equal(service.onboardingStatus().error, 'Test write failed.');
    assert.deepEqual(service.installedCharacters, []);
  } finally {
    await cleanup();
  }
});

test('the same USB device can reconnect on a new port without losing the selected character', async () => {
  const {service, store, device, installer, cleanup} = await fixture();
  try {
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    installer.flash = async () => {
      device.usbPath = process.platform === 'win32' ? 'COM8' : '/dev/cu.usbmodem8';
      device.active = true;
      device.firmwareId = 'aaaaaaaaaaaaaaaa';
    };
    await service.setupOnboardingDevice(true, 'waveshare-amoled-175');
    assert.equal(store.state.port, device.usbPath);
    assert.equal(device.characterId, 'claude');
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('swapping the selected USB device during a download never flashes the replacement', async () => {
  const {service, store, device, installer, flashes, cleanup} = await fixture();
  try {
    await store.reset({display: 'both', port: device.usbPath});
    installer.releases.prepare = async version => {
      device.serialNumber = 'different-board';
      return {version, board: 'waveshare-amoled-175', dir: '/test', id: 'aaaaaaaaaaaaaaaa'};
    };
    await assert.rejects(service.setupOnboardingDevice(true, 'waveshare-amoled-175'), /device changed/);
    assert.deepEqual(flashes, []);
    assert.equal(store.state.completed, false);
  } finally {
    await cleanup();
  }
});

test('USB setup works when an existing user previously selected Wi-Fi-only mode', async () => {
  const {service, store, device, cleanup} = await fixture();
  try {
    device.connectionMode = 'wifi';
    device.active = true;
    await store.reset({display: 'both', character: 'claude', port: device.usbPath});
    await service.setupOnboardingDevice(false);
    assert.equal(device.connectionMode, 'auto');
    assert.equal(device.characterId, 'claude');
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
  } finally {
    await cleanup();
  }
});

test('existing Wi-Fi setup installs the selected character without USB or a connection-mode change', async () => {
  const {service, store, device, flashes, cleanup} = await fixture();
  try {
    device.active = true;
    device.link = 'wifi';
    device.usbAvailable = false;
    device.connectionMode = 'wifi';
    await store.reset({display: 'both', character: 'claude', agentsDeferred: true});
    assert.deepEqual(await service.detectUsbDevices(), {ports: [], connected: null});
    await service.setupOnboardingDevice(false);
    assert.deepEqual(service.installedCharacters, ['claude']);
    assert.deepEqual(flashes, []);
    assert.equal(device.selected, null);
    assert.equal(device.characterId, 'claude');
    assert.equal(device.transport, 'wifi');
    assert.equal(device.connectionMode, 'wifi');
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
    assert.equal(device.connectionMode, 'wifi');
  } finally {
    await cleanup();
  }
});

test('setup status preserves character-only Wi-Fi intent while the device disconnects during installation', async () => {
  const {service, store, device, flashes, cleanup} = await fixture();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  try {
    device.active = true;
    device.link = 'wifi';
    device.usbAvailable = false;
    await store.reset({display: 'both', character: 'claude'});
    const original = service.installCharacter.bind(service);
    service.installCharacter = async character => {
      device.active = false;
      enter();
      await resumed;
      device.active = true;
      return original(character);
    };
    const operation = service.setupOnboardingDevice(false);
    await entered;
    assert.equal(device.transport, null);
    assert.equal(service.onboardingStatus().busy, true);
    assert.deepEqual(service.onboardingStatus().deviceSetup, {flash: false, transport: 'wifi'});
    await assert.rejects(service.navigateOnboarding('welcome'), /setup \(connecting to the device\)/);
    assert.deepEqual(flashes, []);
    resume();
    await operation;
    assert.equal(service.onboardingStatus().deviceSetup, null);
    assert.equal(service.onboardingStatus().busy, false);
    assert.equal(device.characterId, 'claude');
  } finally {
    resume();
    await cleanup();
  }
});

test('a ready Wi-Fi device needs no reinstall and cannot be USB-flashed without a selected port', async () => {
  const {service, store, device, flashes, cleanup} = await fixture();
  try {
    device.active = true;
    device.link = 'wifi';
    device.usbAvailable = false;
    await store.reset({display: 'device', agentsDeferred: true});
    assert.throws(() => service.setupOnboardingDevice(true), /Detect and select the USB device first/);
    await service.setupOnboardingDevice(false);
    assert.deepEqual(service.installedCharacters, []);
    assert.deepEqual(flashes, []);
    assert.equal(service.onboardingStatus().deviceSetup, null);
    await service.finishOnboarding();
    assert.equal(store.state.completed, true);
    assert.equal(device.transport, 'wifi');
  } finally {
    await cleanup();
  }
});

test('reopening setup preserves selected agents and approved deselection removes hooks in every location', async () => {
  const {service, store, cleanup} = await fixture();
  try {
    service.agentList = [{id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
      enabled: true, hookStatus: 'installed', activeSessions: 0, driving: false}];
    await store.reset({agents: ['copilot']});
    await store.finish();
    assert.deepEqual((await service.restartOnboarding()).agents, ['copilot']);
    const removed = await service.removeOnboardingAgent('copilot');
    assert.deepEqual(service.removals, [{id: 'copilot', allLocations: true}]);
    assert.deepEqual(removed.state.agents, []);
    assert.equal(service.agentList[0]?.enabled, false);
    await store.finish();
    assert.deepEqual((await service.restartOnboarding()).agents, []);
    await assert.rejects(service.removeOnboardingAgent('copilot'), /selection changed/);
  } finally {
    await cleanup();
  }
});

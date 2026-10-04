import {chmod, mkdir, unlink} from 'node:fs/promises';
import {createConnection, createServer, type Socket} from 'node:net';
import {dirname} from 'node:path';
import {characterStates, hookEvents, type DaemonRequest} from './protocol.js';
import {socketPath, statePath} from './paths.js';
import {StateCoordinator} from './state-coordinator.js';
import {StateStore} from './state-store.js';
import {DeviceTransport} from './device-transport.js';
import {isConnectionMode, loadConnectionMode} from './connection-mode.js';
import {CompanionService} from './companion-service.js';
import {startSettingsServer} from './settings-server.js';
import {isAgentId} from './agents/types.js';
import {defaultAgentContext, normalizeAgentHook} from './agents/index.js';
import {loadAgentBadgeIcons} from './agent-badges.js';
import {desktopBackdrops, isDesktopBackdrop, isDesktopVolume} from './display-settings.js';
import {isUsageWindow, usageWindows} from './usage-tracker.js';

const autoInstallRetryMs = 5 * 60 * 1000;

export async function runDaemon(): Promise<void> {
  let lastAutoInstall = 0;
  let service: CompanionService | undefined;
  // A device that lost its pack (for example, an interrupted install) gets the preferred one back.
  let settingsUrl: string | null = null;
  const transport = new DeviceTransport(() => {
    if (!service || transport.installing || Date.now() - lastAutoInstall < autoInstallRetryMs) return;
    lastAutoInstall = Date.now();
    service.restoreCharacter().catch(error => console.error(`[character] automatic install failed: ${
      error instanceof Error ? error.message : String(error)}`));
  }, () => void service?.openSettings(settingsUrl));
  const store = new StateStore(statePath());
  const restored = await store.load();
  const agentContext = defaultAgentContext();
  const badgeIcons = await loadAgentBadgeIcons(agentContext.dataDir);
  const coordinator = new StateCoordinator(state => transport.setState(state), {
    restored,
    onMutation: state => {
      store.schedule(state);
      service?.syncBadges();
      service?.syncUsage();
    },
  });
  service = new CompanionService(transport, coordinator, agentContext, badgeIcons);
  // Picks up characters added or changed since the last run before anyone opens the settings page.
  void service.refreshCharacterPacks();
  await service.refreshWifiPairing();
  await service.refreshCharacterPreference();
  void service.loadSavedRelease();
  transport.setState(coordinator.state);
  service.syncBadges();
  service.startUsage();
  const path = socketPath();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await removeStaleSocket(path);

  const companion = service;
  const server = createServer({allowHalfOpen: true},
    socket => handleSocket(socket, coordinator, transport, companion, () => settingsUrl));
  server.on('error', error => {
    console.error(`[daemon] ${error.message}`);
    process.exitCode = 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  await transport.start(await loadConnectionMode());
  console.log(`[daemon] listening ${path}`);
  settingsUrl = await startSettingsServer(companion);

  const shutdown = async () => {
    companion.stopUsage();
    coordinator.close();
    await store.flush(coordinator.snapshot());
    await transport.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(path).catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

export const agentHookTimeoutMs = 45_000;

function handleSocket(socket: Socket, coordinator: StateCoordinator, transport: DeviceTransport,
                      service: CompanionService, settingsUrl: () => string | null): void {
  socket.setEncoding('utf8');
  socket.setTimeout(2000, () => socket.destroy());
  socket.on('error', () => undefined);
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    if (input.length > 65536) socket.destroy();
  });
  const reply = (work: Promise<unknown>) => void work.then(
    result => respond(socket, result),
    error => respond(socket, {ok: false, error: error instanceof Error ? error.message : String(error)}));
  socket.on('end', () => {
    try {
      const request = JSON.parse(input.trim()) as DaemonRequest;
      if (request.type === 'hook') {
        const agent = isAgentId(request.agent) ? request.agent : 'copilot';
        const eventName = typeof request.event === 'string' ? request.event : undefined;
        const canonical = hookEvents.includes(eventName as never) && !request.nativeEvent
          ? [{event: eventName as typeof hookEvents[number], payload: request.payload ?? {}}]
          : normalizeAgentHook(agent, request.nativeEvent ?? eventName, request.payload ?? {});
        for (const hook of canonical) service.handleHook(agent, hook.event, hook.payload);
        // A manual `send` only lasts until the next agent event; otherwise the device keeps it for
        // as long as the coordinator stays in one state, which can be hours while agents work.
        if (transport.state !== coordinator.state) transport.setState(coordinator.state);
        respond(socket, {ok: true, state: coordinator.state});
      } else if (request.type === 'send' && characterStates.includes(request.state)) {
        transport.setState(request.state);
        respond(socket, {ok: true, state: request.state});
      } else if (request.type === 'status') {
        const command = request.client === 'desktop'
          ? service.desktopSeen({
            executable: request.executable, environment: request.environment, flasher: request.flasher,
          }) : null;
        respond(socket, command ? {...service.status(), desktopCommand: command} : service.status());
      } else if (request.type === 'agents') {
        respond(socket, service.agentStatuses());
      } else if (request.type === 'agentEnable' && isAgentId(request.agent)) {
        reply(service.setAgentEnabled(request.agent, Boolean(request.enabled)).then(agents => ({ok: true, agents})));
      } else if (request.type === 'agentInstall' && isAgentId(request.agent)) {
        // OpenClaw runs several of its own CLI commands, each allowed up to 10 seconds.
        socket.setTimeout(agentHookTimeoutMs, () => socket.destroy());
        reply(service.installAgentHook(request.agent).then(agents => ({ok: true, agents})));
      } else if (request.type === 'agentUninstall' && isAgentId(request.agent)) {
        socket.setTimeout(agentHookTimeoutMs, () => socket.destroy());
        reply(service.uninstallAgentHook(request.agent).then(agents => ({ok: true, agents})));
      } else if (request.type === 'reloadWifi') {
        reply(service.refreshWifiPairing().then(() => transport.reloadWifi()).then(() => ({ok: true})));
      } else if (request.type === 'configureWifi') {
        socket.setTimeout(10000, () => socket.destroy());
        reply(service.configureWifi(request.ssid, request.password).then(deviceId => ({ok: true, deviceId})));
      } else if (request.type === 'setConnection' && isConnectionMode(request.mode)) {
        const mode = request.mode;
        reply(service.setConnection(mode).then(() => ({ok: true, mode})));
      } else if (request.type === 'badges' && typeof request.enabled === 'boolean') {
        reply(service.setAgentBadgesEnabled(request.enabled).then(() => ({ok: true, enabled: request.enabled})));
      } else if (request.type === 'desktop') {
        if (request.visible !== undefined && typeof request.visible !== 'boolean')
          throw new Error('Desktop visibility must be true or false.');
        if (request.backdrop !== undefined && !isDesktopBackdrop(request.backdrop))
          throw new Error(`Desktop backdrop must be one of: ${desktopBackdrops.join(', ')}.`);
        if (request.sounds !== undefined && typeof request.sounds !== 'boolean')
          throw new Error('Desktop sounds must be on (true) or off (false).');
        if (request.volume !== undefined && !isDesktopVolume(request.volume))
          throw new Error('Desktop volume must be a whole number from 0 to 100.');
        if (request.character !== undefined && typeof request.character !== 'string')
          throw new Error('Desktop character must be a character id.');
        const change = {visible: request.visible, backdrop: request.backdrop, sounds: request.sounds,
                        volume: request.volume, character: request.character};
        reply(service.setDesktop(change).then(() => ({ok: true, desktop: service.status().desktop})));
      } else if (request.type === 'usage') {
        if (request.enabled !== undefined && typeof request.enabled !== 'boolean')
          throw new Error('Usage must be on (true) or off (false).');
        if (request.window !== undefined && !isUsageWindow(request.window))
          throw new Error(`Usage window must be one of: ${usageWindows.join(', ')}.`);
        reply(service.setUsage({enabled: request.enabled, window: request.window})
          .then(() => ({ok: true, usage: service.status().usage})));
      } else if (request.type === 'listCharacters') {
        reply(service.characters());
      } else if (request.type === 'settings') {
        respond(socket, {url: settingsUrl()});
      } else if (request.type === 'installCharacter' && typeof request.character === 'string') {
        // Installs take about a minute, so progress streams as JSON lines until the result.
        socket.setTimeout(0);
        let shown = -1;
        reply(service.installCharacter(request.character, (sent, total) => {
          const percent = Math.floor(sent * 100 / total);
          if (percent === shown || socket.destroyed) return;
          shown = percent;
          socket.write(`${JSON.stringify({progress: percent})}\n`);
        }));
      } else {
        throw new Error('Unknown daemon request.');
      }
    } catch (error) {
      respond(socket, {ok: false, error: error instanceof Error ? error.message : String(error)});
    }
  });
}

function respond(socket: Socket, response: unknown): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function removeStaleSocket(path: string): Promise<void> {
  const active = await new Promise<boolean>(resolve => {
    const socket = createConnection(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      resolve(code !== 'ENOENT' && code !== 'ECONNREFUSED');
    });
  });
  if (active) throw new Error(`Agent Companion daemon is already listening at ${path}`);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

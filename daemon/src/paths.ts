import {readFileSync} from 'node:fs';
import {homedir, tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface ServiceInfo {
  // The folder the daemon runs from: this repository, or the copy the desktop app installs.
  root: string;
  version: string | null;
}

// This file runs from daemon/dist/src, so the root is three folders up.
export function serviceInfo(root = fileURLToPath(new URL('../../../', import.meta.url))): ServiceInfo {
  const trimmed = root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
  let version: string | null = null;
  try {
    version = readFileSync(join(trimmed, 'VERSION'), 'utf8').trim() || null;
  } catch {
    // A checkout without VERSION still runs.
  }
  return {root: trimmed, version};
}

export function socketPath(): string {
  if (process.env.AGENT_COMPANION_SOCKET) return process.env.AGENT_COMPANION_SOCKET;
  return defaultSocketPath(process.platform, homedir(), process.env, tmpdir(),
                           process.getuid?.() ?? userInfo().uid);
}

export function defaultSocketPath(
    platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv,
    temporary: string, uid: number): string {
  if (platform === 'darwin')
    return join(defaultDataDirectory(platform, home, environment), 'daemon.sock');
  const runtime = environment.XDG_RUNTIME_DIR;
  return runtime
    ? join(runtime, 'esp32-agent-companion', 'daemon.sock')
    : join(temporary, `esp32-agent-companion-${uid}`, 'daemon.sock');
}

export function statePath(): string {
  if (process.env.AGENT_COMPANION_STATE) return process.env.AGENT_COMPANION_STATE;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'state.json');
}

export function wifiConfigPath(): string {
  if (process.env.AGENT_COMPANION_WIFI_CONFIG) return process.env.AGENT_COMPANION_WIFI_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'wifi.json');
}

export function connectionPreferencePath(): string {
  if (process.env.AGENT_COMPANION_CONNECTION_CONFIG) return process.env.AGENT_COMPANION_CONNECTION_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'connection.json');
}

export function userCharacterDirectory(): string {
  if (process.env.AGENT_COMPANION_USER_CHARACTERS) return process.env.AGENT_COMPANION_USER_CHARACTERS;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'characters');
}

export function settingsInfoPath(): string {
  if (process.env.AGENT_COMPANION_SETTINGS_INFO) return process.env.AGENT_COMPANION_SETTINGS_INFO;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'settings.json');
}

export function agentsConfigPath(): string {
  if (process.env.AGENT_COMPANION_AGENTS_CONFIG) return process.env.AGENT_COMPANION_AGENTS_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'agents.json');
}

export function characterPreferencePath(): string {
  if (process.env.AGENT_COMPANION_CHARACTER_CONFIG) return process.env.AGENT_COMPANION_CHARACTER_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'character.json');
}

export function displaySettingsPath(): string {
  if (process.env.AGENT_COMPANION_DISPLAY_CONFIG) return process.env.AGENT_COMPANION_DISPLAY_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'display.json');
}

export function desktopAppPath(): string {
  if (process.env.AGENT_COMPANION_DESKTOP_APP) return process.env.AGENT_COMPANION_DESKTOP_APP;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'desktop-app.json');
}

export function usageCachePath(): string {
  if (process.env.AGENT_COMPANION_USAGE_CACHE) return process.env.AGENT_COMPANION_USAGE_CACHE;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'usage-cache.json');
}

export function defaultDataDirectory(
    platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string {
  if (platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'ESP32 Agent Companion');
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'),
              'esp32-agent-companion');
}

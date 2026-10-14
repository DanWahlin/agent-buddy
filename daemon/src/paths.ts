import {readFileSync} from 'node:fs';
import {homedir, tmpdir, userInfo} from 'node:os';
import {join, posix, win32} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface ServiceInfo {
  // The folder the daemon runs from: this repository, or the copy the desktop app installs.
  root: string;
  version: string | null;
  // The ID of the release firmware for this version. The desktop build writes it
  // (desktop/apps/desktop/scripts/bundle-daemon.mjs); a checkout has none.
  releaseFirmwareId: string | null;
}

// This file runs from daemon/dist/src, so the root is three folders up.
export function serviceInfo(root = fileURLToPath(new URL('../../../', import.meta.url))): ServiceInfo {
  const trimmed = root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
  const releaseFirmwareId = readTrimmed(join(trimmed, 'RELEASE_FIRMWARE_ID'));
  return {
    root: trimmed,
    version: readTrimmed(join(trimmed, 'VERSION')),
    releaseFirmwareId: releaseFirmwareId && /^[0-9a-f]{16}$/.test(releaseFirmwareId) ? releaseFirmwareId : null,
  };
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    // A checkout has no VERSION and no RELEASE_FIRMWARE_ID, and it still runs.
    return null;
  }
}

export function socketPath(): string {
  if (process.env.AGENT_COMPANION_SOCKET) return process.env.AGENT_COMPANION_SOCKET;
  return defaultSocketPath(process.platform, homedir(), process.env, tmpdir(),
                           process.getuid?.() ?? userInfo().uid, currentUserName());
}

function currentUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'user';
  }
}

// Windows has no Unix sockets for this use, so the daemon listens on a named pipe per user.
export function isNamedPipe(path: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(path);
}

export function windowsPipeName(user: string): string {
  const safe = user.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user';
  return `\\\\.\\pipe\\esp32-agent-companion-${safe}`;
}

export function defaultSocketPath(
    platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv,
    temporary: string, uid: number, user = 'user'): string {
  if (platform === 'win32') return windowsPipeName(user);
  if (platform === 'darwin')
    return posix.join(defaultDataDirectory(platform, home, environment), 'daemon.sock');
  const runtime = environment.XDG_RUNTIME_DIR;
  return runtime
    ? posix.join(runtime, 'esp32-agent-companion', 'daemon.sock')
    : posix.join(temporary, `esp32-agent-companion-${uid}`, 'daemon.sock');
}

export function statePath(): string {
  if (process.env.AGENT_COMPANION_STATE) return process.env.AGENT_COMPANION_STATE;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'state.json');
}

export function wifiConfigPath(): string {
  if (process.env.AGENT_COMPANION_WIFI_CONFIG) return process.env.AGENT_COMPANION_WIFI_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'wifi.json');
}

// The Deepgram API key, kept apart from display.json so status never carries it.
export function deepgramConfigPath(): string {
  if (process.env.AGENT_COMPANION_DEEPGRAM_CONFIG) return process.env.AGENT_COMPANION_DEEPGRAM_CONFIG;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'deepgram.json');
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

export function onboardingPath(): string {
  if (process.env.AGENT_COMPANION_ONBOARDING) return process.env.AGENT_COMPANION_ONBOARDING;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'onboarding.json');
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

// Records that this computer has used a device, so quitting the desktop app leaves the service running.
export function deviceHistoryPath(): string {
  if (process.env.AGENT_COMPANION_DEVICE_HISTORY) return process.env.AGENT_COMPANION_DEVICE_HISTORY;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'device.json');
}

// Present while the service is stopped on request; the desktop app then starts it without waiting.
// The name is also in desktop/apps/desktop/src-tauri/src/service.rs.
export function serviceStoppedPath(): string {
  if (process.env.AGENT_COMPANION_SERVICE_STOPPED) return process.env.AGENT_COMPANION_SERVICE_STOPPED;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'service-stopped');
}

export function usageCachePath(): string {
  if (process.env.AGENT_COMPANION_USAGE_CACHE) return process.env.AGENT_COMPANION_USAGE_CACHE;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'usage-cache.json');
}

// %LOCALAPPDATA%, or its usual place when it is not set to an absolute path.
export function windowsLocalAppData(home: string, environment: NodeJS.ProcessEnv): string {
  const local = environment.LOCALAPPDATA?.trim();
  return local && win32.isAbsolute(local) ? local : win32.join(home, 'AppData', 'Local');
}

export function defaultDataDirectory(
    platform: NodeJS.Platform, home: string, environment: NodeJS.ProcessEnv): string {
  if (platform === 'darwin')
    return posix.join(home, 'Library', 'Application Support', 'ESP32 Agent Companion');
  if (platform === 'win32') return win32.join(windowsLocalAppData(home, environment), 'ESP32 Agent Companion');
  return posix.join(environment.XDG_STATE_HOME ?? posix.join(home, '.local', 'state'),
              'esp32-agent-companion');
}

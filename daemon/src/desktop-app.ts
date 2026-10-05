import {spawn} from 'node:child_process';
import {constants, existsSync, readFileSync} from 'node:fs';
import {access, chmod, mkdir, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, isAbsolute, posix, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopAppPath, windowsLocalAppData} from './paths.js';

// The desktop app asks for status about every 400 ms, so a longer gap means it has gone.
const seenWithinMs = 3000;
const startingForMs = 20_000;
const quitPendingForMs = 5000;
const settingsPendingForMs = 3000;
const locationsCacheMs = 10_000;
const maxValueLength = 4096;

// What a GUI app needs to reach the user's display. A service manager does not always pass these on.
export const desktopEnvironmentNames = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE',
] as const;

export type DesktopAppState = 'running' | 'starting' | 'stopping' | 'stopped';

// What the service tells the app to do in its next status reply.
export type DesktopCommand = 'quit' | 'settings';

export interface DesktopAppStatus {
  state: DesktopAppState;
  // Whether the service knows where the app is: from a time it ran, or a usual install location.
  canStart: boolean;
  // Why the last start failed, when the app closed before it reached the service.
  error: string | null;
}

// What the desktop app tells the service about itself on each status request.
export interface DesktopAppReport {
  executable?: unknown;
  environment?: unknown;
  // 1 when the app can install firmware over USB (`--flash-firmware`).
  flasher?: unknown;
}

export interface SavedDesktopApp {
  executable: string;
  environment: Record<string, string>;
  flasher?: true;
}

// Starts the app. `exited` is called if the started process closes; a code that is not 0 is a failure.
export type DesktopLauncher = (app: SavedDesktopApp, exited: (code: number | null) => void) => Promise<void>;

export interface DesktopAppOptions {
  path?: string;
  now?: () => number;
  launch?: DesktopLauncher;
  // Where to look for the app before it has run one time.
  locations?: string[];
}

// The desktop app is a separate program. It follows the service, so the service knows it runs
// while it asks for status, and can start it again from where it last ran.
export class DesktopApp {
  #saved: SavedDesktopApp | null;
  #lastSeen = 0;
  #startedAt = 0;
  #quitAt = 0;
  #settingsAt = 0;
  #error: string | null = null;
  #saving: Promise<void> = Promise.resolve();
  #found: {at: number; executable: string | null} | null = null;
  readonly #path: string;
  readonly #now: () => number;
  readonly #launch: DesktopLauncher;
  readonly #locations: string[];

  constructor(options: DesktopAppOptions = {}) {
    this.#path = options.path ?? desktopAppPath();
    this.#now = options.now ?? Date.now;
    this.#launch = options.launch ?? launchDesktopApp;
    this.#locations = options.locations ?? defaultDesktopAppLocations(process.platform, homedir(), repositoryRoot());
    this.#saved = loadSavedDesktopApp(this.#path);
  }

  get running(): boolean {
    return this.#lastSeen > 0 && this.#now() - this.#lastSeen < seenWithinMs;
  }

  status(): DesktopAppStatus {
    const now = this.#now();
    const running = this.running;
    let state: DesktopAppState = running ? 'running' : 'stopped';
    if (running && this.#quitPending(now)) state = 'stopping';
    else if (!running && this.#startedAt > 0 && now - this.#startedAt < startingForMs) state = 'starting';
    return {state, canStart: this.#target() !== null, error: this.#error};
  }

  // The display variables the app last reported, for other programs the service opens.
  get environment(): Record<string, string> {
    return this.#saved?.environment ?? {};
  }

  // Records a status request from the desktop app. `command` tells it what to do now.
  seen(report: DesktopAppReport): {command: DesktopCommand | null; changed: boolean} {
    const now = this.#now();
    if (this.#quitPending(now)) {
      this.#quitAt = 0;
      this.#settingsAt = 0;
      this.#lastSeen = 0;
      return {command: 'quit', changed: true};
    }
    const settings = this.#settingsAt > 0 && now - this.#settingsAt < settingsPendingForMs;
    this.#settingsAt = 0;
    const changed = !this.running || this.#error !== null;
    this.#lastSeen = now;
    this.#startedAt = 0;
    this.#error = null;
    const app = parseDesktopAppReport(report);
    if (app && JSON.stringify(app) !== JSON.stringify(this.#saved)) {
      this.#saved = app;
      this.#saving = this.#saving.then(() => saveDesktopApp(this.#path, app)).catch(error =>
        console.error(`[desktop] could not save the app's location: ${error instanceof Error ? error.message : String(error)}`));
    }
    return {command: settings ? 'settings' : null, changed};
  }

  // Asks a running app to open its Settings window at its next status request. False when the
  // app does not run, or is closing.
  openSettings(): boolean {
    const now = this.#now();
    if (!this.running || this.#quitPending(now)) return false;
    this.#settingsAt = now;
    return true;
  }

  // The program that installs firmware over USB: the app itself, when the version that ran last can.
  flasher(): string | null {
    return this.#saved?.flasher ? desktopFlasherPath(this.#saved.executable, process.platform) : null;
  }

  // Resolves when the app's location is on disk.
  saved(): Promise<void> {
    return this.#saving;
  }

  async start(): Promise<void> {
    const {state} = this.status();
    if (state === 'running' || state === 'starting') return;
    if (state === 'stopping') throw new Error('The desktop app is closing. Try again in a moment.');
    const target = this.#target();
    if (!target) throw new Error('The service cannot find the desktop app. Download it or build it (see '
      + '"Run the desktop app" in the README), and open it one time yourself.');
    this.#error = null;
    const startedAt = this.#now();
    await this.#launch(target, code => {
      // Only a start that has not reached the service yet can fail; a later exit is the app closing.
      if (code === 0 || this.#startedAt !== startedAt) return;
      this.#startedAt = 0;
      this.#error = `The desktop app closed when it started${code === null ? '' : ` (exit code ${code})`}. `
        + 'Open it one time yourself, then try again from here.';
      console.error(`[desktop] ${this.#error}`);
    });
    this.#startedAt = startedAt;
  }

  // Where the app is: where it ran last, else the first usual location that has it.
  location(): string | null {
    return this.#target()?.executable ?? null;
  }

  stop(): void {
    if (!this.running) return;
    this.#startedAt = 0;
    this.#quitAt = this.#now();
  }

  #quitPending(now: number): boolean {
    return this.#quitAt > 0 && now - this.#quitAt < quitPendingForMs;
  }

  // Where the app ran last; else the first usual location that has it. Lookups are cached
  // because the desktop app asks for status a few times a second.
  #target(): SavedDesktopApp | null {
    if (this.#saved) return this.#saved;
    const now = this.#now();
    if (!this.#found || now - this.#found.at >= locationsCacheMs)
      this.#found = {at: now, executable: this.#locations.find(location => existsSync(location)) ?? null};
    return this.#found.executable ? {executable: this.#found.executable, environment: {}} : null;
  }
}

// The download's usual install locations come first, then a build in this repository.
export function defaultDesktopAppLocations(platform: NodeJS.Platform, home: string, repository: string,
                                           env: NodeJS.ProcessEnv = process.env): string[] {
  const program = platform === 'win32' ? 'agent-companion-desktop.exe' : 'agent-companion-desktop';
  const {join} = platform === 'win32' ? win32 : posix;
  const build = (profile: string) =>
    join(repository, 'desktop', 'apps', 'desktop', 'src-tauri', 'target', profile, program);
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files';
    // The installer is per user by default; a per-machine install goes to Program Files.
    return [join(windowsLocalAppData(home, env), 'Agent Companion', program),
            join(programFiles, 'Agent Companion', program), build('release'), build('debug')];
  }
  if (platform === 'darwin')
    return ['/Applications/Agent Companion.app', join(home, 'Applications', 'Agent Companion.app'),
            build('release'), build('debug')];
  if (platform === 'linux') return ['/usr/bin/agent-companion-desktop', build('release'), build('debug')];
  return [];
}

// This file runs from daemon/dist/src or daemon/src.
function repositoryRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

export function parseDesktopAppReport(report: DesktopAppReport): SavedDesktopApp | null {
  const {executable} = report;
  if (typeof executable !== 'string' || !isAbsolute(executable) || !isSafeValue(executable)) return null;
  const environment: Record<string, string> = {};
  const reported = report.environment;
  if (reported && typeof reported === 'object' && !Array.isArray(reported)) {
    for (const name of desktopEnvironmentNames) {
      const value = (reported as Record<string, unknown>)[name];
      if (typeof value === 'string' && value && isSafeValue(value)) environment[name] = value;
    }
  }
  return report.flasher === 1 ? {executable, environment, flasher: true} : {executable, environment};
}

// A macOS app bundle's program is inside it; an AppImage or plain binary runs as it is.
export function desktopFlasherPath(executable: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' && /\.app\/?$/.test(executable)
    ? posix.join(executable.replace(/\/+$/, ''), 'Contents', 'MacOS', 'agent-companion-desktop') : executable;
}

function isSafeValue(value: string): boolean {
  return value.length <= maxValueLength && !value.includes('\0');
}

function loadSavedDesktopApp(path: string): SavedDesktopApp | null {
  try {
    return parseDesktopAppReport(JSON.parse(readFileSync(path, 'utf8')) as DesktopAppReport);
  } catch {
    return null;
  }
}

async function saveDesktopApp(path: string, app: SavedDesktopApp): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(`${path}.tmp`, `${JSON.stringify(app, null, 2)}\n`, {mode: 0o600});
  await rename(`${path}.tmp`, path);
  await chmod(path, 0o600);
}

// A macOS app bundle opens through Launch Services; anything else runs as it is.
export function desktopLaunchCommand(executable: string, platform: NodeJS.Platform): [string, string[]] {
  return platform === 'darwin' && /\.app\/?$/.test(executable)
    ? ['/usr/bin/open', [executable]] : [executable, []];
}

export const launchDesktopApp: DesktopLauncher = async (app, exited) => {
  const [command, args] = desktopLaunchCommand(app.executable, process.platform);
  const direct = command === app.executable;
  try {
    await access(app.executable, direct ? constants.X_OK : constants.F_OK);
  } catch {
    throw new Error(`The desktop app is no longer at ${app.executable}. Open it one time yourself so the `
      + 'service can find it again.');
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    // A build in the repository finds the repository's character packs from where it runs.
    ...(direct ? {cwd: dirname(app.executable)} : {}),
    env: {...process.env, ...app.environment},
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.once('exit', code => exited(code));
  child.unref();
  console.log(`[desktop] started ${app.executable}`);
};

import {closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync} from 'node:fs';
import {join, win32} from 'node:path';
import {windowsLocalAppData} from '../paths.js';
import {environmentValue} from './commands.js';
import type {AgentContext} from './types.js';

// A desktop app that runs an agent with the same settings folder as the agent's CLI.
export interface DesktopApp {
  // The app as the user knows it, for example "ChatGPT app".
  label: string;
  // The install folder. For a Windows Store (MSIX) app, it is known after the first registry probe.
  path?: string;
  version?: string;
}

// Where an app installs on each system.
export interface AppSpec {
  label: string;
  // The app bundle, in /Applications or ~/Applications.
  mac?: string;
  windows?: {
    // MSIX package family names (`<Name>_<PublisherId>`).
    packages?: readonly string[];
    // A per-user (`LOCALAPPDATA`) or machine (`ProgramFiles`) install: the folder and the program in it.
    folders?: ReadonlyArray<{base: 'LOCALAPPDATA' | 'ProgramFiles'; folder: string; program: string}>;
    // The key under HKCU\...\Uninstall whose DisplayVersion is the app's version.
    uninstallKey?: string;
    // A Squirrel install in LOCALAPPDATA, with the program and its app-<version> folders.
    squirrel?: {folder: string; program: string};
  };
  // The install folder under /usr/lib or /opt, as .deb, .rpm, and Arch packages install it.
  linux?: string;
}

type AppContext = Pick<AgentContext, 'home' | 'platform' | 'env' | 'appFolders' | 'hostPath' | 'runCommand'>;

// Desktop apps run on this computer's own system, so an agent location in WSL (a context with
// hostPath) has none.
export function findApp(ctx: AppContext, spec: AppSpec): DesktopApp | undefined {
  if (ctx.hostPath) return undefined;
  if (ctx.platform === 'darwin') return spec.mac ? macApp(ctx, spec.mac, spec.label) : undefined;
  if (ctx.platform === 'win32') return spec.windows ? windowsApp(ctx, spec.windows, spec.label) : undefined;
  if (ctx.platform === 'linux') return spec.linux ? linuxApp(ctx, spec.linux, spec.label) : undefined;
  return undefined;
}

// The version of the CLI and of each app, for example "CLI 0.162.1 · ChatGPT app 26.715".
export function clientVersions(cli: string | undefined, apps: readonly DesktopApp[]): string | undefined {
  const parts = [
    cli && `CLI ${cli}`,
    ...apps.map(app => app.version ? `${app.label} ${app.version}` : app.label),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

// The Codex CLI that the ChatGPT app (and the older macOS Codex app) includes. A user who has only
// an app runs it in a terminal to approve hooks, because only the terminal Codex can approve them.
export function bundledCodexCli(ctx: Pick<AgentContext, 'platform'>, app: DesktopApp): string | undefined {
  if (!app.path) return undefined;
  const path = ctx.platform === 'darwin' ? join(app.path, 'Contents', 'Resources', 'codex')
    : ctx.platform === 'win32' ? join(app.path, 'app', 'resources', 'codex.exe')
    : join(app.path, 'resources', 'codex');
  return existsSync(path) ? path : undefined;
}

// Paths of another system reach the file system only in tests, so all paths use this system's join.
function macApp(ctx: AppContext, bundle: string, label: string): DesktopApp | undefined {
  for (const folder of ctx.appFolders ?? ['/Applications', join(ctx.home, 'Applications')]) {
    const path = join(folder, bundle);
    let plist: string;
    try {
      plist = readFileSync(join(path, 'Contents', 'Info.plist'), 'utf8');
    } catch {
      continue;
    }
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
    return {label, path, ...(version ? {version} : {})};
  }
  return undefined;
}

function linuxApp(ctx: AppContext, folder: string, label: string): DesktopApp | undefined {
  for (const parent of ctx.appFolders ?? ['/usr/lib', '/opt']) {
    const path = join(parent, folder);
    if (!existsSync(path)) continue;
    const version = linuxAppVersion(join(path, 'resources'));
    return {label, path, ...(version ? {version} : {})};
  }
  return undefined;
}

// The ChatGPT package writes its version to a metadata file. Other Electron apps have it only in
// the package.json inside app.asar.
function linuxAppVersion(resources: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(resources, 'linux-package-metadata.json'), 'utf8')) as
      {version?: unknown}).version;
    if (typeof version === 'string') return version;
  } catch {
    // No metadata file.
  }
  return asarPackageVersion(join(resources, 'app.asar'));
}

const asarVersions = new Map<string, string | undefined>();

// An asar archive starts with its size fields and a JSON index of its files; package.json is
// read from its offset after that index. The result is kept until the file changes.
export function asarPackageVersion(path: string): string | undefined {
  let key: string;
  try {
    const details = statSync(path);
    key = `${path}:${details.mtimeMs}:${details.size}`;
  } catch {
    return undefined;
  }
  if (asarVersions.has(key)) return asarVersions.get(key);
  let version: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const read = (length: number, position: number) => {
      const buffer = Buffer.alloc(length);
      if (readSync(fd!, buffer, 0, length, position) !== length) throw new Error('Short read');
      return buffer;
    };
    const sizes = read(16, 0);
    const headerSize = sizes.readUInt32LE(4);
    const jsonLength = sizes.readUInt32LE(12);
    if (jsonLength > 64 * 1024 * 1024) throw new Error('Index too large');
    const index = JSON.parse(read(jsonLength, 16).toString('utf8')) as {files?: Record<string, {size?: number; offset?: string}>};
    const entry = index.files?.['package.json'];
    if (entry && typeof entry.size === 'number' && entry.size < 1024 * 1024 && typeof entry.offset === 'string') {
      const value = (JSON.parse(read(entry.size, 8 + headerSize + Number(entry.offset)).toString('utf8')) as
        {version?: unknown}).version;
      if (typeof value === 'string') version = value;
    }
  } catch {
    version = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  asarVersions.set(key, version);
  return version;
}

function windowsApp(ctx: AppContext, spec: NonNullable<AppSpec['windows']>, label: string): DesktopApp | undefined {
  const local = windowsLocalAppData(ctx.home, {LOCALAPPDATA: environmentValue(ctx.env, 'LOCALAPPDATA', 'win32')});
  const programFiles = environmentValue(ctx.env, 'ProgramFiles', 'win32') || 'C:\\Program Files';
  for (const family of spec.packages ?? []) {
    // Windows makes this folder for each user who has the package.
    let installedAt: number;
    try {
      const folder = statSync(join(local, 'Packages', family));
      installedAt = folder.birthtimeMs || folder.ctimeMs;
    } catch {
      continue;
    }
    const found = windowsPackages(ctx, installedAt).get(family);
    return {label, ...(found ? {path: found.root, version: found.version} : {})};
  }
  for (const {base, folder, program} of spec.folders ?? []) {
    const path = join(base === 'LOCALAPPDATA' ? local : programFiles, ...folder.split('\\'));
    if (!existsSync(join(path, program))) continue;
    const version = spec.uninstallKey && base === 'LOCALAPPDATA' ? uninstallVersion(ctx, spec.uninstallKey) : undefined;
    return {label, path, ...(version ? {version} : {})};
  }
  if (spec.squirrel) {
    const path = join(local, spec.squirrel.folder);
    if (existsSync(join(path, spec.squirrel.program))) {
      const version = newestSquirrelVersion(path);
      return {label, path, ...(version ? {version} : {})};
    }
  }
  return undefined;
}

function newestSquirrelVersion(path: string): string | undefined {
  try {
    return readdirSync(path).flatMap(name => /^app-(\d+(?:\.\d+)*)$/.exec(name)?.[1] ?? [])
      .sort((first, second) => second.localeCompare(first, undefined, {numeric: true}))[0];
  } catch {
    return undefined;
  }
}

// Registry reads run reg.exe in the background, because status requests arrive every second.
// Until the first read finishes, the version and the install folder are unknown. A read runs
// again after five minutes, also after a failure. Windows can write a package's registry key after
// its folder, so a read that started less than 15 seconds after a change (such as a new package
// folder) can miss it: then the next read runs 15 seconds after that read. A change time in the
// future, from a wrong clock, doesn't count.
const registryRefreshMs = 5 * 60_000;
const registryChangeMs = 15_000;
const registryCache = new WeakMap<object, Map<string, {started: number; at: number; value?: unknown; probing: boolean}>>();

function cachedRegistry<T>(ctx: AppContext, key: string, args: string[], parse: (stdout: string) => T,
                           changedAt = 0): T | undefined {
  const run = ctx.runCommand;
  if (!run) return undefined;
  let entries = registryCache.get(run);
  if (!entries) registryCache.set(run, entries = new Map());
  const entry = entries.get(key);
  const now = Date.now();
  const changed = changedAt <= now ? changedAt : 0;
  const maxAgeMs = entry && entry.started < changed + registryChangeMs ? registryChangeMs : registryRefreshMs;
  if (entry && (entry.probing || now - entry.at < maxAgeMs)) return entry.value as T | undefined;
  const next = {started: now, at: now, value: entry?.value, probing: true};
  entries.set(key, next);
  const system = environmentValue(ctx.env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  void run(win32.join(system, 'System32', 'reg.exe'), args, {timeoutMs: 5000})
    .then(result => { next.value = parse(result.stdout); }, () => undefined)
    .finally(() => { next.probing = false; next.at = Date.now(); });
  return next.value as T | undefined;
}

const packagesKey = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel'
  + '\\Repository\\Packages';

// Every installed MSIX package of the user, by family name: one reg.exe run lists them all.
function windowsPackages(ctx: AppContext, changedAt?: number): Map<string, {version: string; root: string}> {
  return cachedRegistry(ctx, 'packages', ['query', packagesKey, '/s', '/v', 'PackageRootFolder'], parseWindowsPackages,
                        changedAt) ?? new Map();
}

// A package's full name is `<Name>_<Version>_<Architecture>_<ResourceId>_<PublisherId>`. Only a
// main package has no resource ID: a resource package (such as `split.scale-200`) or a bundle (`~`)
// has the same family name. When the user has two versions of a package, the newer one is kept.
export function parseWindowsPackages(text: string): Map<string, {version: string; root: string}> {
  const packages = new Map<string, {version: string; root: string}>();
  let fullName: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      fullName = line.slice(line.lastIndexOf('\\') + 1).trim();
      continue;
    }
    const root = /^\s+PackageRootFolder\s+REG_SZ\s+(.+?)\s*$/.exec(line)?.[1];
    const parts = fullName?.split('_');
    if (!root || parts?.length !== 5 || parts[3]) continue;
    const family = `${parts[0]}_${parts[4]}`;
    const known = packages.get(family)?.version;
    if (known && known.localeCompare(parts[1]!, undefined, {numeric: true}) >= 0) continue;
    packages.set(family, {version: parts[1]!, root});
  }
  return packages;
}

function uninstallVersion(ctx: AppContext, key: string): string | undefined {
  return cachedRegistry(ctx, `uninstall:${key}`,
    ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`, '/v', 'DisplayVersion'],
    stdout => /^\s+DisplayVersion\s+REG_SZ\s+(.+?)\s*$/m.exec(stdout)?.[1]);
}

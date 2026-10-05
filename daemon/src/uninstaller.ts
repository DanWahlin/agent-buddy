import {spawn} from 'node:child_process';
import {posix, win32} from 'node:path';
import {launchAgentLabel, macLogName, systemdUnit, windowsRunKey, windowsRunValue} from './service-names.js';

// The desktop app's Tauri identifier and program name, which name its own data and cache folders.
const appIdentifier = 'dev.agentcompanion.desktop';
const appProgram = 'agent-companion-desktop';
const debPackage = 'agent-companion';

export interface UninstallContext {
  platform: 'darwin' | 'linux' | 'win32';
  home: string;
  uid: number;
  // The service's data folder, its socket, and the folder it runs from.
  dataDir: string;
  socketPath: string;
  serviceRoot: string;
  // The desktop app: a macOS .app bundle, an AppImage, or a program a package installed.
  app: string | null;
  keepData: boolean;
  // The Copilot folder, when COPILOT_HOME moves it from ~/.copilot.
  copilotHome?: string;
  configHome?: string;
  dataHome?: string;
  cacheHome?: string;
  // Windows: %APPDATA% and %LOCALAPPDATA%, where the desktop app keeps its data.
  appData?: string;
  localAppData?: string;
}

export interface UninstallPlan {
  platform: UninstallContext['platform'];
  // Commands before and after the files go. The last command stops this service, so it comes last.
  before: string[][];
  remove: string[];
  after: string[][];
  // What the user must do, because the service cannot do it.
  manual: string[];
}

export function createUninstallPlan(context: UninstallContext): UninstallPlan {
  const {home, dataDir, platform} = context;
  const {join} = platform === 'win32' ? win32 : posix;
  const before: string[][] = [];
  const after: string[][] = [];
  const remove = [
    join(dataDir, 'runtime'), join(dataDir, 'runtime.new'), join(dataDir, 'runtime.old'),
    `${join(context.copilotHome ?? join(home, '.copilot'), 'hooks', 'agent-companion.json')}.bak`,
  ];
  // A Windows named pipe is not a file, and goes when the service stops.
  if (platform !== 'win32') remove.push(context.socketPath);
  const data = [dataDir];

  if (platform === 'win32') {
    remove.push(join(dataDir, 'service.json'), join(dataDir, 'service.json.bak'),
                join(dataDir, 'companion.log'), join(dataDir, 'companion.log.old'));
    const appData = context.appData ?? join(home, 'AppData', 'Roaming');
    const localAppData = context.localAppData ?? join(home, 'AppData', 'Local');
    data.push(join(appData, appIdentifier), join(localAppData, appIdentifier));
    // The script stops the launcher (and this service) after these, before it removes files in use.
    before.push(['reg.exe', 'delete', windowsRunKey, '/v', windowsRunValue, '/f']);
  } else if (platform === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
    remove.push(plist, `${plist}.bak`, join(home, 'Library', 'Logs', macLogName));
    const library = join(home, 'Library');
    data.push(join(library, 'Application Support', appIdentifier));
    for (const name of [appIdentifier, appProgram])
      data.push(join(library, 'Caches', name), join(library, 'WebKit', name));
    after.push(['launchctl', 'bootout', `gui/${context.uid}/${launchAgentLabel}`]);
  } else {
    const unit = join(context.configHome ?? join(home, '.config'), 'systemd', 'user', systemdUnit);
    remove.push(unit, `${unit}.bak`);
    const dataHome = context.dataHome ?? join(home, '.local', 'share');
    const cacheHome = context.cacheHome ?? join(home, '.cache');
    for (const name of [appIdentifier, appProgram]) data.push(join(dataHome, name), join(cacheHome, name));
    before.push(['systemctl', '--user', 'disable', systemdUnit]);
    after.push(['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'stop', systemdUnit]);
  }
  if (!context.keepData) remove.push(...data);

  const manual: string[] = [];
  const app = context.app;
  // A build in a clone of the repository belongs to the clone.
  if (app && !inside(app, context.serviceRoot, platform)) {
    if (isRemovableApp(app, platform)) remove.push(posix.normalize(app).replace(/\/+$/, ''));
    else if (platform === 'linux' && app.startsWith('/usr/'))
      manual.push(`Remove the desktop app's package: sudo apt remove ${debPackage}`);
    else if (platform === 'win32' && /agent[- ]?companion/i.test(win32.basename(win32.dirname(app))))
      manual.push('Remove the desktop app: open Windows Settings, then Apps, then Installed apps, and uninstall '
        + '"Agent Companion".');
    else manual.push(`Delete the desktop app: ${app}`);
  }
  if (!inside(context.serviceRoot, dataDir, platform))
    manual.push(`The companion service ran from ${context.serviceRoot}. That folder is not changed.`);

  return {platform, before, remove: [...new Set(remove.filter(path => isOwnPath(path, home, platform)))], after,
          manual};
}

// A shell script that does the plan. It runs apart from this service, because it stops it.
export function uninstallScript(plan: UninstallPlan): string {
  if (plan.platform === 'win32') return windowsUninstallScript(plan);
  const command = (parts: string[]) => `${parts.map(quote).join(' ')} >/dev/null 2>&1`;
  const lines = ['sleep 1', ...plan.before.map(command)];
  if (plan.remove.length > 0) lines.push(`rm -rf -- ${plan.remove.map(quote).join(' ')}`);
  lines.push(...plan.after.map(command));
  return `${lines.join('\n')}\n`;
}

// Starts the script, and closes this process when it finishes, for a service that no service
// manager stops (one started in a terminal).
export function runUninstall(plan: UninstallPlan, exit: () => void = () => process.exit(0)): void {
  const child = plan.platform === 'win32'
    ? spawn(windowsPowerShell(process.env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                             '-EncodedCommand', Buffer.from(uninstallScript(plan), 'utf16le')
                                               .toString('base64')],
            {detached: true, stdio: 'ignore', windowsHide: true})
    : spawn('/bin/sh', ['-c', uninstallScript(plan)], {detached: true, stdio: 'ignore'});
  child.once('exit', exit);
  child.once('error', error => {
    console.error(`[uninstall] could not start the uninstall: ${error.message}`);
    exit();
  });
}

// PowerShell, which every Windows has: it stops the launcher through its event, then removes the files.
function windowsUninstallScript(plan: UninstallPlan): string {
  const command = (parts: string[]) => `& ${parts.map(powerShellQuote).join(' ')} *> $null`;
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Start-Sleep -Seconds 1',
    ...plan.before.map(command),
    // The launcher (src-tauri/src/launcher.rs) stops its service, then frees the mutex.
    'try {',
    "  [void][System.Threading.EventWaitHandle]::OpenExisting('Local\\ESP32AgentCompanionServiceStop').Set()",
    "  $mutex = [System.Threading.Mutex]::OpenExisting('Local\\ESP32AgentCompanionService')",
    '  try { [void]$mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] {}',
    '} catch {}',
    'Start-Sleep -Milliseconds 500',
  ];
  if (plan.remove.length > 0)
    lines.push(`Remove-Item -LiteralPath ${plan.remove.map(powerShellQuote).join(', ')} -Recurse -Force`);
  lines.push(...plan.after.map(command));
  return `${lines.join('\r\n')}\r\n`;
}

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot?.trim() || env.windir?.trim() || 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powerShellQuote(value: string): string {
  // PowerShell also reads the typographic single quotes as quotes.
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
}

function isRemovableApp(app: string, platform: UninstallContext['platform']): boolean {
  if (platform === 'win32') return false;
  const name = posix.basename(app.replace(/\/+$/, ''));
  if (!/agent[- ]?companion/i.test(name)) return false;
  return platform === 'darwin' ? name.endsWith('.app') : /\.appimage$/i.test(name);
}

// Every path is absolute, has this project's name in it, and is not a folder that holds other things.
function isOwnPath(path: string, home: string, platform: UninstallContext['platform']): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  if (!paths.isAbsolute(path) || path.includes('\0')) return false;
  // A Windows path such as \\server\share or \\.\pipe is not a folder of this user's.
  if (platform === 'win32' && !/^[a-z]:\\/i.test(paths.normalize(path))) return false;
  const trim = (value: string) => paths.normalize(value).replace(/[\\/]+$/, '');
  const fold = (value: string) => platform === 'win32' ? value.toLowerCase() : value;
  const clean = trim(path);
  const root = trim(home);
  if (clean === '' || fold(clean) === fold(root)) return false;
  // The home folder's own name does not count.
  const own = fold(clean).startsWith(fold(`${root}${paths.sep}`)) ? clean.slice(root.length) : clean;
  return /agent[- ]?companion|agentcompanion/i.test(own);
}

function inside(path: string, folder: string, platform: UninstallContext['platform']): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  const between = paths.relative(folder, path);
  return between === '' || (!between.startsWith('..') && !paths.isAbsolute(between));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

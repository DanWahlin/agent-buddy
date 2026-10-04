import {spawn} from 'node:child_process';
import {basename, isAbsolute, join, normalize, relative} from 'node:path';

export const launchAgentLabel = 'com.danwahlin.esp32-agent-companion';
export const systemdUnit = 'esp32-agent-companion.service';
// The desktop app's Tauri identifier and program name, which name its own data and cache folders.
const appIdentifier = 'dev.agentcompanion.desktop';
const appProgram = 'agent-companion-desktop';
const debPackage = 'agent-companion';

export interface UninstallContext {
  platform: 'darwin' | 'linux';
  home: string;
  uid: number;
  // The service's data folder, its socket, and the folder it runs from.
  dataDir: string;
  socketPath: string;
  serviceRoot: string;
  // The desktop app: a macOS .app bundle, an AppImage, or a program a package installed.
  app: string | null;
  keepData: boolean;
  configHome?: string;
  dataHome?: string;
  cacheHome?: string;
}

export interface UninstallPlan {
  // Commands before and after the files go. The last command stops this service, so it comes last.
  before: string[][];
  remove: string[];
  after: string[][];
  // What the user must do, because the service cannot do it.
  manual: string[];
}

export function createUninstallPlan(context: UninstallContext): UninstallPlan {
  const {home, dataDir} = context;
  const before: string[][] = [];
  const after: string[][] = [];
  const remove = [
    join(dataDir, 'runtime'), join(dataDir, 'runtime.new'), join(dataDir, 'runtime.old'), context.socketPath,
    `${join(home, '.copilot', 'hooks', 'agent-companion.json')}.bak`,
  ];
  const data = [dataDir];

  if (context.platform === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
    remove.push(plist, `${plist}.bak`, join(home, 'Library', 'Logs', 'esp32-agent-companion.log'));
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
  if (app && !inside(app, context.serviceRoot)) {
    if (isRemovableApp(app, context.platform)) remove.push(normalize(app).replace(/\/+$/, ''));
    else if (context.platform === 'linux' && app.startsWith('/usr/'))
      manual.push(`Remove the desktop app's package: sudo apt remove ${debPackage}`);
    else manual.push(`Delete the desktop app: ${app}`);
  }
  if (!inside(context.serviceRoot, dataDir))
    manual.push(`The companion service ran from ${context.serviceRoot}. That folder is not changed.`);

  return {before, remove: [...new Set(remove.filter(path => isOwnPath(path, home)))], after, manual};
}

// A shell script that does the plan. It runs apart from this service, because it stops it.
export function uninstallScript(plan: UninstallPlan): string {
  const command = (parts: string[]) => `${parts.map(quote).join(' ')} >/dev/null 2>&1`;
  const lines = ['sleep 1', ...plan.before.map(command)];
  if (plan.remove.length > 0) lines.push(`rm -rf -- ${plan.remove.map(quote).join(' ')}`);
  lines.push(...plan.after.map(command));
  return `${lines.join('\n')}\n`;
}

// Starts the script, and closes this process when it finishes, for a service that no service
// manager stops (one started in a terminal).
export function runUninstall(plan: UninstallPlan, exit: () => void = () => process.exit(0)): void {
  const child = spawn('/bin/sh', ['-c', uninstallScript(plan)], {detached: true, stdio: 'ignore'});
  child.once('exit', exit);
  child.once('error', error => {
    console.error(`[uninstall] could not start the uninstall: ${error.message}`);
    exit();
  });
}

function isRemovableApp(app: string, platform: UninstallContext['platform']): boolean {
  const name = basename(app.replace(/\/+$/, ''));
  if (!/agent[- ]?companion/i.test(name)) return false;
  return platform === 'darwin' ? name.endsWith('.app') : /\.appimage$/i.test(name);
}

// Every path is absolute, has this project's name in it, and is not a folder that holds other things.
function isOwnPath(path: string, home: string): boolean {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  const clean = normalize(path).replace(/\/+$/, '');
  const root = normalize(home).replace(/\/+$/, '');
  if (clean === '' || clean === root) return false;
  // The home folder's own name does not count.
  const own = clean.startsWith(`${root}/`) ? clean.slice(root.length) : clean;
  return /agent[- ]?companion|agentcompanion/i.test(own);
}

function inside(path: string, folder: string): boolean {
  const between = relative(folder, path);
  return between === '' || (!between.startsWith('..') && !isAbsolute(between));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

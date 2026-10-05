import {execFileSync, spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, posix, win32} from 'node:path';
import {defaultDataDirectory, socketPath} from './paths.js';
import {defaultAgentContext, installDetectedAgents, otherAgentLocations} from './agents/index.js';
import {agentHomeVariables} from './agents/homes.js';
import {shellQuote} from './agents/commands.js';
import {defaultDesktopAppLocations} from './desktop-app.js';
import {launchAgentLabel, macLogName, systemdUnit, windowsRunKey, windowsRunValue} from './service-names.js';

export type InstallerPlatform = 'darwin' | 'linux' | 'win32';

export interface InstallerContext {
  home: string;
  node: string;
  cli: string;
  uid: number;
  configHome?: string;
  // Windows: the service's data folder, and the desktop app's program, which starts the service.
  dataDir?: string;
  launcher?: string;
  // Variables the service needs from the user's shell; launchd and systemd start with a bare PATH.
  environment?: Record<string, string>;
}

interface InstallFile {
  path: string;
  content: string;
  mode?: number;
}

interface InstallCommand {
  executable: string;
  arguments: string[];
  ignoreFailure?: boolean;
  // Starts a program that keeps running, and does not wait for it.
  detached?: boolean;
}

export interface InstallationPlan {
  files: InstallFile[];
  commands: InstallCommand[];
  messages: string[];
}

export function createInstallationPlan(
    platform: InstallerPlatform, context: InstallerContext): InstallationPlan {
  // The agent hooks, Copilot's too, come from installDetectedAgents, which skips hooks the user removed.
  const files: InstallFile[] = [];
  const messages: string[] = [];
  let commands: InstallCommand[] = [];

  if (platform === 'darwin') {
    const plistPath = posix.join(context.home, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
    const logPath = posix.join(context.home, 'Library', 'Logs', macLogName);
    const domain = `gui/${context.uid}`;
    files.push({path: plistPath, content: launchAgent(context.node, context.cli, logPath, context.environment ?? {})});
    commands = [
      {executable: 'launchctl', arguments: ['bootout', domain, plistPath], ignoreFailure: true},
      {executable: 'launchctl', arguments: ['bootstrap', domain, plistPath]},
      {executable: 'launchctl', arguments: ['kickstart', '-k', `${domain}/${launchAgentLabel}`]},
    ];
    messages.push(`Installed launch agent: ${plistPath}`);
  } else if (platform === 'linux') {
    const configHome = context.configHome ?? posix.join(context.home, '.config');
    const servicePath = posix.join(configHome, 'systemd', 'user', systemdUnit);
    files.push({path: servicePath, content: systemdService(context.node, context.cli, context.environment ?? {})});
    commands = [
      {executable: 'systemctl', arguments: ['--user', 'daemon-reload']},
      {executable: 'systemctl', arguments: ['--user', 'enable', systemdUnit]},
      {executable: 'systemctl', arguments: ['--user', 'restart', systemdUnit]},
    ];
    messages.push(`Installed systemd user service: ${servicePath}`);
  } else if (platform === 'win32') {
    if (!context.dataDir || !context.launcher) throw new Error('A Windows install needs the data folder and launcher.');
    // The desktop app's program has no console window. It reads service.json and runs the service
    // (src-tauri/src/launcher.rs). A new launcher stops the old one, so the new service starts now.
    const config = win32.join(context.dataDir, 'service.json');
    files.push({path: config, content: `${JSON.stringify({
      node: context.node, cli: context.cli, environment: context.environment ?? {}}, null, 2)}\n`});
    commands = [
      {executable: 'reg.exe', arguments: ['add', windowsRunKey, '/v', windowsRunValue, '/t', 'REG_SZ',
                                          '/d', `"${context.launcher}" --companion-service`, '/f']},
      {executable: context.launcher, arguments: ['--companion-service'], detached: true},
    ];
    messages.push(`The companion service starts when you sign in to Windows, through ${context.launcher}`);
  }
  messages.push('Restart any open agent sessions so they load the new hooks.');
  return {files, commands, messages};
}

export async function installDaemon(cli: string): Promise<void> {
  if (!isSupportedPlatform(process.platform))
    throw new Error(`Unsupported platform: ${process.platform}`);
  const launcher = process.platform === 'win32' ? windowsLauncher(cli, process.env) : undefined;
  if (process.platform === 'linux') {
    const problem = linuxServiceProblem(() => {
      execFileSync('systemctl', ['--user', 'show-environment'], {stdio: 'ignore', timeout: 10_000});
    }, process.env, readProcVersion(), `${shellQuote(process.execPath)} ${shellQuote(cli)} daemon`);
    if (problem) throw new Error(problem);
  }
  const plan = createInstallationPlan(process.platform, {
    home: homedir(),
    node: process.execPath,
    cli,
    uid: process.getuid?.() ?? 0,
    configHome: process.env.XDG_CONFIG_HOME,
    dataDir: defaultDataDirectory(process.platform, homedir(), process.env),
    launcher,
    environment: serviceEnvironment(process.env, process.platform),
  });
  const agentContext = defaultAgentContext({
    home: homedir(),
    node: process.execPath,
    cli,
    platform: process.platform,
    env: process.env,
    dataDir: defaultDataDirectory(process.platform, homedir(), process.env),
    socketPath: socketPath(),
  });
  agentContext.locations = otherAgentLocations(agentContext);
  const hookResults = await installDetectedAgents(agentContext);
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), {recursive: true});
    writeFileWithBackup(file.path, file.content, file.mode);
    if (file.mode) chmodSync(file.path, file.mode);
  }
  for (const command of plan.commands) {
    try {
      if (command.detached) await startDetached(command.executable, command.arguments);
      else execFileSync(command.executable, command.arguments, {stdio: 'ignore', windowsHide: true});
    } catch (error) {
      if (!command.ignoreFailure) throw error;
    }
  }
  for (const message of plan.messages) console.log(message);
  for (const result of hookResults) console.log(result.message);
}

// The service runs as a systemd user service. Without a user manager, say what to do
// before anything changes, instead of a raw systemctl error after the hooks are in.
export function linuxServiceProblem(check: () => void, env: NodeJS.ProcessEnv, procVersion: string,
                                    startCommand: string): string | null {
  try {
    check();
    return null;
  } catch {
    if (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion)) {
      return 'systemd is not running in this WSL distribution, so the companion service cannot start. '
        + 'Add "[boot]" and "systemd=true" to /etc/wsl.conf, run "wsl --shutdown" in Windows, '
        + 'then open the distribution and run the install again.';
    }
    return 'no systemd user service manager answered ("systemctl --user" failed), so the companion service '
      + `cannot be installed. Sign in to a desktop session that runs systemd, or run ${startCommand} `
      + 'in a terminal and keep it open.';
  }
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return '';
  }
}

export function serviceEnvironment(env: NodeJS.ProcessEnv,
                                   platform: NodeJS.Platform = process.platform): Record<string, string> {
  const result: Record<string, string> = {};
  // Windows gives the launcher the user's own PATH when they sign in, and takes their later changes.
  const path = platform === 'win32' ? '' : servicePath(env.PATH);
  if (path) result.PATH = path;
  for (const name of agentHomeVariables) {
    const value = env[name]?.trim();
    if (value) result[name] = value;
  }
  return result;
}

// Drops the temporary entries `npm run` prepends and relative entries a service can't resolve.
function servicePath(value: string | undefined): string {
  const entries = (value ?? '').split(':').filter(entry => entry.startsWith('/')
    && !/\/node_modules\/\.bin$/.test(entry) && !/\/node-gyp-bin$/.test(entry));
  return [...new Set(entries)].join(':');
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is InstallerPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

// The desktop app that runs this install (bundled service), else an installed or built desktop app.
export function windowsLauncher(cli: string, env: NodeJS.ProcessEnv,
                                exists: (path: string) => boolean = existsSync): string {
  const given = env.AGENT_COMPANION_LAUNCHER?.trim();
  if (given && win32.isAbsolute(given) && exists(given)) return given;
  const repository = win32.resolve(win32.dirname(cli), '..', '..', '..');
  const found = defaultDesktopAppLocations('win32', homedir(), repository, env).find(exists);
  if (found) return found;
  throw new Error('On Windows, the desktop app starts the companion service when you sign in, and it is not '
    + 'installed. Install the desktop app (see "Desktop app" in the README), or build it with "npm run desktop", '
    + 'then run "npm run setup" again.');
}

function startDetached(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {detached: true, stdio: 'ignore', windowsHide: true});
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function launchAgent(node: string, cli: string, logPath: string, environment: Record<string, string>): string {
  const variables = Object.entries(environment)
    .map(([name, value]) => `\n    <key>${escapeXml(name)}</key><string>${escapeXml(value)}</string>`).join('');
  const environmentBlock = variables
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>${variables}\n  </dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(cli)}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(dirname(cli))}</string>${environmentBlock}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdService(node: string, cli: string, environment: Record<string, string>): string {
  const variables = Object.entries(environment)
    .map(([name, value]) => `\nEnvironment=${quoteSystemd(`${name}=${value}`)}`).join('');
  return `[Unit]
Description=ESP32 Agent Companion daemon
After=default.target

[Service]
Type=simple
ExecStart=${quoteSystemd(node)} ${quoteSystemd(cli)} daemon${variables}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function writeFileWithBackup(path: string, content: string, mode: number | undefined): void {
  if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, content, mode ? {mode} : undefined);
}

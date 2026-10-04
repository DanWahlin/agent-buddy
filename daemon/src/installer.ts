import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {defaultDataDirectory, socketPath} from './paths.js';
import {createCopilotHooks} from './agents/copilot.js';
import {defaultAgentContext, installDetectedAgents} from './agents/index.js';

export type InstallerPlatform = 'darwin' | 'linux';

export interface InstallerContext {
  home: string;
  node: string;
  cli: string;
  uid: number;
  configHome?: string;
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
}

export interface InstallationPlan {
  files: InstallFile[];
  commands: InstallCommand[];
  messages: string[];
}

export function createInstallationPlan(
    platform: InstallerPlatform, context: InstallerContext): InstallationPlan {
  const hookPath = join(context.home, '.copilot', 'hooks', 'agent-companion.json');
  const files: InstallFile[] = [{
    path: hookPath,
    content: `${JSON.stringify(createCopilotHooks(context.node, context.cli), null, 2)}\n`,
    mode: 0o600,
  }];
  const messages = [`Installed Copilot hooks: ${hookPath}`];
  let commands: InstallCommand[] = [];

  if (platform === 'darwin') {
    const label = 'com.danwahlin.esp32-agent-companion';
    const plistPath = join(context.home, 'Library', 'LaunchAgents', `${label}.plist`);
    const logPath = join(context.home, 'Library', 'Logs', 'esp32-agent-companion.log');
    const domain = `gui/${context.uid}`;
    files.push({path: plistPath, content: launchAgent(context.node, context.cli, logPath, context.environment ?? {})});
    commands = [
      {executable: 'launchctl', arguments: ['bootout', domain, plistPath], ignoreFailure: true},
      {executable: 'launchctl', arguments: ['bootstrap', domain, plistPath]},
      {executable: 'launchctl', arguments: ['kickstart', '-k', `${domain}/${label}`]},
    ];
    messages.push(`Installed launch agent: ${plistPath}`);
  } else if (platform === 'linux') {
    const configHome = context.configHome ?? join(context.home, '.config');
    const servicePath = join(configHome, 'systemd', 'user', 'esp32-agent-companion.service');
    files.push({path: servicePath, content: systemdService(context.node, context.cli, context.environment ?? {})});
    commands = [
      {executable: 'systemctl', arguments: ['--user', 'daemon-reload']},
      {executable: 'systemctl', arguments: ['--user', 'enable', 'esp32-agent-companion.service']},
      {executable: 'systemctl', arguments: ['--user', 'restart', 'esp32-agent-companion.service']},
    ];
    messages.push(`Installed systemd user service: ${servicePath}`);
  }
  messages.push('Restart GitHub Copilot to load the new hooks.');
  return {files, commands, messages};
}

export async function installDaemon(cli: string): Promise<void> {
  if (!isSupportedPlatform(process.platform))
    throw new Error(`Unsupported platform: ${process.platform}`);
  const plan = createInstallationPlan(process.platform, {
    home: homedir(),
    node: process.execPath,
    cli,
    uid: process.getuid?.() ?? 0,
    configHome: process.env.XDG_CONFIG_HOME,
    environment: serviceEnvironment(process.env),
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
  const hookResults = await installDetectedAgents(agentContext);
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), {recursive: true});
    writeFileWithBackup(file.path, file.content, file.mode);
    if (file.mode) chmodSync(file.path, file.mode);
  }
  for (const command of plan.commands) {
    try {
      execFileSync(command.executable, command.arguments, {stdio: 'ignore'});
    } catch (error) {
      if (!command.ignoreFailure) throw error;
    }
  }
  for (const message of plan.messages) console.log(message);
  for (const result of hookResults) console.log(result.message);
}

export function serviceEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const path = servicePath(env.PATH);
  if (path) result.PATH = path;
  if (env.HERMES_HOME) result.HERMES_HOME = env.HERMES_HOME;
  return result;
}

// Drops the temporary entries `npm run` prepends and relative entries a service can't resolve.
function servicePath(value: string | undefined): string {
  const entries = (value ?? '').split(':').filter(entry => entry.startsWith('/')
    && !/\/node_modules\/\.bin$/.test(entry) && !/\/node-gyp-bin$/.test(entry));
  return [...new Set(entries)].join(':');
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is InstallerPlatform {
  return platform === 'darwin' || platform === 'linux';
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
  <key>Label</key><string>com.danwahlin.esp32-agent-companion</string>
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

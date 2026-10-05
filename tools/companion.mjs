#!/usr/bin/env node
// Friendly entry point for `npm run setup|status|wifi|pair|character` from the repository root.
import {spawn} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const daemon = join(root, 'daemon');
const cliPath = join(daemon, 'dist', 'src', 'cli.js');
const characters = join(root, 'build', 'characters');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 11)) {
  console.error(`Agent Companion needs Node.js 24 LTS (24.11 or newer), but this is Node.js ${process.versions.node}.\n`
    + 'Install it from https://nodejs.org/ (or run `nvm install 24`), then try again.');
  process.exit(1);
}

function run(command, args, {cwd = root, quiet = false} = {}) {
  return new Promise((resolve, reject) => {
    // Node.js runs a Windows .cmd file (npm.cmd) only through a shell. These arguments need no quotes.
    const shell = process.platform === 'win32' && /\.cmd$/i.test(command);
    const child = spawn(command, args, {cwd, shell, windowsHide: true,
                                        stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(error.code === 'ENOENT'
      ? new Error(`${command} is not installed or not on your PATH.`) : error));
    child.on('exit', code => code === 0 ? resolve(output)
      : reject(Object.assign(new Error(output.trim() || `${command} exited with code ${code}.`),
          {printed: !quiet})));
  });
}

function newestChange(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestChange(path) : statSync(path).mtimeMs);
  }
  return newest;
}

// Installs and compiles the daemon only when a fresh clone or a source change needs it.
async function prepareDaemon() {
  // npm records the installed tree in node_modules/.package-lock.json; an older one means an update changed dependencies.
  const installed = join(daemon, 'node_modules', '.package-lock.json');
  if (!existsSync(installed) || statSync(installed).mtimeMs < statSync(join(daemon, 'package-lock.json')).mtimeMs) {
    console.log('Installing companion dependencies...');
    await run(npm, ['ci', '--no-audit', '--no-fund'], {cwd: daemon, quiet: true});
  }
  const sources = Math.max(newestChange(join(daemon, 'src')),
                           statSync(join(daemon, 'package.json')).mtimeMs);
  if (!existsSync(cliPath) || statSync(cliPath).mtimeMs < sources) {
    console.log('Building the companion daemon...');
    await run(npm, ['run', 'build', '--silent'], {cwd: daemon, quiet: true});
  }
}

// Windows has the "py" launcher or python.exe; "python3" there is often a Microsoft Store shortcut.
const pythons = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []]];

async function buildCharacters() {
  for (const [index, [python, options]] of pythons.entries()) {
    try {
      await run(python, [...options, join(root, 'tools', 'character_pack.py'), 'build'], {quiet: true});
      return;
    } catch (error) {
      if (index === pythons.length - 1 || !/not installed/.test(error.message)) throw error;
    }
  }
}

async function cli(args, {quiet = false} = {}) {
  await prepareDaemon();
  return run(process.execPath, [cliPath, ...args], {quiet});
}

async function daemonStatus() {
  try {
    return JSON.parse(await cli(['status'], {quiet: true}));
  } catch {
    return null;
  }
}

function packName(path) {
  const header = readFileSync(path).subarray(32, 56);
  const end = header.indexOf(0);
  return header.toString('ascii', 0, end < 0 ? header.length : end);
}

async function ask(question) {
  const prompt = createInterface({input: process.stdin, output: process.stdout});
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

const notRunning = 'The companion service is not running. Run "npm run setup" first.';

function isWsl() {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// Opens a URL in the default browser; WSL hands it to the Windows browser.
async function openBrowser(url) {
  const attempts = process.platform === 'darwin' ? [['open', [url]]]
    : process.platform === 'win32' ? [['rundll32.exe', ['url.dll,FileProtocolHandler', url]]]
    : isWsl() ? [['wslview', [url]], ['explorer.exe', [url]]]
    : [['xdg-open', [url]]];
  for (const [command, args] of attempts) {
    try {
      await run(command, args, {quiet: true});
      return true;
    } catch (error) {
      // explorer.exe exits non-zero even when it opens the page.
      if (command === 'explorer.exe' && !/not installed/.test(error.message)) return true;
    }
  }
  return false;
}

function printAgentActions(agents) {
  for (const agent of agents) {
    console.log(`  ${agent.action.title}`);
    for (const step of agent.action.steps) console.log(`    - ${step}`);
  }
}

async function settingsUrl() {
  try {
    return JSON.parse(await cli(['settings'], {quiet: true})).url ?? null;
  } catch {
    return null;
  }
}

// The freshly restarted service needs a moment before it answers.
async function waitForAgentActions() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await daemonStatus();
    if (status?.agents) return status.agents.filter(agent => agent.action);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return [];
}

const commands = {
  async setup(args) {
    await prepareDaemon();
    console.log('Building character packs...');
    await buildCharacters();
    await run(process.execPath, [join(daemon, 'dist', 'src', 'install.js')]);
    const pending = await waitForAgentActions();
    if (pending.length) {
      console.log('\nAlmost done. A few agents need a one-time step:');
      printAgentActions(pending);
      // First-time setup opens the settings page, which tracks these steps and clears them as you finish.
      if (process.stdout.isTTY && !args.includes('--no-open')) {
        const url = await settingsUrl();
        if (url && await openBrowser(url)) console.log('\nThe settings page is open and updates as you finish each step.');
        else console.log('\nRun "npm run settings" to track these steps as you finish them.');
      } else {
        console.log('\nRun "npm run settings" to track these steps as you finish them.');
      }
    } else {
      console.log('\nSetup complete.');
    }
    console.log('\nTry:');
    console.log('  npm run settings');
    console.log('  npm run status');
    console.log('  npm run wifi "Your Wi-Fi name"');
    console.log('  npm run character openclaw');
    console.log('  npm run badges off');
  },

  async settings() {
    await prepareDaemon();
    let response;
    try {
      response = JSON.parse(await cli(['settings'], {quiet: true}));
    } catch {
      throw new Error(notRunning);
    }
    if (!response.url) throw new Error('The settings page is not available. Check the daemon log for details.');
    const opened = await openBrowser(response.url);
    console.log(opened ? 'Opened the settings page in your browser. If it didn\'t appear, open:'
                       : 'Open this link in your browser:');
    console.log(`  ${response.url}`);
  },

  async status() {
    const status = await daemonStatus();
    if (!status) throw new Error(notRunning);
    if (!status.connected) {
      console.log('The companion service is running, but no device is connected.');
      if (status.mode === 'wifi') console.log('Connection mode is wifi, so USB is ignored.');
      console.log('Connect it over USB, or run "npm run wifi" once while it is plugged in.');
      return;
    }
    const via = status.transport === 'wifi' ? `Wi-Fi (${status.port})` : `USB (${status.port})`;
    console.log(`Connected over ${via}`);
    if (status.network?.ssid)
      console.log(`Wi-Fi network: ${status.network.ssid}${status.network.connected ? '' : ' (not connected)'}`);
    if (status.mode && status.mode !== 'auto') console.log(`Connection mode: ${status.mode}`);
    console.log(`Character: ${status.character ?? 'unknown'}`);
    const drivers = status.drivingAgents?.length
      ? ` · ${status.drivingAgents.map(id => status.agents?.find(agent => agent.id === id)?.name ?? id).join(', ')}`
      : '';
    console.log(`State: ${status.state}${drivers}, tracking ${status.sessions} session(s)`);
    const pending = (status.agents ?? []).filter(agent => agent.action);
    if (pending.length) {
      console.log('\nAgents that need a one-time step:');
      printAgentActions(pending);
    }
  },

  async agents(args) {
    const action = args[0]?.toLowerCase();
    const id = args[1]?.toLowerCase();
    if (action) {
      if (!['enable', 'disable', 'install', 'uninstall'].includes(action) || !id)
        throw new Error('Usage: npm run agents [enable|disable|install|uninstall AGENT]');
      await cli(['agents', action, id], {quiet: true});
    }
    const agents = JSON.parse(await cli(['agents'], {quiet: true}));
    console.log('Supported agents:');
    for (const agent of agents) {
      const notes = [
        agent.detected ? (agent.version ?? 'detected') : 'not detected',
        `hook: ${agent.hookStatus}`,
        agent.enabled ? 'enabled' : 'disabled',
        agent.driving ? 'driving display' : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${agent.id.padEnd(9)} ${agent.name} (${notes})`);
      if (agent.hint) console.log(`            ${agent.hint}`);
      if (agent.warning) console.log(`            Warning: ${agent.warning}`);
    }
    console.log('\nExamples: npm run agents disable claude | npm run agents install codex');
  },

  async wifi(args) {
    const ssid = args.join(' ') || await ask('Wi-Fi network name (2.4 GHz): ');
    if (!ssid) throw new Error('A Wi-Fi network name is required.');
    await cli(['setup-wifi', ssid]);
  },

  async pair(args) {
    if (!args[0]) throw new Error('Usage: npm run pair 12345678 (the code shown on the device)');
    await cli(['pair-wifi', ...args]);
  },

  async connection(args) {
    const mode = args[0]?.toLowerCase();
    if (!mode) {
      const status = await daemonStatus();
      if (!status) throw new Error(notRunning);
      console.log(`Connection mode: ${status.mode ?? 'auto'}`);
      console.log('  auto  use USB when it is connected, otherwise Wi-Fi');
      console.log('  wifi  always use Wi-Fi; a USB cable only provides power');
      console.log('  usb   only use USB');
      console.log('\nChange it with: npm run connection wifi');
      return;
    }
    await cli(['connection', mode]);
    console.log(mode === 'wifi'
      ? 'Now using Wi-Fi only. A connected USB cable just provides power.'
      : mode === 'usb' ? 'Now using USB only.' : 'Now using USB when connected, otherwise Wi-Fi.');
  },

  async badges(args) {
    const value = args[0]?.toLowerCase();
    if (value !== 'on' && value !== 'off') throw new Error('Usage: npm run badges on|off');
    await cli(['badges', value], {quiet: true});
    console.log(value === 'on' ? 'Agent badges are on.' : 'Agent badges are off.');
  },

  async character(args) {
    const choice = args.join(' ');
    await buildCharacters();
    if (!choice) {
      let entries;
      try {
        entries = JSON.parse(await cli(['list-characters'], {quiet: true}));
      } catch {
        // Without the service, list the built-in packs directly.
        entries = readdirSync(characters).filter(name => name.endsWith('.acpk')).sort().map(file => ({
          id: file.slice(0, -'.acpk'.length), name: packName(join(characters, file)), builtIn: true}));
      }
      console.log('Available characters:');
      for (const entry of entries) {
        const notes = [entry.installed && 'installed', !entry.builtIn && 'added'].filter(Boolean);
        console.log(`  ${entry.id.padEnd(12)} ${entry.name}${notes.length ? `  (${notes.join(', ')})` : ''}`);
      }
      console.log('\nInstall one with: npm run character openclaw');
      console.log('Or install your own pack: npm run character path/to/pack.acpk');
      return;
    }
    await cli(['setup-character', choice]);
  },
};

const [name, ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error('Usage: npm run setup | settings | status | agents | wifi [NAME] | pair CODE | character [NAME|PATH] | connection [auto|wifi|usb] | badges [on|off]');
  process.exit(2);
}
command(args).catch(error => {
  // Commands that ran in the foreground have already printed their own errors.
  if (!error.printed) console.error(error.message);
  process.exitCode = 1;
});

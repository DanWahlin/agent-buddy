import assert from 'node:assert/strict';
import test from 'node:test';
import {createInstallationPlan, linuxServiceProblem, serviceEnvironment, windowsLauncher} from '../src/installer.js';

const context = {
  home: '/home/example',
  node: '/opt/node/bin/node',
  cli: '/home/example/agent companion/dist/src/cli.js',
  uid: 1000,
  configHome: '/home/example/.config',
};

test('creates a macOS launch agent and leaves the agent hooks to installDetectedAgents', () => {
  const plan = createInstallationPlan('darwin', context);
  assert.equal(plan.files.length, 1);
  assert.match(plan.files[0]?.path ?? '', /Library\/LaunchAgents\/com\.danwahlin/);
  assert.match(plan.files[0]?.content ?? '', /KeepAlive/);
  assert.deepEqual(plan.commands.map(command => command.executable),
                   ['launchctl', 'launchctl', 'launchctl']);
});

test('creates a Linux systemd user service', () => {
  const plan = createInstallationPlan('linux', context);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]?.path,
               '/home/example/.config/systemd/user/esp32-agent-companion.service');
  assert.match(plan.files[0]?.content ?? '',
               /ExecStart="\/opt\/node\/bin\/node" "\/home\/example\/agent companion\/dist\/src\/cli\.js" daemon/);
  assert.deepEqual(plan.commands.map(command => command.arguments), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', 'esp32-agent-companion.service'],
    ['--user', 'restart', 'esp32-agent-companion.service'],
  ]);
});

test('services get the user PATH and HERMES_HOME so agent detection matches setup', () => {
  const environment = serviceEnvironment({
    PATH: '/repo/node_modules/.bin:/npm/lib/node-gyp-bin:/opt/homebrew/bin:~/.dotnet/tools:/usr/bin:/opt/homebrew/bin',
    HERMES_HOME: '/h/50%',
    HOME: '/x',
  }, 'darwin');
  assert.deepEqual(environment, {PATH: '/opt/homebrew/bin:/usr/bin', HERMES_HOME: '/h/50%'});
  const mac = createInstallationPlan('darwin', {...context, environment});
  assert.match(mac.files[0]?.content ?? '',
               /<key>EnvironmentVariables<\/key>\n  <dict>\n    <key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  const linux = createInstallationPlan('linux', {...context, environment});
  assert.match(linux.files[0]?.content ?? '', /^Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin"$/m);
  assert.match(linux.files[0]?.content ?? '', /^Environment="HERMES_HOME=\/h\/50%%"$/m);
});

test('services keep the agents\' folder variables, so the service edits the files the agents read', () => {
  assert.deepEqual(serviceEnvironment({PATH: '/usr/bin', CODEX_HOME: '/work/codex', COPILOT_HOME: ' ', OTHER: 'x'}, 'linux'),
                   {PATH: '/usr/bin', CODEX_HOME: '/work/codex'});
});

test('Linux without a systemd user manager gets a clear message before anything changes', () => {
  const works = () => undefined;
  const fails = () => { throw new Error('Failed to connect to bus'); };
  assert.equal(linuxServiceProblem(works, {}, '', 'node cli.js daemon'), null);
  assert.match(linuxServiceProblem(fails, {WSL_DISTRO_NAME: 'Ubuntu'}, '', 'node cli.js daemon') ?? '', /systemd=true/);
  assert.match(linuxServiceProblem(fails, {}, 'Linux version 5.15.0-microsoft-standard-WSL2', 'x') ?? '', /wsl\.conf/);
  assert.match(linuxServiceProblem(fails, {}, 'Linux version 6.8.0', "'/n/node' '/c/cli.js' daemon") ?? '',
               /run '\/n\/node' '\/c\/cli\.js' daemon in a terminal/);
});

test('the Windows plan writes service.json and starts the desktop app\'s launcher at sign-in', () => {
  const launcher = 'C:\\Users\\Dan\\AppData\\Local\\Agent Companion\\agent-companion-desktop.exe';
  const plan = createInstallationPlan('win32', {
    home: 'C:\\Users\\Dan', node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\src\\daemon\\dist\\src\\cli.js', uid: -1,
    dataDir: 'C:\\Users\\Dan\\AppData\\Local\\ESP32 Agent Companion', launcher, environment: {CODEX_HOME: 'D:\\codex'},
  });
  assert.equal(plan.files[0]!.path, 'C:\\Users\\Dan\\AppData\\Local\\ESP32 Agent Companion\\service.json');
  assert.deepEqual(JSON.parse(plan.files[0]!.content), {
    node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\src\\daemon\\dist\\src\\cli.js',
    environment: {CODEX_HOME: 'D:\\codex'}});
  assert.deepEqual(plan.commands, [
    {executable: 'reg.exe', arguments: ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v',
      'ESP32 Agent Companion', '/t', 'REG_SZ', '/d', `"${launcher}" --companion-service`, '/f']},
    {executable: launcher, arguments: ['--companion-service'], detached: true},
  ]);
  assert.throws(() => createInstallationPlan('win32', {home: 'C:\\Users\\Dan', node: 'n', cli: 'c', uid: -1}));
});

test('Windows keeps the PATH it gives at sign-in, and finds a launcher', () => {
  assert.deepEqual(serviceEnvironment({Path: 'C:\\x', PATH: 'C:\\x', CODEX_HOME: 'D:\\c'}, 'win32'), {CODEX_HOME: 'D:\\c'});
  const given = 'D:\\apps\\agent-companion-desktop.exe';
  assert.equal(windowsLauncher('C:\\src\\daemon\\dist\\src\\cli.js', {AGENT_COMPANION_LAUNCHER: given},
                               path => path === given), given);
  assert.equal(windowsLauncher('C:\\src\\daemon\\dist\\src\\cli.js', {LOCALAPPDATA: 'C:\\L'},
                               path => path.endsWith('release\\agent-companion-desktop.exe')),
               'C:\\src\\desktop\\apps\\desktop\\src-tauri\\target\\release\\agent-companion-desktop.exe');
  assert.throws(() => windowsLauncher('C:\\src\\daemon\\dist\\src\\cli.js', {}, () => false), /desktop app/);
});

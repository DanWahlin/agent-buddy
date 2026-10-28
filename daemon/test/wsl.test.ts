import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync} from 'node:fs';
import {mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  agentStatuses,
  combinedStatus,
  defaultAgentContext,
  installAgent,
  removeAllAgentHooks,
  uninstallAgent,
} from '../src/agents/index.js';
import {codexAdapter, untrustedCodexHooks} from '../src/agents/codex.js';
import {hookHealth} from '../src/agents/hook-config.js';
import type {AgentContext, AgentLocation, AgentLocations} from '../src/agents/types.js';
import {
  decodeWslOutput,
  parseDistributions,
  parseProbe,
  parseWslPath,
  probeScript,
  wslAgentPath,
  wslContext,
  wslHostPath,
  wslExecutable,
  WslLocations,
  type WslRunner,
} from '../src/agents/wsl.js';

const probeOutput = (lines: string[]) => lines.map(line => `@@agent-companion:${line}`).join('\n');

test('reads what a distribution reports about itself', () => {
  const probe = parseProbe([
    'Welcome to Ubuntu',
    probeOutput(['home=/home/dan', 'node=/mnt/c/Program Files/nodejs/node.exe', 'mount=/mnt/c/',
                 'env:CODEX_HOME=/home/dan/codex', 'env:EMPTY=', 'command=claude', 'command=codex',
                 'version:codex=codex-cli 0.140.0', 'version:grok=', 'interop=1']),
  ].join('\r\n'));
  assert.deepEqual(probe, {
    home: '/home/dan', node: '/mnt/c/Program Files/nodejs/node.exe', mount: '/mnt/', env: {CODEX_HOME: '/home/dan/codex'},
    commands: ['claude', 'codex'], versions: {codex: 'codex-cli 0.140.0'}, interop: true,
  });
  // A custom automount root, no interop, and a node path that wslpath could not make.
  assert.deepEqual(parseProbe(probeOutput(['home=/root', 'node=', 'mount=/c/'])),
                   {home: '/root', mount: '/', env: {}, commands: [], versions: {}, interop: false});
  assert.equal(parseProbe('no markers here'), undefined);
  assert.equal(parseProbe(probeOutput(['home=relative'])), undefined);

  const script = probeScript('C:\\Program Files\\nodejs\\node.exe');
  assert.match(script, /wslpath -u 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /timeout 5 codex --version <\/dev\/null/);
  assert.match(script, /WSLInterop-late/);
  assert.match(script, /exit 0\n$/);
});

// The probe runs as `sh -s`, so its stdin is the script. A codex that reads stdin gets none, and the
// rest of the script still runs. WSL adds the Windows PATH, so a Windows program under the drives'
// mount doesn't count as the distribution's agent.
test('the probe reads the version of codex and skips Windows programs, without losing the rest of its script',
     {skip: process.platform === 'win32' && 'needs sh'}, async () => {
  const root = join(process.cwd(), '.test-output', `wsl-probe-${randomUUID()}`);
  const bin = join(root, 'bin');
  const windowsNpm = join(root, 'mnt', 'c', 'Users', 'dan', 'AppData', 'Roaming', 'npm');
  try {
    await mkdir(bin, {recursive: true});
    await mkdir(windowsNpm, {recursive: true});
    await writeFile(join(bin, 'codex'), "#!/bin/sh\ncat >/dev/null\necho 'codex-cli 0.140.0'\n", {mode: 0o755});
    // macOS has no timeout command.
    await writeFile(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', {mode: 0o755});
    await writeFile(join(bin, 'wslpath'), `#!/bin/sh\necho '${join(root, 'mnt', 'c')}/'\n`, {mode: 0o755});
    await writeFile(join(windowsNpm, 'claude'), '#!/bin/sh\nexit 127\n', {mode: 0o755});
    const script = probeScript('C:\\node.exe').replace('exit 0\n', 'p after 1\nexit 0\n');
    const output = execFileSync('sh', ['-s'], {input: script, encoding: 'utf8',
                                               env: {PATH: `${bin}:${windowsNpm}:/usr/bin:/bin`, HOME: '/home/dan'}});
    const probe = parseProbe(output);
    assert.deepEqual(probe?.commands, ['codex']);
    assert.deepEqual(probe?.versions, {codex: 'codex-cli 0.140.0'});
    assert.equal(probe?.mount, `${join(root, 'mnt')}/`);
    assert.match(output, /@@agent-companion:after=1/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('reads wsl.exe lists in UTF-16 and UTF-8, without the distributions of other tools', () => {
  const utf16 = Buffer.from('\uFEFFUbuntu\r\ndocker-desktop\r\nDebian\r\n', 'utf16le');
  assert.equal(decodeWslOutput(utf16), 'Ubuntu\r\ndocker-desktop\r\nDebian\r\n');
  assert.equal(decodeWslOutput(Buffer.from('Ubuntu\r\n', 'utf16le')), 'Ubuntu\r\n');
  assert.equal(decodeWslOutput(Buffer.from('Ubuntu-24.04\n', 'utf8')), 'Ubuntu-24.04\n');
  assert.deepEqual(parseDistributions('Ubuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\nrancher-desktop\r\n'
    + 'bad name\r\n\r\nkali.linux_2\r\n'), ['Ubuntu-24.04', 'kali.linux_2']);
});

test('runs the WSL in Program Files before the System32 copy that forwards to it', () => {
  const env = {ProgramW6432: 'D:\\Apps', SystemRoot: 'E:\\Win'};
  const store = 'D:\\Apps\\WSL\\wsl.exe';
  const inbox = 'E:\\Win\\System32\\wsl.exe';
  assert.equal(wslExecutable(env, path => path === store || path === inbox), store);
  assert.equal(wslExecutable(env, path => path === inbox), inbox);
  assert.equal(wslExecutable(env, () => false), undefined);
});

test('maps paths between Windows and a distribution', () => {
  const probe = {mount: '/mnt/'};
  assert.equal(wslHostPath('Ubuntu', probe, '/home/dan/.claude'), '\\\\wsl$\\Ubuntu\\home\\dan\\.claude');
  assert.equal(wslHostPath('Ubuntu', probe, '/mnt/c/Users/Dan/node.exe'), 'C:\\Users\\Dan\\node.exe');
  assert.equal(wslHostPath('Ubuntu', probe, '/mnt/d'), 'D:\\');
  assert.equal(wslHostPath('Ubuntu', {mount: '/'}, '/c/tools'), 'C:\\tools');
  assert.equal(wslHostPath('Ubuntu', {}, '/mnt/c/tools'), '\\\\wsl$\\Ubuntu\\mnt\\c\\tools');

  assert.equal(wslAgentPath('Ubuntu', probe, '\\\\wsl$\\Ubuntu\\home\\dan\\.codex\\hooks.json'), '/home/dan/.codex/hooks.json');
  assert.equal(wslAgentPath('Ubuntu', probe, '\\\\wsl.localhost\\Ubuntu\\home\\dan'), '/home/dan');
  assert.equal(wslAgentPath('Ubuntu', probe, '\\\\WSL$\\ubuntu'), '/');
  assert.equal(wslAgentPath('Ubuntu', probe, 'C:\\Users\\Dan\\cli.js'), '/mnt/c/Users/Dan/cli.js');
  // Another distribution's files stay as they are.
  assert.equal(wslAgentPath('Ubuntu', probe, '\\\\wsl$\\Debian\\home'), '\\\\wsl$\\Debian\\home');
  for (const path of ['/home/dan/a b/c', '/mnt/c/Users/Dan/x'])
    assert.equal(wslAgentPath('Ubuntu', probe, wslHostPath('Ubuntu', probe, path)), path);

  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\dan\\.claude\\settings.json'),
                   {distribution: 'Ubuntu', path: '/home/dan/.claude/settings.json'});
  assert.equal(parseWslPath('C:\\Users\\Dan'), undefined);
});

test('gives a distribution Linux hooks that run the Windows node.exe and CLI', () => {
  const host = defaultAgentContext({
    home: 'C:\\Users\\Dan', node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Agent Companion\\cli.js',
    platform: 'win32', env: {}, dataDir: 'C:\\data', socketPath: '\\\\.\\pipe\\agent-companion',
  });
  const ctx = wslContext(host, 'Ubuntu', {
    home: '/home/dan', node: '/mnt/c/Program Files/nodejs/node.exe', mount: '/mnt/',
    env: {CODEX_HOME: '/home/dan/codex', GROK_HOME: 'relative'}, commands: [], versions: {codex: 'codex-cli 0.164.0'},
    interop: true,
  });
  assert.equal(ctx.platform, 'linux');
  assert.equal(ctx.home, '\\\\wsl$\\Ubuntu\\home\\dan');
  assert.equal(ctx.node, '/mnt/c/Program Files/nodejs/node.exe');
  assert.equal(ctx.cli, host.cli);
  assert.equal(ctx.socketPath, host.socketPath);
  assert.deepEqual(ctx.env, {PATH: '', HOME: '/home/dan', CODEX_HOME: '\\\\wsl$\\Ubuntu\\home\\dan\\codex', GROK_HOME: 'relative'});
  // This service can't run the distribution's codex, so its version comes from the probe.
  assert.deepEqual(ctx.commandVersions, {codex: 'codex-cli 0.164.0'});
  assert.equal(ctx.runCommand, undefined);
});

test('checks the Linux node path of a hook through the Windows path of the file', () => {
  const cli = fileURLToPath(import.meta.url);
  const found = [{node: '/mnt/c/node.exe', cli, event: 'Stop'}];
  assert.equal(hookHealth(found, ['Stop'], {cli}), 'outdated');
  assert.equal(hookHealth(found, ['Stop'], {cli, hostPath: path => path === '/mnt/c/node.exe' ? process.execPath : path}),
               'installed');
});

test('combines the hook status of each place', () => {
  assert.equal(combinedStatus(['installed', 'installed']), 'installed');
  assert.equal(combinedStatus(['missing', 'missing']), 'missing');
  assert.equal(combinedStatus(['installed', 'missing']), 'outdated');
  assert.equal(combinedStatus(['installed', 'needs-approval']), 'needs-approval');
  assert.equal(combinedStatus(['unsupported', 'installed']), 'installed');
  assert.equal(combinedStatus(['unsupported']), 'unsupported');
  assert.equal(combinedStatus([]), 'missing');
});

function fakeWsl(state: {running: Set<string>; interop?: boolean}): {run: WslRunner; probes: string[]} {
  const probes: string[] = [];
  const list = (names: string[]) => ({status: 0, stdout: Buffer.from(`\uFEFF${names.join('\r\n')}\r\n`, 'utf16le')});
  const run: WslRunner = async (args) => {
    if (args.join(' ') === '--list --quiet') return list(['Ubuntu', 'Debian', 'docker-desktop']);
    if (args.join(' ') === '--list --running --quiet')
      return state.running.size ? list([...state.running]) : {status: 1, stdout: Buffer.alloc(0)};
    const name = args[1]!;
    probes.push(name);
    state.running.add(name);
    const lines = [`home=/home/${name.toLowerCase()}`, 'node=/mnt/c/node.exe', 'mount=/mnt/c/', 'command=claude'];
    if (state.interop !== false) lines.push('interop=1');
    return {status: 0, stdout: Buffer.from(probeOutput(lines))};
  };
  return {run, probes};
}

test('looks only into running distributions, until an uninstall needs all of them', async () => {
  const host = defaultAgentContext({home: 'C:\\Users\\Dan', node: 'C:\\node.exe', cli: 'C:\\cli.js', platform: 'win32',
                                    env: {}, dataDir: 'C:\\data', socketPath: '\\\\.\\pipe\\x'});
  let now = 0;
  const state = {running: new Set(['Ubuntu'])};
  const {run, probes} = fakeWsl(state);
  const wsl = new WslLocations(host, run, () => now);
  assert.deepEqual(wsl.list(), []);
  await wsl.refresh();
  let [ubuntu, debian] = wsl.list();
  assert.equal(wsl.list().length, 2);
  assert.deepEqual({id: ubuntu!.id, name: ubuntu!.name, running: ubuntu!.running, commands: ubuntu!.commands},
                   {id: 'wsl:Ubuntu', name: 'WSL: Ubuntu', running: true, commands: ['claude']});
  assert.equal(ubuntu!.ctx?.home, '\\\\wsl$\\Ubuntu\\home\\ubuntu');
  assert.equal(ubuntu!.problem, undefined);
  assert.deepEqual({running: debian!.running, ctx: debian!.ctx}, {running: false, ctx: undefined});
  assert.deepEqual(probes, ['Ubuntu']);

  // A recent probe is used again.
  now += 60_000;
  await wsl.refresh();
  assert.deepEqual(probes, ['Ubuntu']);
  // A distribution that stopped and started again is probed again.
  state.running.clear();
  await wsl.refresh();
  assert.equal(wsl.list()[0]!.running, false);
  state.running.add('Ubuntu');
  await wsl.refresh();
  assert.deepEqual(probes, ['Ubuntu', 'Ubuntu']);

  await wsl.refresh({all: true});
  [ubuntu, debian] = wsl.list();
  assert.deepEqual(probes, ['Ubuntu', 'Ubuntu', 'Debian']);
  assert.equal(debian!.running, true);
  assert.equal(debian!.ctx?.home, '\\\\wsl$\\Debian\\home\\debian');
});

test('tells the user when interop is off in a distribution', async () => {
  const host = defaultAgentContext({home: 'C:\\Users\\Dan', node: 'C:\\node.exe', cli: 'C:\\cli.js', platform: 'win32',
                                    env: {}, dataDir: 'C:\\data', socketPath: '\\\\.\\pipe\\x'});
  const {run} = fakeWsl({running: new Set(['Ubuntu']), interop: false});
  const wsl = new WslLocations(host, run);
  await wsl.refresh();
  assert.match(wsl.list()[0]!.problem ?? '', /interop is off in Ubuntu/);
});

test('an explicit rescan reprobes running WSL agents without starting stopped distributions', async () => {
  const host = defaultAgentContext({platform: 'win32', env: {}});
  const state = {running: new Set(['Ubuntu'])};
  const {run, probes} = fakeWsl(state);
  const wsl = new WslLocations(host, run, () => 0);
  await wsl.refresh();
  await wsl.refresh();
  assert.deepEqual(probes, ['Ubuntu']);
  await wsl.refresh({force: true});
  assert.deepEqual(probes, ['Ubuntu', 'Ubuntu']);
  assert.equal(state.running.has('Debian'), false);
  state.running.clear();
  await wsl.refresh({force: true});
  assert.deepEqual(probes, ['Ubuntu', 'Ubuntu']);
});

test('a refresh that fails does not stop the next one', async () => {
  const host = defaultAgentContext({platform: 'win32', env: {}});
  let calls = 0;
  const wsl = new WslLocations(host, async () => {
    calls++;
    return {status: 1, stdout: Buffer.alloc(0)};
  });
  await wsl.refresh();
  await wsl.refresh();
  assert.equal(calls, 4);
  assert.deepEqual(wsl.list(), []);
});

class FakeLocations implements AgentLocations {
  constructor(public locations: AgentLocation[]) {}
  list(): AgentLocation[] {
    return this.locations;
  }
  async refresh(): Promise<void> {}
}

async function locationFixture() {
  const root = join(process.cwd(), '.test-output', `wsl-${randomUUID()}`);
  const hostHome = join(root, 'host');
  const linuxRoot = join(root, 'ubuntu');
  const linuxHome = join(linuxRoot, 'home', 'dan');
  await mkdir(hostHome, {recursive: true});
  await mkdir(linuxHome, {recursive: true});
  await writeFile(join(root, 'node'), '');
  await writeFile(join(root, 'cli.js'), '');
  const previous = process.env.AGENT_COMPANION_AGENTS_CONFIG;
  process.env.AGENT_COMPANION_AGENTS_CONFIG = join(root, 'agents.json');
  const host = defaultAgentContext({
    home: hostHome, node: join(root, 'node'), cli: join(root, 'cli.js'), platform: 'darwin', env: {PATH: ''},
    dataDir: join(root, 'data'), socketPath: join(root, 'daemon.sock'), runCommand: async () => ({stdout: '', status: 0}),
    appFolders: [],
  });
  const ubuntuCtx: AgentContext = {
    home: linuxHome, node: '/mnt/c/node.exe', cli: host.cli, platform: 'linux', env: {PATH: '', HOME: '/home/dan'},
    dataDir: host.dataDir, socketPath: host.socketPath,
    hostPath: path => path === '/mnt/c/node.exe' ? host.node
      : path.startsWith('/') && !path.startsWith(root) ? join(linuxRoot, path) : path,
    agentPath: path => path.startsWith(linuxRoot) ? path.slice(linuxRoot.length).replaceAll('\\', '/') : path,
  };
  const ubuntu: AgentLocation = {id: 'wsl:Ubuntu', name: 'WSL: Ubuntu', running: true, commands: [], ctx: ubuntuCtx};
  host.locations = new FakeLocations([ubuntu]);
  return {
    root, hostHome, linuxHome, host, ubuntu,
    cleanup: async () => {
      if (previous === undefined) delete process.env.AGENT_COMPANION_AGENTS_CONFIG;
      else process.env.AGENT_COMPANION_AGENTS_CONFIG = previous;
      await rm(root, {recursive: true, force: true});
    },
  };
}

test('installs and removes hooks in a distribution where only it has the agent', async () => {
  const {hostHome, linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    await mkdir(join(linuxHome, '.claude'), {recursive: true});
    ubuntu.commands = ['claude'];
    const settings = join(linuxHome, '.claude', 'settings.json');
    assert.deepEqual(await installAgent('claude', host), []);
    assert.equal(existsSync(join(hostHome, '.claude')), false);
    const text = await readFile(settings, 'utf8');
    assert.match(text, /\/mnt\/c\/node\.exe/);

    const claude = agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'claude')!;
    assert.equal(claude.detected, true);
    assert.equal(claude.installed, true);
    assert.equal(claude.hookStatus, 'installed');
    assert.deepEqual(claude.locations?.map(location => [location.id, location.detected, location.hookStatus]),
                     [['host', false, 'missing'], ['wsl:Ubuntu', true, 'installed']]);
    assert.equal(claude.locations?.[1]?.configPath, '/home/dan/.claude/settings.json');

    // A stopped distribution keeps the status it last had, and an install asks the user to start it.
    ubuntu.running = false;
    const stopped = agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'claude')!;
    assert.equal(stopped.locations?.[1]?.running, false);
    assert.equal(stopped.locations?.[1]?.hookStatus, 'installed');
    await assert.rejects(installAgent('claude', host), /Open WSL: Ubuntu so the service can reach it/);
    ubuntu.running = true;

    await uninstallAgent('claude', host);
    assert.doesNotMatch(await readFile(settings, 'utf8'), /agent-companion|cli\.js/);
    const removed = agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'claude')!;
    assert.equal(removed.installed, false);
  } finally {
    await cleanup();
  }
});

test('missing-only hook setup preserves current host and WSL hook files', async () => {
  const {hostHome, linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    await mkdir(join(linuxHome, '.copilot'), {recursive: true});
    ubuntu.commands = ['copilot'];
    await installAgent('copilot', host);
    const hostHooks = join(hostHome, '.copilot', 'hooks', 'agent-companion.json');
    const wslHooks = join(linuxHome, '.copilot', 'hooks', 'agent-companion.json');
    for (const {current, missing} of [
      {current: hostHooks, missing: wslHooks}, {current: wslHooks, missing: hostHooks},
    ]) {
      const text = JSON.stringify({...JSON.parse(await readFile(current, 'utf8')), note: 'Keep this current file.'}) + '\n';
      await writeFile(current, text);
      const before = await stat(current);
      await rm(missing);
      assert.deepEqual(await installAgent('copilot', host, true), []);
      assert.equal(await readFile(current, 'utf8'), text);
      assert.equal((await stat(current)).mtimeMs, before.mtimeMs);
      assert.equal(agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'copilot')?.hookStatus, 'installed');
    }
  } finally {
    await cleanup();
  }
});

test('approved removal reaches a stopped WSL installation as well as native host hooks', async () => {
  const {hostHome, linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    await mkdir(join(hostHome, '.claude'), {recursive: true});
    await mkdir(join(linuxHome, '.claude'), {recursive: true});
    ubuntu.commands = ['claude'];
    await writeFile(join(hostHome, '.claude', 'settings.json'), '{}');
    await installAgent('claude', host);
    const found = agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'claude')!;
    assert.deepEqual(found.locations?.map(location => location.detected), [true, true]);
    ubuntu.running = false;
    let approvedScan = false;
    host.locations = {
      list: () => [ubuntu],
      async refresh(options) {
        approvedScan = options?.all === true && options.force === true;
        if (options?.all) ubuntu.running = true;
      },
    };
    await uninstallAgent('claude', host, true);
    assert.equal(approvedScan, true);
    assert.doesNotMatch(await readFile(join(hostHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    assert.doesNotMatch(await readFile(join(linuxHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
  } finally {
    await cleanup();
  }
});
test('reports the problem of a distribution as a warning and installs the other places', async () => {
  const {hostHome, linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    await mkdir(join(hostHome, '.claude'), {recursive: true});
    await writeFile(join(hostHome, '.claude', 'settings.json'), '{}');
    await mkdir(join(linuxHome, '.claude'), {recursive: true});
    ubuntu.problem = 'Windows interop is off in Ubuntu.';
    const warnings = await installAgent('claude', host);
    assert.deepEqual(warnings, ['WSL: Ubuntu: Windows interop is off in Ubuntu.']);
    assert.match(await readFile(join(hostHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    assert.equal(existsSync(join(linuxHome, '.claude', 'settings.json')), false);
    const claude = agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'claude')!;
    assert.equal(claude.locations?.[1]?.hookStatus, 'unsupported');
    assert.equal(claude.locations?.[1]?.hint, 'Windows interop is off in Ubuntu.');
  } finally {
    await cleanup();
  }
});

test('reads Codex approvals by the path that Codex in the distribution sees', async () => {
  const {linuxHome, ubuntu, host, cleanup} = await locationFixture();
  try {
    await mkdir(join(linuxHome, '.codex'), {recursive: true});
    await installAgent('codex', host);
    const hooks = JSON.parse(await readFile(join(linuxHome, '.codex', 'hooks.json'), 'utf8')) as
      {hooks: Record<string, Array<{hooks: unknown[]}>>};
    const snake = (event: string) => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const keys = (file: string) => Object.entries(hooks.hooks).flatMap(([event, groups]) =>
      groups.flatMap((group, groupIndex) => group.hooks.map((_, hookIndex) =>
        `[hooks.state."${file}:${snake(event)}:${groupIndex}:${hookIndex}"]\ntrusted_hash = "x"\n`))).join('');
    const config = join(linuxHome, '.codex', 'config.toml');
    const waiting = untrustedCodexHooks(ubuntu.ctx!).length;
    assert.ok(waiting > 0);
    // Keys with the path that Windows opens are not the ones Codex in WSL writes.
    await writeFile(config, keys(join(linuxHome, '.codex', 'hooks.json')));
    assert.equal(untrustedCodexHooks(ubuntu.ctx!).length, waiting);
    await writeFile(config, keys('/home/dan/.codex/hooks.json'));
    assert.deepEqual(untrustedCodexHooks(ubuntu.ctx!), []);
  } finally {
    await cleanup();
  }
});

test('the Codex approval steps name each place whose hooks wait, with a CLI that runs there', async () => {
  const {hostHome, linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    const action = () => agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'codex')?.action;
    await mkdir(join(linuxHome, '.codex'), {recursive: true});
    await installAgent('codex', host);
    ubuntu.commands = ['codex'];
    // Only the distribution's hooks wait, so the user runs codex there.
    assert.equal(action()?.steps[0], 'In WSL: Ubuntu, open a terminal and run codex.');
    assert.equal(action()?.command, undefined);
    // Hooks on this computer wait too. Codex in the distribution can't approve them, and this
    // computer has no Codex CLI.
    await mkdir(join(hostHome, '.codex'), {recursive: true});
    await codexAdapter.install(host);
    const steps = action()?.steps ?? [];
    assert.match(steps[0] ?? '', /^Install the Codex CLI/);
    assert.equal(steps[1], 'In WSL: Ubuntu, open a terminal and run codex.');
  } finally {
    await cleanup();
  }
});

test('a Codex in a distribution that can’t run the hooks gets an update step', async () => {
  const {linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    const codex = () => agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'codex')!;
    const update = 'Your Codex CLI 0.140.0 can’t run the Agent Buddy hooks. Update the Codex CLI.';
    await mkdir(join(linuxHome, '.codex'), {recursive: true});
    ubuntu.commands = ['codex'];
    ubuntu.ctx = {...ubuntu.ctx!, commandVersions: {codex: 'codex-cli 0.140.0'}};
    // Settings shows it on the distribution's row, and the setup guide names the distribution.
    assert.equal(codex().locations?.find(location => location.id === 'wsl:Ubuntu')?.hint, update);
    await installAgent('codex', host);
    // That codex doesn't list the hooks in /hooks, so the guide updates it before it runs it to approve them.
    const steps = codex().action?.steps ?? [];
    const updateStep = `In WSL: Ubuntu, y${update.slice(1)}`;
    assert.equal(steps.filter(step => step === updateStep).length, 1);
    assert.equal(steps.indexOf(updateStep) + 1, steps.indexOf('In WSL: Ubuntu, open a terminal and run codex.'));
    assert.equal(codex().locations?.find(location => location.id === 'wsl:Ubuntu')?.hint,
                 `${update} Approve the new hooks with /hooks in the Codex CLI, then reopen the ChatGPT app.`);

    // A VS Code window in the distribution runs the Codex of the extension in .vscode-server.
    const extensions = join(linuxHome, '.vscode-server', 'extensions');
    const bin = join(extensions, 'openai.chatgpt-26.715.1-linux-x64', 'bin', 'linux-x86_64');
    await mkdir(bin, {recursive: true});
    await writeFile(join(bin, 'codex-package.json'), JSON.stringify({layoutVersion: 1, version: '0.145.0-alpha.30'}));
    await writeFile(join(extensions, 'extensions.json'), JSON.stringify([
      {identifier: {id: 'openai.chatgpt'}, version: '26.715.1', relativeLocation: 'openai.chatgpt-26.715.1-linux-x64'},
    ]));
    ubuntu.ctx = {...ubuntu.ctx!, commandVersions: {codex: 'codex-cli 0.164.0'}};
    const extensionSteps = () => codex().action?.steps.filter(step => step.startsWith('In WSL: Ubuntu, the'));
    assert.deepEqual(extensionSteps(), [
      'In WSL: Ubuntu, the Codex extension in VS Code includes Codex 0.145.0-alpha.30, which can’t run the Agent '
        + 'Buddy hooks. Update the extension, then reload the VS Code window.',
    ]);
    // Remote windows that the user no longer opens leave an old list, which doesn't count.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    await utimes(join(extensions, 'extensions.json'), old, old);
    assert.deepEqual(extensionSteps(), []);
  } finally {
    await cleanup();
  }
});

test('hooks that an older probe put in a distribution without the agent don’t count, and Remove deletes them', async () => {
  const {linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    // An older probe counted the Windows codex that WSL finds through the Windows PATH, so setup put
    // hooks in the distribution, although Codex never ran there.
    ubuntu.commands = ['codex'];
    await installAgent('codex', host);
    const hooks = join(linuxHome, '.codex', 'hooks.json');
    assert.match(await readFile(hooks, 'utf8'), /hook codex/);
    ubuntu.commands = [];
    const codex = () => agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'codex')!;
    const row = () => codex().locations?.find(location => location.id === 'wsl:Ubuntu');
    // The folder holds only those hooks, so Codex isn't there, and the guide doesn't ask for approval there.
    assert.equal(row()?.detected, false);
    assert.equal(row()?.hookStatus, 'needs-approval');
    assert.equal(row()?.hint, 'Codex isn’t installed in this distribution, so these hooks never run there.');
    assert.equal(codex().hookStatus, 'missing');
    assert.equal(codex().action, undefined);
    // They still count as installed, so Remove deletes them, and an install doesn't put them back.
    assert.equal(codex().installed, true);
    await uninstallAgent('codex', host);
    assert.doesNotMatch(await readFile(hooks, 'utf8'), /hook codex/);
    await installAgent('codex', host);
    assert.doesNotMatch(await readFile(hooks, 'utf8'), /hook codex/);
    // The files that Codex writes when it runs there show that it is there.
    await writeFile(join(linuxHome, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    assert.equal(row()?.detected, true);
  } finally {
    await cleanup();
  }
});

test('Remove leaves the empty hooks folder of Copilot, which doesn’t count as Copilot', async () => {
  const {linuxHome, host, ubuntu, cleanup} = await locationFixture();
  try {
    // Copilot keeps the hook file in a hooks folder, and Remove deletes only the file.
    ubuntu.commands = ['copilot'];
    await installAgent('copilot', host);
    const hooks = join(linuxHome, '.copilot', 'hooks');
    assert.deepEqual(readdirSync(hooks), ['agent-companion.json']);
    ubuntu.commands = [];
    const copilot = () => agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'copilot')!;
    const row = () => copilot().locations?.find(location => location.id === 'wsl:Ubuntu');
    assert.equal(row()?.detected, false);
    assert.match(row()?.hint ?? '', /isn’t installed in this distribution/);
    await uninstallAgent('copilot', host);
    assert.deepEqual(readdirSync(hooks), []);
    assert.equal(row(), undefined);
    // Install puts the hooks back on this computer only.
    await installAgent('copilot', host);
    assert.equal(copilot().hookStatus, 'installed');
    assert.deepEqual(readdirSync(hooks), []);
  } finally {
    await cleanup();
  }
});

test('an empty hooks folder that Remove left doesn’t count when the service starts', async () => {
  const {linuxHome, host, cleanup} = await locationFixture();
  try {
    const folder = join(linuxHome, '.copilot');
    await mkdir(join(folder, 'hooks'), {recursive: true});
    // A file system with coarse timestamps (such as NTFS) can give the folder the same mtime before and
    // after a quick change. A whole second is the same each time it is set. It is a minute in the past,
    // as from a WSL distribution whose clock is behind this computer's.
    const sameStep = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(join(folder, 'hooks'), sameStep, sameStep);
    await utimes(folder, sameStep, sameStep);
    const row = () => agentStatuses(host, new Map(), new Map()).find(agent => agent.id === 'copilot')!
      .locations?.find(location => location.id === 'wsl:Ubuntu');
    assert.equal(row(), undefined);
    // A file that Copilot writes shows that it is there, also when the folder keeps its mtime.
    await writeFile(join(folder, 'config.json'), '{}');
    await utimes(folder, sameStep, sameStep);
    assert.equal(row()?.detected, true);
  } finally {
    await cleanup();
  }
});

test('an uninstall of the service removes the hooks in every place', async () => {
  const {hostHome, linuxHome, host, cleanup} = await locationFixture();
  try {
    await mkdir(join(hostHome, '.claude'), {recursive: true});
    await writeFile(join(hostHome, '.claude', 'settings.json'), '{}');
    await mkdir(join(linuxHome, '.claude'), {recursive: true});
    await installAgent('claude', host);
    assert.match(await readFile(join(hostHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    assert.match(await readFile(join(linuxHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    assert.deepEqual(await removeAllAgentHooks(host), []);
    assert.doesNotMatch(await readFile(join(hostHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    assert.doesNotMatch(await readFile(join(linuxHome, '.claude', 'settings.json'), 'utf8'), /cli\.js/);
    // Agents that have no hooks get no new files.
    assert.equal(existsSync(join(linuxHome, '.copilot')), false);
  } finally {
    await cleanup();
  }
});

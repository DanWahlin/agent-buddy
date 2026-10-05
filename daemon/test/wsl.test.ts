import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
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
import {untrustedCodexHooks} from '../src/agents/codex.js';
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
                 'env:CODEX_HOME=/home/dan/codex', 'env:EMPTY=', 'command=claude', 'command=codex', 'interop=1']),
  ].join('\r\n'));
  assert.deepEqual(probe, {
    home: '/home/dan', node: '/mnt/c/Program Files/nodejs/node.exe', mount: '/mnt/', env: {CODEX_HOME: '/home/dan/codex'},
    commands: ['claude', 'codex'], interop: true,
  });
  // A custom automount root, no interop, and a node path that wslpath could not make.
  assert.deepEqual(parseProbe(probeOutput(['home=/root', 'node=', 'mount=/c/'])),
                   {home: '/root', mount: '/', env: {}, commands: [], interop: false});
  assert.equal(parseProbe('no markers here'), undefined);
  assert.equal(parseProbe(probeOutput(['home=relative'])), undefined);

  const script = probeScript('C:\\Program Files\\nodejs\\node.exe');
  assert.match(script, /wslpath -u 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /WSLInterop-late/);
  assert.match(script, /exit 0\n$/);
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
    env: {CODEX_HOME: '/home/dan/codex', GROK_HOME: 'relative'}, commands: [], interop: true,
  });
  assert.equal(ctx.platform, 'linux');
  assert.equal(ctx.home, '\\\\wsl$\\Ubuntu\\home\\dan');
  assert.equal(ctx.node, '/mnt/c/Program Files/nodejs/node.exe');
  assert.equal(ctx.cli, host.cli);
  assert.equal(ctx.socketPath, host.socketPath);
  assert.deepEqual(ctx.env, {PATH: '', HOME: '/home/dan', CODEX_HOME: '\\\\wsl$\\Ubuntu\\home\\dan\\codex', GROK_HOME: 'relative'});
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

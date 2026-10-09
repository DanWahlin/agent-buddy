import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {parseDocument} from 'yaml';
import {codexAdapter, hasHookState} from '../src/agents/codex.js';
import {codexQuote, commandInvocation, environmentValue, findExecutable, isCompanionCli, isCompanionHookCommand,
  powershellHookCommand, samePath, shellHookCommand} from '../src/agents/commands.js';
import {grokAdapter} from '../src/agents/grok.js';
import {cursorAdapter} from '../src/agents/cursor.js';
import {hermesAdapter} from '../src/agents/hermes.js';
import {hermesHome} from '../src/agents/homes.js';
import {defaultAgentContext} from '../src/agents/index.js';
import {parseHookCommand} from '../src/agents/hook-config.js';
import {defaultPython} from '../src/character-build.js';

test('finds Windows commands through Path and PATHEXT', () => {
  const env = {Path: 'C:\\Tools;"C:\\Program Files\\nodejs"', PATHEXT: '.EXE;.CMD'};
  assert.equal(environmentValue(env, 'PATH', 'win32'), env.Path);
  assert.equal(environmentValue(env, 'PATH', 'linux'), undefined);
  // Windows file names ignore case.
  const files = new Set(['c:\\program files\\nodejs\\codex.cmd', 'c:\\tools\\node.exe']);
  const exists = (path: string) => files.has(path.toLowerCase());
  assert.equal(findExecutable('codex', env, 'win32', exists), 'C:\\Program Files\\nodejs\\codex.CMD');
  assert.equal(findExecutable('node', env, 'win32', exists), 'C:\\Tools\\node.EXE');
  assert.equal(findExecutable('node.exe', env, 'win32', exists), 'C:\\Tools\\node.exe');
  assert.equal(findExecutable('grok', env, 'win32', exists), undefined);
});

test('runs Windows .cmd shims through cmd.exe and other programs directly', () => {
  assert.deepEqual(commandInvocation('C:\\Tools\\node.exe', ['--version'], {}, 'win32'),
                   {file: 'C:\\Tools\\node.exe', args: ['--version']});
  assert.deepEqual(commandInvocation('C:\\npm\\codex.cmd', ['--version'], {ComSpec: 'C:\\Windows\\cmd.exe'}, 'win32'), {
    file: 'C:\\Windows\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:\\npm\\codex.cmd" "--version""'],
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(commandInvocation('/usr/bin/codex.cmd', ['x'], {}, 'linux'), {file: '/usr/bin/codex.cmd', args: ['x']});
});

test('writes Windows hook command lines for Hermes and for Grok\'s PowerShell', () => {
  const ctx = {node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\Dan\\AC\\daemon\\dist\\src\\cli.js',
               platform: 'win32' as const};
  const command = shellHookCommand(ctx, 'grok', 'SessionStart');
  assert.equal(command,
    '"C:/Program Files/nodejs/node.exe" "C:/Users/Dan/AC/daemon/dist/src/cli.js" hook grok SessionStart');
  assert.deepEqual(parseHookCommand(command, 'grok'), {
    node: 'C:/Program Files/nodejs/node.exe', cli: 'C:/Users/Dan/AC/daemon/dist/src/cli.js', event: 'SessionStart'});
  assert.equal(samePath('C:/Users/Dan/AC/cli.js', 'c:\\users\\dan\\AC\\cli.js'), true);
  assert.equal(samePath('/Users/Dan/cli.js', '/users/dan/cli.js'), false);
  assert.equal(shellHookCommand({...ctx, platform: 'linux'}, 'grok', 'Stop'),
               `'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Dan\\AC\\daemon\\dist\\src\\cli.js' hook grok Stop`);
  const powershell = powershellHookCommand({...ctx, cli: "C:\\Users\\O'Neil\\AC\\daemon\\dist\\src\\cli.js"}, 'grok', 'Stop');
  assert.equal(powershell, `& 'C:/Program Files/nodejs/node.exe' 'C:/Users/O''Neil/AC/daemon/dist/src/cli.js' hook grok Stop`);
  assert.deepEqual(parseHookCommand(powershell, 'grok'), {
    node: 'C:/Program Files/nodejs/node.exe', cli: "C:/Users/O'Neil/AC/daemon/dist/src/cli.js", event: 'Stop'});
});

test('finds the hooks of another Windows install in each quote style', () => {
  const ctx = {cli: 'C:\\Users\\Dan\\AC\\daemon\\dist\\src\\cli.js'};
  const other = 'C:\\Users\\Dan\\AppData\\Local\\Agent Companion\\runtime\\daemon\\dist\\src\\cli.js';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(isCompanionHookCommand(`${codexQuote(node)} ${codexQuote(other)} hook codex Stop`, 'codex', ctx), true);
  assert.equal(isCompanionHookCommand(`"${node}" "${other}" hook claude Stop`, 'claude', ctx), true);
  assert.equal(isCompanionHookCommand(`"${other.replaceAll('\\', '/')}" hook grok Stop`, 'grok', ctx), true);
  assert.equal(isCompanionHookCommand(`& '${node}' '${other.replaceAll('\\', '/')}' hook grok Stop`, 'grok', ctx), true);
  assert.equal(isCompanionHookCommand(`${codexQuote(node)} ${codexQuote(other)} hook codex Stop`, 'claude', ctx), false);
  assert.equal(isCompanionCli(other.replaceAll('\\', '\\\\'), ctx), true);
  assert.equal(isCompanionCli('C:\\tools\\cli.js', ctx), false);
});

test('reads Codex approvals whose Windows path TOML escaped', () => {
  const key = 'C:\\Users\\Dan\\.codex\\hooks.json:session_start:0:0';
  assert.equal(hasHookState('[hooks.state."C:\\\\Users\\\\Dan\\\\.codex\\\\hooks.json:session_start:0:0"]', key), true);
  assert.equal(hasHookState(`[hooks.state.'${key}']`, key), true);
  assert.equal(hasHookState('[hooks.state."/home/dan/.codex/hooks.json:session_start:0:0"]',
                            '/home/dan/.codex/hooks.json:session_start:0:0'), true);
  assert.equal(hasHookState('[hooks.state."C:\\\\Users\\\\Dan\\\\.codex\\\\hooks.json:stop:0:0"]', key), false);
});

test('installs Windows forms of the Codex, Cursor, Grok, and Hermes hooks', async () => {
  const root = join(process.cwd(), '.test-output', `windows-${randomUUID()}`);
  const home = join(root, 'home');
  const node = join(root, 'node bin', 'node.exe');
  const cli = join(root, 'agent companion', 'daemon', 'dist', 'src', 'cli.js');
  for (const path of [node, cli]) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, '');
  }
  const local = join(root, 'local');
  const ctx = defaultAgentContext({home, node, cli, platform: 'win32', env: {PATH: '', LOCALAPPDATA: local}, dataDir: join(root, 'data'),
                                   socketPath: join(root, 'pipe'), runCommand: async () => ({stdout: '', status: 0})});
  try {
    await codexAdapter.install(ctx);
    const codex = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
    const handler = codex.hooks.SessionStart.at(-1).hooks[0];
    const codexPath = join(home, '.codex', 'hooks.json');
    assert.equal(handler.commandWindows, `& '${node.replaceAll('\\', '/')}' '${cli.replaceAll('\\', '/')}' hook codex SessionStart`);
    assert.match(handler.command, /hook codex SessionStart$/);
    assert.notEqual(codexAdapter.hookStatus(ctx), 'outdated');
    // Codex runs hooks in PowerShell, so the cmd.exe form of earlier versions shows as outdated.
    codex.hooks.SessionStart.at(-1).hooks[0].commandWindows = `"${node}" "${cli}" hook codex SessionStart`;
    await writeFile(codexPath, JSON.stringify(codex));
    assert.equal(codexAdapter.hookStatus(ctx), 'outdated');
    await codexAdapter.install(ctx);
    assert.notEqual(codexAdapter.hookStatus(ctx), 'outdated');

    await grokAdapter.install(ctx);
    const grokPath = join(home, '.grok', 'hooks', 'agent-companion.json');
    const grokText = await readFile(grokPath, 'utf8');
    const grok = JSON.parse(grokText);
    assert.equal(Object.values(grok.hooks as Record<string, Array<{hooks: Array<{command: string}>}>>)[0]![0]!.hooks[0]!.command
      .startsWith(`& '${node.replaceAll('\\', '/')}' `), true);
    assert.equal(grokAdapter.hookStatus(ctx), 'installed');
    // The double-quoted form of earlier versions fails in PowerShell, so Settings offers a reinstall.
    await writeFile(grokPath, grokText.replace(/"command": "& '([^']*)' '([^']*)'/g, '"command": "\\"$1\\" \\"$2\\"'));
    assert.match(await readFile(grokPath, 'utf8'), /"command": "\\"/);
    assert.equal(grokAdapter.hookStatus(ctx), 'outdated');
    await grokAdapter.install(ctx);
    assert.equal(grokAdapter.hookStatus(ctx), 'installed');

    // Earlier versions wrote to ~/.hermes, which Hermes does not read on Windows.
    const legacy = join(home, '.hermes', 'config.yaml');
    await mkdir(dirname(legacy), {recursive: true});
    await writeFile(legacy, `model: x\nhooks:\n  pre_llm_call:\n    - command: '${shellHookCommand(ctx, 'hermes', 'pre_llm_call')}'\n`);
    await hermesAdapter.install(ctx);
    const legacyAfter = parseDocument(await readFile(legacy, 'utf8')).toJS() as {model: string; hooks?: Record<string, unknown[]>};
    assert.equal(legacyAfter.model, 'x');
    assert.deepEqual(Object.values(legacyAfter.hooks ?? {}).flat(), []);
    const hermes = parseDocument(await readFile(join(local, 'hermes', 'config.yaml'), 'utf8')).toJS() as
      {hooks: Record<string, Array<{command: string}>>};
    const commands = Object.values(hermes.hooks).flat().map(entry => entry.command);
    assert.ok(commands.length > 0);
    const slash = (path: string) => path.replaceAll('\\', '/');
    assert.ok(commands.every(command => command.startsWith(`"${slash(node)}" "${slash(cli)}" hook hermes `)));
    await hermesAdapter.uninstall(ctx);
    const after = parseDocument(await readFile(join(local, 'hermes', 'config.yaml'), 'utf8')).toJS() as
      {hooks?: Record<string, unknown[]>} | null;
    assert.deepEqual(Object.values(after?.hooks ?? {}).flat(), []);

    await cursorAdapter.install(ctx);
    const cursor = JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8')) as
      {hooks: Record<string, Array<{command: string}>>};
    const cursorCommands = Object.values(cursor.hooks).flat().map(entry => entry.command);
    assert.ok(cursorCommands.length > 0);
    assert.ok(cursorCommands.every(command => command.startsWith(`"${slash(node)}" "${slash(cli)}" hook cursor `)));
    assert.equal(cursorAdapter.hookStatus(ctx), 'installed');
    await cursorAdapter.uninstall(ctx);
    assert.equal(cursorAdapter.hookStatus(ctx), 'missing');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('builds character packs with the Windows Python launcher, not the Store shortcut', () => {
  const env = {Path: 'C:\\Windows;C:\\Python312'};
  assert.deepEqual(defaultPython('win32', env, path => path === 'C:\\Windows\\py.EXE'), ['C:\\Windows\\py.EXE', ['-3']]);
  assert.deepEqual(defaultPython('win32', env, path => path === 'C:\\Python312\\python.EXE'),
                   ['C:\\Python312\\python.EXE', []]);
  assert.deepEqual(defaultPython('darwin', env), ['python3', []]);
});

test('finds the Hermes home where Hermes looks on each platform', () => {
  assert.equal(hermesHome('/home/dan', {}, 'linux'), join('/home/dan', '.hermes'));
  assert.equal(hermesHome('/home/dan', {HERMES_DATA_DIR_SUFFIX: '-dev'}, 'darwin'), join('/home/dan', '.hermes-dev'));
  assert.equal(hermesHome('/u', {LOCALAPPDATA: '/local'}, 'win32'), join('/local', 'hermes'));
  assert.equal(hermesHome('/u', {}, 'win32'), join('/u', 'AppData', 'Local', 'hermes'));
  assert.equal(hermesHome('/u', {LOCALAPPDATA: '/local', HERMES_HOME: '/h'}, 'win32'), '/h');
});

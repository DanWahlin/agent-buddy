import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {copilotHookCommand, createCopilotHooks, parseCopilotHookEntry} from '../src/agents/copilot.js';

const windowsEnv = {SystemRoot: 'C:\\Windows'};

test('Copilot hooks run through the system shell', () => {
  assert.deepEqual(copilotHookCommand('C:\\A B\\node.exe', 'C:\\A B\\cli.js', 'preToolUse', 'win32', windowsEnv), {
    exec: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/c', 'if', 'exist', 'C:\\A B\\cli.js', 'C:\\A B\\node.exe', 'C:\\A B\\cli.js', 'hook', 'copilot',
           'preToolUse'],
  });
  assert.deepEqual(copilotHookCommand('/a b/node', '/a b/cli.js', 'preToolUse', 'darwin', {}), {
    exec: '/bin/sh',
    args: ['-c', '[ -f "$1" ] || exit 0; exec "$0" "$@"', '/a b/node', '/a b/cli.js', 'hook', 'copilot', 'preToolUse'],
  });
  // cmd.exe would read these characters, so Node.js runs directly.
  for (const path of ['C:\\R&D\\cli.js', 'C:\\100%\\cli.js', 'C:\\a,b\\cli.js', 'C:\\x (y)\\cli.js'])
    assert.deepEqual(copilotHookCommand('C:\\n\\node.exe', path, 'agentStop', 'win32', windowsEnv),
                     {exec: 'C:\\n\\node.exe', args: [path, 'hook', 'copilot', 'agentStop']});
});

test('Copilot hooks of this version and of earlier ones are read', () => {
  const hooks = createCopilotHooks('C:\\A B\\node.exe', 'C:\\A B\\cli.js', 'win32', windowsEnv) as {
    hooks: Record<string, Array<{exec: string; args: string[]}>>};
  for (const [event, [entry]] of Object.entries(hooks.hooks)) {
    assert.deepEqual(parseCopilotHookEntry(entry!.exec, entry!.args), {node: 'C:\\A B\\node.exe', cli: 'C:\\A B\\cli.js'});
    assert.equal(entry!.args.at(-1), event);
  }
  const shell = copilotHookCommand('/n/node', '/c/cli.js', 'sessionStart', 'linux', {});
  assert.deepEqual(parseCopilotHookEntry(shell.exec, shell.args), {node: '/n/node', cli: '/c/cli.js'});
  assert.deepEqual(parseCopilotHookEntry('/n/node', ['/c/cli.js', 'hook', 'copilot', 'sessionStart']),
                   {node: '/n/node', cli: '/c/cli.js'});
  assert.equal(parseCopilotHookEntry('/n/node', ['/c/cli.js', 'hook', 'claude', 'Stop']), undefined);
  assert.equal(parseCopilotHookEntry('/bin/sh', ['hook', 'copilot', 'Stop']), undefined);
});

// Copilot runs the hook's exec with its args and no shell, and passes the event on stdin.
function runHook(command: {exec: string; args: string[]}, input: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.exec, command.args, {stdio: ['pipe', 'ignore', 'inherit']});
    child.once('error', reject);
    child.once('exit', resolve);
    child.stdin.end(input);
  });
}

test('a Copilot hook runs the CLI while it is there, and exits with 0 once it is gone', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'agent companion hook '));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const runtime = join(folder, 'runtime dir');
  await mkdir(runtime);
  const cli = join(runtime, 'cli.js');
  const output = join(folder, 'ran.json');
  await writeFile(cli, `let input = '';
process.stdin.on('data', chunk => input += chunk).on('end', () =>
  require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args: process.argv.slice(2), input})));
`);
  const command = copilotHookCommand(process.execPath, cli, 'preToolUse', process.platform, process.env);
  assert.equal(await runHook(command, '{"toolName":"bash"}'), 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')),
                   {args: ['hook', 'copilot', 'preToolUse'], input: '{"toolName":"bash"}'});

  // After an uninstall, Copilot denies the tool call unless the hook exits with 0.
  await rm(runtime, {recursive: true});
  assert.equal(await runHook(command, '{"toolName":"bash"}'), 0);
  assert.equal(await runHook({exec: join(runtime, 'node.exe'), args: [cli, 'hook', 'copilot', 'preToolUse']}, '{}')
    .catch(() => 'cannot start'), 'cannot start');
});

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
    args: ['/d', '/c', 'if', 'exist', 'C:\\A B\\node.exe', '(if', 'exist', 'C:\\A B\\cli.js', '(', 'C:\\A B\\node.exe',
           'C:\\A B\\cli.js', 'hook', 'copilot', 'preToolUse', ')', 'else', 'more', '>nul)', 'else', 'more', '>nul'],
  });
  assert.deepEqual(copilotHookCommand('/a b/node', '/a b/cli.js', 'preToolUse', 'darwin', {}), {
    exec: '/bin/sh',
    args: ['-c', '[ -x "$0" ] && [ -f "$1" ] && exec "$0" "$@"; while read -r _; do :; done', '/a b/node',
           '/a b/cli.js', 'hook', 'copilot', 'preToolUse'],
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
    assert.equal(entry!.args[entry!.args.indexOf('copilot') + 1], event);
  }
  const shell = copilotHookCommand('/n/node', '/c/cli.js', 'sessionStart', 'linux', {});
  assert.deepEqual(parseCopilotHookEntry(shell.exec, shell.args), {node: '/n/node', cli: '/c/cli.js'});
  assert.deepEqual(parseCopilotHookEntry('/n/node', ['/c/cli.js', 'hook', 'copilot', 'sessionStart']),
                   {node: '/n/node', cli: '/c/cli.js'});
  assert.equal(parseCopilotHookEntry('/n/node', ['/c/cli.js', 'hook', 'claude', 'Stop']), undefined);
  assert.equal(parseCopilotHookEntry('/bin/sh', ['hook', 'copilot', 'Stop']), undefined);
});

// Copilot runs the hook's exec with its args and no shell, and writes the event to its stdin.
// A hook that exits before reading the event makes that write fail.
function runHook(command: {exec: string; args: string[]}, input: string):
    Promise<{code: number | null; writeFailed: boolean}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.exec, command.args, {stdio: ['pipe', 'ignore', 'inherit']});
    let writeFailed = false;
    child.stdin.once('error', () => writeFailed = true);
    child.once('error', reject);
    child.once('close', code => resolve({code, writeFailed}));
    child.stdin.end(input);
  });
}

test('a Copilot hook runs the CLI while it is there, and exits with 0 once it is gone', async t => {
  // A user folder can have spaces and letters outside ASCII.
  const folder = await mkdtemp(join(tmpdir(), 'agent companion José 日本 '));
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
  assert.deepEqual(await runHook(command, '{"toolName":"bash"}'), {code: 0, writeFailed: false});
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')),
                   {args: ['hook', 'copilot', 'preToolUse'], input: '{"toolName":"bash"}'});

  // After an uninstall, Copilot denies the tool call unless the hook exits with 0, and it may count
  // a failed write as an error too. An event larger than a pipe holds fails to write every time
  // when the hook does not read it.
  await rm(runtime, {recursive: true});
  const large = JSON.stringify({toolName: 'bash', toolArgs: 'x'.repeat(1024 * 1024)});
  assert.deepEqual(await runHook(command, '{"toolName":"bash"}'), {code: 0, writeFailed: false});
  assert.deepEqual(await runHook(command, large), {code: 0, writeFailed: false});
  // Node.js gone while a CLI is still there, as when the service ran from a clone and Node.js was removed.
  const kept = join(folder, 'cli.js');
  await writeFile(kept, 'process.stdin.resume().on("end", () => process.exit(3));\n');
  const noNode = copilotHookCommand(join(runtime, 'node.exe'), kept, 'preToolUse', process.platform, process.env);
  assert.deepEqual(await runHook(noNode, large), {code: 0, writeFailed: false});
  // The hook's own exit code still comes back.
  assert.deepEqual(await runHook(copilotHookCommand(process.execPath, kept, 'preToolUse', process.platform, process.env),
                                 '{}'), {code: 3, writeFailed: false});
});

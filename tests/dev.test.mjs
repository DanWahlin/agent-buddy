import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import test from 'node:test';
import {developmentEnvironment, main, prepareDevelopmentState, run} from '../tools/dev.mjs';

test('development paths are worktree-specific, short, and discard inherited file overrides', () => {
  const first = developmentEnvironment(resolve('first'), {
    HOME: '/unchanged', AGENT_COMPANION_STATE: '/installed/state.json',
    AGENT_COMPANION_SOCKET: '/installed/daemon.sock',
    AGENT_COMPANION_DATA_DIR: '/installed', AGENT_COMPANION_SETTINGS_PORT: '54321',
  });
  const second = developmentEnvironment(resolve('second'), {});
  assert.notEqual(first.AGENT_COMPANION_SOCKET, second.AGENT_COMPANION_SOCKET);
  assert.notEqual(first.AGENT_COMPANION_DATA_DIR, second.AGENT_COMPANION_DATA_DIR);
  assert.equal(first.AGENT_COMPANION_STATE, undefined);
  assert.equal(first.HOME, '/unchanged');
  assert.equal(first.AGENT_COMPANION_SETTINGS_PORT, '54321');
  assert.equal(first.AGENT_COMPANION_DEV, '1');
  assert.ok(first.AGENT_COMPANION_SOCKET.length < 104);
  assert.match(developmentEnvironment(resolve('first'), {}, 'win32').AGENT_COMPANION_SOCKET,
    /^\\\\\.\\pipe\\agent-buddy-dev-[0-9a-f]{20}$/);
  assert.equal(developmentEnvironment(`${resolve('first')}/`, {}).AGENT_COMPANION_SOCKET,
    first.AGENT_COMPANION_SOCKET);
});

test('startup disables physical devices and real usage scanning, preserving unrelated dev preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-dev-'));
  try {
    const env = developmentEnvironment(root, {});
    const token = await prepareDevelopmentState(env);
    assert.match(token, /^[0-9a-f]{48}$/);
    const path = join(env.AGENT_COMPANION_DATA_DIR, 'display.json');
    await writeFile(path, JSON.stringify({useDevice: true, showUsage: true, desktopVolume: 12}));
    assert.equal(await prepareDevelopmentState(env), token);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')),
      {useDevice: false, showUsage: false, desktopVolume: 12});
    await writeFile(path, 'invalid');
    await assert.rejects(prepareDevelopmentState(env), SyntaxError);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('commands report failures instead of succeeding silently', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)']), /exited with 7/);
  await assert.rejects(run('agent-buddy-nonexistent-program', []), /ENOENT/);
  await assert.rejects(main(['send', 'invalid']), /Choose idle/);
  await assert.rejects(main(['firmware-build', 'not-a-board']), /Unknown board/);
  await assert.rejects(main(['package', 'not-a-board']), /Unknown board/);
  if (process.platform !== 'win32')
    await assert.rejects(main(['firmware-flash', 'waveshare-amoled-175']), /explicit.*port/);
  await assert.rejects(main(['invalid']), /Usage:/);
});

test('native build actions isolate tools, restore missing desktop dependencies, and require flash consent',
  {skip: process.platform === 'win32'}, async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'buddy-dev-tools-')));
    try {
      for (const directory of ['tools', 'firmware', 'bin'])
        await mkdir(join(root, directory));
      await copyFile(new URL('../tools/dev.mjs', import.meta.url), join(root, 'tools/dev.mjs'));
      await copyFile(new URL('../firmware/boards.json', import.meta.url), join(root, 'firmware/boards.json'));
      await writeFile(join(root, 'VERSION'), '1.2.3\n');
      const log = join(root, 'commands.jsonl');
      for (const name of ['arduino-cli', 'bash', 'python3', 'lsof', 'cargo', 'npm']) {
        await writeFile(join(root, 'bin', name), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({
  command: ${JSON.stringify(name)}, args: process.argv.slice(2),
  board: process.env.BOARD, config: process.env.ARDUINO_CONFIG,
  vendor: process.env.WAVESHARE_DIR, cwd: process.cwd(), data: process.env.AGENT_COMPANION_DATA_DIR
}) + '\\n');
if (${JSON.stringify(name)} === 'arduino-cli' && process.argv[2] === 'version')
  console.log(JSON.stringify({VersionString: '1.5.1'}));
if (${JSON.stringify(name)} === 'lsof') process.exit(process.env.TEST_PORT_BUSY === '1' ? 0 : 1);
`, {mode: 0o755});
      }
      const env = {
        ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
        ARDUINO_CLI: join(root, 'bin', 'arduino-cli'), PYTHON: join(root, 'bin', 'python3'),
        TEST_COMMAND_LOG: log,
      };
      const execute = (args, overrides = {}) =>
        run(process.execPath, [join(root, 'tools/dev.mjs'), ...args], {cwd: root, env: {...env, ...overrides}});
      const commands = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const board = 'waveshare-lcd-154';
      await execute(['firmware-setup', board]);
      const setup = await commands();
      assert.ok(setup.some(call => call.args.includes('esp32:esp32@3.3.10')));
      for (const directory of ['data', 'downloads', 'user']) {
        assert.ok(setup.some(call => call.args.includes(`directories.${directory}`)
          && call.args.at(-1) === join(root, '.deps', 'arduino', directory)));
      }
      assert.deepEqual(setup.at(-1).args,
        ['tools/boards.py', 'fetch-vendor', join(root, '.deps/waveshare'), '--board', board]);
      await execute(['firmware-build', board]);
      const build = (await commands()).at(-1);
      assert.equal(build.command, 'bash');
      assert.deepEqual(build.args, ['tools/arduino.sh', 'build']);
      assert.equal(build.board, board);
      assert.equal(build.config, join(root, '.deps/arduino/arduino-cli.yaml'));
      await execute(['package', board]);
      const packaged = (await commands()).at(-1);
      assert.deepEqual(packaged.args, ['tools/package_release.py', '--version', '1.2.3']);
      assert.equal(packaged.board, board);
      const beforeFlash = (await commands()).length;
      await assert.rejects(execute(['firmware-flash', board, '/dev/fake']), /exited with 1/);
      assert.equal((await commands()).length, beforeFlash);
      await assert.rejects(execute(['firmware-flash', board, '/dev/fake', 'FLASH'],
        {TEST_PORT_BUSY: '1'}), /exited with 1/);
      assert.equal((await commands()).at(-1).command, 'lsof');
      await execute(['firmware-flash', board, '/dev/fake', 'FLASH']);
      const flash = (await commands()).at(-1);
      assert.equal(flash.command, 'bash');
      assert.deepEqual(flash.args, ['tools/arduino.sh', 'upload', '/dev/fake']);
      assert.equal(flash.board, board);
      await mkdir(join(root, 'desktop/node_modules/typescript'), {recursive: true});
      await mkdir(join(root, 'desktop/apps/desktop/src-tauri'), {recursive: true});
      const beforeDesktop = (await commands()).length;
      await execute(['desktop']);
      const desktop = (await commands()).slice(beforeDesktop);
      assert.deepEqual(desktop.map(call => [call.command, ...call.args]), [
        ['cargo', '--version'],
        ['npm', 'ci', '--prefix', 'desktop', '--no-audit', '--no-fund'],
        ['npm', '--prefix', 'desktop', 'run', 'typecheck'],
        ['npm', '--prefix', 'desktop', 'run', 'build'],
        ['cargo', 'run'],
      ]);
      assert.equal(desktop.at(-1).cwd, join(root, 'desktop/apps/desktop/src-tauri'));
      assert.equal(desktop.at(-1).data, join(root, 'build/dev/companion'));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

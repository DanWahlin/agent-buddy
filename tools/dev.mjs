#!/usr/bin/env node
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function developmentEnvironment(repository, environment = process.env, platform = process.platform) {
  repository = resolve(repository);
  const data = join(repository, 'build', 'dev', 'companion');
  const id = createHash('sha256').update(repository).digest('hex').slice(0, 20);
  const env = {...environment};
  for (const name of [
    'STATE', 'WIFI_CONFIG', 'CONNECTION_CONFIG', 'USER_CHARACTERS', 'SETTINGS_INFO',
    'AGENTS_CONFIG', 'ONBOARDING', 'CHARACTER_CONFIG', 'DISPLAY_CONFIG', 'DESKTOP_APP',
    'DEVICE_HISTORY', 'SERVICE_STOPPED', 'USAGE_CACHE',
  ]) delete env[`AGENT_COMPANION_${name}`];
  return {
    ...env,
    AGENT_COMPANION_DEV: '1',
    AGENT_COMPANION_DATA_DIR: data,
    AGENT_COMPANION_SOCKET: platform === 'win32'
      ? `\\\\.\\pipe\\agent-buddy-dev-${id}` : join(tmpdir(), `agent-buddy-dev-${id}.sock`),
    ARDUINO_CONFIG: join(repository, '.deps', 'arduino', 'arduino-cli.yaml'),
    WAVESHARE_DIR: join(repository, '.deps', 'waveshare'),
  };
}

export async function prepareDevelopmentState(env) {
  const data = env.AGENT_COMPANION_DATA_DIR;
  await mkdir(data, {recursive: true, mode: 0o700});
  const path = join(data, 'display.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(path, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error(`Invalid development display settings: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify({...settings, useDevice: false, showUsage: false}, null, 2)}\n`,
    {mode: 0o600});
  const info = join(data, 'settings.json');
  try {
    const saved = JSON.parse(await readFile(info, 'utf8'));
    const token = typeof saved.url === 'string' ? /#token=([0-9a-f]{48})$/.exec(saved.url)?.[1] : null;
    if (!token) throw new Error(`Invalid development Settings token: ${info}`);
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(24).toString('hex');
  await writeFile(info, `${JSON.stringify({url: `http://127.0.0.1:0/#token=${token}`, port: 0})}\n`,
    {mode: 0o600, flag: 'wx'});
  return token;
}

export function run(command, args, {env = process.env, cwd = root} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio: 'inherit',
      shell: process.platform === 'win32' && command === 'npm.cmd',
    });
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
}

export async function main([action, ...args] = process.argv.slice(2)) {
  const env = developmentEnvironment(root);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const execute = (command, values) => run(command, values, {env});
  const boards = JSON.parse(await readFile(join(root, 'firmware', 'boards.json'), 'utf8'));
  const board = args[0] ?? boards.default;
  if (['firmware-build', 'firmware-setup', 'firmware-flash', 'package'].includes(action)
      && !Object.hasOwn(boards.boards, board))
    throw new Error(`Unknown board: ${board}`);
  switch (action) {
    case 'daemon': {
      await prepareDevelopmentState(env);
      console.log(`[dev] isolated state: ${env.AGENT_COMPANION_DATA_DIR}; physical device disabled`);
      Object.assign(process.env, env);
      for (const name of Object.keys(process.env))
        if (name.startsWith('AGENT_COMPANION_') && !(name in env)) delete process.env[name];
      const telemetry = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? (await import('../daemon/dist/src/development-telemetry.js')).startDevelopmentTelemetry() : undefined;
      await (await import('../daemon/dist/src/daemon.js')).runDaemon({onShutdown: telemetry?.shutdown});
      break;
    }
    case 'desktop':
      try {
        await execute('cargo', ['--version']);
      } catch (error) {
        if (error.code === 'ENOENT')
          throw new Error('Desktop requires Rust/Cargo on PATH. See desktop/README.md and the Tauri prerequisites.',
            {cause: error});
        throw error;
      }
      if (!existsSync(join(root, 'desktop', 'node_modules', 'typescript'))
          || !existsSync(join(root, 'desktop', 'node_modules', 'esbuild'))) {
        await execute(npm, ['ci', '--prefix', 'desktop', '--no-audit', '--no-fund']);
      }
      await execute(npm, ['--prefix', 'desktop', 'run', 'typecheck']);
      await execute(npm, ['--prefix', 'desktop', 'run', 'build']);
      await run('cargo', ['run'], {env, cwd: join(root, 'desktop', 'apps', 'desktop', 'src-tauri')});
      break;
    case 'settings': {
      const {url} = JSON.parse(await readFile(join(env.AGENT_COMPANION_DATA_DIR, 'settings.json'), 'utf8'));
      console.log(url);
      break;
    }
    case 'send':
      if (!['idle', 'surprise', 'working', 'attention', 'complete'].includes(args[0]))
        throw new Error('Choose idle, surprise, working, attention, or complete.');
      await execute(process.execPath, ['daemon/dist/src/cli.js', 'send', args[0]]);
      break;
    case 'firmware-setup': {
      if (process.platform === 'win32') throw new Error('Firmware source builds need macOS or Linux/WSL.');
      const cli = process.env.ARDUINO_CLI ?? 'arduino-cli';
      await execute(cli, ['version']);
      const {execFileSync} = await import('node:child_process');
      const version = execFileSync(cli, ['version', '--format', 'json'], {encoding: 'utf8'});
      if (JSON.parse(version).VersionString !== '1.5.1')
        throw new Error('Firmware builds require Arduino CLI 1.5.1 (see docs/build-from-source.md).');
      await mkdir(dirname(env.ARDUINO_CONFIG), {recursive: true});
      if (!existsSync(env.ARDUINO_CONFIG))
        await execute(cli, ['config', 'init', '--dest-dir', dirname(env.ARDUINO_CONFIG)]);
      for (const directory of ['data', 'downloads', 'user'])
        await execute(cli, ['--config-file', env.ARDUINO_CONFIG, 'config', 'set', `directories.${directory}`,
          join(dirname(env.ARDUINO_CONFIG), directory)]);
      await execute(cli, ['--config-file', env.ARDUINO_CONFIG, 'config', 'add', 'board_manager.additional_urls',
        'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json']);
      await execute(cli, ['--config-file', env.ARDUINO_CONFIG, 'core', 'update-index']);
      await execute(cli, ['--config-file', env.ARDUINO_CONFIG, 'core', 'install', 'esp32:esp32@3.3.10']);
      await execute(python, ['tools/boards.py', 'fetch-vendor', env.WAVESHARE_DIR, '--board', board]);
      break;
    }
    case 'firmware-build':
    case 'firmware-flash': {
      if (process.platform === 'win32') throw new Error('Firmware source builds need macOS or Linux/WSL.');
      if (action === 'firmware-flash' && (!args[0] || !args[1]?.startsWith('/dev/') || args[2] !== 'FLASH'))
        throw new Error('Flashing requires a board, an explicit /dev/ port, and confirmation FLASH.');
      const cli = process.env.ARDUINO_CLI ?? 'arduino-cli';
      // arduino.sh requires an executable path, not a command resolved through PATH.
      const {execFileSync} = await import('node:child_process');
      env.ARDUINO_CLI = resolve(execFileSync('which', [cli], {encoding: 'utf8'}).trim());
      env.BOARD = board;
      if (action === 'firmware-flash') {
        const [, port] = args;
        try {
          execFileSync('lsof', ['-t', '--', port], {stdio: 'pipe'});
        } catch (error) {
          if (error.status !== 1) throw error;
          await execute('bash', ['tools/arduino.sh', 'upload', port]);
          break;
        }
        throw new Error(`Port ${port} is in use. Stop the owning application/service before flashing.`);
      }
      await execute('bash', ['tools/arduino.sh', 'build']);
      break;
    }
    case 'package':
      env.BOARD = board;
      await execute(python, ['tools/package_release.py', '--version',
        (await readFile(join(root, 'VERSION'), 'utf8')).trim()]);
      break;
    default:
      throw new Error('Usage: node tools/dev.mjs daemon|desktop|settings|send STATE|firmware-setup [BOARD]'
        + '|firmware-build [BOARD]|firmware-flash BOARD PORT FLASH|package');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[dev] ${error.message}`);
    process.exitCode = 1;
  });
}

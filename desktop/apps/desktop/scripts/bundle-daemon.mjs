// Puts the companion daemon, a Node.js runtime and the character packs in
// src-tauri/daemon-runtime, for `tauri build --config src-tauri/tauri.daemon.conf.json`.
// The app copies this folder out of itself and installs the service from it,
// so a user needs no clone of the repository and no Node.js.
//
//   node scripts/bundle-daemon.mjs [--target universal-apple-darwin]
//
// The target is a Rust target triple, as `tauri build --target` takes; without
// one it is this computer's.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync}
  from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Keep this the same as the Node.js in .github/workflows/build.yml.
const NODE_VERSION = '24.21.0';

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(app, '..', '..', '..');
const daemon = join(root, 'daemon');
const output = join(app, 'src-tauri', 'daemon-runtime');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targetIndex = process.argv.indexOf('--target');
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : hostTarget();
const {platform, arches} = parseTarget(target);

function hostTarget() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
  throw new Error('The daemon runs on macOS and Linux only. Windows users run it in WSL 2.');
}

function parseTarget(value) {
  if (value === 'universal-apple-darwin') return {platform: 'darwin', arches: ['arm64', 'x64']};
  const match = /^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu)$/.exec(value ?? '');
  if (!match) throw new Error(`The daemon cannot be bundled for ${value}. Use a macOS or Linux target.`);
  return {
    platform: match[2] === 'apple-darwin' ? 'darwin' : 'linux',
    arches: [match[1] === 'aarch64' ? 'arm64' : 'x64'],
  };
}

function run(command, args, cwd) {
  execFileSync(command, args, {cwd, stdio: ['ignore', 'inherit', 'inherit']});
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The official binary, checked against the release's SHASUMS256.txt.
async function nodeBinary(arch, sums, work) {
  const name = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const file = `${name}.tar.gz`;
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, entry]) => entry === file)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt has no ${file}.`);
  const archive = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`);
  if (createHash('sha256').update(archive).digest('hex') !== expected)
    throw new Error(`${file} does not match its SHA-256.`);
  const archivePath = join(work, file);
  writeFileSync(archivePath, archive);
  run('tar', ['-xzf', archivePath, '-C', work, `${name}/bin/node`], work);
  return join(work, name, 'bin', 'node');
}

async function main() {
  const packs = join(root, 'build', 'characters');
  const packFiles = existsSync(packs) ? readdirSync(packs).filter(name => name.endsWith('.acpk')) : [];
  if (packFiles.length === 0)
    throw new Error('No character packs. Run "python3 tools/character_pack.py build" first.');

  console.log('Building the daemon');
  if (!existsSync(join(daemon, 'node_modules'))) run(npm, ['ci', '--no-audit', '--no-fund'], daemon);
  run(npm, ['run', 'build', '--silent'], daemon);

  rmSync(output, {recursive: true, force: true});
  const runtimeDaemon = join(output, 'daemon');
  mkdirSync(runtimeDaemon, {recursive: true});
  cpSync(join(daemon, 'dist', 'src'), join(runtimeDaemon, 'dist', 'src'), {recursive: true});
  cpSync(join(daemon, 'web'), join(runtimeDaemon, 'web'), {recursive: true});
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(daemon, file), join(runtimeDaemon, file));

  console.log('Installing the daemon\'s production dependencies');
  // No install scripts: serialport loads its prebuilt binding when it runs.
  run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], runtimeDaemon);
  rmSync(join(runtimeDaemon, 'node_modules', '.bin'), {recursive: true, force: true});
  const prebuilds = join(runtimeDaemon, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds');
  const keep = platform === 'darwin' ? ['darwin-x64+arm64'] : arches.map(arch => `linux-${arch}`);
  for (const name of readdirSync(prebuilds)) {
    if (!keep.includes(name)) rmSync(join(prebuilds, name), {recursive: true, force: true});
  }
  if (platform === 'linux') {
    // The app runs on glibc only, and linuxdeploy cannot resolve the musl binding's libc.
    for (const arch of arches) {
      const dir = join(prebuilds, `linux-${arch}`);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) if (name.includes('.musl.')) rmSync(join(dir, name), {force: true});
    }
  }
  if (readdirSync(prebuilds).length === 0) throw new Error(`serialport has no prebuilt binding for ${target}.`);

  mkdirSync(join(output, 'build', 'characters'), {recursive: true});
  for (const file of packFiles) cpSync(join(packs, file), join(output, 'build', 'characters', file));
  cpSync(join(root, 'VERSION'), join(output, 'VERSION'));

  console.log(`Downloading Node.js ${NODE_VERSION} for ${target}`);
  const work = mkdtempSync(join(tmpdir(), 'companion-node-'));
  try {
    const sums = (await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).toString('utf8');
    const binaries = [];
    for (const arch of arches) binaries.push(await nodeBinary(arch, sums, work));
    const node = join(output, 'node');
    // lipo keeps each architecture's own signature.
    if (binaries.length > 1) run('lipo', ['-create', ...binaries, '-output', node], work);
    else cpSync(binaries[0], node);
    chmodSync(node, 0o755);
  } finally {
    rmSync(work, {recursive: true, force: true});
  }

  const version = readFileSync(join(output, 'VERSION'), 'utf8').trim();
  console.log(`The daemon ${version} is ready in ${output}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

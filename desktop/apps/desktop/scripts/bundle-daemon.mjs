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
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  throw new Error(`The daemon cannot be bundled on ${process.platform}.`);
}

function parseTarget(value) {
  if (value === 'universal-apple-darwin') return {platform: 'darwin', arches: ['arm64', 'x64']};
  const match = /^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/.exec(value ?? '');
  if (!match) throw new Error(`The daemon cannot be bundled for ${value}. Use a macOS, Linux or Windows target.`);
  const platforms = {'apple-darwin': 'darwin', 'unknown-linux-gnu': 'linux', 'pc-windows-msvc': 'win32'};
  return {platform: platforms[match[2]], arches: [match[1] === 'aarch64' ? 'arm64' : 'x64']};
}

function run(command, args, cwd) {
  // Node.js does not start a .cmd file (npm.cmd) without a shell.
  const shell = process.platform === 'win32' && command.endsWith('.cmd');
  execFileSync(command, args, {cwd, shell, stdio: ['ignore', 'inherit', 'inherit']});
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// A file of the Node.js release, checked against the release's SHASUMS256.txt.
async function verifiedDownload(file, sums) {
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, entry]) => entry === file)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt has no ${file}.`);
  const data = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`);
  if (createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`${file} does not match its SHA-256.`);
  return data;
}

// The official binary.
async function nodeBinary(arch, sums, work) {
  if (platform === 'win32') {
    // Node.js publishes node.exe by itself, so no archive is necessary.
    const path = join(work, `node-${arch}.exe`);
    writeFileSync(path, await verifiedDownload(`win-${arch}/node.exe`, sums));
    return path;
  }
  const name = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const archivePath = join(work, `${name}.tar.gz`);
  writeFileSync(archivePath, await verifiedDownload(`${name}.tar.gz`, sums));
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
  const keep = platform === 'darwin' ? ['darwin-x64+arm64'] : arches.map(arch => `${platform}-${arch}`);
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
    const node = join(output, platform === 'win32' ? 'node.exe' : 'node');
    // lipo keeps each architecture's own signature.
    if (binaries.length > 1) run('lipo', ['-create', ...binaries, '-output', node], work);
    else cpSync(binaries[0], node);
    if (platform !== 'win32') chmodSync(node, 0o755);
  } finally {
    rmSync(work, {recursive: true, force: true});
  }

  const version = readFileSync(join(output, 'VERSION'), 'utf8').trim();
  // The app replaces its copy of the service when this changes, also between builds of one version.
  writeFileSync(join(output, 'BUILD_HASH'), `${folderHash(output)}\n`);
  console.log(`The daemon ${version} is ready in ${output}`);
}

function folderHash(folder) {
  const hash = createHash('sha256');
  const visit = relative => {
    for (const entry of readdirSync(join(folder, relative), {withFileTypes: true})
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path !== 'BUILD_HASH') hash.update(`${path}\0`).update(readFileSync(join(folder, path)));
    }
  };
  visit('');
  return hash.digest('hex');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

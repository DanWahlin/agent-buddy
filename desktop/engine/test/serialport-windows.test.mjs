import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {PATCHED_VERSION, buildPatchedWindowsBinding, patchWindowsSource, windowsMachine}
  from '../../apps/desktop/scripts/serialport-windows.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const installed = join(repository, 'daemon', 'node_modules', '@serialport', 'bindings-cpp');

function completionRoutine(source, name) {
  const start = source.indexOf(`void __stdcall ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('the daemon locks the serialport binding the Windows fix was written for', async () => {
  const lock = JSON.parse(await readFile(join(repository, 'daemon', 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@serialport/bindings-cpp'].version, PATCHED_VERSION);
});

test('the fixed completion routines use the result Windows passes them',
     {skip: !existsSync(installed) && 'daemon dependencies are not installed'}, async () => {
  const source = await readFile(join(installed, 'src', 'serialport_win.cpp'), 'utf8');
  const patched = patchWindowsSource(source.replace(/\n/g, '\r\n'));
  for (const name of ['WriteIOCompletion', 'ReadIOCompletion']) {
    assert.match(completionRoutine(source, name), /GetOverlappedResult/);
    const routine = completionRoutine(patched, name);
    // ReadIOCompletion's own ReadFile further down uses a real event, so only its start is checked.
    const end = routine.indexOf('// ReadFileEx and');
    assert.doesNotMatch(end < 0 ? routine : routine.slice(0, end), /GetOverlappedResult|CloseHandle/);
    assert.match(routine, /\+= bytesTransferred;/);
  }
  assert.match(completionRoutine(patched, 'WriteIOCompletion'), /if \(errorCode\)/);
  assert.throws(() => patchWindowsSource(patched), /not the source this fix was written for/);
});

test('other serialport_win.cpp sources are refused', () => {
  assert.throws(() => patchWindowsSource('int main() {}\n'), /not the source this fix was written for/);
});

test('another binding version is refused before anything is built', async t => {
  const bindings = await mkdtemp(join(tmpdir(), 'agent-buddy-serialport-'));
  t.after(() => rm(bindings, {recursive: true, force: true}));
  await mkdir(join(bindings, 'src'));
  await writeFile(join(bindings, 'package.json'), JSON.stringify({version: '13.0.1'}));
  await writeFile(join(bindings, 'src', 'serialport_win.cpp'), 'unchanged');
  await assert.rejects(buildPatchedWindowsBinding({bindings, arch: 'x64', nodeVersion: '24.21.0', nodeGyp: 'none'}),
                       process.platform === 'win32' ? /fixes @serialport\/bindings-cpp 13\.0\.0, not 13\.0\.1/
                         : /can only be built on Windows/);
  assert.equal(await readFile(join(bindings, 'src', 'serialport_win.cpp'), 'utf8'), 'unchanged');
});

test('a Windows binary\'s machine is read from its PE header', () => {
  const binary = Buffer.alloc(0x90);
  binary.write('MZ', 0, 'latin1');
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80, 'latin1');
  binary.writeUInt16LE(0xaa64, 0x84);
  assert.equal(windowsMachine(binary), 0xaa64);
  assert.equal(windowsMachine(Buffer.concat([Buffer.from('\x7fELF', 'latin1'), Buffer.alloc(0x90)])), null);
  binary.writeUInt32LE(0x8e, 0x3c);
  assert.equal(windowsMachine(binary), null);
});

// Compiles the binding, so it needs Visual Studio's C++ tools; CI runs it on each Windows runner.
test('the fixed binding builds for this computer and loads', {
  skip: (process.platform !== 'win32' || !process.env.AGENT_COMPANION_BUILD_SERIALPORT || !existsSync(installed))
    && 'set AGENT_COMPANION_BUILD_SERIALPORT=1 on Windows, with daemon dependencies installed, to build it',
}, async t => {
  // Inside daemon/node_modules, so the build resolves node-addon-api as the bundled runtime does,
  // and about 200 characters deep, as the bundle in a deep checkout is: MSBuild fails near 260.
  const root = await mkdtemp(join(repository, 'daemon', 'node_modules', '.serialport-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const padding = Math.max(0, 200 - root.length - '\\bindings-cpp'.length);
  const bindings = join(root, ...Array.from({length: Math.ceil(padding / 41)}, () => 'd'.repeat(40)), 'bindings-cpp');
  await cp(installed, bindings, {recursive: true});
  const prebuilds = join(bindings, 'prebuilds', `win32-${process.arch}`);
  const [name] = (await readdir(prebuilds)).filter(file => file.endsWith('.node'));
  const published = await readFile(join(prebuilds, name));
  const source = await readFile(join(bindings, 'src', 'serialport_win.cpp'), 'utf8');

  await buildPatchedWindowsBinding({
    bindings, arch: process.arch, nodeVersion: process.versions.node,
    nodeGyp: join(repository, 'daemon', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  });

  const built = await readFile(join(prebuilds, name));
  assert.notDeepEqual(built, published);
  assert.equal(windowsMachine(built), {x64: 0x8664, arm64: 0xaa64}[process.arch]);
  // Only the binary changes: node-gyp-build would load a build folder before the prebuilt one.
  assert.equal(existsSync(join(bindings, 'build')), false);
  assert.equal(await readFile(join(bindings, 'src', 'serialport_win.cpp'), 'utf8'), source);
  // A child process, so Windows lets go of the binding before the copy is removed.
  const loads = `require(${JSON.stringify(bindings)}).autoDetect().list().then(ports => console.log(Array.isArray(ports)))`;
  assert.equal(execFileSync(process.execPath, ['-e', loads], {encoding: 'utf8'}).trim(), 'true');
});

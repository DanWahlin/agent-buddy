import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {PATCHED_VERSION, buildPatchedWindowsBinding, patchWindowsSource}
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
  assert.throws(() => buildPatchedWindowsBinding({bindings, arch: 'x64', nodeVersion: '24.21.0', nodeGyp: 'none'}),
                /fixes @serialport\/bindings-cpp 13\.0\.0, not 13\.0\.1/);
  assert.equal(await readFile(join(bindings, 'src', 'serialport_win.cpp'), 'utf8'), 'unchanged');
});

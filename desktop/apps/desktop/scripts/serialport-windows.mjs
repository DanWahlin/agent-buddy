// Builds serialport's Windows binding with a fix for USB serial writes.
//
// @serialport/bindings-cpp 13.0.0 calls GetOverlappedResult inside its WriteFileEx and
// ReadFileEx completion routines, where the OVERLAPPED's hEvent holds a pointer, not an event.
// When the driver still reports the request as pending, as usbser.sys does on Windows on Arm,
// GetOverlappedResult waits on that pointer and fails with "Invalid handle", so every write to
// the device fails and the app never finds it (serialport/bindings-cpp#241). Microsoft says
// not to call GetOverlappedResult there: the completion routine receives the result itself.
import {execFileSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync}
  from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

export const PATCHED_VERSION = '13.0.0';

// The machine field of a Windows binary's PE header.
const MACHINES = {x64: 0x8664, arm64: 0xaa64};

const FIXES = [
  {
    before: `  WriteBaton* baton = static_cast<WriteBaton*>(ov->hEvent);
  DWORD bytesWritten;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesWritten, TRUE)) {
    errorCode = GetLastError();
    ErrorCodeToString("Writing to COM port (GetOverlappedResult)", errorCode, baton->errorString);
    baton->complete = true;
    return;
  }
  if (bytesWritten) {
    baton->offset += bytesWritten;
`,
    after: `  WriteBaton* baton = static_cast<WriteBaton*>(ov->hEvent);
  if (errorCode) {
    ErrorCodeToString("Writing to COM port (WriteFileEx)", errorCode, baton->errorString);
    baton->complete = true;
    return;
  }
  if (bytesTransferred) {
    baton->offset += bytesTransferred;
`,
  },
  {
    before: `  DWORD lastError;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesTransferred, TRUE)) {
    lastError = GetLastError();
    ErrorCodeToString("Reading from COM port (GetOverlappedResult)", lastError, baton->errorString);
    baton->complete = true;
    return;
  }
  if (bytesTransferred) {
`,
    after: `  DWORD lastError;
  if (bytesTransferred) {
`,
  },
  {
    // hEvent is the baton here, not a handle to close.
    before: `  if (!baton->bytesToRead) {
    baton->complete = true;
    CloseHandle(ov->hEvent);
    return;
  }
`,
    after: `  if (!baton->bytesToRead) {
    baton->complete = true;
    return;
  }
`,
  },
];

export function patchWindowsSource(source) {
  let patched = source.replace(/\r\n/g, '\n');
  for (const {before, after} of FIXES) {
    const at = patched.indexOf(before);
    if (at < 0 || patched.indexOf(before, at + 1) >= 0)
      throw new Error('serialport_win.cpp is not the source this fix was written for.');
    patched = patched.slice(0, at) + after + patched.slice(at + before.length);
  }
  return patched;
}

export function windowsMachine(binary) {
  if (binary.length < 0x40 || binary.toString('latin1', 0, 2) !== 'MZ') return null;
  const header = binary.readUInt32LE(0x3c);
  if (header + 6 > binary.length || binary.toString('latin1', header, header + 4) !== 'PE\0\0') return null;
  return binary.readUInt16LE(header + 4);
}

// Replaces the prebuilt binding for `arch` in an installed @serialport/bindings-cpp with one
// built from the fixed source. Needs Visual Studio's C++ tools for that architecture.
export function buildPatchedWindowsBinding({bindings, arch, nodeVersion, nodeGyp}) {
  // node-gyp builds for the computer it runs on, whatever --arch says about the CPU.
  if (process.platform !== 'win32') throw new Error('serialport\'s Windows binding can only be built on Windows.');
  if (!MACHINES[arch]) throw new Error(`serialport's Windows binding cannot be built for ${arch}.`);
  const {version} = JSON.parse(readFileSync(join(bindings, 'package.json'), 'utf8'));
  if (version !== PATCHED_VERSION) {
    throw new Error(`serialport-windows.mjs fixes @serialport/bindings-cpp ${PATCHED_VERSION}, not ${version}. `
      + 'Check whether serialport/bindings-cpp#241 is fixed in it, then update or remove the fix.');
  }
  if (!existsSync(nodeGyp)) throw new Error(`node-gyp is missing at ${nodeGyp}. Run npm ci in daemon.`);
  const prebuilds = join(bindings, 'prebuilds', `win32-${arch}`);
  const prebuilt = existsSync(prebuilds) ? readdirSync(prebuilds).filter(name => name.endsWith('.node')) : [];
  if (prebuilt.length !== 1) throw new Error(`serialport has no single prebuilt binding in ${prebuilds}.`);

  const source = join(bindings, 'src', 'serialport_win.cpp');
  const patched = patchWindowsSource(readFileSync(source, 'utf8'));
  // MSBuild's file tracker fails on paths near 260 characters, which a build inside the bundle of
  // a deep checkout reaches, so the binding builds in a short folder beside node-addon-api.
  const work = mkdtempSync(join(tmpdir(), 'acsp-'));
  try {
    const copy = join(work, 'bindings-cpp');
    for (const name of ['package.json', 'binding.gyp', 'src']) cpSync(join(bindings, name), join(copy, name), {recursive: true});
    writeFileSync(join(copy, 'src', 'serialport_win.cpp'), patched);
    const addonApi = dirname(createRequire(join(bindings, 'package.json')).resolve('node-addon-api/package.json'));
    cpSync(addonApi, join(work, 'node_modules', 'node-addon-api'), {recursive: true});
    execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release', `--arch=${arch}`, `--target=${nodeVersion}`],
                 {cwd: copy, stdio: ['ignore', 'inherit', 'inherit']});
    const built = join(copy, 'build', 'Release', 'bindings.node');
    if (windowsMachine(readFileSync(built)) !== MACHINES[arch])
      throw new Error(`node-gyp did not build serialport's Windows binding for ${arch}.`);
    copyFileSync(built, join(prebuilds, prebuilt[0]));
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  DesktopApp, defaultDesktopAppLocations, desktopFlasherPath, desktopLaunchCommand, parseDesktopAppReport,
  type SavedDesktopApp,
} from '../src/desktop-app.js';

// Windows has no POSIX permission bits, so mode checks run only on macOS and Linux.
const posix = process.platform !== 'win32';

type Exited = (code: number | null) => void;

async function withApp(run: (app: DesktopApp, clock: {now: number}, launched: SavedDesktopApp[], path: string,
                             exits: Exited[], directory: string) => Promise<void>,
                       locations: (directory: string) => string[] = () => []): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ac-desktop-'));
  const path = join(directory, 'desktop-app.json');
  const clock = {now: 1_000_000};
  const launched: SavedDesktopApp[] = [];
  const exits: Exited[] = [];
  const app = new DesktopApp({
    path, now: () => clock.now, locations: locations(directory),
    launch: async (saved, exited) => { launched.push(saved); exits.push(exited); },
  });
  try {
    await run(app, clock, launched, path, exits, directory);
  } finally {
    await app.saved();
    await rm(directory, {recursive: true, force: true});
  }
}

test('the app is running while it asks for status, and stopped soon after it stops', async () => {
  await withApp(async (app, clock) => {
    assert.deepEqual(app.status(), {state: 'stopped', canStart: false, error: null});
    assert.deepEqual(app.seen({}), {command: null, changed: true});
    assert.equal(app.status().state, 'running');
    clock.now += 400;
    assert.deepEqual(app.seen({}), {command: null, changed: false});
    clock.now += 3000;
    assert.equal(app.status().state, 'stopped');
  });
});

test('start needs a location the app reported, and remembers it', async () => {
  await withApp(async (app, clock, launched, path) => {
    await assert.rejects(app.start(), /cannot find the desktop app/);
    app.seen({executable: '/Applications/Agent Companion.app', environment: {DISPLAY: ':0', SECRET: 'x'}});
    await app.saved();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved, {executable: '/Applications/Agent Companion.app', environment: {DISPLAY: ':0'}});
    if (posix) assert.equal((await stat(path)).mode & 0o777, 0o600);

    await app.start();
    assert.equal(launched.length, 0, 'a running app is not started again');
    clock.now += 5000;
    await app.start();
    assert.deepEqual(launched, [saved]);
    assert.equal(app.status().state, 'starting');
    await app.start();
    assert.equal(launched.length, 1, 'a starting app is not started again');
    app.seen({executable: '/Applications/Agent Companion.app'});
    assert.equal(app.status().state, 'running');
    clock.now += 30_000;
    assert.deepEqual(app.status(), {state: 'stopped', canStart: true, error: null});

    const reloaded = new DesktopApp({path, now: () => clock.now, launch: async () => undefined, locations: []});
    assert.equal(reloaded.status().canStart, true);
  });
});

test('before the app has run, it starts from a usual install location', async () => {
  await withApp(async (app, clock, launched, _path, _exits, directory) => {
    assert.equal(app.status().canStart, false);
    await writeFile(join(directory, 'Agent Companion.app'), '');
    clock.now += 10_000;
    assert.equal(app.status().canStart, true);
    await app.start();
    assert.deepEqual(launched, [{executable: join(directory, 'Agent Companion.app'), environment: {}}]);
  }, directory => [join(directory, 'missing'), join(directory, 'Agent Companion.app')]);
});

test('a start that closes before it reaches the service shows why', async () => {
  await withApp(async (app, clock, _launched, _path, exits) => {
    app.seen({executable: '/opt/agent-companion'});
    clock.now += 5000;
    await app.start();
    exits[0]!(0);
    assert.equal(app.status().error, null, 'macOS open exits 0 once it hands the app over');
    exits[0]!(1);
    assert.equal(app.status().state, 'stopped');
    assert.match(app.status().error ?? '', /closed when it started \(exit code 1\)/);
    await app.start();
    assert.equal(app.status().error, null, 'a new start clears the old failure');
    app.seen({});
    exits[1]!(1);
    assert.equal(app.status().error, null, 'an app that reached the service then closed did not fail to start');
  });
});

test('the usual locations cover the downloads and a build in the repository', () => {
  assert.deepEqual(defaultDesktopAppLocations('darwin', '/Users/me', '/repo'), [
    '/Applications/Agent Companion.app', '/Users/me/Applications/Agent Companion.app',
    '/repo/desktop/apps/desktop/src-tauri/target/release/agent-companion-desktop',
    '/repo/desktop/apps/desktop/src-tauri/target/debug/agent-companion-desktop',
  ]);
  assert.equal(defaultDesktopAppLocations('linux', '/home/me', '/repo')[0], '/usr/bin/agent-companion-desktop');
  assert.deepEqual(defaultDesktopAppLocations('win32', 'C:\\Users\\me', 'C:\\repo',
                                              {LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'}), [
    'C:\\Users\\me\\AppData\\Local\\Agent Companion\\agent-companion-desktop.exe',
    'C:\\Program Files\\Agent Companion\\agent-companion-desktop.exe',
    'C:\\repo\\desktop\\apps\\desktop\\src-tauri\\target\\release\\agent-companion-desktop.exe',
    'C:\\repo\\desktop\\apps\\desktop\\src-tauri\\target\\debug\\agent-companion-desktop.exe',
  ]);
  assert.deepEqual(defaultDesktopAppLocations('freebsd', '/home/me', '/repo'), []);
});

test('stop tells the app to close on its next request', async () => {
  await withApp(async (app, clock) => {
    app.stop();
    app.seen({executable: '/usr/bin/agent-companion'});
    app.stop();
    assert.equal(app.status().state, 'stopping');
    await assert.rejects(app.start(), /closing/);
    clock.now += 400;
    assert.deepEqual(app.seen({}), {command: 'quit', changed: true});
    assert.equal(app.status().state, 'stopped');
    // The command is sent one time, so an app opened again stays open.
    assert.deepEqual(app.seen({}), {command: null, changed: true});
  });
});

test('a stop the app never collects expires', async () => {
  await withApp(async (app, clock) => {
    app.seen({});
    app.stop();
    clock.now += 6000;
    assert.deepEqual(app.seen({}), {command: null, changed: true});
  });
});

test('the BOOT button opens Settings in a running app one time', async () => {
  await withApp(async (app, clock) => {
    assert.equal(app.openSettings(), false);
    app.seen({executable: '/usr/bin/agent-companion', environment: {DISPLAY: ':1'}});
    assert.deepEqual(app.environment, {DISPLAY: ':1'});
    assert.equal(app.openSettings(), true);
    clock.now += 400;
    assert.deepEqual(app.seen({}), {command: 'settings', changed: false});
    clock.now += 400;
    assert.deepEqual(app.seen({}), {command: null, changed: false});
    // A request the app does not collect soon is dropped, so a window does not open much later.
    app.openSettings();
    clock.now += 3100;
    assert.deepEqual(app.seen({}), {command: null, changed: true});
    // Closing wins over Settings, and a closing app does not take the request.
    app.stop();
    assert.equal(app.openSettings(), false);
    clock.now += 400;
    assert.deepEqual(app.seen({}), {command: 'quit', changed: true});
    assert.equal(app.openSettings(), false);
  });
});

test('reports keep only an absolute location and display variables', () => {
  assert.equal(parseDesktopAppReport({}), null);
  assert.equal(parseDesktopAppReport({executable: 'agent-companion'}), null);
  assert.equal(parseDesktopAppReport({executable: '/a\0b'}), null);
  assert.deepEqual(parseDesktopAppReport({executable: '/opt/app', environment: ['DISPLAY']}),
                   {executable: '/opt/app', environment: {}});
  assert.deepEqual(parseDesktopAppReport({
    executable: '/opt/app.AppImage',
    environment: {WAYLAND_DISPLAY: 'wayland-1', DISPLAY: 7, LD_PRELOAD: '/evil.so', XAUTHORITY: ''},
  }), {executable: '/opt/app.AppImage', environment: {WAYLAND_DISPLAY: 'wayland-1'}});
});

test('only an app that reports it can write firmware is used for USB installs', async () => {
  assert.deepEqual(parseDesktopAppReport({executable: '/opt/app', flasher: 1}),
                   {executable: '/opt/app', environment: {}, flasher: true});
  assert.deepEqual(parseDesktopAppReport({executable: '/opt/app', flasher: true}), {executable: '/opt/app', environment: {}});
  assert.equal(desktopFlasherPath('/Applications/Agent Companion.app/', 'darwin'),
               '/Applications/Agent Companion.app/Contents/MacOS/agent-companion-desktop');
  assert.equal(desktopFlasherPath('/home/me/Agent.AppImage', 'linux'), '/home/me/Agent.AppImage');
  const directory = await mkdtemp(join(tmpdir(), 'desktop-flasher-'));
  try {
    const app = new DesktopApp({path: join(directory, 'desktop-app.json'), locations: []});
    app.seen({executable: '/opt/old-app'});
    assert.equal(app.flasher(), null);
    app.seen({executable: '/opt/app', flasher: 1});
    assert.equal(app.flasher(), '/opt/app');
    await app.saved();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a macOS app bundle opens through Launch Services', () => {
  assert.deepEqual(desktopLaunchCommand('/Applications/Agent Companion.app', 'darwin'),
                   ['/usr/bin/open', ['/Applications/Agent Companion.app']]);
  assert.deepEqual(desktopLaunchCommand('/repo/target/release/agent-companion', 'darwin'),
                   ['/repo/target/release/agent-companion', []]);
  assert.deepEqual(desktopLaunchCommand('/home/me/Agent.AppImage', 'linux'), ['/home/me/Agent.AppImage', []]);
});

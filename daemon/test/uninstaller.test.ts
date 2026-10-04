import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {createUninstallPlan, uninstallScript, type UninstallContext} from '../src/uninstaller.js';

const mac: UninstallContext = {
  platform: 'darwin',
  home: '/Users/dan',
  uid: 501,
  dataDir: '/Users/dan/Library/Application Support/ESP32 Agent Companion',
  socketPath: '/Users/dan/Library/Application Support/ESP32 Agent Companion/daemon.sock',
  serviceRoot: '/Users/dan/Library/Application Support/ESP32 Agent Companion/runtime',
  app: '/Applications/Agent Companion.app',
  keepData: false,
};

const linux: UninstallContext = {
  platform: 'linux',
  home: '/home/dan',
  uid: 1000,
  dataDir: '/home/dan/.local/state/esp32-agent-companion',
  socketPath: '/run/user/1000/esp32-agent-companion/daemon.sock',
  serviceRoot: '/home/dan/.local/state/esp32-agent-companion/runtime',
  app: '/home/dan/Apps/Agent Companion_0.8.1_amd64.AppImage',
  keepData: false,
};

test('the macOS plan removes the app, the service, its data and the app folders, then stops the service', () => {
  const plan = createUninstallPlan(mac);
  const support = '/Users/dan/Library/Application Support';
  assert.deepEqual(plan.before, []);
  assert.deepEqual(plan.after, [['launchctl', 'bootout', 'gui/501/com.danwahlin.esp32-agent-companion']]);
  for (const path of [
    `${support}/ESP32 Agent Companion`, `${support}/ESP32 Agent Companion/runtime`,
    '/Users/dan/Library/LaunchAgents/com.danwahlin.esp32-agent-companion.plist',
    '/Users/dan/Library/Logs/esp32-agent-companion.log', '/Users/dan/.copilot/hooks/agent-companion.json.bak',
    `${support}/dev.agentcompanion.desktop`, '/Users/dan/Library/Caches/agent-companion-desktop',
    '/Users/dan/Library/WebKit/dev.agentcompanion.desktop', '/Applications/Agent Companion.app',
  ]) assert.ok(plan.remove.includes(path), path);
  assert.deepEqual(plan.manual, []);
});

test('keepData keeps the data folder and the app folders, but not the service', () => {
  const plan = createUninstallPlan({...mac, keepData: true});
  const support = '/Users/dan/Library/Application Support';
  assert.ok(!plan.remove.includes(`${support}/ESP32 Agent Companion`));
  assert.ok(!plan.remove.includes(`${support}/dev.agentcompanion.desktop`));
  assert.ok(plan.remove.includes(`${support}/ESP32 Agent Companion/runtime`));
  assert.ok(plan.remove.includes('/Applications/Agent Companion.app'));
});

test('the Linux plan disables the unit first and stops it last', () => {
  const plan = createUninstallPlan({...linux, configHome: '/home/dan/.cfg'});
  assert.deepEqual(plan.before, [['systemctl', '--user', 'disable', 'esp32-agent-companion.service']]);
  assert.deepEqual(plan.after, [['systemctl', '--user', 'daemon-reload'],
                                ['systemctl', '--user', 'stop', 'esp32-agent-companion.service']]);
  for (const path of [
    '/home/dan/.cfg/systemd/user/esp32-agent-companion.service', '/home/dan/.local/state/esp32-agent-companion',
    '/run/user/1000/esp32-agent-companion/daemon.sock', '/home/dan/.local/share/dev.agentcompanion.desktop',
    '/home/dan/.cache/agent-companion-desktop', linux.app!,
  ]) assert.ok(plan.remove.includes(path), path);
});

test('a packaged or unknown app is a manual step, and a repository build is left alone', () => {
  assert.deepEqual(createUninstallPlan({...linux, app: '/usr/bin/agent-companion-desktop'}).manual,
                   ["Remove the desktop app's package: sudo apt remove agent-companion"]);
  const other = createUninstallPlan({...mac, app: '/Applications/Something Else.app'});
  assert.ok(!other.remove.includes('/Applications/Something Else.app'));
  assert.deepEqual(other.manual, ['Delete the desktop app: /Applications/Something Else.app']);

  const repo = '/Users/dan/projects/esp32-agent-companion';
  const build = `${repo}/desktop/apps/desktop/src-tauri/target/release/agent-companion-desktop`;
  const plan = createUninstallPlan({...mac, serviceRoot: repo, app: build});
  assert.ok(!plan.remove.some(path => path.startsWith(repo)));
  assert.deepEqual(plan.manual, [`The companion service ran from ${repo}. That folder is not changed.`]);
});

test('the plan never removes the home folder or a path without the project name', () => {
  const plan = createUninstallPlan({...mac, home: '/Users/agent-companion', app: '/Users/agent-companion/x.app',
                                    dataDir: '/Users/agent-companion', socketPath: 'relative.sock'});
  assert.ok(!plan.remove.includes('/Users/agent-companion'));
  assert.ok(!plan.remove.includes('relative.sock'));
  for (const path of plan.remove) assert.match(path.slice('/Users/agent-companion'.length), /agent[- ]?companion|agentcompanion/i);
});

test('the script quotes every path and runs the commands in order', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-companion-uninstall-'));
  try {
    const odd = join(folder, "it's agent companion");
    const kept = join(folder, 'keep');
    await mkdir(odd);
    await writeFile(join(odd, 'file'), 'x');
    await writeFile(kept, 'x');
    const log = join(folder, 'log');
    const script = uninstallScript({before: [['sh', '-c', `echo before >> '${log}'`]], remove: [odd],
                                    after: [['sh', '-c', `echo after >> '${log}'`]], manual: []});
    assert.match(script, /^sleep 1\n/);
    assert.ok(script.includes(`'${folder}/it'\\''s agent companion'`));
    await promisify(execFile)('/bin/sh', ['-c', script]);
    assert.equal(existsSync(odd), false);
    assert.equal(existsSync(kept), true);
    assert.equal(await readFile(log, 'utf8'), 'before\nafter\n');
  } finally {
    await rm(folder, {recursive: true, force: true});
  }
});

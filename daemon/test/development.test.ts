import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {CompanionService} from '../src/companion-service.js';
import {defaultAgentContext} from '../src/agents/index.js';
import {DeviceTransport} from '../src/device-transport.js';
import {StateCoordinator} from '../src/state-coordinator.js';

test('foreground development refuses installed-service and installed-desktop operations before any mutation', async () => {
  const previous = process.env.AGENT_COMPANION_DEV;
  process.env.AGENT_COMPANION_DEV = '1';
  try {
    const service = Object.create(CompanionService.prototype) as CompanionService;
    await assert.rejects(service.uninstall(false), /foreground development/);
    assert.throws(() => service.restartService(), /Aspire dashboard/);
    await assert.rejects(service.startDesktop(), /desktop resource in Aspire/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_COMPANION_DEV;
    else process.env.AGENT_COMPANION_DEV = previous;
  }
});

test('stopping a development daemon emits its own stop event without invoking an OS service manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-dev-stop-'));
  const previous = {...process.env};
  const coordinator = new StateCoordinator(() => undefined);
  try {
    process.env.AGENT_COMPANION_DEV = '1';
    process.env.AGENT_COMPANION_DATA_DIR = root;
    const service = new CompanionService(new DeviceTransport(), coordinator,
      defaultAgentContext({home: root, dataDir: root, appFolders: []}));
    let managerCalls = 0;
    const stopped = once(service, 'stop');
    await service.stopService((_plan, exit) => { managerCalls++; exit(); });
    await stopped;
    assert.equal(managerCalls, 0);
  } finally {
    coordinator.close();
    for (const name of ['AGENT_COMPANION_DEV', 'AGENT_COMPANION_DATA_DIR']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(root, {recursive: true, force: true});
  }
});

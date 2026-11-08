import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CompanionService} from '../src/companion-service.js';
import {defaultAgentContext} from '../src/agents/index.js';
import {DeviceTransport} from '../src/device-transport.js';
import {StateCoordinator} from '../src/state-coordinator.js';

test('status exposes concurrent agent roles without hardware or visible badges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-streamdeck-status-'));
  const previous = process.env.AGENT_COMPANION_DATA_DIR;
  process.env.AGENT_COMPANION_DATA_DIR = root;
  const coordinator = new StateCoordinator(() => undefined, {sweepMs: 0});
  try {
    const service = new CompanionService(new DeviceTransport(), coordinator,
      defaultAgentContext({home: root, dataDir: root, appFolders: [], env: {PATH: ''}}));
    coordinator.handle('userPromptSubmitted', {sessionId: 'claude:one'});
    coordinator.handle('userPromptSubmitted', {sessionId: 'copilot:two'});
    coordinator.handle('notification', {sessionId: 'copilot:two'});
    await service.setAgentBadgesEnabled(false);
    const status = service.status();
    assert.equal(status.connected, false);
    assert.equal(status.badges.enabled, false);
    assert.deepEqual(status.badges.roles.attention, ['copilot']);
    assert.ok(status.badges.roles.working.includes('claude'));
    assert.deepEqual(status.badges.active, [{id: 'copilot', role: 'attention'}]);
    coordinator.handle('sessionEnd', {sessionId: 'copilot:two'});
    assert.deepEqual(service.status().badges.roles.attention, []);
    assert.deepEqual(service.status().badges.roles.working, ['claude']);
  } finally {
    coordinator.close();
    if (previous === undefined) delete process.env.AGENT_COMPANION_DATA_DIR;
    else process.env.AGENT_COMPANION_DATA_DIR = previous;
    await rm(root, {recursive: true, force: true});
  }
});

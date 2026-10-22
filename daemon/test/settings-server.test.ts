import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {request} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import test from 'node:test';
import {createSettingsServer} from '../src/settings-server.js';
import {initialOnboarding, SetupError, type OnboardingChange, type OnboardingStep} from '../src/onboarding.js';
import {isHookCurrent} from '../src/agents/hook-config.js';
import type {AgentId, HookStatus} from '../src/agents/types.js';

const token = 'a'.repeat(48);

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

class FakeService extends EventEmitter {
  connected = true;
  installBusy = false;
  installs: string[] = [];
  wifi: Array<[string, string]> = [];
  modes: string[] = [];
  orientation: {offsetDegrees: number} | null = {offsetDegrees: 0};
  orientationChanges: number[] = [];
  agentActions: string[] = [];
  badges: boolean[] = [];
  desktop: Array<{visible?: boolean; backdrop?: string; sounds?: boolean; volume?: number; character?: string}> = [];
  usage: Array<{enabled?: boolean; window?: string}> = [];
  usbFirmware = {release: '0.7.0', releaseId: null, flasher: true, port: '/dev/test', unanswered: false,
                 installing: null, last: null};
  firmware = {device: 'aaaaaaaaaaaaaaaa', built: 'bbbbbbbbbbbbbbbb', canUpdate: true, updating: null, last: null,
              usb: this.usbFirmware};
  firmwareUpdates = 0;
  usbInstalls = 0;
  usbInstallPorts: Array<string | undefined> = [];
  setup = initialOnboarding();
  setupActions: string[] = [];
  setupBusy = false;
  hookStatus: HookStatus = 'installed';
  hookApprovals: AgentId[][] = [];
  status() {
    return {state: 'idle', transport: 'usb', connected: this.connected, port: '/dev/test', character: 'copilot',
            mode: 'auto', sessions: 0, wifiPaired: false, firmware: this.firmware,
            orientation: this.orientation, installing: null, lastInstall: null,
            drivingAgents: [], agents: this.agentStatuses(),
            badges: {enabled: true, active: [], icons: [{id: 'copilot', name: 'GitHub Copilot', color: '#6F7CFF', mask: Buffer.alloc(72).toString('base64')}]},
            desktop: {visible: true, backdrop: 'device', sounds: false, volume: 30, character: 'copilot', pack: null},
            usage: {enabled: true, window: 'today', aic: 902, tokens: null, lines: ['AIC: 902'], summary: ['AIC: 902']}} as never;
  }
  agentStatuses() {
    return [{id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
             hookStatus: this.hookStatus, enabled: true, activeSessions: 0, driving: false}];
  }
  async setAgentEnabled(id: string, enabled: boolean) {
    this.agentActions.push(`${enabled ? 'enable' : 'disable'}:${id}`);
    return this.agentStatuses();
  }
  async installAgentHook(id: string) {
    this.agentActions.push(`install:${id}`);
    return this.agentStatuses();
  }
  async uninstallAgentHook(id: string) {
    this.agentActions.push(`uninstall:${id}`);
    return this.agentStatuses();
  }
  async characters() {
    return [{id: 'copilot', name: 'Copilot', builtIn: true, bytes: 1, thumbnail: true, installed: true},
            {id: 'openclaw', name: 'OpenClaw', builtIn: true, bytes: 1, thumbnail: false, installed: false}];
  }
  async installCharacter(id: string) {
    this.installs.push(id);
    return {ok: true, character: id, name: id};
  }
  async addCharacter(data: Buffer) {
    return {id: 'custom', name: `bytes:${data.length}`, builtIn: false, bytes: data.length, thumbnail: false};
  }
  async removeCharacter() {}
  async configureWifi(ssid: string, password: string) {
    this.wifi.push([ssid, password]);
    return 'device';
  }
  async scanWifi() {
    return [{ssid: 'Home', rssi: -40, secure: true}];
  }
  async setConnection(mode: string) {
    this.modes.push(mode);
  }
  async setOrientationOffset(offsetDegrees: number) {
    if (!this.connected) throw new Error('Connect the Agent Companion first.');
    if (!this.orientation) throw new Error('Update the device firmware to adjust orientation.');
    if (this.installBusy) throw new Error('Wait for the current installation to finish.');
    this.orientationChanges.push(offsetDegrees);
    this.orientation = {offsetDegrees};
    return this.orientation;
  }
  async setAgentBadgesEnabled(enabled: boolean) {
    this.badges.push(enabled);
  }
  async setDesktop(change: {visible?: boolean; backdrop?: string; sounds?: boolean; volume?: number; character?: string}) {
    if (change.character === 'missing') throw new Error('Unknown character.');
    this.desktop.push(change);
  }
  desktopApp: string[] = [];
  canStartDesktop = true;
  async startDesktop() {
    if (!this.canStartDesktop) throw new Error('Open the desktop app one time yourself.');
    this.desktopApp.push('start');
  }
  stopDesktop() {
    this.desktopApp.push('stop');
  }
  async setUsage(change: {enabled?: boolean; window?: string}) {
    this.usage.push(change);
  }
  async updateFirmware() {
    this.firmwareUpdates += 1;
  }
  usbInstallBoards: Array<string | null | undefined> = [];
  async installFirmwareOverUsb(port?: string, board?: string | null) {
    this.usbInstalls += 1;
    this.usbInstallPorts.push(port);
    this.usbInstallBoards.push(board);
  }
  onboardingStatus() {
    return {...this.setup, busy: this.setupBusy, phase: null, error: null};
  }
  async updateOnboarding(change: OnboardingChange) {
    this.setup = {...this.setup, ...change};
    if (!this.setup.visitedSteps.includes(this.setup.step)) this.setup.visitedSteps.push(this.setup.step);
    return this.setup;
  }
  async navigateOnboarding(step: OnboardingStep) {
    if (this.setupBusy) throw new SetupError('Wait for the current installation to finish.');
    if (!this.setup.visitedSteps.includes(step)) throw new SetupError('This step has not been reached.');
    this.setupActions.push(`navigate:${step}`);
    return this.updateOnboarding({step, ...(step === 'agents' ? {agentStage: 'select'} : {})});
  }
  async restartOnboarding() {
    this.setup = initialOnboarding();
    return this.setup;
  }
  async exitOnboarding() {
    if (!this.setup.rerun) throw new SetupError('Finish setup first. It has not been completed on this computer.');
    this.setupActions.push('exit');
    this.setup = {...this.setup, completed: true, rerun: false, step: 'complete'};
    return this.setup;
  }
  async installOnboardingAgents(approved: AgentId[] = []) {
    if (!isHookCurrent(this.hookStatus) && !approved.includes('copilot'))
      throw new SetupError('Hooks changed. Review and approve the required installation.');
    this.hookApprovals.push(approved);
    this.setupActions.push('hooks');
    return this.setup.agents.map(id => ({id, ok: true}));
  }
  async rescanAgents() {
    this.setupActions.push('rescan');
    return this.agentStatuses();
  }
  async removeOnboardingAgent(id: AgentId) {
    this.setupActions.push(`remove:${id}`);
    this.setup.agents = this.setup.agents.filter(agent => agent !== id);
    return {state: this.setup};
  }
  async detectDevice() {
    return {result: 'no-device' as const, transport: null, port: null, ports: [], mode: 'auto' as const,
      wifiPaired: false, error: null};
  }
  async detectUsbDevices() {
    return {ports: [{path: '/dev/test', pid: 0x1001}], connected: this.connected ? '/dev/test' : null};
  }
  async applyOnboardingDisplay() {
    this.setupActions.push('display');
  }
  setupDeviceProblem = false;
  setupBoards: Array<string | null | undefined> = [];
  setupOnboardingDevice(flash: boolean, board?: string | null) {
    if (this.setupDeviceProblem) throw new SetupError('The companion service is stopping.');
    this.setupActions.push(flash ? 'flash' : 'existing-firmware');
    this.setupBoards.push(board);
    return Promise.resolve();
  }
  async finishOnboarding() {
    this.setupActions.push('finish');
    this.setup.completed = true;
    return this.setup;
  }
  serviceStops = 0;
  serviceRestarts = 0;
  restartService() {
    if (this.serviceStops > 0) throw new Error('The companion service is already stopping or restarting.');
    this.serviceRestarts += 1;
  }
  async stopService() {
    if (this.serviceStops > 0) throw new Error('The companion service is already stopping.');
    this.serviceStops += 1;
  }
  uninstalls: boolean[] = [];
  async uninstall(keepData: boolean) {
    if (this.uninstalls.length > 0) throw new Error('The uninstall is already in progress.');
    this.uninstalls.push(keepData);
    return {keptData: keepData, manual: ['Delete the desktop app: /opt/app']};
  }
}

async function withServer(run: (call: Call, service: FakeService) => Promise<void>): Promise<void> {
  const port = await freePort();
  const service = new FakeService();
  const server = createSettingsServer({
    service: service as never, port, token,
    thumbnail: async id => id === 'copilot' ? Buffer.from('png') : null,
    previewPack: async id => Buffer.from(`pack:${id}`),
  });

  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const call: Call = (path, options = {}) => new Promise((resolve, reject) => {
    const headers: Record<string, string> = {Host: options.host ?? `127.0.0.1:${port}`, ...options.headers};
    if (options.token !== false) headers['X-Companion-Token'] = options.token ?? token;
    const req = request({host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (res.headers['content-type']?.startsWith('text/event-stream')) {
          req.destroy();
          resolve({status: res.statusCode ?? 0, headers: res.headers, body});
        }

      });
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body}));
      res.on('close', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body}));
    });
    req.on('error', error => (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(error));
    req.end(options.body);
  });
  try {
    await run(call, service);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

type Call = (path: string, options?: {
  method?: string; host?: string; token?: string | false; headers?: Record<string, string>; body?: string | Buffer;
}) => Promise<{status: number; headers: Record<string, string | string[] | undefined>; body: string}>;

test('onboarding hook APIs allow checks without consent and restrict installations to approved agents', async () => {
  await withServer(async (call, service) => {
    const post = (body: unknown) => call('/api/onboarding/hooks', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    service.setup.agents = ['copilot'];
    assert.equal((await post({confirmed: false, agents: ['copilot'], installAgents: []})).status, 200);
    assert.deepEqual(service.hookApprovals, [[]]);
    service.setupActions = [];
    service.hookApprovals = [];
    service.hookStatus = 'outdated';
    assert.equal((await post({confirmed: false, agents: ['copilot'], installAgents: []})).status, 409);
    assert.equal((await post({confirmed: true, agents: ['copilot'], installAgents: []})).status, 409);
    for (const installAgents of [['copilot', 'copilot'], ['unknown'], ['codex'], 'copilot', null])
      assert.equal((await post({confirmed: true, agents: ['copilot'], installAgents})).status, 400);
    assert.equal((await post({confirmed: false, agents: ['copilot'], installAgents: ['copilot']})).status, 400);
    assert.deepEqual(service.setupActions, []);
    assert.deepEqual(service.hookApprovals, []);
    assert.equal((await post({confirmed: true, agents: ['copilot'], installAgents: ['copilot']})).status, 200);
    assert.deepEqual(service.hookApprovals, [['copilot']]);
  });

});

test('step navigation requires authentication and a reached step, and refuses installation-time changes', async () => {
  await withServer(async (call, service) => {
    const navigate = (step: unknown, authenticated = true) => call('/api/onboarding/navigate', {
      method: 'POST', token: authenticated ? token : false,
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({step}),
    });
    assert.equal((await navigate('welcome', false)).status, 401);
    assert.equal((await navigate('missing')).status, 400);
    assert.equal((await navigate('character')).status, 409);
    await service.updateOnboarding({step: 'agents', agents: ['copilot']});
    await service.updateOnboarding({step: 'character', character: 'claude'});
    assert.equal((await navigate('agents')).status, 200);
    assert.deepEqual(service.setup.agents, ['copilot']);
    assert.equal(service.setup.character, 'claude');
    assert.equal((await navigate('character')).status, 200);
    service.setupBusy = true;
    assert.equal((await navigate('agents')).status, 409);
    assert.equal(service.setup.step, 'character');
    assert.deepEqual(service.setupActions, ['navigate:agents', 'navigate:character']);
  });
});

test('a rejected device operation returns a conflict rather than an accepted installation', async () => {
  await withServer(async (call, service) => {
    service.setup.display = 'both';
    service.setup.port = '/dev/test';
    service.setupDeviceProblem = true;
    const response = await call('/api/onboarding/device', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({confirmed: true, flash: false, port: '/dev/test', display: 'both', character: 'copilot'}),
    });
    assert.equal(response.status, 409);
    assert.match(JSON.parse(response.body).error, /service is stopping/);
    assert.deepEqual(service.setupActions, []);
  });
});

test('a setup rerun can be left over the API; a first setup cannot', async () => {
  await withServer(async (call, service) => {
    service.setup = {...initialOnboarding(), rerun: true};
    assert.equal((await call('/api/onboarding/exit', {method: 'POST', token: false})).status, 401);
    const left = await call('/api/onboarding/exit', {method: 'POST'});
    assert.equal(left.status, 200);
    assert.equal(JSON.parse(left.body).completed, true);
    service.setup = initialOnboarding();
    const first = await call('/api/onboarding/exit', {method: 'POST'});
    assert.equal(first.status, 409);
    assert.match(JSON.parse(first.body).error, /Finish setup first/);
    assert.deepEqual(service.setupActions, ['exit']);
  });
});

test('non-object JSON bodies produce clear errors and cannot change setup or Settings', async () => {
  await withServer(async (call, service) => {
    for (const path of ['/api/onboarding', '/api/onboarding/hooks', '/api/onboarding/device', '/api/wifi',
      '/api/connection', '/api/desktop', '/api/orientation', '/api/badges', '/api/usage', '/api/uninstall']) {
      for (const body of ['null', '[]', '"value"', 'false']) {
        const response = await call(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
        assert.equal(response.status, 400, `${path}: ${body}`);
        assert.equal(JSON.parse(response.body).error, 'Request body must be a JSON object.');
      }
    }
    assert.deepEqual(service.setupActions, []);
    assert.deepEqual(service.desktop, []);
    assert.deepEqual(service.wifi, []);
    assert.deepEqual(service.modes, []);
    assert.deepEqual(service.uninstalls, []);
  });
});

test('orientation settings are authenticated, bounded, confirmed, and report unavailable devices', async () => {
  await withServer(async (call, service) => {
    const request = (offsetDegrees: unknown, tokenValue: string | false = token) =>
      call('/api/orientation', {method: 'POST', token: tokenValue,
        body: JSON.stringify({offsetDegrees}), headers: {'Content-Type': 'application/json'}});
    assert.equal((await request(0.5, false)).status, 401);
    for (const value of [15.5, -15.5, 0.1, '0', null]) {
      assert.equal((await request(value)).status, 400);
    }
    assert.deepEqual(service.orientationChanges, []);
    const saved = await request(-2.5);
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.body), {ok: true, orientation: {offsetDegrees: -2.5}});
    assert.deepEqual(service.orientationChanges, [-2.5]);
    assert.equal(JSON.parse((await call('/api/status')).body).orientation.offsetDegrees, -2.5);
    assert.equal((await request(0)).status, 200);
    service.installBusy = true;
    assert.equal((await request(1)).status, 409);
    service.installBusy = false;
    service.orientation = null;
    assert.equal((await request(1)).status, 409);
    service.connected = false;
    assert.equal((await request(1)).status, 409);
  });
});

test('serves the page with strict security headers', async () => {
  await withServer(async call => {
    const page = await call('/', {token: false});
    assert.equal(page.status, 200);
    assert.match(page.body, /Agent Buddy/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await call('/app.js', {token: false})).status, 200);
    const welcome = await call('/welcome-device.webp', {token: false});
    assert.equal(welcome.status, 200);
    assert.equal(welcome.headers['content-type'], 'image/webp');
    assert.match(page.body, /id="ob-welcome-graphic" src="\/welcome-device\.webp"/);
    const shell = await call('/device-shell.webp', {token: false});
    assert.equal(shell.status, 200);
    assert.equal(shell.headers['content-type'], 'image/webp');
    const engine = await call('/character-engine.js', {token: false});
    assert.equal(engine.status, 200);
    assert.match(engine.body, /var createEngine=/);
    assert.equal((await call('/character-preview.js', {token: false})).status, 200);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /(?:^| )'unsafe-eval'/);
    assert.equal((await call('/../package.json', {token: false})).status, 404);
  });
});

test('animation packs require the private token and a registered character without installing it', async () => {
  await withServer(async (call, service) => {
    assert.equal((await call('/api/characters/copilot/preview-pack', {token: false})).status, 401);
    assert.equal((await call(`/api/characters/copilot/preview-pack?token=${token}`, {token: false})).status, 401);
    assert.equal((await call('/api/characters/copilot/preview-pack', {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await call('/api/characters/missing/preview-pack')).status, 404);
    assert.equal((await call('/api/characters/..%2f..%2fsecret/preview-pack')).status, 404);
    const preview = await call('/api/characters/copilot/preview-pack');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers['content-type'], 'application/octet-stream');
    assert.equal(preview.body, 'pack:copilot');
    assert.equal(Number(preview.headers['content-length']), Buffer.byteLength(preview.body));
    assert.deepEqual(service.installs, []);
    assert.deepEqual(service.setupActions, []);
  });
});

test('rejects foreign hosts, foreign origins, and missing tokens', async () => {
  await withServer(async call => {
    assert.equal((await call('/api/status', {host: 'evil.example:4667'})).status, 421);
    assert.equal((await call('/', {host: 'evil.example', token: false})).status, 421);
    assert.equal((await call('/api/status', {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await call('/api/status', {token: false})).status, 401);
    assert.equal((await call('/api/status', {token: 'b'.repeat(48)})).status, 401);
    assert.equal((await call(`/api/status?token=${token}`, {token: false})).status, 401);
    const ok = await call('/api/status', {headers: {Origin: 'http://localhost:1'}});
    assert.equal(ok.status, 403);
  });
});

test('welcome animation supports byte ranges and HEAD requests for WebKit playback', async () => {
  await withServer(async call => {
    const head = await call('/welcome-idle.mp4', {method: 'HEAD', token: false});
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-type'], 'video/mp4');
    assert.equal(head.headers['accept-ranges'], 'bytes');
    const size = Number(head.headers['content-length']);
    assert.ok(size > 0);
    const first = await call('/welcome-idle.mp4', {token: false, headers: {Range: 'bytes=0-1'}});
    assert.equal(first.status, 206);
    assert.equal(first.headers['content-length'], '2');
    assert.equal(first.headers['content-range'], `bytes 0-1/${size}`);
    const suffix = await call('/welcome-idle.mp4', {token: false, headers: {Range: 'bytes=-4'}});
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], `bytes ${size - 4}-${size - 1}/${size}`);
    for (const range of [`bytes=${size}-`, 'bytes=9-1', 'bytes=-0', 'bytes=0-1,3-4', 'invalid']) {
      const response = await call('/welcome-idle.mp4', {token: false, headers: {Range: range}});
      assert.equal(response.status, 416);
      assert.equal(response.headers['content-range'], `bytes */${size}`);
    }
  });
});

test('reports status, characters, thumbnails, and events', async () => {
  await withServer(async call => {
    const status = await call('/api/status');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).character, 'copilot');
    assert.equal(JSON.parse((await call('/api/agents')).body).length, 1);
    assert.equal(JSON.parse((await call('/api/characters')).body).length, 2);
    const image = await call(`/api/characters/copilot/thumbnail?token=${token}`, {token: false});
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal((await call('/api/characters/openclaw/thumbnail')).status, 404);
    const events = await call(`/api/events?token=${token}`, {token: false});
    assert.equal(events.status, 200);
    assert.match(events.body, /^event: status\ndata: \{/);
  });
});

test('validates and performs actions', async () => {
  await withServer(async (call, service) => {
    const json = {'Content-Type': 'application/json'};
    assert.equal((await call('/api/characters/openclaw/install', {method: 'POST'})).status, 202);
    assert.deepEqual(service.installs, ['openclaw']);
    assert.equal((await call('/api/characters/nobody/install', {method: 'POST'})).status, 404);
    assert.equal((await call('/api/characters/Bad!/install', {method: 'POST'})).status, 404);
    service.connected = false;
    assert.equal((await call('/api/characters/openclaw/install', {method: 'POST'})).status, 409);

    assert.equal((await call('/api/wifi', {method: 'POST', body: '{"ssid":"Home","password":"secret12"}'})).status, 415);
    assert.equal((await call('/api/wifi', {method: 'POST', headers: json, body: '{"ssid":1}'})).status, 400);
    assert.equal((await call('/api/wifi', {method: 'POST', headers: json, body: '{"ssid":"Home","password":"secret12"}'})).status, 200);
    assert.deepEqual(service.wifi, [['Home', 'secret12']]);
    const networks = await call('/api/wifi/networks');
    assert.equal(networks.status, 200);
    assert.deepEqual(JSON.parse(networks.body), [{ssid: 'Home', rssi: -40, secure: true}]);

    assert.equal((await call('/api/connection', {method: 'POST', headers: json, body: '{"mode":"bluetooth"}'})).status, 400);
    assert.equal((await call('/api/connection', {method: 'POST', headers: json, body: '{"mode":"wifi"}'})).status, 200);
    assert.deepEqual(service.modes, ['wifi']);
    assert.equal((await call('/api/badges', {method: 'POST', headers: json, body: '{"enabled":"yes"}'})).status, 400);
    assert.equal((await call('/api/badges', {method: 'POST', headers: json, body: '{"enabled":false}'})).status, 200);
    assert.deepEqual(service.badges, [false]);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"visible":"no"}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"backdrop":"neon"}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"visible":false}'})).status, 200);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"backdrop":"device"}'})).status, 200);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"sounds":"on"}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"sounds":true}'})).status, 200);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"volume":101}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"volume":"50"}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"volume":30}'})).status, 200);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"character":"Bad!"}'})).status, 400);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"character":"missing"}'})).status, 409);
    assert.equal((await call('/api/desktop', {method: 'POST', headers: json, body: '{"character":"claude"}'})).status, 200);
    assert.deepEqual(service.desktop, [
      {visible: false, backdrop: undefined, sounds: undefined, volume: undefined, character: undefined},
      {visible: undefined, backdrop: 'device', sounds: undefined, volume: undefined, character: undefined},
      {visible: undefined, backdrop: undefined, sounds: true, volume: undefined, character: undefined},
      {visible: undefined, backdrop: undefined, sounds: undefined, volume: 30, character: undefined},
      {visible: undefined, backdrop: undefined, sounds: undefined, volume: undefined, character: 'claude'},
    ]);
    assert.equal((await call('/api/usage', {method: 'POST', headers: json, body: '{}'})).status, 400);
    assert.equal((await call('/api/usage', {method: 'POST', headers: json, body: '{"enabled":"yes"}'})).status, 400);
    assert.equal((await call('/api/usage', {method: 'POST', headers: json, body: '{"window":"year"}'})).status, 400);
    const usage = await call('/api/usage', {method: 'POST', headers: json, body: '{"enabled":false,"window":"month"}'});
    assert.equal(usage.status, 200);
    assert.deepEqual(JSON.parse(usage.body).usage.lines, ['AIC: 902']);
    assert.equal((await call('/api/usage', {method: 'POST', headers: json, body: '{"window":"active"}'})).status, 200);
    assert.deepEqual(service.usage, [{enabled: false, window: 'month'}, {enabled: undefined, window: 'active'}]);
    assert.equal((await call('/api/desktop/start', {method: 'POST'})).status, 200);
    assert.equal((await call('/api/desktop/stop', {method: 'POST'})).status, 200);
    assert.equal((await call('/api/desktop/restart', {method: 'POST'})).status, 404);
    assert.equal((await call('/api/desktop/start', {method: 'GET'})).status, 404);
    assert.equal((await call('/api/desktop/start', {method: 'POST', token: false})).status, 401);
    service.canStartDesktop = false;
    const refused = await call('/api/desktop/start', {method: 'POST'});
    assert.equal(refused.status, 409);
    assert.match(JSON.parse(refused.body).error, /one time yourself/);
    assert.deepEqual(service.desktopApp, ['start', 'stop']);
    assert.equal((await call('/api/uninstall', {method: 'POST', headers: json, body: '{}'})).status, 400);
    assert.equal((await call('/api/uninstall', {method: 'POST', headers: json, body: '{"keepData":"yes"}'})).status, 400);
    assert.equal((await call('/api/uninstall', {method: 'POST', headers: json, body: '{"keepData":true}', token: false})).status, 401);
    const uninstalled = await call('/api/uninstall', {method: 'POST', headers: json, body: '{"keepData":true}'});
    assert.equal(uninstalled.status, 200);
    assert.deepEqual(JSON.parse(uninstalled.body), {ok: true, keptData: true, manual: ['Delete the desktop app: /opt/app']});
    assert.equal((await call('/api/uninstall', {method: 'POST', headers: json, body: '{"keepData":false}'})).status, 409);
    assert.deepEqual(service.uninstalls, [true]);
    assert.equal((await call('/api/service/restart', {method: 'POST', token: false})).status, 401);
    assert.equal((await call('/api/service/restart', {method: 'POST'})).status, 200);
    assert.equal(service.serviceRestarts, 1);
    assert.equal((await call('/api/service/stop', {method: 'GET'})).status, 404);
    assert.equal((await call('/api/service/stop', {method: 'POST', token: false})).status, 401);
    assert.equal((await call('/api/service/stop', {method: 'POST'})).status, 200);
    assert.equal((await call('/api/service/stop', {method: 'POST'})).status, 409);
    assert.equal(service.serviceStops, 1);
    assert.equal((await call('/api/service/restart', {method: 'POST'})).status, 409);
    assert.equal((await call('/api/firmware/update', {method: 'GET'})).status, 404);
    assert.equal((await call('/api/firmware/update', {method: 'POST', token: false})).status, 401);
    assert.equal((await call('/api/firmware/update', {method: 'POST'})).status, 202);
    assert.equal(service.firmwareUpdates, 1);
    service.firmware = {...service.firmware, built: service.firmware.device, canUpdate: false};
    const current = await call('/api/firmware/update', {method: 'POST'});
    assert.equal(current.status, 409);
    assert.match(JSON.parse(current.body).error, /already runs/);
    service.firmware = {...service.firmware, built: 'bbbbbbbbbbbbbbbb', canUpdate: false};
    assert.match(JSON.parse((await call('/api/firmware/update', {method: 'POST'})).body).error, /Wi-Fi/);
    assert.equal(service.firmwareUpdates, 1);
    assert.equal((await call('/api/firmware/usb', {method: 'POST', token: false})).status, 401);
    assert.equal((await call('/api/firmware/usb', {method: 'POST', headers: json, body: '{}'})).status, 400);
    assert.equal(service.usbInstalls, 0);
    assert.equal((await call('/api/firmware/usb', {method: 'POST', headers: json,
      body: '{"confirmed":true,"port":"/dev/test"}'})).status, 202);
    assert.equal(service.usbInstalls, 1);
    assert.deepEqual(service.usbInstallPorts, ['/dev/test']);
    // The board chosen for a device that does not answer goes to the service; an unknown one is refused.
    assert.equal((await call('/api/firmware/usb', {method: 'POST', headers: json,
      body: '{"confirmed":true,"port":"/dev/test","board":"other-board"}'})).status, 400);
    assert.equal((await call('/api/firmware/usb', {method: 'POST', headers: json,
      body: '{"confirmed":true,"port":"/dev/test","board":"waveshare-lcd-154"}'})).status, 202);
    assert.deepEqual(service.usbInstallBoards, [null, 'waveshare-lcd-154']);
    service.usbInstalls = 1;
    service.firmware = {...service.firmware, usb: {...service.usbFirmware, flasher: false}};
    const noApp = await call('/api/firmware/usb', {method: 'POST', headers: json, body: '{"confirmed":true}'});
    assert.equal(noApp.status, 409);
    assert.match(JSON.parse(noApp.body).error, /desktop app/);
    assert.equal(service.usbInstalls, 1);
    assert.equal((await call('/api/agents/copilot/disable', {method: 'POST'})).status, 200);
    assert.equal((await call('/api/agents/copilot/install', {method: 'POST'})).status, 200);
    assert.equal((await call('/api/agents/copilot', {method: 'DELETE'})).status, 200);
    assert.equal((await call('/api/agents/nope/disable', {method: 'POST'})).status, 404);
    assert.deepEqual(service.agentActions, ['disable:copilot', 'install:copilot', 'uninstall:copilot']);

    const upload = await call('/api/characters', {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: Buffer.alloc(300)});
    assert.equal(upload.status, 201);
    assert.equal(JSON.parse(upload.body).name, 'bytes:300');
    assert.equal((await call('/api/characters', {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(17 * 1024 * 1024)},
    })).status, 413);
    assert.equal((await call('/api/characters/custom', {method: 'DELETE'})).status, 200);
  });
});

test('onboarding APIs require authentication, valid choices, and explicit install approval', async () => {
  await withServer(async (call, service) => {
    const post = (path: string, body: unknown, authenticated = true) =>
      call(path, {method: 'POST', token: authenticated ? token : false,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal((await call('/onboarding.js', {token: false})).status, 200);
    assert.equal((await call('/onboarding.css', {token: false})).status, 200);
    assert.equal((await call('/api/onboarding', {token: false})).status, 401);
    assert.equal((await post('/api/onboarding', {agents: ['copilot']}, false)).status, 401);
    for (const choice of [{completed: true}, {agents: ['unknown']}, {display: 'cloud'}, {step: 'missing'}])
      assert.equal((await post('/api/onboarding', choice)).status, 400);
    assert.deepEqual(service.setupActions, []);
    assert.equal((await post('/api/onboarding', {agents: ['copilot'], step: 'agents'})).status, 200);
    assert.equal((await post('/api/onboarding/hooks', {confirmed: false})).status, 400);
    assert.deepEqual(service.setupActions, []);
    assert.equal((await post('/api/onboarding/hooks', {confirmed: true, agents: ['codex']})).status, 409);
    assert.deepEqual(service.setupActions, []);
    assert.equal((await post('/api/onboarding/hooks', {confirmed: true, agents: ['copilot']})).status, 200);
    assert.deepEqual(service.setupActions, ['hooks']);
    assert.equal((await call('/api/devices', {token: false})).status, 401);
    assert.deepEqual(JSON.parse((await call('/api/devices')).body).ports, [{path: '/dev/test', pid: 0x1001}]);
    assert.equal((await post('/api/devices/detect', {}, false)).status, 401);
    assert.equal(JSON.parse((await post('/api/devices/detect', {})).body).result, 'no-device');
    assert.equal((await post('/api/onboarding/device', {flash: true})).status, 400);
    assert.equal((await post('/api/onboarding/device', {flash: 'true', confirmed: true})).status, 400);
    service.setupBusy = true;
    assert.equal((await post('/api/onboarding/device', {flash: true, confirmed: true})).status, 409);
    service.setupBusy = false;
    service.setup.display = 'both';
    service.setup.port = '/dev/test';
    assert.equal((await post('/api/onboarding/device', {flash: false, confirmed: true,
      port: '/dev/other', character: 'copilot', display: 'both'})).status, 409);
    assert.deepEqual(service.setupActions, ['hooks']);
    assert.equal((await post('/api/onboarding/device', {flash: false, confirmed: true,
      port: '/dev/test', character: 'copilot', display: 'both'})).status, 202);
    assert.deepEqual(service.setupActions, ['hooks', 'existing-firmware']);
    assert.equal((await post('/api/onboarding/device', {flash: true, confirmed: true,
      port: '/dev/test', character: 'copilot', display: 'both', board: '../x'})).status, 400);
    assert.equal((await post('/api/onboarding/device', {flash: true, confirmed: true,
      port: '/dev/test', character: 'copilot', display: 'both', board: 'waveshare-lcd-154'})).status, 202);
    assert.deepEqual(service.setupBoards, [null, 'waveshare-lcd-154']);
    service.setupActions.pop();
    assert.equal((await post('/api/onboarding/remove-agent', {agent: 'copilot', confirmed: false, agents: ['copilot']})).status, 400);
    assert.equal((await post('/api/onboarding/remove-agent', {agent: 'copilot', confirmed: true, agents: ['codex']})).status, 409);
    assert.deepEqual(service.setup.agents, ['copilot']);
    assert.equal((await post('/api/onboarding/remove-agent', {agent: 'copilot', confirmed: true, agents: ['copilot']})).status, 200);
    assert.deepEqual(service.setup.agents, []);
    assert.equal((await call('/api/onboarding/rescan', {method: 'POST'})).status, 200);
    assert.deepEqual(service.setupActions, ['hooks', 'existing-firmware', 'remove:copilot', 'rescan']);
    assert.equal((await call('/api/onboarding/finish', {method: 'POST'})).status, 200);
    assert.equal(service.setup.completed, true);
  });
});

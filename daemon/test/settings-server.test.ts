import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {request} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import test from 'node:test';
import {createSettingsServer} from '../src/settings-server.js';

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
  voice: string[] = [];
  usbFirmware = {release: '0.7.0', releaseId: null, flasher: true, port: '/dev/test', unanswered: false,
                 installing: null, last: null};
  firmware = {device: 'aaaaaaaaaaaaaaaa', built: 'bbbbbbbbbbbbbbbb', canUpdate: true, updating: null, last: null,
              usb: this.usbFirmware};
  firmwareUpdates = 0;
  usbInstalls = 0;
  status() {
    return {state: 'idle', transport: 'usb', connected: this.connected, port: '/dev/test', character: 'copilot',
            mode: 'auto', sessions: 0, wifiPaired: false, firmware: this.firmware,
            orientation: this.orientation, installing: null, lastInstall: null,
            drivingAgents: [], agents: this.agentStatuses(),
            badges: {enabled: true, active: [], icons: [{id: 'copilot', name: 'GitHub Copilot', color: '#6F7CFF', mask: Buffer.alloc(72).toString('base64')}]},
            desktop: {visible: true, backdrop: 'device', sounds: false, volume: 30, character: 'copilot', pack: null},
            voice: {mode: 'off', supported: true},
            usage: {enabled: true, window: 'today', aic: 902, tokens: null, lines: ['AIC: 902'], summary: ['AIC: 902']}} as never;
  }
  agentStatuses() {
    return [{id: 'copilot', name: 'GitHub Copilot', detected: true, installed: true,
             hookStatus: 'installed', enabled: true, activeSessions: 0, driving: false}];
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
  async setVoiceNotifications(mode: string) {
    this.voice.push(mode);
  }
  async updateFirmware() {
    this.firmwareUpdates += 1;
  }
  async installFirmwareOverUsb() {
    this.usbInstalls += 1;
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
    assert.match(page.body, /Agent Companion/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await call('/app.js', {token: false})).status, 200);
    assert.equal((await call('/../package.json', {token: false})).status, 404);
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
    assert.equal((await call('/api/voice', {method: 'POST', headers: json, body: '{"mode":"loud"}'})).status, 400);
    assert.equal((await call('/api/voice', {method: 'POST', headers: json, body: '{"mode":"milestones"}'})).status, 200);
    assert.deepEqual(service.voice, ['milestones']);
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
    assert.equal((await call('/api/firmware/usb', {method: 'POST'})).status, 202);
    assert.equal(service.usbInstalls, 1);
    service.firmware = {...service.firmware, usb: {...service.usbFirmware, flasher: false}};
    const noApp = await call('/api/firmware/usb', {method: 'POST'});
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

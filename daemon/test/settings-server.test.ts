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
  agentActions: string[] = [];
  badges: boolean[] = [];
  status() {
    return {state: 'idle', transport: 'usb', connected: this.connected, port: '/dev/test', character: 'copilot',
            mode: 'auto', sessions: 0, wifiPaired: false, installing: null, lastInstall: null,
            drivingAgents: [], agents: this.agentStatuses(),
            badges: {enabled: true, active: [], icons: [{id: 'copilot', name: 'GitHub Copilot CLI', color: '#6F7CFF', mask: Buffer.alloc(72).toString('base64')}]}} as never;
  }
  agentStatuses() {
    return [{id: 'copilot', name: 'GitHub Copilot CLI', detected: true, installed: true,
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
  async setConnection(mode: string) {
    this.modes.push(mode);
  }
  async setAgentBadgesEnabled(enabled: boolean) {
    this.badges.push(enabled);
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

    assert.equal((await call('/api/connection', {method: 'POST', headers: json, body: '{"mode":"bluetooth"}'})).status, 400);
    assert.equal((await call('/api/connection', {method: 'POST', headers: json, body: '{"mode":"wifi"}'})).status, 200);
    assert.deepEqual(service.modes, ['wifi']);
    assert.equal((await call('/api/badges', {method: 'POST', headers: json, body: '{"enabled":"yes"}'})).status, 400);
    assert.equal((await call('/api/badges', {method: 'POST', headers: json, body: '{"enabled":false}'})).status, 200);
    assert.deepEqual(service.badges, [false]);
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

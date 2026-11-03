import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer, type Server} from 'node:http';
import test from 'node:test';
import {settingsTelemetryRoute, startDevelopmentTelemetry} from '../src/development-telemetry.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('telemetry routes exclude polling, static files, queries, and dynamic identifiers', () => {
  assert.equal(settingsTelemetryRoute('/api/status?token=private'), null);
  assert.equal(settingsTelemetryRoute('/api/events?token=private'), null);
  assert.equal(settingsTelemetryRoute('/app.js'), null);
  assert.equal(settingsTelemetryRoute('/api/characters/private-name/thumbnail?token=private'), '/api/characters/*');
  assert.equal(settingsTelemetryRoute('/api/private-name'), '/api/other');
});

test('telemetry stays off outside explicit development with an exporter endpoint', () => {
  const previous = {...process.env};
  try {
    delete process.env.AGENT_COMPANION_DEV;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';
    assert.equal(startDevelopmentTelemetry(), undefined);
    process.env.AGENT_COMPANION_DEV = '1';
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    assert.equal(startDevelopmentTelemetry(), undefined);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example.com';
    assert.throws(startDevelopmentTelemetry, /loopback Aspire/);
  } finally {
    for (const name of ['AGENT_COMPANION_DEV', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('exports real request spans and metrics with no token, body, header, or dynamic-path data', async () => {
  const previous = {...process.env};
  const exports: {path: string; body: string; authorization: string | undefined}[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    exports.push({path: request.url ?? '', body: Buffer.concat(chunks).toString(),
      authorization: request.headers.authorization});
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('{}');
  });
  const settings = createServer((request, response) => {
    request.resume();
    response.statusCode = request.method === 'POST' ? 503 : 200;
    response.end('private-response');
  });
  let telemetry: ReturnType<typeof startDevelopmentTelemetry>;
  try {
    const endpoint = await listen(collector);
    const url = await listen(settings);
    process.env.AGENT_COMPANION_DEV = '1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=collector-only';
    process.env.OTEL_SERVICE_NAME = 'companion-test';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.instance.id=isolated-test';
    telemetry = startDevelopmentTelemetry();
    assert.ok(telemetry);
    await (await fetch(`${url}/api/status?token=private-token`)).text();
    await (await fetch(`${url}/api/characters/private-character?token=private-token`,
      {headers: {'X-Companion-Token': 'private-header', Cookie: 'private-cookie'}})).text();
    await (await fetch(`${url}/api/desktop?token=private-token`,
      {method: 'POST', body: 'private-body'})).text();
    await telemetry.shutdown();
    telemetry = undefined;

    const spans = exports.filter(item => item.path === '/v1/traces');
    const metrics = exports.filter(item => item.path === '/v1/metrics');
    assert.ok(spans.length > 0, 'trace exporter reached the collector');
    assert.ok(metrics.length > 0, 'metric exporter reached the collector');
    assert.ok(exports.every(item => item.authorization === 'collector-only'), 'exporter honors injected OTLP auth');
    const traces = spans.map(item => item.body).join('\n');
    const measurements = metrics.map(item => item.body).join('\n');
    assert.match(traces, /GET \/api\/characters\/\*/);
    assert.match(traces, /POST \/api\/desktop\/\*/);
    assert.match(traces, /"code":2/);
    for (const name of ['settings.requests', 'settings.request.duration', 'process.memory.usage', 'process.cpu.time'])
      assert.ok(measurements.includes(name), `exported ${name}`);
    const all = `${traces}\n${measurements}`;
    assert.ok(all.includes('companion-test'));
    assert.ok(all.includes('isolated-test'), 'preserves Aspire resource identity');
    for (const secret of ['private-token', 'private-character', 'private-header', 'private-cookie',
      'private-body', 'private-response', 'collector-only', '/api/status'])
      assert.ok(!all.includes(secret), `telemetry must exclude ${secret}`);
  } finally {
    await telemetry?.shutdown();
    settings.closeAllConnections();
    collector.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => settings.close(() => resolve())),
      new Promise<void>(resolve => collector.close(() => resolve()))]);
    for (const name of ['AGENT_COMPANION_DEV', 'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

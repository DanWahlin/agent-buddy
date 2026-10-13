import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import test from 'node:test';

test('serves MCP initialize, tool discovery, and explicit connection errors', async () => {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AGENT_COMPANION_SOCKET: '/tmp/esp32-agent-companion-missing-test.sock',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = createInterface({input: child.stdout, crlfDelay: Infinity});
  const lines = [];
  output.on('line', line => lines.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {protocolVersion: '2025-06-18', capabilities: {}},
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {name: 'status', arguments: {}},
  })}\n`);
  child.stdin.end();
  await once(child, 'close');

  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(lines[1].result.tools.map(tool => tool.name),
                   ['status', 'test_connection', 'set_state', 'narrate']);
  assert.equal(lines[2].result.isError, true);
  assert.match(lines[2].result.content[0].text, /daemon is unavailable/);
});

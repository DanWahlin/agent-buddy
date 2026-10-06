#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {createToolHandler, listTools} from './tools.mjs';

const supportedVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const latestVersion = '2025-06-18';
const handleTool = createToolHandler();
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});

for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    if (request.method?.startsWith('notifications/')) continue;
    const result = await handleRequest(request.method, request.params);
    respond({jsonrpc: '2.0', id: request.id, result});
  } catch (error) {
    respond({
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function handleRequest(method, params = {}) {
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    return {
      protocolVersion: supportedVersions.has(requested) ? requested : latestVersion,
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: 'esp32-agent-companion', version: '0.2.0'},
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return {tools: listTools()};
  if (method === 'tools/call') {
    if (typeof params.name !== 'string') throw new Error('tools/call requires a tool name.');
    return handleTool(params.name, params.arguments ?? {});
  }
  throw new Error(`Method not found: ${method}`);
}

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

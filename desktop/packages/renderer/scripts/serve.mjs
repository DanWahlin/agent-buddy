/**
 * Static server for the harness. The pack and the built renderer live outside
 * the harness directory, so both are mounted rather than copied.
 *
 * It also runs a real `StateBridge` and pushes the agent state to the page over
 * SSE, so the character can be driven by actual agent hooks with no VS Code
 * running. That is the whole standalone thesis, minus the window chrome: real
 * hooks, real coordinator, real pixels. The bridge is optional - if
 * `@agent-companion/agent-state` has not been built the page still serves and
 * the buttons still work.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const mounts = [
  ['/pack/', resolve(here, '..', '..', 'packs', 'marvin')],
  ['/dist/', join(here, 'dist')],
  ['/pack-format/', resolve(here, '..', 'pack-format', 'dist')],
  ['/', join(here, 'harness')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
};

/** Every open SSE response, so shutdown can end them. */
const listeners = new Set();
let bridge = null;
let currentState = 'idle';

/** What the page needs to know: the state, and whether a bridge is behind it. */
function frame() {
  return 'data: ' + JSON.stringify({
    state: currentState,
    bridge: bridge ? bridge.role : null,
  }) + '\n\n';
}

function broadcast() {
  for (const client of listeners) client.write(frame());
}

/**
 * Hold the response open and push state to it.
 *
 * The current state goes out immediately, so a page opened mid-session shows
 * what is happening rather than waiting for the next event - the same reason
 * `CompanionViewProvider` re-sends state to a restored view.
 */
function subscribe(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  response.write('retry: 2000\n\n');
  response.write(frame());
  listeners.add(response);
  response.on('close', () => listeners.delete(response));
}

async function startBridge() {
  let agentState;
  try {
    agentState = await import('@agent-companion/agent-state');
  } catch {
    console.log('No agent bridge: build @agent-companion/agent-state to drive this from real hooks.');
    return;
  }

  bridge = new agentState.StateBridge({
    onState: state => { currentState = state; broadcast(); },
    onLog: line => console.log('[bridge] ' + line),
  });

  try {
    await bridge.start();
    console.log('Bridge ' + bridge.role + ' on ' + agentState.endpointPath());
    // A page opened before the bridge came up is still showing "no bridge".
    broadcast();
  } catch (error) {
    console.log('Bridge did not start: ' + error.message);
    bridge = null;
  }
}

const port = Number(process.env.PORT ?? 4321);
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;

  if (path === '/events') { subscribe(response); return; }

  for (const [prefix, root] of mounts) {
    if (!path.startsWith(prefix)) continue;
    // join + the containment check below is what actually stops traversal.
    const file = join(root, normalize(path.slice(prefix.length)));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) continue;
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found: ' + path);
});

// A comment frame, which EventSource ignores. It keeps the connection warm and
// surfaces a client that went away without a 'close'.
setInterval(() => {
  for (const client of listeners) client.write(': ping\n\n');
}, 20_000).unref();

/**
 * An SSE response never ends on its own, so `server.close()` would wait on it
 * forever - the same trap the bridge hit by tracking only its subscribers.
 * End them first, then close.
 */
async function shutdown() {
  for (const client of listeners) client.end();
  listeners.clear();
  await bridge?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, async () => {
  console.log('Harness on http://localhost:' + port);
  await startBridge();
});

import {createConnection, type Socket} from 'node:net';
import type {DaemonRequest} from './protocol.js';
import {isNamedPipe, socketPath} from './paths.js';

// Unix clients half-close so older daemons, which wait for 'end', still answer. Windows named
// pipes do not half-close reliably, so there the daemon answers at the newline instead.
function sendRequest(socket: Socket, request: DaemonRequest): void {
  const line = `${JSON.stringify(request)}\n`;
  if (isNamedPipe(socketPath())) socket.write(line);
  else socket.end(line);
}

// Reads newline-delimited JSON replies; the last message is the result.
export function streamDaemon(request: DaemonRequest, onMessage: (message: unknown) => void,
                             timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let buffer = '';
    let last: unknown = {};
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Agent Companion daemon did not respond.'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => sendRequest(socket, request));
    socket.on('data', chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          last = JSON.parse(line);
        } catch {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('Agent Companion daemon returned invalid JSON.'));
          return;
        }
        onMessage(last);
      }
      if (buffer.length > 65536) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('Agent Companion daemon returned an oversized response.'));
      }
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(last);
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(daemonError(error));
    });
  });
}

const notRunning = 'The companion service is not running. Start the Agent Companion app, or run "npm run setup" from the repository root.';

function daemonError(error: NodeJS.ErrnoException): Error {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? new Error(notRunning) : error;
}

export function requestDaemon(request: DaemonRequest, timeoutMs = 500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Agent Companion daemon did not respond.'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => sendRequest(socket, request));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length <= 65536) return;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('Agent Companion daemon returned an oversized response.'));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(buffer.trim() ? JSON.parse(buffer) : {});
      } catch {
        reject(new Error('Agent Companion daemon returned invalid JSON.'));
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(daemonError(error));
    });
  });
}

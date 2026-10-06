import {createConnection} from 'node:net';
import {homedir, tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';

export const characterStates = ['idle', 'surprise', 'working', 'complete', 'attention'];

export function socketPath({
  platform = process.platform,
  home = homedir(),
  environment = process.env,
  temporary = tmpdir(),
  uid = process.getuid?.() ?? userInfo().uid,
} = {}) {
  if (environment.AGENT_COMPANION_SOCKET) return environment.AGENT_COMPANION_SOCKET;
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ESP32 Agent Companion', 'daemon.sock');
  }
  return environment.XDG_RUNTIME_DIR
    ? join(environment.XDG_RUNTIME_DIR, 'esp32-agent-companion', 'daemon.sock')
    : join(temporary, `esp32-agent-companion-${uid}`, 'daemon.sock');
}

export function requestDaemon(request, {
  path = socketPath(),
  timeoutMs = 1500,
  connect = createConnection,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('ESP32 Agent Companion daemon did not respond.'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length <= 65536) return;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('ESP32 Agent Companion daemon returned an oversized response.'));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const response = buffer.trim() ? JSON.parse(buffer) : {};
        if (response?.ok === false) {
          reject(new Error(typeof response.error === 'string'
            ? response.error
            : 'ESP32 Agent Companion daemon rejected the request.'));
          return;
        }
        resolve(response);
      } catch (error) {
        reject(error instanceof SyntaxError
          ? new Error('ESP32 Agent Companion daemon returned invalid JSON.')
          : error);
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`ESP32 Agent Companion daemon is unavailable: ${error.message}`));
    });
  });
}

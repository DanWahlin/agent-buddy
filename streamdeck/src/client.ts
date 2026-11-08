import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, win32} from 'node:path';

export const agents = {
  copilot: 'Copilot',
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
} as const;
export type AgentId = keyof typeof agents;
export type State = 'idle' | 'working' | 'attention' | 'complete';
export type Roles = Record<'working' | 'attention' | 'complete', AgentId[]>;
export type Status = {state: State; roles: Roles};
export type Connection = {url: URL; token: string};

export function settingsPath(
  platform = process.platform, home = homedir(), environment = process.env,
): string {
  if (environment.AGENT_COMPANION_SETTINGS_INFO) return environment.AGENT_COMPANION_SETTINGS_INFO;
  if (environment.AGENT_COMPANION_DATA_DIR)
    return join(environment.AGENT_COMPANION_DATA_DIR, 'settings.json');
  if (platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'ESP32 Agent Companion', 'settings.json');
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA?.trim();
    return win32.join(local && win32.isAbsolute(local) ? local : win32.join(home, 'AppData', 'Local'),
      'ESP32 Agent Companion', 'settings.json');
  }
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'esp32-agent-companion', 'settings.json');
}

export function isAgent(value: unknown): value is AgentId {
  return typeof value === 'string' && Object.hasOwn(agents, value);
}

function isState(value: unknown): value is State {
  return value === 'idle' || value === 'working' || value === 'attention' || value === 'complete';
}

export function parseConnection(value: unknown): Connection {
  if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string')
    throw new Error('Invalid settings.json. Open Agent Buddy Settings to recreate it.');
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error('Invalid Settings URL. Open Agent Buddy Settings to recreate it.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search)
    throw new Error('Settings must use a local HTTP loopback URL.');
  const match = /^#token=([0-9a-f]{48})$/.exec(url.hash);
  if (!match?.[1]) throw new Error('Missing Settings token. Open Agent Buddy Settings to recreate it.');
  const token = match[1];
  url.hash = '';
  return {url, token};
}

export async function readConnection(path: string): Promise<Connection> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      throw new Error('Start Agent Buddy. If using a custom data folder, select its settings.json.');
    throw new Error('Cannot read settings.json. Check its path and file permissions.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid settings.json. Open Agent Buddy Settings to recreate it.');
  }
  return parseConnection(value);
}

export function parseStatus(value: unknown): Status {
  if (!value || typeof value !== 'object' || !('state' in value)
    || !isState(value.state)
    || !('badges' in value) || !value.badges || typeof value.badges !== 'object')
    throw new Error('Invalid Agent Buddy status response.');
  const badges = value.badges;
  if (!('roles' in badges) || !badges.roles || typeof badges.roles !== 'object')
    throw new Error('Update Agent Buddy to a version with Stream Deck support.');
  const roles = badges.roles;
  if (!('working' in roles) || !('attention' in roles) || !('complete' in roles)
    || !Array.isArray(roles.working) || !roles.working.every(isAgent)
    || !Array.isArray(roles.attention) || !roles.attention.every(isAgent)
    || !Array.isArray(roles.complete) || !roles.complete.every(isAgent))
    throw new Error('Invalid agent roles in Agent Buddy status.');
  return {
    state: value.state,
    roles: {working: roles.working, attention: roles.attention, complete: roles.complete},
  };
}

export async function fetchStatus(connection: Connection): Promise<Status> {
  let response: Response;
  try {
    response = await fetch(new URL('api/status', connection.url), {
      headers: {'X-Companion-Token': connection.token},
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error('Agent Buddy is offline or not responding. Start the app or companion service.');
  }
  if (response.status === 401)
    throw new Error('Settings token changed. Reopen Agent Buddy Settings and retry.');
  if (!response.ok) throw new Error(`Agent Buddy returned HTTP ${response.status}.`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Invalid Agent Buddy status response.');
  }
  return parseStatus(value);
}

export function stateFor(status: Status, agent: AgentId | 'all'): State {
  if (agent === 'all') {
    if (status.roles.attention.length) return 'attention';
    return status.state;
  }
  if (status.roles.attention.includes(agent)) return 'attention';
  if (status.roles.working.includes(agent)) return 'working';
  if (status.roles.complete.includes(agent)) return 'complete';
  return 'idle';
}

export function settingsUrl(connection: Connection): string {
  const url = new URL(connection.url);
  url.hash = `token=${connection.token}`;
  return url.href;
}

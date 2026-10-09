import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {win32} from 'node:path';
import {agentHomeVariables} from './homes.js';
import {shellQuote} from './commands.js';
import type {AgentContext, AgentLocation, AgentLocations} from './types.js';

// On Windows, agents can also run in WSL distributions. Their hooks run the Windows node.exe
// through WSL interop, so one Windows service gets the events of both. The service edits the
// agents' files in each distribution through \\wsl$\<distribution>.

// The agents that a distribution can have. OpenClaw's plugin cannot reach a Windows named pipe.
const wslCommands = ['copilot', 'claude', 'codex', 'cursor-agent', 'grok', 'hermes', 'openclaw'] as const;

export interface WslProbe {
  home: string;
  // The Windows node.exe, as the distribution sees it: /mnt/c/...
  node?: string;
  // Where the distribution mounts the C: drive, such as /mnt/c/.
  mount?: string;
  env: Record<string, string>;
  commands: string[];
  interop: boolean;
}

const marker = '@@agent-companion:';

// Runs in the distribution's login shell, so the agents' variables and PATH are the user's.
export function probeScript(windowsNode: string): string {
  return [
    `p() { printf '${marker}%s=%s\\n' "$1" "$2"; }`,
    'p home "$HOME"',
    `p node "$(wslpath -u ${shellQuote(windowsNode)} 2>/dev/null)"`,
    `p mount "$(wslpath -u 'C:\\' 2>/dev/null)"`,
    `for v in ${agentHomeVariables.join(' ')}; do eval "p env:$v \\"\\\${$v:-}\\""; done`,
    `for c in ${wslCommands.join(' ')}; do command -v "$c" >/dev/null 2>&1 && p command "$c"; done`,
    // `agent` alone is not Cursor. It counts when the Cursor launcher sits beside it.
    'if ! command -v cursor-agent >/dev/null 2>&1 && command -v agent >/dev/null 2>&1; then',
    '  d=$(dirname "$(command -v agent)")',
    '  if [ -e "$d/cursor-agent" ] || [ -e "$d/cursor-agent.exe" ]; then p command cursor-agent; fi',
    'fi',
    'if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then p interop 1; fi',
    'exit 0',
    '',
  ].join('\n');
}

export function parseProbe(text: string): WslProbe | undefined {
  const probe: WslProbe = {home: '', env: {}, commands: [], interop: false};
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(marker);
    if (start < 0) continue;
    const entry = line.slice(start + marker.length);
    const equals = entry.indexOf('=');
    if (equals < 0) continue;
    const [key, value] = [entry.slice(0, equals), entry.slice(equals + 1)];
    if (key === 'home') probe.home = value;
    else if (key === 'node' && value.startsWith('/')) probe.node = value;
    else if (key === 'mount' && /^\/(?:.*\/)?[a-z]\/?$/i.test(value)) probe.mount = value.replace(/[a-z]\/?$/i, '');
    else if (key.startsWith('env:') && value) probe.env[key.slice(4)] = value;
    else if (key === 'command') probe.commands.push(value);
    else if (key === 'interop') probe.interop = true;
  }
  return probe.home.startsWith('/') ? probe : undefined;
}

// `wsl.exe --list` writes UTF-16 unless WSL_UTF8 is set, and older versions ignore WSL_UTF8.
export function decodeWslOutput(output: Buffer): string {
  const utf16 = output.length >= 2 && (output[0] === 0xff && output[1] === 0xfe
    || output.subarray(0, 64).some((byte, index) => index % 2 === 1 && byte === 0));
  return (utf16 ? output.toString('utf16le') : output.toString('utf8')).replace(/^\uFEFF/, '');
}

// Docker Desktop and Rancher Desktop add distributions that are not the user's.
export function parseDistributions(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.replaceAll('\0', '').trim())
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name) && !/^(docker-desktop|rancher-desktop)/i.test(name));
}

function wslRoot(distribution: string): string {
  return `\\\\wsl$\\${distribution}`;
}

// A path as the distribution sees it, as a path that Windows can open.
export function wslHostPath(distribution: string, probe: Pick<WslProbe, 'mount'>, path: string): string {
  const mount = probe.mount && new RegExp(`^${escape(probe.mount)}([a-z])(/.*)?$`, 'i').exec(path);
  if (mount) return `${mount[1]!.toUpperCase()}:${(mount[2] ?? '/').replaceAll('/', '\\')}`;
  if (path.startsWith('/')) return wslRoot(distribution) + path.replaceAll('/', '\\');
  return path;
}

// A path that Windows opens, as the distribution sees it.
export function wslAgentPath(distribution: string, probe: Pick<WslProbe, 'mount'>, path: string): string {
  for (const root of [wslRoot(distribution), `\\\\wsl.localhost\\${distribution}`]) {
    if (path.toLowerCase() === root.toLowerCase()) return '/';
    if (path.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) return path.slice(root.length).replaceAll('\\', '/');
  }
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (drive && probe.mount) return `${probe.mount}${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}`;
  return path;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The agent context of a distribution: Linux hook commands that run the Windows node.exe and CLI.
export function wslContext(host: AgentContext, distribution: string, probe: WslProbe): AgentContext {
  const hostPath = (path: string) => wslHostPath(distribution, probe, path);
  const env: NodeJS.ProcessEnv = {PATH: '', HOME: probe.home};
  for (const [name, value] of Object.entries(probe.env)) env[name] = value.startsWith('/') ? hostPath(value) : value;
  return {
    home: hostPath(probe.home),
    node: probe.node ?? '',
    cli: host.cli,
    platform: 'linux',
    env,
    dataDir: host.dataDir,
    socketPath: host.socketPath,
    hostPath,
    agentPath: path => wslAgentPath(distribution, probe, path),
  };
}

export type WslRunner = (args: string[], input?: string) => Promise<{status: number; stdout: Buffer}>;

// The Store and MSI versions of WSL put wsl.exe in Program Files. The System32 copy forwards to
// it, and it can fail ("The file cannot be accessed by the system") until the next sign-in.
export function wslExecutable(env: NodeJS.ProcessEnv = process.env,
                              exists: (path: string) => boolean = existsSync): string | undefined {
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return [win32.join(programFiles, 'WSL', 'wsl.exe'), win32.join(root, 'System32', 'wsl.exe')].find(exists);
}

export function runWsl(executable: string): WslRunner {
  return (args, input) => new Promise(resolve => {
    const child = execFile(executable, args, {
      encoding: 'buffer', timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: {...process.env, WSL_UTF8: '1'},
    }, (error, stdout) => resolve({status: error ? 1 : 0, stdout: Buffer.from(stdout ?? [])}));
    // wsl.exe can stop before it reads all of the input.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

const listEveryMs = 15_000;
const probeEveryMs = 5 * 60_000;

interface Distribution {
  running: boolean;
  probe?: WslProbe;
  probedAt?: number;
}

// Knows the distributions and what each one has. It looks only into running distributions, as
// a look into a stopped one starts it. All of the work runs in the background: list() gives what
// is known now.
export class WslLocations implements AgentLocations {
  readonly #host: AgentContext;
  readonly #run: WslRunner;
  readonly #now: () => number;
  #distributions = new Map<string, Distribution>();
  #listedAt = -Infinity;
  #refreshing: Promise<void> | undefined;

  constructor(host: AgentContext, run: WslRunner, now: () => number = Date.now) {
    this.#host = host;
    this.#run = run;
    this.#now = now;
  }

  list(): AgentLocation[] {
    if (this.#now() - this.#listedAt >= listEveryMs) this.refresh().catch(() => undefined);
    return [...this.#distributions].map(([name, distribution]) => this.#location(name, distribution));
  }

  // `all` also starts each stopped distribution to look into it, as an uninstall must.
  refresh(options: {all?: boolean} = {}): Promise<void> {
    if (this.#refreshing && !options.all) return this.#refreshing;
    const work: Promise<void> = (this.#refreshing ?? Promise.resolve())
      .then(() => this.#update(Boolean(options.all)))
      .finally(() => {
        if (this.#refreshing === work) this.#refreshing = undefined;
      });
    this.#refreshing = work;
    return work;
  }

  async #update(all: boolean): Promise<void> {
    this.#listedAt = this.#now();
    const listed = await this.#run(['--list', '--quiet']);
    const names = listed.status === 0 ? parseDistributions(decodeWslOutput(listed.stdout)) : [];
    const running = await this.#run(['--list', '--running', '--quiet']);
    const active = new Set(running.status === 0 ? parseDistributions(decodeWslOutput(running.stdout)) : []);
    const next = new Map<string, Distribution>();
    for (const name of names) {
      const old = this.#distributions.get(name);
      const distribution: Distribution = {...old, running: active.has(name) || all};
      const stale = old?.probedAt === undefined || this.#now() - old.probedAt >= probeEveryMs || !old.running;
      if (distribution.running && stale) {
        const result = await this.#run(['--distribution', name, '--exec', 'sh', '-l', '-s'], probeScript(this.#host.node));
        const probe = result.status === 0 ? parseProbe(result.stdout.toString('utf8')) : undefined;
        if (probe) Object.assign(distribution, {probe, probedAt: this.#now()});
      }
      next.set(name, distribution);
    }
    this.#distributions = next;
  }

  #location(name: string, distribution: Distribution): AgentLocation {
    const {probe} = distribution;
    const problem = !probe ? undefined
      : !probe.interop || !probe.node
        ? `Windows interop is off in ${name}, so its agents cannot start the companion service. `
          + 'Turn on [interop] enabled in /etc/wsl.conf, then run wsl --shutdown.'
        : undefined;
    return {
      id: `wsl:${name}`,
      name: `WSL: ${name}`,
      running: distribution.running,
      commands: probe?.commands ?? [],
      ctx: probe ? wslContext(this.#host, name, probe) : undefined,
      problem,
    };
  }
}

// A file that Windows writes in a distribution gets the default mode, so a config file that only
// its user could read would become readable to all. Set the mode again from in the distribution.
export async function restoreWslMode(path: string, mode: number, platform = process.platform): Promise<void> {
  const file = wslFile(path, platform);
  if (!file) return;
  await file.run(['--distribution', file.distribution, '--exec', 'chmod', (mode & 0o777).toString(8), file.path]);
}

// The Linux mode of a file in a distribution. Windows reports 0666 for every file there.
export async function wslFileMode(path: string, platform = process.platform): Promise<number | undefined> {
  const file = wslFile(path, platform);
  if (!file) return undefined;
  const result = await file.run(['--distribution', file.distribution, '--exec', 'stat', '-L', '-c', '%a', file.path]);
  const mode = result.status === 0 ? Number.parseInt(result.stdout.toString('utf8').trim(), 8) : Number.NaN;
  // Unknown: a mode only the user can use is safe for any config file.
  return Number.isInteger(mode) ? mode & 0o777 : 0o600;
}

export function parseWslPath(path: string): {distribution: string; path: string} | undefined {
  const match = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)$/i.exec(path);
  return match ? {distribution: match[1]!, path: match[2]!.replaceAll('\\', '/')} : undefined;
}

function wslFile(path: string, platform: NodeJS.Platform) {
  if (platform !== 'win32') return undefined;
  const file = parseWslPath(path);
  const wsl = file && wslExecutable();
  return file && wsl ? {...file, run: runWsl(wsl)} : undefined;
}

import {execFile} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {posix, win32} from 'node:path';
import type {AgentContext} from './types.js';

// A copy of the Windows environment (for example `{...process.env}`) keeps the original
// spelling of each name, and Windows spells it `Path`.
export function environmentValue(env: NodeJS.ProcessEnv, name: string,
                                 platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined || platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
                               exists: (path: string) => boolean = existsSync): string | undefined {
  const windows = platform === 'win32';
  const path = environmentValue(env, 'PATH', platform) ?? environmentValue(process.env, 'PATH', platform) ?? '';
  // npm installs agents as `.cmd` shims, so a bare name must also try each PATHEXT suffix.
  const suffixes = windows && !win32.extname(name)
    ? (environmentValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of path.split(windows ? ';' : ':').filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = (windows ? win32 : posix).join(directory.replace(/^"(.*)"$/, '$1'), name + suffix);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface Invocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

// Node cannot start a Windows `.cmd` or `.bat` file without a shell, so those run through cmd.exe.
export function commandInvocation(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env,
                                  platform: NodeJS.Platform = process.platform): Invocation {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return {file: executable, args};
  const line = [executable, ...args].map(cmdQuote).join(' ');
  return {file: environmentValue(env, 'ComSpec', platform) ?? 'cmd.exe',
          args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true};
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function hasCommand(name: string, ctx: AgentContext): boolean {
  return Boolean(findExecutable(name, ctx.env, ctx.platform));
}

// Status requests arrive every second, so each executable's version is probed once per change.
// The probe runs in the background: a cold start of some agents takes more than a second,
// and the service must not wait for it. Until it finishes, the version is unknown.
const versions = new Map<string, string | undefined>();
const probing = new Set<string>();
const versionTimeoutMs = 5000;

export function versionOf(command: string, ctx: AgentContext): string | undefined {
  const executable = findExecutable(command, ctx.env, ctx.platform);
  if (!executable) return undefined;
  let key: string;
  try {
    const details = statSync(executable);
    key = `${executable}:${details.mtimeMs}:${details.size}`;
  } catch {
    return undefined;
  }
  if (versions.has(key)) return versions.get(key);
  if (!probing.has(key)) {
    probing.add(key);
    void probeVersion(executable, ctx).then(version => {
      versions.set(key, version);
      probing.delete(key);
    });
  }
  return undefined;
}

function probeVersion(executable: string, ctx: AgentContext): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      const run = commandInvocation(executable, ['--version'], ctx.env, ctx.platform);
      const child = execFile(run.file, run.args, {encoding: 'utf8', timeout: versionTimeoutMs, env: ctx.env,
                                                  windowsHide: true,
                                                  windowsVerbatimArguments: run.windowsVerbatimArguments},
        (error, stdout) => resolve(error ? undefined : stdout.trim().split(/\r?\n/)[0]?.replace(/\.$/, '') || undefined));
      child.stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Grok and Hermes read a hook's command line. On Windows, Hermes splits it into arguments itself,
// where a double-quoted path with forward slashes works.
export function shellHookCommand(ctx: Pick<AgentContext, 'node' | 'cli' | 'platform'>, agent: string,
                                 event: string): string {
  const quote = ctx.platform === 'win32' ? (path: string) => `"${path.replaceAll('\\', '/')}"` : shellQuote;
  return `${quote(ctx.node)} ${quote(ctx.cli)} hook ${agent} ${event}`;
}

// On Windows, Grok runs a hook's command line in PowerShell. There a quoted path is only a string
// until `&` runs it.
export function powershellHookCommand(ctx: Pick<AgentContext, 'node' | 'cli'>, agent: string, event: string): string {
  const quote = (path: string) => `'${path.replaceAll('\\', '/').replaceAll("'", "''")}'`;
  return `& ${quote(ctx.node)} ${quote(ctx.cli)} hook ${agent} ${event}`;
}

// Windows paths match without regard to case or slash style.
export function samePath(first: string, second: string): boolean {
  const normal = (path: string) => /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;
  return normal(first) === normal(second);
}

export function codexQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The CLI of any companion install: a clone of the repository, or the copy the desktop app
// installs. Installing from one must replace the hooks of the other, not add a second set.
// Codex's quotes double each backslash of a Windows path, so a separator can be two characters.
const companionCli = /[\\/]+daemon[\\/]+dist[\\/]+src[\\/]+cli\.js$/;

export function isCompanionCli(path: unknown, ctx: Pick<AgentContext, 'cli'>): boolean {
  return typeof path === 'string' && (path === ctx.cli || companionCli.test(path));
}

// A hook command line, quoted for a shell or for Codex, that runs a companion CLI's `hook AGENT`.
export function isCompanionHookCommand(command: string, agent: string, ctx: Pick<AgentContext, 'cli'>): boolean {
  // Windows shell hooks write the CLI path with forward slashes.
  const cli = [ctx.cli, ctx.cli.replaceAll('\\', '/')];
  if (cli.some(path => command.includes(path)) && command.includes(`hook ${agent}`)) return true;
  return new RegExp(`[\\\\/]+daemon[\\\\/]+dist[\\\\/]+src[\\\\/]+cli\\.js['"]? hook ${agent}(\\s|$)`).test(command);
}

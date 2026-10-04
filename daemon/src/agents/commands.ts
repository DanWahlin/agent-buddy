import {execFileSync} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentContext} from './types.js';

export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? process.env.PATH ?? '').split(':').filter(Boolean)) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// Status requests arrive every second, so each executable's version is probed once per change.
const versions = new Map<string, string | undefined>();

export function versionOf(command: string, ctx: AgentContext): string | undefined {
  const executable = findExecutable(command, ctx.env);
  if (!executable) return undefined;
  let key: string;
  try {
    const details = statSync(executable);
    key = `${executable}:${details.mtimeMs}:${details.size}`;
  } catch {
    return undefined;
  }
  if (versions.has(key)) return versions.get(key);
  const version = probeVersion(executable, ctx);
  versions.set(key, version);
  return version;
}

function probeVersion(executable: string, ctx: AgentContext): string | undefined {
  try {
    return execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 1000,
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)[0]?.replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function codexQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The CLI of any companion install: a clone of the repository, or the copy the desktop app
// installs. Installing from one must replace the hooks of the other, not add a second set.
const companionCli = /[\\/]daemon[\\/]dist[\\/]src[\\/]cli\.js$/;

export function isCompanionCli(path: unknown, ctx: Pick<AgentContext, 'cli'>): boolean {
  return typeof path === 'string' && (path === ctx.cli || companionCli.test(path));
}

// A hook command line, quoted for a shell or for Codex, that runs a companion CLI's `hook AGENT`.
export function isCompanionHookCommand(command: string, agent: string, ctx: Pick<AgentContext, 'cli'>): boolean {
  if (command.includes(ctx.cli) && command.includes(`hook ${agent}`)) return true;
  return new RegExp(`[\\\\/]daemon[\\\\/]dist[\\\\/]src[\\\\/]cli\\.js['"]? hook ${agent}(\\s|$)`).test(command);
}

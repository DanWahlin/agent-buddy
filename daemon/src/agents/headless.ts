import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import type {AgentId} from './types.js';

// An agent started with a one-shot prompt (copilot -p, claude -p, codex exec, grok -p, hermes -z) has
// no one to answer permission or question prompts. Copilot still fires its notification hook and then
// denies the request on its own, so those notifications must not put the device in Needs attention.

export interface ProcessInfo {
  ppid: number;
  args: string[];
  // Whether the process has a controlling terminal.
  tty: boolean;
}

interface HeadlessRule {
  // Executable names, or package paths for agents launched through node.
  programs: string[];
  headless: (args: string[], info: ProcessInfo) => boolean;
}

const rules: Partial<Record<AgentId, HeadlessRule>> = {
  copilot: {programs: ['copilot', '@github/copilot'], headless: args => promptFlag(args, ['-p', '--prompt'])},
  // SDK hosts run claude --print too, but pass --permission-prompt-tool when they show approvals to a person.
  claude: {
    programs: ['claude', '@anthropic-ai/claude-code'],
    headless: args => promptFlag(args, ['-p', '--print'])
      && !args.some(arg => arg === '--permission-prompt-tool' || arg.startsWith('--permission-prompt-tool=')),
  },
  codex: {programs: ['codex', '@openai/codex'], headless: args => ['exec', 'e'].includes(args.find(arg => !arg.startsWith('-')) ?? '')},
  grok: {programs: ['grok'], headless: args => promptFlag(args, ['-p', '--single', '--prompt-file', '--prompt-json'])},
  // hermes chat -q seeds an interactive session on a terminal and answers once without one.
  hermes: {
    programs: ['hermes'],
    headless: (args, info) => promptFlag(args, ['-z', '--oneshot'])
      || (promptFlag(args, ['-q', '--query', '--query-file']) && (promptFlag(args, ['-Q', '--quiet']) || !info.tty)),
  },
};

// Flags come before any prompt text, and an explicit interactive flag wins, so words inside an
// interactive session's initial prompt can't be mistaken for -p.
function promptFlag(args: string[], flags: string[]): boolean {
  for (const arg of args) {
    if (arg === '-i' || arg === '--interactive' || arg.startsWith('--interactive=')) return false;
    if (flags.includes(arg) || flags.some(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`))) return true;
  }
  return false;
}

export function readProcess(pid: number): ProcessInfo | undefined {
  try {
    if (process.platform === 'linux') {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // After "pid (comm) ": state, ppid, pgrp, session, tty_nr, ...
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(fields[1]);
      return Number.isInteger(ppid) ? {ppid, args, tty: Number(fields[4]) !== 0} : undefined;
    }
    if (process.platform === 'win32') return undefined;
    const output = execFileSync('ps', ['-o', 'ppid=,tty=,args=', '-p', String(pid)],
                                {encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    const match = /^(\d+)\s+(\S+)\s+([\s\S]*)$/.exec(output);
    return match ? {ppid: Number(match[1]), tty: !/^\?+$/.test(match[2]!), args: match[3]!.split(/\s+/)} : undefined;
  } catch {
    return undefined;
  }
}

function isProgram(arg: string, programs: string[]): boolean {
  const name = basename(arg).replace(/\.(exe|cmd|js|mjs)$/i, '');
  return programs.some(program => program.includes('/') ? arg.includes(`/${program}/`) : name === program);
}

// Hermes relaunches itself as python3 -c "…; sys.argv = ['…/hermes', '-z', …]; runpy.run_path(…)",
// so its real arguments are inside the code string.
export function relaunchedArgs(args: string[]): string[] {
  const match = /\bsys\.argv\s*=\s*\[(.*?)\];\s*runpy\./s.exec(args.join(' '));
  if (!match) return args;
  return [...match[1]!.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map(item => (item[1] ?? item[2]!).replace(/\\(.)/g, '$1'));
}

// Hooks may run under a shell, so look a few processes up for the agent itself.
export function agentRunsHeadless(agent: AgentId, pid = process.ppid,
                                  read: (pid: number) => ProcessInfo | undefined = readProcess): boolean {
  const rule = rules[agent];
  if (!rule) return false;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    const info = read(pid);
    if (!info) return false;
    const args = relaunchedArgs(info.args);
    const index = args.slice(0, 2).findIndex(arg => isProgram(arg, rule.programs));
    if (index >= 0) return rule.headless(args.slice(index + 1), info);
    pid = info.ppid;
  }
  return false;
}

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import type {AgentId} from './types.js';

// An agent started with a one-shot prompt (copilot -p, claude -p, codex exec) has no one to answer
// permission or question prompts. Copilot still fires its notification hook and then denies the
// request on its own, so those notifications must not put the device in Needs attention.

export interface ProcessInfo {
  ppid: number;
  args: string[];
}

interface HeadlessRule {
  // Executable names, or package paths for agents launched through node.
  programs: string[];
  headless: (args: string[]) => boolean;
}

const rules: Partial<Record<AgentId, HeadlessRule>> = {
  copilot: {programs: ['copilot', '@github/copilot'], headless: args => promptFlag(args, ['-p', '--prompt'])},
  claude: {programs: ['claude', '@anthropic-ai/claude-code'], headless: args => promptFlag(args, ['-p', '--print'])},
  codex: {programs: ['codex', '@openai/codex'], headless: args => ['exec', 'e'].includes(args.find(arg => !arg.startsWith('-')) ?? '')},
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
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return Number.isInteger(ppid) ? {ppid, args} : undefined;
    }
    if (process.platform === 'win32') return undefined;
    const output = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)],
                                {encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    const match = /^(\d+)\s+([\s\S]*)$/.exec(output);
    return match ? {ppid: Number(match[1]), args: match[2]!.split(/\s+/)} : undefined;
  } catch {
    return undefined;
  }
}

function isProgram(arg: string, programs: string[]): boolean {
  const name = basename(arg).replace(/\.(exe|cmd|js|mjs)$/i, '');
  return programs.some(program => program.includes('/') ? arg.includes(`/${program}/`) : name === program);
}

// Hooks may run under a shell, so look a few processes up for the agent itself.
export function agentRunsHeadless(agent: AgentId, pid = process.ppid,
                                  read: (pid: number) => ProcessInfo | undefined = readProcess): boolean {
  const rule = rules[agent];
  if (!rule) return false;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    const info = read(pid);
    if (!info) return false;
    const index = info.args.slice(0, 2).findIndex(arg => isProgram(arg, rule.programs));
    if (index >= 0) return rule.headless(info.args.slice(index + 1));
    pid = info.ppid;
  }
  return false;
}

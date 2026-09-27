import assert from 'node:assert/strict';
import test from 'node:test';
import {agentRunsHeadless, readProcess, type ProcessInfo} from '../src/agents/headless.js';
import type {AgentId} from '../src/agents/types.js';

function tree(processes: Record<number, Omit<ProcessInfo, 'tty'> & {tty?: boolean}>) {
  return (pid: number) => processes[pid] && {tty: true, ...processes[pid]};
}

function runs(agent: AgentId, args: string[], tty = true): boolean {
  return agentRunsHeadless(agent, 10, tree({10: {ppid: 1, args, tty}}));
}

test('one-shot agent runs are headless, interactive sessions are not', () => {
  assert.equal(runs('copilot', ['copilot', '--allow-all-tools', '-p', 'Build the app']), true);
  assert.equal(runs('copilot', ['copilot', '--prompt=Build the app']), true);
  assert.equal(runs('copilot', ['copilot', '--yolo']), false);
  assert.equal(runs('copilot', ['copilot', '--resume=abc']), false);
  // The Copilot app's SDK server shows approvals in its own window.
  assert.equal(runs('copilot', ['copilot', '--server', '--stdio'], false), false);
  // Words in an interactive session's initial prompt aren't flags.
  assert.equal(runs('copilot', ['copilot', '-i', 'list', 'files', 'with', 'ls', '-p']), false);
  assert.equal(runs('copilot', ['node', '/usr/lib/node_modules/@github/copilot/index.js', '-p', 'hi']), true);

  assert.equal(runs('claude', ['claude', '--print', 'hi']), true);
  assert.equal(runs('claude', ['claude']), false);
  // SDK hosts that route approvals to a person pass a permission prompt tool.
  assert.equal(runs('claude', ['claude', '--print', '--permission-prompt-tool', 'stdio'], false), false);

  assert.equal(runs('codex', ['codex', 'exec', 'fix it']), true);
  assert.equal(runs('codex', ['codex', '-p', 'work-profile']), false);

  assert.equal(runs('grok', ['grok', '-p', 'summarize']), true);
  assert.equal(runs('grok', ['grok', '--prompt-file', 'task.md']), true);
  assert.equal(runs('grok', ['grok', 'fix the bug']), false);

  assert.equal(runs('hermes', ['python3', '/opt/hermes/bin/hermes', '-z', 'hi']), true);
  assert.equal(runs('hermes', ['hermes', 'chat', '-q', 'hi', '--oneshot']), true);
  assert.equal(runs('hermes', ['hermes', 'chat', '-q', 'hi', '-Q']), true);
  // On a terminal, chat -q seeds an interactive session; without one it answers once.
  assert.equal(runs('hermes', ['hermes', 'chat', '-q', 'hi'], true), false);
  assert.equal(runs('hermes', ['hermes', 'chat', '-q', 'hi'], false), true);
  assert.equal(runs('hermes', ['hermes', 'chat']), false);
});

test('the agent is found through a wrapping shell, and unknown cases stay interactive', () => {
  const processes = tree({
    30: {ppid: 20, args: ['/bin/sh', '-c', 'node cli.js hook copilot notification']},
    20: {ppid: 1, args: ['/opt/homebrew/bin/copilot', '-p', 'Plan it']},
  });
  assert.equal(agentRunsHeadless('copilot', 30, processes), true);
  assert.equal(agentRunsHeadless('copilot', 99, processes), false);
  assert.equal(agentRunsHeadless('openclaw', 20, processes), false);
  assert.equal(agentRunsHeadless('copilot', 30, tree({30: {ppid: 1, args: ['/bin/zsh']}})), false);
});

test('reads this process from the operating system', {skip: process.platform === 'win32'}, () => {
  const self = readProcess(process.pid);
  assert.equal(self?.ppid, process.ppid);
  assert.equal(typeof self?.tty, 'boolean');
  assert.ok(self?.args.some(arg => arg.includes('node')));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {agentRunsHeadless, readProcess, type ProcessInfo} from '../src/agents/headless.js';

function tree(processes: Record<number, ProcessInfo>) {
  return (pid: number) => processes[pid];
}

test('one-shot agent runs are headless, interactive sessions are not', () => {
  const run = (args: string[]) => agentRunsHeadless('copilot', 10, tree({10: {ppid: 1, args}}));
  assert.equal(run(['copilot', '--allow-all-tools', '-p', 'Build the app']), true);
  assert.equal(run(['copilot', '--prompt=Build the app']), true);
  assert.equal(run(['copilot', '--yolo']), false);
  assert.equal(run(['copilot', '--resume=abc']), false);
  // Words in an interactive session's initial prompt aren't flags.
  assert.equal(run(['copilot', '-i', 'list', 'files', 'with', 'ls', '-p']), false);
  assert.equal(run(['node', '/usr/lib/node_modules/@github/copilot/index.js', '-p', 'hi']), true);
  assert.equal(agentRunsHeadless('claude', 10, tree({10: {ppid: 1, args: ['claude', '--print', 'hi']}})), true);
  assert.equal(agentRunsHeadless('claude', 10, tree({10: {ppid: 1, args: ['claude']}})), false);
  assert.equal(agentRunsHeadless('codex', 10, tree({10: {ppid: 1, args: ['codex', 'exec', 'fix it']}})), true);
  assert.equal(agentRunsHeadless('codex', 10, tree({10: {ppid: 1, args: ['codex', '--model', 'x']}})), false);
});

test('the agent is found through a wrapping shell, and unknown cases stay interactive', () => {
  const processes = tree({
    30: {ppid: 20, args: ['/bin/sh', '-c', 'node cli.js hook copilot notification']},
    20: {ppid: 1, args: ['/opt/homebrew/bin/copilot', '-p', 'Plan it']},
  });
  assert.equal(agentRunsHeadless('copilot', 30, processes), true);
  assert.equal(agentRunsHeadless('copilot', 99, processes), false);
  assert.equal(agentRunsHeadless('grok', 20, processes), false);
  assert.equal(agentRunsHeadless('copilot', 30, tree({30: {ppid: 1, args: ['/bin/zsh']}})), false);
});

test('reads this process from the operating system', {skip: process.platform === 'win32'}, () => {
  const self = readProcess(process.pid);
  assert.equal(self?.ppid, process.ppid);
  assert.ok(self?.args.some(arg => arg.includes('node')));
});

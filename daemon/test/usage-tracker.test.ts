import assert from 'node:assert/strict';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  compactNumber, deviceUsageLines, formatAic, formatTokens, isUsageWindow, shouldSendUsage, usageLines, usagePacket, UsageTracker,
} from '../src/usage-tracker.js';

// Local times in the real current month, since the files written here are new: the windows start
// at local midnight and the local 1st of the month.
const year = new Date().getFullYear();
const month = new Date().getMonth();
const now = new Date(year, month, 15, 12, 0).getTime();
const today = (hour: number) => new Date(year, month, 15, hour).toISOString();
const earlierThisMonth = new Date(year, month, 3, 9).toISOString();
const lastMonth = new Date(year, month - 1, 28, 9).toISOString();

const copilotLine = (timestamp: string, nanoAiu: number, type = 'session.usage_checkpoint') =>
  JSON.stringify({type, data: {totalNanoAiu: nanoAiu, totalPremiumRequests: 1}, id: 'x', timestamp}) + '\n';
const copilotStop = (timestamp: string, nanoAiu: number, models: Record<string, [number, number, number]>) =>
  JSON.stringify({type: 'session.shutdown', timestamp, data: {totalNanoAiu: nanoAiu, modelMetrics:
    Object.fromEntries(Object.entries(models).map(([model, [input, cacheRead, output]]) =>
      [model, {usage: {inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, cacheWriteTokens: 5}}]))}})
  + '\n';
const claudeLine = (timestamp: string, id: string, input: number, output: number, cacheRead = 1000) =>
  JSON.stringify({type: 'assistant', timestamp, message: {id, usage: {
    input_tokens: input, cache_creation_input_tokens: 10, cache_read_input_tokens: cacheRead, output_tokens: output,
  }}}) + '\n';
const codexLine = (timestamp: string, input: number, cached: number, output: number) =>
  JSON.stringify({timestamp, type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {
    input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output,
  }}}}) + '\n';

async function withHome(run: (home: string, cache: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    await run(home, join(home, 'state', 'usage-cache.json'));
  } finally {
    await rm(home, {recursive: true, force: true});
  }
}

test('Copilot AI credits come from running totals, split by window', async () => {
  await withHome(async (home, cachePath) => {
    const dir = join(home, '.copilot', 'session-state', 'session-a');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'events.jsonl'),
      '{"type":"user.message","data":{"content":"mentions totalNanoAiu in text"},"timestamp":"' + earlierThisMonth + '"}\n'
      + copilotLine(lastMonth, 100e9)
      + copilotLine(earlierThisMonth, 250e9)
      + copilotLine(today(9), 400e9)
      + copilotLine(today(10), 400e9, 'session.shutdown')
      + copilotLine(today(11), 1402.4e9));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    assert.equal(await tracker.refresh(), true);
    assert.deepEqual(tracker.totals('today'), {aic: 1152.4, tokens: null});
    assert.deepEqual(tracker.totals('month'), {aic: 1302.4, tokens: null});
    assert.deepEqual(tracker.totals('active'), {aic: null, tokens: null});
    assert.deepEqual(tracker.totals('active', ['copilot:session-a']), {aic: 1402.4, tokens: null});
  });
});

test('Copilot gives AI credits but no tokens, since its token counts are not complete', async () => {
  await withHome(async (home, cachePath) => {
    const dir = join(home, '.copilot', 'session-state', 'session-b');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'events.jsonl'),
      copilotLine(today(9), 200e9)
      + copilotStop(today(10), 300e9, {'model-a': [30_000, 25_000, 800]}));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    await tracker.refresh();
    assert.deepEqual(tracker.totals('today'), {aic: 300, tokens: null});
    assert.deepEqual(usageLines(tracker.totals('today')), ['AIC: 300']);
  });
});

test('a version 2 cache keeps its AI credits and drops the old Copilot tokens', async () => {
  await withHome(async (home, cachePath) => {
    const dir = join(home, '.copilot', 'session-state', 'session-c');
    const file = join(dir, 'events.jsonl');
    await mkdir(dir, {recursive: true});
    await mkdir(join(home, 'state'), {recursive: true});
    const text = copilotLine(today(9), 7e9);
    await writeFile(file, text);
    await writeFile(cachePath, JSON.stringify({version: 2, files: {[file]: {
      source: 'copilot', session: 'session-c', offset: Buffer.byteLength(text), last: 7e9,
      entries: [[Date.parse(today(9)), 7e9]], tokenLast: 900, tokenEntries: [[Date.parse(today(9)), 900]],
    }}}));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    assert.equal(await tracker.refresh(), false);
    assert.deepEqual(tracker.totals('today'), {aic: 7, tokens: null});
  });
});

test('reads only what was added, keeps a partial line for later, and resumes from its cache', async () => {
  await withHome(async (home, cachePath) => {
    const dir = join(home, '.copilot', 'session-state', 'session-b');
    const file = join(dir, 'events.jsonl');
    await mkdir(dir, {recursive: true});
    const whole = copilotLine(today(8), 5e9);
    const next = copilotLine(today(9), 9e9);
    await writeFile(file, whole + next.slice(0, 20));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    await tracker.refresh();
    assert.equal(tracker.totals('today').aic, 5);
    assert.equal(await tracker.refresh(), false);
    await appendFile(file, next.slice(20));
    assert.equal(await tracker.refresh(), true);
    assert.equal(tracker.totals('today').aic, 9);

    const restarted = new UsageTracker({home, cachePath, now: () => now});
    assert.equal(await restarted.refresh(), false);
    assert.equal(restarted.totals('today').aic, 9);
    // A file that shrank was replaced, so it is read again from the start.
    await writeFile(file, copilotLine(today(10), 2e9));
    await restarted.refresh();
    assert.equal(restarted.totals('today').aic, 2);
  });
});

test('Claude tokens count input, cache writes and output once per message, across files', async () => {
  await withHome(async (home, cachePath) => {
    const project = join(home, '.claude', 'projects', '-Users-me-app');
    await mkdir(join(project, 'claude-a', 'subagents'), {recursive: true});
    await writeFile(join(project, 'claude-a.jsonl'),
      claudeLine(today(9), 'msg_1', 100, 40)
      + claudeLine(today(9), 'msg_1', 100, 40)
      + claudeLine(today(9), 'msg_2', 5, 15)
      + claudeLine(lastMonth, 'msg_0', 1000, 1000));
    // A resumed session repeats msg_1; a subagent adds its own message.
    await writeFile(join(project, 'claude-b.jsonl'), claudeLine(today(10), 'msg_1', 100, 40));
    await writeFile(join(project, 'claude-a', 'subagents', 'agent-1.jsonl'), claudeLine(today(10), 'msg_3', 1, 2));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    await tracker.refresh();
    assert.deepEqual(tracker.totals('today'), {aic: null, tokens: 150 + 30 + 13});
    assert.deepEqual(tracker.totals('active', ['claude:claude-b']), {aic: null, tokens: 150});
  });
});

test('Codex tokens leave cached input out of its running totals', async () => {
  await withHome(async (home, cachePath) => {
    const day = join(home, '.codex', 'sessions', String(year), String(month + 1).padStart(2, '0'), '15');
    await mkdir(day, {recursive: true});
    await writeFile(join(day, 'rollout-2026-10-15T08-00-00-0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000.jsonl'),
      codexLine(today(8), 1000, 400, 50)
      + JSON.stringify({timestamp: today(8), type: 'event_msg', payload: {type: 'token_count', info: null}}) + '\n'
      + codexLine(today(9), 3000, 1400, 150));
    const tracker = new UsageTracker({home, cachePath, now: () => now});
    await tracker.refresh();
    assert.deepEqual(tracker.totals('today'), {aic: null, tokens: 1750});
    assert.deepEqual(tracker.totals('active', ['codex:0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000']), {aic: null, tokens: 1750});

    // A session that started months ago and is still in use counts what it used today.
    const old = join(home, '.codex', 'sessions', String(year - 1), '01', '02');
    await mkdir(old, {recursive: true});
    await writeFile(join(old, 'rollout-old-0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001.jsonl'),
      codexLine(lastMonth, 500, 0, 0) + codexLine(today(10), 800, 100, 50));
    await tracker.refresh();
    assert.deepEqual(tracker.totals('today'), {aic: null, tokens: 1750 + 250});
  });
});

test('numbers stay short enough for the bottom of the screen', () => {
  assert.equal(formatAic(0.04), '0');
  assert.equal(formatAic(2.46), '2.5');
  assert.equal(formatAic(902.06), '902');
  assert.equal(formatAic(26458.4), '26,458');
  assert.equal(formatAic(999_999.4), '999,999');
  assert.equal(formatAic(1_234_567), '1.2M');
  assert.equal(formatTokens(845), '845');
  assert.equal(formatTokens(12_400), '12.4K');
  assert.equal(formatTokens(845_000), '845K');
  assert.equal(formatTokens(999_600), '1M');
  assert.equal(compactNumber(12_400_000), '12.4M');
  assert.equal(compactNumber(3_000_000_000), '3B');
  assert.deepEqual(usageLines({aic: 902, tokens: 1_200_000}), ['AIC: 902', 'Tokens: 1.2M']);
  assert.deepEqual(usageLines({aic: null, tokens: null}), []);
  assert.deepEqual(usageLines({aic: 902, tokens: null}), ['AIC: 902']);
  assert.deepEqual(usageLines({aic: null, tokens: 845}), ['Tokens: 845']);
  const totals = {aic: 902, tokens: 1_200_000};
  assert.deepEqual(deviceUsageLines(totals, {copilot: true, others: true}), ['AIC: 902']);
  assert.deepEqual(deviceUsageLines(totals, {copilot: false, others: true}), ['Tokens: 1.2M']);
  assert.deepEqual(deviceUsageLines(totals, {copilot: false, others: false}), []);
  assert.deepEqual(deviceUsageLines({aic: null, tokens: null}, {copilot: true, others: false}), ['AIC: 0']);
  assert.equal(usagePacket(['AIC: 902', 'Tokens: 1.2M']), '$AIC: 902|Tokens: 1.2M\n');
  assert.equal(usagePacket([]), '$\n');
  assert.equal(shouldSendUsage(7), false);
  assert.equal(shouldSendUsage(8), true);
  assert.equal(isUsageWindow('month'), true);
  assert.equal(isUsageWindow('year'), false);
});

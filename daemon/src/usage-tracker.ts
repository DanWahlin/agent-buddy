import {mkdir, open, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {usageCachePath} from './paths.js';

// How far back usage counts: since local midnight, since the 1st of the month, or only the
// sessions that are active now (each one in full).
export const usageWindows = ['today', 'month', 'active'] as const;
export type UsageWindow = typeof usageWindows[number];

export function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === 'string' && (usageWindows as readonly string[]).includes(value);
}

// AI credits are GitHub Copilot's unit. Tokens come from all the agents; Copilot writes its
// tokens only when a session stops, so they lag its AI credits. Null when nothing counts.
export interface UsageTotals {
  aic: number | null;
  tokens: number | null;
}

type UsageSource = 'copilot' | 'claude' | 'codex';

// One transcript, read up to `offset`. Each entry is [time ms, amount, message id]; Copilot and
// Codex write running totals, so their entries are the increases and `last` is the latest total.
interface FileRecord {
  source: UsageSource;
  session: string;
  offset: number;
  last: number;
  entries: Array<[number, number, string?]>;
}

interface Candidate {
  path: string;
  source: UsageSource;
  session: string;
  size: number;
}

export interface UsageTrackerOptions {
  home?: string;
  cachePath?: string;
  now?: () => number;
}

// A new version reads the transcripts again, once. Version 2 also held Copilot tokens, which
// are no longer counted; the load removes them, and keeps the rest.
const CACHE_VERSION = 2;
const CHUNK_BYTES = 4 << 20;
// Usage lines are a few KB; a line longer than this is a big tool result, not usage.
const MAX_LINE_BYTES = 16 << 20;
const NEEDLES: Record<UsageSource, Buffer> = {
  copilot: Buffer.from('totalNanoAiu'),
  claude: Buffer.from('"usage"'),
  codex: Buffer.from('"token_count"'),
};
const UUID_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Reads the agents' own session logs, only the bytes added since the last read, so a 6 GB
// Copilot log is read once. The positions are saved, so a restart does not read it again.
export class UsageTracker {
  readonly #home: string;
  readonly #cachePath: string;
  readonly #now: () => number;
  #files = new Map<string, FileRecord>();
  #loaded = false;
  #busy: Promise<boolean> | null = null;

  constructor(options: UsageTrackerOptions = {}) {
    this.#home = options.home ?? homedir();
    this.#cachePath = options.cachePath ?? usageCachePath();
    this.#now = options.now ?? Date.now;
  }

  // Reads what is new; true when any total may have changed.
  refresh(activeSessions: readonly string[] = []): Promise<boolean> {
    this.#busy ??= this.#refresh(new Set(activeSessions)).finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  totals(window: UsageWindow, activeSessions: readonly string[] = []): UsageTotals {
    const now = new Date(this.#now());
    const start = window === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : window === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : 0;
    const active = new Set(activeSessions);
    let aic: number | null = null;
    let tokens: number | null = null;
    const counted = new Set<string>();
    for (const record of this.#files.values()) {
      if (window === 'active' && !active.has(`${record.source}:${record.session}`)) continue;
      let sum = 0;
      let used = false;
      for (const [time, amount, id] of record.entries) {
        if (time < start) continue;
        // A resumed or forked Claude session copies earlier messages into its new file.
        if (id) {
          if (counted.has(id)) continue;
          counted.add(id);
        }
        sum += amount;
        used = true;
      }
      if (!used) continue;
      if (record.source === 'copilot') aic = (aic ?? 0) + sum / 1e9;
      else tokens = (tokens ?? 0) + sum;
    }
    return {aic, tokens};
  }

  async #refresh(active: Set<string>): Promise<boolean> {
    if (!this.#loaded) await this.#load();
    const now = new Date(this.#now());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const candidates = await this.#candidates(monthStart, active);
    let changed = false;
    const keep = new Set(candidates.map(candidate => candidate.path));
    for (const path of this.#files.keys()) {
      if (!keep.has(path)) {
        this.#files.delete(path);
        changed = true;
      }
    }
    for (const candidate of candidates) {
      let record = this.#files.get(candidate.path);
      // A shorter file was replaced, not appended to; read it again from the start.
      if (!record || record.offset > candidate.size || record.source !== candidate.source) {
        record = {source: candidate.source, session: candidate.session, offset: 0, last: 0, entries: []};
        this.#files.set(candidate.path, record);
        changed = true;
      }
      if (record.offset === candidate.size) continue;
      try {
        if (await readUsage(candidate.path, record, candidate.size)) changed = true;
      } catch (error) {
        console.error(`[usage] ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (changed) await this.#save().catch(error =>
      console.error(`[usage] ${error instanceof Error ? error.message : String(error)}`));
    return changed;
  }

  // Transcripts changed this month, and any older one whose session is still active.
  async #candidates(monthStart: number, active: Set<string>): Promise<Candidate[]> {
    const found: Candidate[] = [];
    const consider = async (path: string, source: UsageSource, session: string): Promise<void> => {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return;
      if (info.mtimeMs >= monthStart || active.has(`${source}:${session}`))
        found.push({path, source, session, size: info.size});
    };
    const copilot = join(this.#home, '.copilot', 'session-state');
    for (const session of await names(copilot))
      await consider(join(copilot, session, 'events.jsonl'), 'copilot', session);
    const claude = join(this.#home, '.claude', 'projects');
    for (const project of await names(claude)) {
      const projectDir = join(claude, project);
      for (const entry of await names(projectDir)) {
        if (entry.endsWith('.jsonl')) {
          await consider(join(projectDir, entry), 'claude', entry.slice(0, -'.jsonl'.length));
          continue;
        }
        // Subagents keep their own transcripts beside the session's.
        const subagents = join(projectDir, entry, 'subagents');
        for (const file of await names(subagents))
          if (file.endsWith('.jsonl')) await consider(join(subagents, file), 'claude', entry);
      }
    }
    // Codex files sessions by the day they started (year/month/day). A session that started in an
    // earlier month can still be in use, so look at all of them; the file time picks which to read.
    const codex = join(this.#home, '.codex', 'sessions');
    for (const year of await names(codex)) {
      for (const month of await names(join(codex, year))) {
        const monthDir = join(codex, year, month);
        for (const day of await names(monthDir)) {
          for (const file of await names(join(monthDir, day))) {
            const session = UUID_FILE.exec(file)?.[1];
            if (session) await consider(join(monthDir, day, file), 'codex', session.toLowerCase());
          }
        }
      }
    }
    return found;
  }

  async #load(): Promise<void> {
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#cachePath, 'utf8')) as {
        version?: number; files?: Record<string, FileRecord>;
      };
      if (parsed.version !== CACHE_VERSION || !parsed.files) return;
      for (const [path, record] of Object.entries(parsed.files)) {
        if (!record || !Number.isFinite(record.offset) || !Array.isArray(record.entries)) continue;
        const old = record as FileRecord & {tokenLast?: unknown; tokenEntries?: unknown};
        delete old.tokenLast;
        delete old.tokenEntries;
        this.#files.set(path, record);
      }
    } catch {
      // No cache yet, or an unreadable one: read the transcripts again.
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#cachePath), {recursive: true, mode: 0o700});
    const tmp = `${this.#cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify({version: CACHE_VERSION, files: Object.fromEntries(this.#files)}),
                    {mode: 0o600});
    await rename(tmp, this.#cachePath);
  }
}

async function names(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

// Reads from record.offset to size, looking only at lines that hold the source's usage marker.
async function readUsage(path: string, record: FileRecord, size: number): Promise<boolean> {
  const needle = NEEDLES[record.source];
  const handle = await open(path, 'r');
  const before = record.entries.length;
  let changedEntry = false;
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = record.offset;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const {bytesRead} = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = data.lastIndexOf(10);
      if (end < 0) {
        carry = data.length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(data);
        continue;
      }
      let from = 0;
      for (let at = data.indexOf(needle, from); at >= 0 && at < end; at = data.indexOf(needle, from)) {
        const lineStart = data.lastIndexOf(10, at) + 1;
        const lineEnd = data.indexOf(10, at);
        if (applyLine(record, data.toString('utf8', lineStart, lineEnd))) changedEntry = true;
        from = lineEnd + 1;
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
    // The last, unfinished line is read again next time, once it is whole.
    record.offset = position - carry.length;
  } finally {
    await handle.close();
  }
  return changedEntry || record.entries.length !== before;
}

// Adds one usage line to the record; true when it changed an entry.
export function applyLine(record: Pick<FileRecord, 'source' | 'last' | 'entries'>, line: string): boolean {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  const time = Date.parse(String(event.timestamp ?? ''));
  if (!Number.isFinite(time)) return false;
  if (record.source === 'copilot') {
    if (event.type !== 'session.usage_checkpoint' && event.type !== 'session.shutdown') return false;
    // Copilot's token counts are not complete (a session that does not stop cleanly loses them),
    // so only its AI credits are counted.
    return addTotal(record, time, number((event.data as Record<string, unknown> | undefined)?.totalNanoAiu));
  }
  if (record.source === 'codex') {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.type !== 'event_msg' || payload?.type !== 'token_count') return false;
    const usage = (payload.info as Record<string, unknown> | null | undefined)?.total_token_usage as
      Record<string, unknown> | undefined;
    if (!usage) return false;
    // Codex counts cached input inside input_tokens; leave cache reads out, as for Claude.
    const total = number(usage.input_tokens) - number(usage.cached_input_tokens) + number(usage.output_tokens);
    return addTotal(record, time, total);
  }
  const message = event.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (event.type !== 'assistant' || !usage) return false;
  // Input and output, with cache writes (new input) but not cache reads.
  const amount = number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.output_tokens);
  const id = typeof message?.id === 'string' && message.id ? message.id : undefined;
  // Claude repeats a message's usage on each of its content blocks; keep the last.
  if (id) {
    for (let i = record.entries.length - 1; i >= Math.max(0, record.entries.length - 64); --i) {
      const entry = record.entries[i];
      if (entry?.[2] !== id) continue;
      if (entry[1] === amount) return false;
      entry[1] = amount;
      return true;
    }
  }
  if (!amount) return false;
  record.entries.push(id ? [time, amount, id] : [time, amount]);
  return true;
}

function addTotal(record: Pick<FileRecord, 'last' | 'entries'>, time: number, total: number): boolean {
  if (!(total > 0)) return false;
  // A smaller total means the count started again.
  const increase = total >= record.last ? total - record.last : total;
  record.last = total;
  if (!increase) return false;
  record.entries.push([time, increase]);
  return true;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// "902", "12,345", then "1.2M": AI credits are shown whole up to a million.
export function formatAic(value: number): string {
  if (value < 10) return trimZero((Math.round(value * 10) / 10).toFixed(1));
  if (value < 1e6) return Math.round(value).toLocaleString('en-US');
  return compactNumber(value);
}

// "845", "12.4K", "845K", "1.2M".
export function formatTokens(value: number): string {
  return compactNumber(value);
}

export function compactNumber(value: number): string {
  const n = Math.max(0, value);
  if (n < 1000) return String(Math.round(n));
  const units: Array<[string, number]> = [['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12]];
  for (const [i, [suffix, size]] of units.entries()) {
    const scaled = n / size;
    const rounded = scaled < 100 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
    if (rounded < 1000 || i === units.length - 1)
      return `${trimZero(scaled < 100 ? rounded.toFixed(1) : String(rounded))}${suffix}`;
  }
  return String(Math.round(n));
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

// Both values, for Settings. Tokens are Claude Code's and Codex's; GitHub Copilot has AIC.
export function usageLines(totals: UsageTotals): string[] {
  const lines: string[] = [];
  if (totals.aic !== null) lines.push(`AIC: ${formatAic(totals.aic)}`);
  if (totals.tokens !== null) lines.push(`Tokens: ${formatTokens(totals.tokens)}`);
  return lines;
}

// The device and desktop show one line, for what is running: AIC while a GitHub Copilot
// session runs, otherwise Tokens while another agent runs, and nothing when none runs.
export function deviceUsageLines(totals: UsageTotals, running: {copilot: boolean; others: boolean}): string[] {
  if (running.copilot) return [`AIC: ${formatAic(totals.aic ?? 0)}`];
  if (running.others) return [`Tokens: ${formatTokens(totals.tokens ?? 0)}`];
  return [];
}

export function usagePacket(lines: readonly string[]): string {
  return `$${lines.join('|')}\n`;
}

export function shouldSendUsage(protocol: number): boolean {
  return Number.isInteger(protocol) && protocol >= 8;
}

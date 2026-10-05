import {existsSync} from 'node:fs';
import {samePath} from './commands.js';
import {isRecord} from './file-utils.js';
import type {AgentContext, HookStatus} from './types.js';

// A companion hook found in an agent's config: the event it is under, and the Node.js and CLI it runs.
export interface FoundHook {
  event: string;
  node: string;
  cli: string;
}

// The hooks are 'installed' only when every event has one, each runs this install's CLI, and that
// Node.js and CLI are still on disk. Hooks of another install, or of a removed one, are 'outdated'.
export function hookHealth(found: FoundHook[], events: readonly string[],
                           ctx: Pick<AgentContext, 'cli' | 'hostPath'>): HookStatus {
  if (!found.length) return 'missing';
  const exists = (path: string) => Boolean(path) && existsSync(ctx.hostPath?.(path) ?? path);
  if (found.some(hook => !samePath(hook.cli, ctx.cli) || !exists(hook.node) || !exists(hook.cli))) return 'outdated';
  return events.every(event => found.some(hook => hook.event === event)) ? 'installed' : 'outdated';
}

// A path that codexQuote ("...") or shellQuote ('...') wrote.
const quoted = /("(?:[^"\\]|\\.)*"|'(?:[^']|'\\'')*')/.source;

// Reads `<node> <cli> hook AGENT EVENT`, the command line the shell-form hooks run.
export function parseHookCommand(command: string, agent: string): FoundHook | undefined {
  const tail = `\\s+hook\\s+${agent}\\s+(\\S+)\\s*$`;
  const powershell = new RegExp(`^&\\s*${powershellQuoted}\\s+${powershellQuoted}${tail}`).exec(command.trim());
  if (powershell) {
    const text = (value: string) => value.slice(1, -1).replaceAll("''", "'");
    return {node: text(powershell[1]!), cli: text(powershell[2]!), event: powershell[3]!};
  }
  const match = new RegExp(`^${quoted}\\s+${quoted}${tail}`).exec(command.trim());
  if (!match) return undefined;
  return {node: unquote(match[1]!), cli: unquote(match[2]!), event: match[3]!};
}

// A path that powershellHookCommand wrote: '...', with each ' inside written as ''.
const powershellQuoted = /('(?:[^']|'')*')/.source;

function unquote(value: string): string {
  const inner = value.slice(1, -1);
  return value.startsWith('"') ? inner.replace(/\\(.)/g, '$1') : inner.replaceAll(`'\\''`, `'`);
}

export type IsOurHandler = (handler: unknown) => boolean;

// The `hooks` object of a JSON config. A value that isn't an object is the user's, so it is not replaced.
function hooksObject(root: Record<string, unknown>, path: string): Record<string, unknown> {
  if (root.hooks === undefined || root.hooks === null) return {};
  if (!isRecord(root.hooks)) throw new Error(`"hooks" in ${path} isn't an object, so it was left unchanged.`);
  return root.hooks;
}

// The groups of one event, or an error when the event holds something other than a list.
export function eventGroups(hooks: Record<string, unknown>, event: string, path: string): unknown[] {
  const groups = hooks[event];
  if (groups === undefined || groups === null) return [];
  if (!Array.isArray(groups)) throw new Error(`"hooks.${event}" in ${path} isn't a list, so it was left unchanged.`);
  return groups;
}

// Removes our handlers. A group goes only when it had our handlers and no others; anything this
// code doesn't recognize stays as it is.
function withoutOurHandlers(groups: unknown[], isOurs: IsOurHandler): unknown[] {
  const result: unknown[] = [];
  for (const group of groups) {
    const handlers = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
    if (!handlers?.some(isOurs)) {
      result.push(group);
      continue;
    }
    const kept = handlers.filter(handler => !isOurs(handler));
    if (kept.length) result.push({...group as Record<string, unknown>, hooks: kept});
  }
  return result;
}

// Puts our group where our old group was, so the other groups keep their positions (Codex links each
// approval to a position). With no old group, ours goes last.
function withOurGroup(groups: unknown[], isOurs: IsOurHandler, ours: Record<string, unknown>): unknown[] {
  const index = groups.findIndex(group => isRecord(group) && Array.isArray(group.hooks)
    && group.hooks.length > 0 && group.hooks.every(isOurs));
  if (index < 0) return [...withoutOurHandlers(groups, isOurs), ours];
  return [...withoutOurHandlers(groups.slice(0, index), isOurs), ours,
          ...withoutOurHandlers(groups.slice(index + 1), isOurs)];
}

// Puts our group under each of `events`, and removes our handlers from every other event (an older
// version's events, or hooks added by hand), so a reinstall leaves no stale hook behind.
export function withOurHooks(root: Record<string, unknown>, path: string, events: readonly string[],
                             isOurs: IsOurHandler, groupFor: (event: string) => Record<string, unknown>,
): Record<string, unknown> {
  const hooks = hooksObject(root, path);
  // Reads every event first, so a value that isn't a list stops the install before any change.
  const current = new Map(events.map(event => [event, eventGroups(hooks, event, path)]));
  for (const [event, groups] of Object.entries(hooks)) {
    if (current.has(event) || !Array.isArray(groups)) continue;
    const kept = withoutOurHandlers(groups, isOurs);
    if (kept.length) hooks[event] = kept;
    else if (groups.length) delete hooks[event];
  }
  for (const event of events) hooks[event] = withOurGroup(current.get(event)!, isOurs, groupFor(event));
  root.hooks = hooks;
  return root;
}

// Removes our handlers from every event. An event goes only when its list held only our handlers,
// and `hooks` goes only when this emptied it.
export function removeOurHooks(root: Record<string, unknown>, isOurs: IsOurHandler): Record<string, unknown> {
  if (!isRecord(root.hooks)) return root;
  const hooks = root.hooks;
  let removed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = withoutOurHandlers(groups, isOurs);
    if (kept.length === groups.length && kept.every((group, index) => group === groups[index])) continue;
    removed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed && !Object.keys(hooks).length) delete root.hooks;
  return root;
}

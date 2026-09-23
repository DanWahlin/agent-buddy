/**
 * Wiring agent lifecycle hooks to the bridge.
 *
 * Both supported agents fire the same shape of events, so the mapping is mostly
 * one to one with the vendored coordinator's vocabulary. Claude Code turns out
 * to carry the full set - including `PostToolUseFailure` and `SubagentStart`,
 * which earlier notes assumed were missing - so nothing has to be synthesised.
 *
 * Hooks run on the agent's critical path, so every entry here is asynchronous
 * with a short timeout: a companion must never be able to stall a session.
 */

import { hookEvents, type HookEvent } from './vendor/protocol.js';

export type AgentKind = 'claude-code' | 'copilot-cli';

/** Claude Code event name to the coordinator's vocabulary. */
export const CLAUDE_CODE_EVENTS: Record<string, HookEvent> = {
  SessionStart: 'sessionStart',
  UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  Stop: 'agentStop',
  Notification: 'notification',
  // A permission prompt is the clearest "waiting on you" signal there is.
  PermissionRequest: 'notification',
  SessionEnd: 'sessionEnd',
};

/** Copilot CLI fires the coordinator's names directly. */
export const COPILOT_CLI_EVENTS: readonly HookEvent[] = hookEvents;

export interface HookTarget {
  /** Absolute path to the Node binary that will run the shim. */
  node: string;
  /** Absolute path to the shim script. */
  shim: string;
}

/**
 * Claude Code's `hooks` block, to merge into a settings.json.
 *
 * `args` selects exec form, which avoids a shell and so avoids quoting a
 * Windows path. `async` keeps the hook off the agent's critical path.
 */
export function claudeCodeHooks(target: HookTarget): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, mapped] of Object.entries(CLAUDE_CODE_EVENTS)) {
    hooks[event] = [{
      hooks: [{
        type: 'command',
        command: target.node,
        args: [target.shim, mapped],
        async: true,
        timeout: 5,
      }],
    }];
  }
  return hooks;
}

/** Copilot CLI's hook file, written whole to `~/.copilot/hooks/`. */
export function copilotCliHooks(target: HookTarget): Record<string, unknown> {
  const command = (event: HookEvent) => [{
    type: 'command',
    exec: target.node,
    args: [target.shim, event],
    timeoutSec: 2,
  }];

  const hooks: Record<string, unknown> = {};
  for (const event of COPILOT_CLI_EVENTS) {
    hooks[event] = event === 'notification'
      // Only the prompts that actually want a human, not every notification.
      ? [{ ...command(event)[0], matcher: 'permission_prompt|elicitation_dialog' }]
      : command(event);
  }
  return { version: 1, hooks };
}

/**
 * Merge our hooks into an existing Claude Code settings object, leaving any
 * other hooks in place and replacing only entries we previously wrote.
 *
 * Ours are recognised by the shim path, so re-running the installer after the
 * extension updates repoints them instead of stacking duplicates.
 */
export function mergeClaudeCodeHooks(
  settings: Record<string, unknown>, target: HookTarget,
): Record<string, unknown> {
  const existing = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const ours = claudeCodeHooks(target);

  for (const [event, entries] of Object.entries(ours)) {
    const previous = Array.isArray(existing[event]) ? existing[event] as unknown[] : [];
    existing[event] = [...previous.filter(entry => !isOurs(entry, target)), ...(entries as unknown[])];
  }

  // An event we no longer register should not keep a stale entry of ours.
  for (const [event, entries] of Object.entries(existing)) {
    if (event in ours || !Array.isArray(entries)) continue;
    const kept = entries.filter(entry => !isOurs(entry, target));
    if (kept.length) existing[event] = kept;
    else delete existing[event];
  }

  return { ...settings, hooks: existing };
}

/** Remove everything we installed, by shim path. */
export function removeClaudeCodeHooks(
  settings: Record<string, unknown>, shim: string,
): Record<string, unknown> {
  if (!isRecord(settings.hooks)) return settings;
  const hooks: Record<string, unknown> = {};

  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) { hooks[event] = entries; continue; }
    const kept = entries.filter(entry => !isOurs(entry, { shim }));
    if (kept.length) hooks[event] = kept;
  }

  const result = { ...settings };
  if (Object.keys(hooks).length) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

/** Does this settings entry point at our shim? */
function isOurs(entry: unknown, target: { shim: string }): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(hook =>
    isRecord(hook)
    && (Array.isArray(hook.args) ? hook.args : []).some(
      argument => samePath(String(argument), target.shim)));
}

/** Compare paths the way the two platforms do, so a reinstall matches. */
function samePath(a: string, b: string): boolean {
  const normalise = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32'
    ? normalise(a).toLowerCase() === normalise(b).toLowerCase()
    : normalise(a) === normalise(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

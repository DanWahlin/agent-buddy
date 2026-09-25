/**
 * Which project a hook belongs to, and which windows should see it.
 *
 * One machine used to mean one state: the coordinator folded every session
 * together and the bridge pushed the result to every window. That is right for
 * upstream, which drives a single device on a desk, and wrong for an editor -
 * a window sitting idle on one project should not animate because an agent is
 * busy in another.
 *
 * Attribution costs nothing to collect: Claude Code puts `cwd` in every hook
 * payload, and the shim already forwards the payload untouched. What was
 * missing was anywhere to put it.
 *
 * A session nobody claims - an agent in a terminal outside every open
 * workspace - is shown by all of them, so it is never silently invisible.
 */

import type { CharacterState, HookPayload } from './vendor/protocol.js';

/** The route for a session no window claims. Not a valid path, deliberately. */
export const UNATTRIBUTED = '*';

/**
 * Compare paths the way the platform does, so a window matches its own hooks.
 *
 * Takes the platform rather than reading it, for the same reason `paths.ts`
 * does: otherwise the Windows branch can only be tested on Windows.
 */
export function normaliseFolder(
  value: string, platform: NodeJS.Platform = process.platform,
): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * The project a hook came from, or null when it cannot be placed.
 *
 * `projectDir` wins when the shim could capture it, because `cwd` follows the
 * agent: into a worktree, and anywhere it is told to `cd`. The project root
 * stays put, which is what a window's workspace should be matched against.
 */
export function projectOf(
  payload: HookPayload | undefined, projectDir?: string,
): string | null {
  if (typeof projectDir === 'string' && projectDir.trim()) return projectDir;
  const cwd = payload?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) return cwd;
  return null;
}

/** The route to file a hook under: its project, or the shared bucket. */
export function routeOf(
  payload: HookPayload | undefined,
  projectDir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const project = projectOf(payload, projectDir);
  return project === null ? UNATTRIBUTED : normaliseFolder(project, platform);
}

/** Is `target` the folder itself, or somewhere inside it? */
export function folderContains(
  folder: string, target: string, platform: NodeJS.Platform = process.platform,
): boolean {
  const base = normaliseFolder(folder, platform);
  const inside = normaliseFolder(target, platform);
  if (!base) return false;
  // The separator matters: without it "/repo" would claim "/repo-backup".
  return inside === base || inside.startsWith(base + '/');
}

/**
 * Should a window showing `folders` react to this route?
 *
 * A window with no folders at all - an empty editor, or a desktop app that has
 * no notion of a workspace - sees everything, which is the old behaviour and
 * the only sensible answer when there is nothing to match against.
 */
export function routeIsVisibleTo(
  route: string, folders: readonly string[], platform: NodeJS.Platform = process.platform,
): boolean {
  if (route === UNATTRIBUTED) return true;
  if (folders.length === 0) return true;
  return folders.some(folder => folderContains(folder, route, platform));
}

/**
 * Fold several routes' states into the one a window shows.
 *
 * The order mirrors the vendored coordinator's own priority, which cannot be
 * reused because it is private to it. `surprise` is absent on purpose: it is a
 * poke, raised in the view, and never something a hook produces.
 */
const PRIORITY: readonly CharacterState[] = ['attention', 'working', 'complete', 'idle'];

export function combineStates(states: Iterable<CharacterState>): CharacterState {
  let best = PRIORITY.length - 1;
  for (const state of states) {
    const rank = PRIORITY.indexOf(state);
    if (rank >= 0 && rank < best) best = rank;
  }
  return PRIORITY[best];
}

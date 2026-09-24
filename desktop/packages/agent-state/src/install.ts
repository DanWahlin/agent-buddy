/**
 * Putting the hook shim somewhere it will still be tomorrow.
 *
 * Hooks name the shim by path. A path inside the host that installed it - a
 * versioned extension directory, an app bundle - stops resolving the moment
 * that host updates or is removed, and the hooks are left pointing at nothing.
 *
 * On Claude Code that costs an animation. On Copilot CLI it costs the session:
 * its `preToolUse` is fail-closed, so a shim that cannot be run is not merely
 * unheard, it denies the tool call. So the shim is copied somewhere of its own,
 * every host installs the same one to the same place, and a host being updated
 * or uninstalled leaves it standing.
 */

import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { shimPath } from './paths.js';

export interface InstalledShim {
  /** Where the hooks should point. */
  path: string;
  /** False when what was already there was identical, so nothing was written. */
  replaced: boolean;
}

/**
 * Copy `source` to the shim's stable home, and say where that is.
 *
 * Written to a temporary name and renamed into place, because a rename is
 * atomic and a copy is not. A half-written shim is not a slow shim - it is a
 * broken one, and on Copilot CLI a broken one blocks the agent. No window
 * should ever be able to catch it mid-write.
 */
export async function installShim(source: string, target = shimPath()): Promise<InstalledShim> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });

  if (await identical(source, target)) return { path: target, replaced: false };

  // Alongside the target, so the rename cannot cross a filesystem boundary.
  const staged = join(dirname(target), 'hook.js.' + process.pid + '.tmp');
  try {
    await copyFile(source, staged);
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path: target, replaced: true };
}

/**
 * Take the shim away again.
 *
 * Only ever after the hooks that name it have gone: removing it first would
 * leave every Copilot tool call denied for as long as they remained.
 */
export async function removeShim(target = shimPath()): Promise<boolean> {
  try {
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the installed shim already this one?
 *
 * Compared by content rather than size or date. The shim is a few kilobytes,
 * so reading it costs nothing, and a build that happens to come out the same
 * length as the last one would otherwise never be installed at all.
 */
async function identical(source: string, target: string): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([readFile(source), readFile(target)]);
    return from.equals(to);
  } catch {
    return false;
  }
}

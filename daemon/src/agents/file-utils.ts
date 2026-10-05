import {copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile, chmod} from 'node:fs/promises';
import {constants, existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {restoreWslMode, wslFileMode} from './wsl.js';

// How many timestamped copies to keep beside each file we change.
const keptBackups = 5;

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// A new file gets `mode`; an existing file keeps its own. Before it changes an existing file, this keeps
// a copy: `<file>.bak` holds the file as it was before our first change, and
// `<file>.agent-companion-<time>.bak` holds it as it was before each change (the last `keptBackups`).
export async function writeTextAtomically(path: string, content: string, newFileMode = 0o600): Promise<boolean> {
  const previous = await readText(path);
  if (previous === content) return false;
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  if (previous !== null) {
    if (!existsSync(`${path}.bak`)) {
      await copyFile(path, `${path}.bak`);
      await onlyUserCanRead(`${path}.bak`);
    }
    await keepTimestampedBackup(path);
  }
  // Write through symlinks (e.g. dotfiles managed by stow or chezmoi) instead of replacing them.
  const target = previous === null ? path : await realpath(path).catch(() => path);
  const mode = previous === null ? newFileMode : await wslFileMode(target) ?? (await stat(target)).mode & 0o777;
  const temporary = uniqueTemporaryPath(target);
  try {
    await writeFile(temporary, content, {mode});
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
  await chmod(target, mode).catch(() => undefined);
  await restoreWslMode(target, mode).catch(() => undefined);
  return true;
}

async function keepTimestampedBackup(path: string): Promise<void> {
  const prefix = `${basename(path)}.agent-companion-`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
  for (let attempt = 0; ; attempt += 1) {
    const backup = join(dirname(path), `${prefix}${stamp}${attempt ? `-${attempt}` : ''}.bak`);
    try {
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      await onlyUserCanRead(backup);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 99) throw error;
    }
  }
  // The names sort by time, oldest first.
  const backups = (await readdir(dirname(path)))
    .filter(name => name.startsWith(prefix) && name.endsWith('.bak')).sort();
  for (const name of backups.slice(0, -keptBackups)) await rm(join(dirname(path), name), {force: true});
}

// Agent configs can hold tokens, so only the user can read the copies. A copy through \\wsl$ does
// not keep the mode of the file.
async function onlyUserCanRead(path: string): Promise<void> {
  await chmod(path, 0o600);
  await restoreWslMode(path, 0o600).catch(() => undefined);
}

export function uniqueTemporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.agent-companion-new`;
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, {force: true});
}

export function parseJsonObject(text: string | null, path = 'settings file'): Record<string, unknown> {
  if (!text?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Couldn't parse ${path}, so it was left unchanged: ${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new Error(`${path} doesn't contain a JSON object, so it was left unchanged.`);
  return value;
}

// Writes the file only when `update` changed its value, so a file with nothing to change keeps its
// formatting. With `create: false`, a missing file stays missing.
export async function updateJsonFile(
    path: string,
    update: (value: Record<string, unknown>) => Record<string, unknown>,
    {create = true}: {create?: boolean} = {}): Promise<boolean> {
  const text = await readText(path);
  if (text === null && !create) return false;
  const value = parseJsonObject(text, path);
  const before = JSON.stringify(value);
  const next = update(value);
  if (text !== null && JSON.stringify(next) === before) return false;
  return writeTextAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The value when it is a plain object, else an empty one.
export function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

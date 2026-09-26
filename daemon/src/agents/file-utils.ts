import {copyFile, mkdir, readFile, realpath, rename, rm, writeFile, chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeTextAtomically(path: string, content: string, mode = 0o600): Promise<boolean> {
  const previous = await readText(path);
  if (previous === content) return false;
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  if (previous !== null && !existsSync(`${path}.bak`)) await copyFile(path, `${path}.bak`);
  // Write through symlinks (e.g. dotfiles managed by stow or chezmoi) instead of replacing them.
  const target = previous === null ? path : await realpath(path);
  const temporary = uniqueTemporaryPath(target);
  try {
    await writeFile(temporary, content, {mode});
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
  await chmod(target, mode).catch(() => undefined);
  return true;
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} doesn't contain a JSON object, so it was left unchanged.`);
  return value as Record<string, unknown>;
}

export async function updateJsonFile(
    path: string,
    update: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const next = update(parseJsonObject(await readText(path), path));
  await writeTextAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
}

export function commandExists(command: string): boolean {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  return paths.some(path => existsSync(`${path}/${command}`));
}

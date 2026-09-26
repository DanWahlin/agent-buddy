import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {connectionPreferencePath} from './paths.js';

// auto prefers USB and falls back to Wi-Fi; wifi leaves a connected cable for power only.
export const connectionModes = ['auto', 'usb', 'wifi'] as const;
export type ConnectionMode = typeof connectionModes[number];

export function isConnectionMode(value: unknown): value is ConnectionMode {
  return typeof value === 'string' && (connectionModes as readonly string[]).includes(value);
}

export async function loadConnectionMode(): Promise<ConnectionMode> {
  try {
    const value = JSON.parse(await readFile(connectionPreferencePath(), 'utf8')) as {mode?: unknown};
    if (isConnectionMode(value.mode)) return value.mode;
  } catch {
    // A missing or unreadable preference keeps the default.
  }
  return 'auto';
}

export async function saveConnectionMode(mode: ConnectionMode): Promise<void> {
  const path = connectionPreferencePath();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify({mode}, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, path);
}

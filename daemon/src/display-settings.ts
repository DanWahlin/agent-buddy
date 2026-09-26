import {mkdir, rename, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {displaySettingsPath} from './paths.js';

export interface DisplaySettings {
  showAgentBadges: boolean;
}

export function loadDisplaySettingsSync(path = displaySettingsPath()): DisplaySettings {
  if (!existsSync(path)) return {showAgentBadges: true};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {showAgentBadges?: unknown};
    return {showAgentBadges: parsed.showAgentBadges !== false};
  } catch {
    return {showAgentBadges: true};
  }
}

export async function saveDisplaySettings(settings: DisplaySettings, path = displaySettingsPath()): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {mode: 0o600});
  await rename(tmp, path);
}

export function customIconDirectory(dataDir: string): string {
  return join(dataDir, 'icons');
}

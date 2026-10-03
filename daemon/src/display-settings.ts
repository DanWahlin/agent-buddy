import {mkdir, rename, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {displaySettingsPath} from './paths.js';

// How the desktop character is framed: as the device itself, or on its own.
export const desktopBackdrops = ['device', 'none'] as const;
export type DesktopBackdrop = typeof desktopBackdrops[number];

export interface DisplaySettings {
  showAgentBadges: boolean;
  // Whether the desktop app shows its character; the device is unaffected.
  showDesktopCompanion: boolean;
  desktopBackdrop: DesktopBackdrop;
}

export const defaultDisplaySettings: DisplaySettings = {
  showAgentBadges: true,
  showDesktopCompanion: true,
  desktopBackdrop: 'device',
};

export function isDesktopBackdrop(value: unknown): value is DesktopBackdrop {
  return typeof value === 'string' && (desktopBackdrops as readonly string[]).includes(value);
}

export function loadDisplaySettingsSync(path = displaySettingsPath()): DisplaySettings {
  if (!existsSync(path)) return {...defaultDisplaySettings};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<keyof DisplaySettings, unknown>>;
    return {
      showAgentBadges: parsed.showAgentBadges !== false,
      showDesktopCompanion: parsed.showDesktopCompanion !== false,
      desktopBackdrop: isDesktopBackdrop(parsed.desktopBackdrop)
        ? parsed.desktopBackdrop : defaultDisplaySettings.desktopBackdrop,
    };
  } catch {
    return {...defaultDisplaySettings};
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

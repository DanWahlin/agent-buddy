import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  defaultDisplaySettings, isDesktopBackdrop, loadDisplaySettingsSync, saveDisplaySettings,
} from '../src/display-settings.js';

test('display settings default to badges on, desktop shown, device look', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'display-settings-'));
  try {
    assert.deepEqual(loadDisplaySettingsSync(join(directory, 'missing.json')), defaultDisplaySettings);
    assert.deepEqual(defaultDisplaySettings, {showAgentBadges: true, showDesktopCompanion: true, desktopBackdrop: 'device'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('older settings files gain the desktop defaults, and bad values fall back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'display-settings-'));
  const path = join(directory, 'display.json');
  try {
    await writeFile(path, JSON.stringify({showAgentBadges: false}));
    assert.deepEqual(loadDisplaySettingsSync(path),
      {showAgentBadges: false, showDesktopCompanion: true, desktopBackdrop: 'device'});
    await writeFile(path, JSON.stringify({showDesktopCompanion: false, desktopBackdrop: 'orb'}));
    assert.deepEqual(loadDisplaySettingsSync(path),
      {showAgentBadges: true, showDesktopCompanion: false, desktopBackdrop: 'device'});
    await writeFile(path, 'not json');
    assert.deepEqual(loadDisplaySettingsSync(path), defaultDisplaySettings);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('desktop settings round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'display-settings-'));
  const path = join(directory, 'nested', 'display.json');
  try {
    const settings = {showAgentBadges: true, showDesktopCompanion: false, desktopBackdrop: 'none'} as const;
    await saveDisplaySettings(settings, path);
    assert.deepEqual(loadDisplaySettingsSync(path), settings);
    assert.equal(isDesktopBackdrop('none'), true);
    assert.equal(isDesktopBackdrop('orb'), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

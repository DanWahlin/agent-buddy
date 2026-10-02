import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  defaultDisplaySettings, isDesktopBackdrop, loadDisplaySettingsSync, saveDisplaySettings,
} from '../src/display-settings.js';

test('display settings default to badges on, desktop shown, orb backdrop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'display-settings-'));
  try {
    assert.deepEqual(loadDisplaySettingsSync(join(directory, 'missing.json')), defaultDisplaySettings);
    assert.deepEqual(defaultDisplaySettings, {showAgentBadges: true, showDesktopCompanion: true, desktopBackdrop: 'orb'});
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
      {showAgentBadges: false, showDesktopCompanion: true, desktopBackdrop: 'orb'});
    await writeFile(path, JSON.stringify({showDesktopCompanion: false, desktopBackdrop: 'neon'}));
    assert.deepEqual(loadDisplaySettingsSync(path),
      {showAgentBadges: true, showDesktopCompanion: false, desktopBackdrop: 'orb'});
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
    const settings = {showAgentBadges: true, showDesktopCompanion: false, desktopBackdrop: 'device'} as const;
    await saveDisplaySettings(settings, path);
    assert.deepEqual(loadDisplaySettingsSync(path), settings);
    assert.equal(isDesktopBackdrop('none'), true);
    assert.equal(isDesktopBackdrop('glow'), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

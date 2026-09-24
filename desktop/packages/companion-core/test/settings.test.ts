import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, withDefaults } from '../src/index.js';

test('nothing supplied leaves the defaults alone', () => {
  assert.deepEqual(withDefaults(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(withDefaults({}), DEFAULT_SETTINGS);
});

test('what the host supplies wins', () => {
  assert.deepEqual(withDefaults({ crossfade: false, maxScale: 5 }), {
    ...DEFAULT_SETTINGS, crossfade: false, maxScale: 5,
  });
});

/**
 * A host that reads settings one key at a time hands back `undefined` for the
 * ones nobody has set. A plain spread would take that as an answer and leave
 * the view with no crossfade setting at all.
 */
test('a setting nobody has set does not overwrite its default', () => {
  assert.deepEqual(
    withDefaults({ crossfade: undefined, maxScale: undefined, autoSleep: undefined }),
    DEFAULT_SETTINGS);
});

test('false is a real answer, not an absent one', () => {
  assert.equal(withDefaults({ crossfade: false }).crossfade, false);
  assert.equal(withDefaults({ autoSleep: false }).autoSleep, false);
});

test('the result is a copy, so a caller cannot edit the defaults', () => {
  const settings = withDefaults({});
  settings.maxScale = 99;
  assert.equal(DEFAULT_SETTINGS.maxScale, 3);
});

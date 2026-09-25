/**
 * The settings every host offers, and what they are when nobody has said.
 *
 * The defaults live here rather than in each host so that a pack checked in
 * one behaves the same in the other. How they are *stored* is the host's
 * business: VS Code has a settings UI, a desktop app has a file.
 */

import type { ViewSettings } from './protocol.js';

export const DEFAULT_SETTINGS: ViewSettings = {
  crossfade: true,
  maxScale: 3,
  autoSleep: true,
};

/**
 * Fill in whatever the host did not supply.
 *
 * Absent keys are skipped rather than spread, because a host reading settings
 * one at a time hands back `undefined` for the ones nobody has set, and a
 * plain spread would let that overwrite the default with nothing.
 */
export function withDefaults(partial: Partial<ViewSettings> | undefined): ViewSettings {
  // Spelled out rather than spread, so adding a setting is a compile error here
  // instead of a default that silently goes missing. `??` also keeps `false` as
  // a real answer, which a truthiness check would not.
  return {
    crossfade: partial?.crossfade ?? DEFAULT_SETTINGS.crossfade,
    maxScale: partial?.maxScale ?? DEFAULT_SETTINGS.maxScale,
    autoSleep: partial?.autoSleep ?? DEFAULT_SETTINGS.autoSleep,
  };
}

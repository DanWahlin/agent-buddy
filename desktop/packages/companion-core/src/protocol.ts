/**
 * What the extension host and the webview say to each other.
 *
 * The host reads `pack.json` from disk and sends it over with every image name
 * already resolved to a webview URI, so the page fetches nothing and needs no
 * `connect-src` in its content security policy.
 */

import type { CharacterState, Pack } from '@agent-companion/pack-format';
import type { Direction } from '@agent-companion/renderer';

export interface ViewSettings {
  crossfade: boolean;
  maxScale: number;
  /** Let the character doze off when left alone, and wake again. */
  autoSleep: boolean;
}

/** Host to webview. */
export type HostMessage =
  | {
      type: 'show';
      pack: Pack;
      /** Image name from `pack.json` to the webview URI serving it. */
      images: Record<string, string>;
      settings: ViewSettings;
    }
  /**
   * Fetch this pack yourself, rather than being handed one.
   *
   * For a host that serves its own files and can simply point at a manifest. VS
   * Code cannot: a webview may not read the disk, so it gets `show` with every
   * image already rewritten to a URI it is allowed to load.
   */
  | { type: 'load'; url: string; settings?: ViewSettings }
  | { type: 'state'; state: CharacterState }
  | { type: 'look'; direction: Direction }
  | { type: 'sleep'; sleeping: boolean }
  | { type: 'settings'; settings: ViewSettings }
  | { type: 'error'; message: string };

/** Webview to host. */
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'failed'; message: string };

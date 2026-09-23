/**
 * Fetching a pack in a browser or webview.
 *
 * Images are loaded before anything is drawn. A half-loaded pack would show
 * holes, and the upstream preview is deliberate about refusing to substitute
 * sprites rather than quietly rendering something wrong.
 */

import { assertValidPack, type Pack } from '@agent-companion/pack-format';
import { PackRenderer, type PackImage } from './pack-renderer.js';

export interface LoadedPack {
  pack: Pack;
  images: Map<string, PackImage>;
}

export interface LoadPackOptions {
  /**
   * Resolve a pack-relative filename to a URL. A webview needs this, because
   * local files are served through a rewritten scheme.
   */
  resolve?: (name: string) => string;
  signal?: AbortSignal;
}

/**
 * Load every image an already-parsed pack references.
 *
 * A VS Code webview takes this path: the extension host reads `pack.json` from
 * disk and hands over both the manifest and a way to resolve image names to
 * webview URIs, so the page never needs to fetch anything itself.
 */
export async function loadImages(
  pack: Pack, resolve: (name: string) => string, signal?: AbortSignal,
): Promise<Map<string, PackImage>> {
  assertValidPack(pack);
  const loaded = await Promise.all(PackRenderer.imageNames(pack).map(async name => {
    const image = await loadImage(resolve(name), signal);
    return [name, image] as const;
  }));
  return new Map(loaded);
}

/**
 * Fetch `pack.json` from `baseUrl` and load every image it references.
 *
 * `baseUrl` should name the `pack.json` itself or the directory holding it.
 */
export async function loadPack(baseUrl: string, options: LoadPackOptions = {}): Promise<LoadedPack> {
  const manifestUrl = baseUrl.endsWith('.json') ? baseUrl : joinUrl(baseUrl, 'pack.json');
  const response = await fetch(manifestUrl, { signal: options.signal });
  if (!response.ok) {
    throw new Error('Could not read ' + manifestUrl + ': ' + response.status + ' ' + response.statusText);
  }

  const pack = await response.json() as Pack;
  const directory = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const resolve = options.resolve ?? (name => directory + name);

  return { pack, images: await loadImages(pack, resolve, options.signal) };
}

function joinUrl(base: string, name: string): string {
  return base.endsWith('/') ? base + name : base + '/' + name;
}

function loadImage(url: string, signal?: AbortSignal): Promise<PackImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      image.src = '';
      reject(new Error('Loading ' + url + ' was aborted.'));
    };

    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => {
      cleanup();
      reject(new Error('Could not load ' + url + '. No substitute art is used.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    image.decoding = 'async';
    image.src = url;
  });
}

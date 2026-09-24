/**
 * Builds the page and copies the pack beside it.
 *
 * The bundle has to be self-contained: the window loads it from a file, with
 * no resolver and no node_modules to reach into.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, 'ui');
const packs = join(here, '..', '..', 'packs');

await esbuild.build({
  entryPoints: [join(here, 'src/webview/main.ts')],
  outfile: join(ui, 'webview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'warning',
});

// Only Marvin, for the same licensing reason the extension bundles only Marvin.
const bundled = ['marvin'];
await rm(join(ui, 'packs'), { recursive: true, force: true });
for (const pack of bundled) {
  await mkdir(join(ui, 'packs', pack), { recursive: true });
  await cp(join(packs, pack), join(ui, 'packs', pack), { recursive: true });
}
console.log('built the page and bundled ' + bundled.join(', '));

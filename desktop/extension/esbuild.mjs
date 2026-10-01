/**
 * Builds the extension.
 *
 * Three bundles and a copy:
 *   dist/extension.js      desktop extension host  (CommonJS, vscode external)
 *   dist/extension-web.js  web extension host      (CommonJS, vscode external)
 *   dist/webview.js        the page inside the view (IIFE, no bare specifiers)
 *   packs/                 the bundled character packs, copied from the repo root
 *
 * The webview bundle has to be self-contained: a browser cannot resolve
 * `@agent-companion/renderer`, and adding an import map to a CSP-restricted page
 * is more moving parts than bundling.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Packs that ship inside the .vsix: the three Agent Companion characters.
 *
 * Deliberately a list rather than everything in packs/. Marvin is the author's
 * own character rather than one of the product's, so he stays in packs/ and
 * loads through `agentCompanion.packPaths` like anybody's own character would.
 * Nothing in the extension is specific to any of the three that ship.
 *
 * All three wear a name that belongs to someone - GitHub's, Anthropic's and the
 * OpenClaw project's - which each `packs/<id>/pack.json` records. Whether they
 * may be published under those names is a trademark question and not one the
 * build can answer; changing this list is all it takes to stop shipping one.
 */
const BUNDLED_PACKS = ['copilot', 'claude', 'openclaw'];

async function copyPacks() {
  const to = join(here, 'packs');
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const name of BUNDLED_PACKS) {
    await cp(join(repoRoot, 'packs', name), join(to, name), { recursive: true });
  }
  console.log('bundled packs: ' + BUNDLED_PACKS.join(', '));
}

const shared = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  target: 'es2022',
};

const builds = [
  {
    ...shared,
    entryPoints: [join(here, 'src/host/desktop.ts')],
    outfile: join(here, 'dist/extension.js'),
    platform: 'node',
    format: 'cjs',
    // Provided by the runtime, never bundled.
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: [join(here, 'src/host/web.ts')],
    outfile: join(here, 'dist/extension-web.js'),
    platform: 'browser',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...shared,
    // The shim runs inside someone's agent session, standalone.
    entryPoints: [join(here, '..', 'packages/agent-state/src/shim.ts')],
    outfile: join(here, 'dist/hook.js'),
    platform: 'node',
    format: 'cjs',
  },
  {
    ...shared,
    entryPoints: [join(here, 'src/webview/main.ts')],
    outfile: join(here, 'dist/webview.js'),
    platform: 'browser',
    format: 'iife',
  },
];

await copyPacks();

if (watch) {
  const contexts = await Promise.all(builds.map(options => esbuild.context(options)));
  await Promise.all(contexts.map(context => context.watch()));
  console.log('watching');
} else {
  await Promise.all(builds.map(options => esbuild.build(options)));
  console.log('built');
}

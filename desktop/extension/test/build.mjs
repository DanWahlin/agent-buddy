/**
 * Bundles the host tests with the real `vscode` module aliased to a stub, so
 * the code under test is exactly the code that ships.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
await esbuild.build({
  entryPoints: [join(here, 'host.test.ts'), join(here, 'gaze.test.ts')],
  outdir: join(here, '..', 'dist-test'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'warning',
  alias: { vscode: join(here, 'vscode-stub.ts') },
  // The bundle is CommonJS, so import.meta is empty; inject the root instead of
  // guessing it from wherever the bundle happens to be written.
  define: { __EXTENSION_ROOT__: JSON.stringify(join(here, '..')) },
  external: ['node:*'],
});

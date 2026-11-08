import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Resvg} from '@resvg/resvg-js';
import {keySvg} from '../dist/streamdeck/src/key-image.js';

await mkdir('../build/streamdeck', {recursive: true});
await writeFile('com.agentbuddy.status.sdPlugin/imgs/key.svg', keySvg('connecting', 'all'));
const icon = await readFile('com.agentbuddy.status.sdPlugin/imgs/status.svg');
for (const [name, width] of [['icon', 144], ['icon@2x', 288]]) {
  await writeFile(`com.agentbuddy.status.sdPlugin/imgs/${name}.png`,
    new Resvg(icon, {fitTo: {mode: 'width', value: width}}).render().asPng());
}
await build({
  entryPoints: ['src/plugin.ts'],
  outfile: 'com.agentbuddy.status.sdPlugin/bin/plugin.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
});

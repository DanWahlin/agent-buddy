/**
 * Builds the page and copies the pack beside it.
 *
 * The bundle has to be self-contained: the window loads it from a file, with
 * no resolver and no node_modules to reach into.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
/**
 * The tray icon, cut from the character's own art.
 *
 * It was a placeholder disc, which tells nobody which app it is. Frame 0 of a
 * gaze track is the centre pose every track returns to - the character looking
 * straight out, which is exactly the picture wanted here.
 */
async function trayIcon() {
  const { default: sharp } = await import('sharp');
  const pack = JSON.parse(await readFile(join(packs, 'marvin', 'pack.json'), 'utf8'));
  const { width, height } = pack.frame;

  const face = await sharp(join(packs, 'marvin', pack.tracks.right.base))
    .extract({ left: 0, top: 0, width, height })
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // An ICO carrying a PNG, which Windows has taken since Vista.
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory.writeUInt8(0, 6);   // 0 means 256
  directory.writeUInt8(0, 7);
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(face.length, 14);
  directory.writeUInt32LE(22, 18);

  await writeFile(join(here, 'src-tauri', 'icons', 'icon.ico'),
    Buffer.concat([directory, face]));
  await writeFile(join(here, 'src-tauri', 'icons', 'icon.png'), face);
  console.log('tray icon cut from marvin');
}
await trayIcon();


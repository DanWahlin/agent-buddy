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

  // Trimmed before resizing. A pack frame carries the margin the character
  // needs to move around in, and keeping it here spends most of the icon on
  // nothing - which at tray size leaves a speck.
  // Two passes: sharp will not extract and trim in one, since the trim has to
  // measure what the extract produced.
  const frame = await sharp(join(packs, 'marvin', pack.tracks.right.base))
    .extract({ left: 0, top: 0, width, height })
    .png()
    .toBuffer();
  const face = await sharp(frame).trim({ threshold: 0 }).png().toBuffer();

  const square = (size) => sharp(face)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Every size Windows asks for, drawn at that size. One 256 entry left it to
  // downscale for the tray, which is where the blur came from.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(square));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const entries = sizes.map((size, index) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[index].length;
    return entry;
  });

  // The icons are generated, so they are not in the repository and the folder
  // will not exist in a fresh clone.
  const icons = join(here, 'src-tauri', 'icons');
  await mkdir(icons, { recursive: true });
  await writeFile(join(icons, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
  await writeFile(join(icons, 'icon.png'), images[images.length - 1]);
  console.log('app icon cut from marvin, at ' + sizes.join('/'));
}
await trayIcon();


/**
 * Builds the page, with the device's engine inside it, and the app icon.
 *
 * The bundle has to be self-contained: the window loads it from a file, with
 * no resolver and no node_modules to reach into. The engine is the firmware's
 * code compiled to WebAssembly, committed in `engine/prebuilt`.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, 'ui');
const repository = join(here, '..', '..', '..');
const engine = join(here, '..', '..', 'engine', 'prebuilt', 'engine.js');

if (!existsSync(engine)) {
  console.error('The engine is missing from desktop/engine/prebuilt. Run: npm run build:engine (needs Emscripten).');
  process.exit(1);
}

await esbuild.build({
  entryPoints: [join(here, 'src/webview/main.ts')],
  outfile: join(ui, 'webview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  // Emscripten's loader names these for Node, behind a check that is never true in a page.
  external: ['node:*', 'fs', 'path', 'crypto', 'url', 'module', 'worker_threads'],
  // The device's sound cues (assets/audio), inside the bundle as bytes.
  loader: { '.wav': 'binary' },
  logLevel: 'warning',
});
console.log('built the page with the device engine');

/**
 * The app icon, made from the project logo at the top of the README
 * (images/logo.png), which has a transparent background.
 */
async function appIcon() {
  const { default: sharp } = await import('sharp');
  const face = await sharp(join(repository, 'images', 'logo.png'))
    .ensureAlpha().trim({ threshold: 0 }).png().toBuffer();

  // Every size Windows asks for, drawn at that size, so the tray is not blurred.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(size => sharp(face)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()));

  const header = Buffer.alloc(6);
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

  // Generated, so not in the repository; the folder will not exist in a fresh clone.
  const icons = join(here, 'src-tauri', 'icons');
  await mkdir(icons, { recursive: true });
  await writeFile(join(icons, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
  // macOS and Linux make their icons from this one, so it is larger than the .ico's largest.
  await writeFile(join(icons, 'icon.png'), await sharp(face)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
  // The logo for the page that says the companion service is starting.
  await writeFile(join(ui, 'logo.png'), images[sizes.indexOf(128)]);
  console.log('app icon made from the project logo, at ' + sizes.join('/'));
}
await appIcon();

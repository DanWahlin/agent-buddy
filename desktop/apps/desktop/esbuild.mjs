/**
 * Builds the page, with the device's engine inside it, and the app icon.
 *
 * The bundle has to be self-contained: the window loads it from a file, with
 * no resolver and no node_modules to reach into. The engine is the firmware's
 * code compiled to WebAssembly by `engine/build.mjs`, which runs first.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, 'ui');
const repository = join(here, '..', '..', '..');
const engine = join(here, '..', '..', 'engine', 'dist', 'engine.js');

if (!existsSync(engine)) {
  console.error('The engine is not built. Run: node engine/build.mjs (needs Emscripten).');
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
  logLevel: 'warning',
});
console.log('built the page with the device engine');

/**
 * The app icon, cut from Copilot's approved centre pose: the character looking
 * straight out. The source is drawn on black, so the backdrop is flooded away
 * from the edges, which keeps the dark parts inside the face.
 */
async function appIcon() {
  const { default: sharp } = await import('sharp');
  const source = join(repository, 'characters', 'copilot', 'source', 'generated-sprites', 'approved-center.png');
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const background = new Uint8Array(width * height);
  const queue = [];
  const push = index => {
    if (background[index]) return;
    const at = index * 4;
    if (Math.max(data[at], data[at + 1], data[at + 2]) > 24) return;
    background[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (queue.length) {
    const index = queue.pop();
    const x = index % width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (index >= width) push(index - width);
    if (index < width * (height - 1)) push(index + width);
  }
  for (let i = 0; i < width * height; i++) if (background[i]) data[i * 4 + 3] = 0;
  const face = await sharp(data, { raw: { width, height, channels: 4 } })
    .trim({ threshold: 0 }).png().toBuffer();

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
  await writeFile(join(icons, 'icon.png'), images[images.length - 1]);
  console.log('app icon cut from copilot, at ' + sizes.join('/'));
}
await appIcon();

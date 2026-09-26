import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const output = path.join(root, 'characters/openclaw/renders');
const tracks = [
  'right', 'left', 'up', 'down', 'up_right', 'up_left', 'down_right', 'down_left',
  'surprise', 'working', 'complete', 'attention', 'attention_alternate',
];
const trackFlag = process.argv.indexOf('--track');
const requestedTrack = trackFlag >= 0 ? process.argv[trackFlag + 1] : undefined;
if (trackFlag >= 0 && !tracks.includes(requestedTrack)) {
  throw new Error(`Unknown OpenClaw track: ${requestedTrack ?? '(missing)'}`);
}
const renderedTracks = requestedTrack ? [requestedTrack] : tracks;
const mime = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.json', 'application/json'],
]);

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(directory, relative);
  if (!target.startsWith(directory + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const {readFile} = await import('node:fs/promises');
    const data = await readFile(target);
    response.writeHead(200, {'Content-Type': mime.get(path.extname(target)) || 'application/octet-stream'});
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({headless: true});
try {
  await mkdir(output, {recursive: true});
  const page = await browser.newPage({viewport: {width: 240, height: 224}, deviceScaleFactor: 1});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.openClawReady);
  let directions = {};
  const manifestPath = path.join(output, 'animation.json');
  if (requestedTrack) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!existing.directions || tracks.some(track => !existing.directions[track]))
      throw new Error('Targeted rendering requires a complete existing OpenClaw manifest.');
    directions = existing.directions;
  }
  for (const track of renderedTracks) {
    const frames = [];
    for (let step = 0; step < 24; ++step) {
      const files = [];
      for (let blink = 0; blink < 5; ++blink) {
        const dataUrl = await page.evaluate(
          pose => window.renderOpenClaw(pose), {track, step, blink});
        const suffix = blink ? `-blink-${blink}` : '';
        const file = `${track}-${String(step).padStart(2, '0')}${suffix}.png`;
        await writeFile(path.join(output, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
        files.push(file);
      }
      frames.push({
        file: files[0],
        blinks: files.slice(1),
        eyes: [],
        sourceBounds: [0, 0, 240, 224],
        sourceIndex: step,
      });
    }
    directions[track] = {
      title: `Procedural 3D OpenClaw ${track} track`,
      provider: 'local-procedural-threejs',
      source: 'characters/openclaw/reference/reference.svg',
      width: 240,
      height: 224,
      count: 24,
      frames,
    };
    process.stdout.write(`Rendered ${track}\n`);
  }
  const manifest = {
    width: 240,
    height: 224,
    count: 24,
    directions,
    blinkLevels: [1, .75, .5, .25, 0],
    model: 'characters/openclaw/model/model.js',
    source: 'characters/openclaw/reference/reference.svg',
    processing: 'Deterministic Three.js beveled 3D geometry rendered to black-backed PNG sprites.',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

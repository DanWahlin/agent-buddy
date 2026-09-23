/**
 * Static server for the harness. The pack and the built renderer live outside
 * the harness directory, so both are mounted rather than copied.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const mounts = [
  ['/pack/', resolve(here, '..', '..', 'packs', 'marvin')],
  ['/dist/', join(here, 'dist')],
  ['/pack-format/', resolve(here, '..', 'pack-format', 'dist')],
  ['/', join(here, 'harness')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
};

const port = Number(process.env.PORT ?? 4321);
createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;

  for (const [prefix, root] of mounts) {
    if (!path.startsWith(prefix)) continue;
    // join + the containment check below is what actually stops traversal.
    const file = join(root, normalize(path.slice(prefix.length)));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) continue;
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found: ' + path);
}).listen(port, () => {
  console.log('Harness on http://localhost:' + port);
});

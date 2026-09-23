// The vendored motion engine is plain JS and deliberately not compiled, so the
// copy in dist stays byte-identical to upstream.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const to = join(here, '..', 'dist', 'vendor', 'sprite-motion.js');
mkdirSync(dirname(to), { recursive: true });
copyFileSync(join(here, '..', 'src', 'vendor', 'sprite-motion.js'), to);

// The compiled output imports the vendored file by the same relative path, so
// its CommonJS scoping has to travel with it.
import { writeFileSync } from 'node:fs';
writeFileSync(join(dirname(to), 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

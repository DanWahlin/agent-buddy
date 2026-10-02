/**
 * Compiles the firmware's animation engine to WebAssembly for the desktop app.
 *
 * The sources are the device's own, from firmware/AgentCompanion/src, so the
 * desktop draws exactly what the device draws. Needs Emscripten (`em++` on
 * PATH): `brew install emscripten`, or https://emscripten.org.
 *
 *   node engine/build.mjs [--out <file>]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '..', '..');
const firmware = join(repository, 'firmware', 'AgentCompanion', 'src');
const flag = process.argv.indexOf('--out');
const out = flag >= 0 ? process.argv[flag + 1] : join(here, 'dist', 'engine.js');

const sources = [
  join(here, 'engine.cpp'),
  ...['CharacterMotion', 'CharacterFrame', 'FullFrameRenderer', 'CharacterPack', 'AgentBadges', 'CharacterEffects',
    'SpriteMotion', 'SpriteRenderer', 'SpriteStorage'].map(name => join(firmware, name + '.cpp')),
];

mkdirSync(dirname(out), { recursive: true });
const compiler = process.env.EMXX ?? 'em++';
try {
  execFileSync(compiler, [
    '-std=c++17', '-O3', '-Wall', '-Wextra', '-Werror',
    '-sUSE_ZLIB=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sMODULARIZE=1',
    '-sEXPORT_NAME=createEngine',
    '-sENVIRONMENT=web,node',
    // One file, so the page needs no second fetch for the .wasm.
    '-sSINGLE_FILE=1',
    '-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToNewUTF8',
    '-sEXPORTED_FUNCTIONS=_malloc,_free',
    ...sources,
    '-o', out,
  ], { stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('em++ was not found. Install Emscripten (brew install emscripten) and try again.');
    process.exit(1);
  }
  throw error;
}
// Emscripten writes CommonJS; the workspace is ES modules, so say so here.
writeFileSync(join(dirname(out), 'package.json'), '{ "type": "commonjs" }\n');
console.log('built the device engine: ' + out);

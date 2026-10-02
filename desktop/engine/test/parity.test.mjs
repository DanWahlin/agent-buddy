/**
 * The desktop engine draws exactly what the device draws.
 *
 * Runs the repository's native character preview (the firmware's own sources
 * compiled for this machine, tools/character_preview.cpp) beside the
 * WebAssembly engine, gives both the same seed and the same commands, and
 * compares every frame pixel for pixel across every mode.
 *
 * Needs the packs (python3 tools/character_pack.py build), a C++ compiler with
 * zlib, and the built engine (node engine/build.mjs). Skips when any is absent.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '..', '..', '..');
const enginePath = join(here, '..', 'dist', 'engine.js');
const packs = join(repository, 'build', 'characters');
const firmware = join(repository, 'firmware', 'AgentCompanion', 'src');
const SEED = 20260911;

function nativePreview() {
  const out = join(here, '..', 'dist', 'character-preview');
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(process.env.CXX ?? 'clang++', [
    '-std=c++17', '-O2',
    join(repository, 'tools', 'character_preview.cpp'),
    ...['CharacterMotion', 'CharacterFrame', 'FullFrameRenderer', 'CharacterPack', 'AgentBadges', 'CharacterEffects',
      'SpriteMotion', 'SpriteRenderer', 'SpriteStorage'].map(name => join(firmware, name + '.cpp')),
    '-lz', '-o', out,
  ], { stdio: 'inherit' });
  return out;
}

/** Drives the native preview over its line protocol, one frame per command. */
function nativeSession(binary) {
  const child = spawn(binary, [], { cwd: repository, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0);
  const waiting = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  function pump() {
    while (waiting.length) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const header = buffer.subarray(0, newline).toString();
      if (header.startsWith('ERR')) {
        waiting.shift().reject(new Error(header));
        buffer = buffer.subarray(newline + 1);
        continue;
      }
      const bytes = Number(header.split(' ')[1]);
      if (buffer.length < newline + 1 + bytes) return;
      const frame = Buffer.from(buffer.subarray(newline + 1, newline + 1 + bytes));
      buffer = buffer.subarray(newline + 1 + bytes);
      waiting.shift().resolve(frame);
    }
  }
  return {
    frame(dt, mode, character, direction = -1) {
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        child.stdin.write(`${dt} ${mode} 1 ${character} ${direction}\n`);
      });
    },
    close() { child.stdin.end(); },
  };
}

const ready = existsSync(enginePath) && existsSync(join(packs, 'copilot.acpk'));

for (const character of ['copilot', 'claude', 'openclaw']) {
  test(`${character}: the desktop engine matches the device frame for frame`,
    { skip: ready ? false : 'needs the built engine and packs' }, async () => {
      const require = createRequire(import.meta.url);
      const engine = await require(enginePath)();
      const bytes = readFileSync(join(packs, character + '.acpk'));
      engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
      assert.equal(engine._ac_load_reserved(SEED), 1, engine.UTF8ToString(engine._ac_error()));

      const width = engine._ac_width();
      const height = engine._ac_height();
      const native = nativeSession(nativePreview());
      // Idle, then every mode in turn, each held long enough to see its effects.
      const script = [
        ...Array(60).fill(-1),
        2, ...Array(150).fill(-1),
        4, ...Array(120).fill(-1),
        3, ...Array(100).fill(-1),
        1, ...Array(40).fill(-1),
        0, ...Array(40).fill(-1),
      ];
      const dt = 1 / 30;
      let compared = 0;
      try {
        for (const mode of script) {
          if (mode >= 0) assert.equal(engine._ac_mode(mode, 0), 1);
          const pixels = engine._ac_frame(dt, 0);
          assert.notEqual(pixels, 0, engine.UTF8ToString(engine._ac_error()));
          const expected = await native.frame(dt, mode, character);
          const rgba = engine.HEAPU8.subarray(pixels, pixels + width * height * 4);
          for (let i = 0; i < width * height; i++) {
            if (rgba[i * 4 + 3] === 0) continue;
            const swapped = expected.readUInt16LE(i * 2);
            const rgb = ((swapped << 8) | (swapped >> 8)) & 0xffff;
            const r = Math.floor(((rgb >> 11) & 31) * 255 / 31);
            const g = Math.floor(((rgb >> 5) & 63) * 255 / 63);
            const b = Math.floor((rgb & 31) * 255 / 31);
            if (rgba[i * 4] !== r || rgba[i * 4 + 1] !== g || rgba[i * 4 + 2] !== b) {
              assert.fail(`frame ${compared} differs at ${i % width},${Math.floor(i / width)}`);
            }
          }
          compared++;
        }
      } finally {
        native.close();
      }
      assert.equal(compared, script.length);
    });
}

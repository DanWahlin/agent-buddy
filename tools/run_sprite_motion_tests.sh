#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p build
"${CXX:-clang++}" -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/test_sprite_motion.cpp firmware/AgentCompanion/src/SpriteMotion.cpp \
  -o build/test-sprite-motion
build/test-sprite-motion
node --test tests/sprite-motion.test.cjs
node <<'NODE'
'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {SpriteMotion, DIRECTIONS} = require('./web/sprite-motion.js');
const phases = ['center', 'out', 'endpoint', 'return'];
const blinkPhases = ['idle', 'closing', 'closed', 'opening'];
let compared = 0;
for (const seed of [0, 1, 42, 0xffffffff]) {
  for (const fps of [30, 60, 120, 0]) {
    for (const scenario of [0, 1, 2]) {
      const count = scenario === 1 ? 33 : 24;
      const ticks = 6000, eased = scenario !== 2;
      const native = spawnSync('./build/test-sprite-motion',
        ['--trace', seed, count, fps, ticks, scenario, Number(eased)].map(String),
        {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
      assert.equal(native.status, 0, native.stderr);
      const rows = native.stdout.trim().split('\n');
      assert.equal(rows.length, ticks);
      let rng = seed || 0x6d2b79f5;
      const p = new SpriteMotion({count, random: () => {
        rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
        return (rng >>> 0) / 4294967296;
      }});
      p.setEased(eased);
      if (scenario === 1) p.setCycle(true);
      for (let i = 0; i < ticks; i++) {
        if (scenario === 2) {
          if (i === 50 || i === 1500) p.setPlaying(false);
          if (i === 70 || i === 1520) p.setPlaying(true);
          if (i % 337 === 0) p.request(DIRECTIONS[Math.floor(i / 337) % 8]);
          if (i % 113 === 0) p.requestBlink();
          if (i === 1000) p.setBlinks(false);
          if (i === 2000) p.setBlinks(true);
          if (i === 3000) { p.setSpeed(3); p.setDuration(.4); }
          if (i === 4000) { p.setSpeed(.75); p.setDuration(2.4); }
          if (i % 71 === 0) p.setEased(Math.floor(i / 71) % 2 === 0);
        }
        const dt = i % 97 === 0 ? 999 : fps ? 1 / fps : [1 / 60, 1 / 90, 1 / 45, 1 / 120][i % 4];
        p.update(dt);
        const expected = [DIRECTIONS.indexOf(p.direction), p.index, p.blinkLevel,
          phases.indexOf(p.phase), p.progress, p.target, p.hold, blinkPhases.indexOf(p.blinkPhase),
          p.blinkElapsed, p.blinkWait, Number(p.doublePending)];
        const actual = rows[i].split(',').map(Number);
        for (let j = 0; j < expected.length; j++) {
          assert.ok(Math.abs(actual[j] - expected[j]) < 1e-10,
            `seed=${seed} fps=${fps} scenario=${scenario} tick=${i} field=${j}: ${actual[j]} != ${expected[j]}`);
        }
        compared++;
      }
    }
  }
}
console.log(`C++/JavaScript xorshift parity: ${compared} complete state snapshots passed`);
NODE

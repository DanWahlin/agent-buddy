const test = require('node:test');
const assert = require('node:assert/strict');
const {SpriteMotion, DIRECTIONS, quintic, inverseQuintic} = require('../src/vendor/sprite-motion.js');

function create(options = {}) {
  const player = new SpriteMotion({random: () => .5, ...options});
  player.setAuto(false);
  player.setBlinks(false);
  return player;
}
function until(player, predicate, delta = 1 / 60, limit = 30000) {
  for (let i = 0; i < limit; i++) {
    if (predicate(player)) return;
    const prior = player.index, direction = player.direction;
    player.update(delta);
    assert.ok(Math.abs(player.index - prior) <= 1, 'each update changes at most one index');
    if (direction !== player.direction) {
      assert.equal(prior, 0, 'old track is centered before switching');
      assert.equal(player.index, 0, 'new track starts at center');
    }
  }
  assert.fail('Player did not reach the requested state');
}
function pose(player) {
  return [player.direction, player.index, player.phase, player.progress, player.blinkLevel, player.blinkPhase];
}

test('quintic is monotonic, invertible, and slower near both endpoints', () => {
  for (let i = 0; i <= 100; i++) {
    const value = i / 100;
    assert.ok(Math.abs(quintic(inverseQuintic(value)) - value) < 1e-8);
  }
  assert.ok(inverseQuintic(1 / 23) > inverseQuintic(12 / 23) - inverseQuintic(11 / 23));
});

test('each direction visits every permitted outbound pose and the exact reverse', () => {
  for (const direction of DIRECTIONS) {
    const player = create();
    player.request(direction);
    until(player, p => p.phase === 'out');
    const outward = [0], inward = [];
    until(player, p => {
      if (outward.at(-1) !== p.index) outward.push(p.index);
      return p.phase === 'endpoint';
    });
    until(player, p => p.phase === 'return');
    inward.push(player.index);
    until(player, p => {
      if (inward.at(-1) !== p.index) inward.push(p.index);
      return p.phase === 'center';
    });
    const count = direction === 'up' || direction === 'down' ? 12 : 24;
    assert.deepEqual(outward, Array.from({length: count}, (_, i) => i));
    assert.deepEqual(inward, outward.toReversed());
    assert.equal(player.direction, direction);
  }
});

test('fractional timing keeps every pose boundary within one refresh of its eased schedule', () => {
  for (const direction of DIRECTIONS) {
    for (const fps of [30, 60, 120]) {
      const player = create();
      player.request(direction);
      until(player, p => p.phase === 'out', 1 / fps);
      const duration = player.duration * Math.sqrt(player.target / (player.count - 1));
      for (const phase of ['out', 'return']) {
        if (phase === 'return') until(player, p => p.phase === 'return', 1 / fps);
        let elapsed = 0;
        while (player.phase === phase) {
          const previous = player.index;
          player.update(1 / fps);
          elapsed += 1 / fps;
          if (player.index !== previous) {
            const travelled = phase === 'out' ? player.index : player.target - player.index;
            const position = travelled / player.target;
            const expected = duration * (direction === 'right' ? position : inverseQuintic(position));
            assert.ok(elapsed >= expected - 1e-9);
            assert.ok(elapsed - expected <= 1 / fps + 1e-9,
              `${direction} ${phase} at ${fps} Hz accumulated pose timing error`);
          }
        }
        assert.ok(Math.abs(elapsed - duration) <= 1 / fps + 1e-9);
      }
    }
  }
});

test('irregular refresh intervals preserve ordinary fractional time without a catch-up burst', () => {
  const player = create();
  player.request('right');
  until(player, p => p.phase === 'out');
  const deltas = [1 / 60, 1 / 90, 1 / 45, 1 / 120];
  let elapsed = 0, tick = 0;
  while (player.phase === 'out') {
    const previous = player.index;
    const delta = deltas[tick++ % deltas.length];
    player.update(delta);
    elapsed += delta;
    assert.ok(player.index - previous <= 1);
    if (previous !== player.index) {
      const expected = player.duration * player.index / player.target;
      assert.ok(elapsed >= expected - 1e-9);
      assert.ok(elapsed - expected <= Math.max(...deltas) + 1e-9);
    }
  }
});

test('crossfade samples adjacent poses without changing motion, pause, or inspection', () => {
  const player = create();
  player.request('right');
  until(player, p => p.index === 8);
  player.progress = .5;
  player.setPlaying(false);
  const state = JSON.stringify(player);
  assert.deepEqual(player.sample(), {from: 8, to: 8, mix: 0});
  assert.deepEqual(player.sample(true), {from: 8, to: 9, mix: .5});
  assert.equal(JSON.stringify(player), state);
  player.phase = 'return';
  assert.deepEqual(player.sample(true), {from: 8, to: 7, mix: .5});
  player.inspect(8);
  assert.deepEqual(player.sample(true), {from: 8, to: 8, mix: 0});
});

test('crossfade never samples beyond a vertical travel limit or across tracks', () => {
  const player = create();
  player.setCycle(true);
  for (let i = 0; i < 5000; i++) {
    player.update(1 / 60);
    const sample = player.sample(true);
    const limit = player.direction === 'up' || player.direction === 'down' ? 11 : 23;
    assert.ok(sample.to >= 0 && sample.to <= limit);
    assert.ok(Math.abs(sample.from - sample.to) <= 1);
    assert.ok(sample.mix >= 0 && sample.mix <= 1);
    if (player.phase === 'center' || player.phase === 'endpoint') {
      assert.equal(sample.to, player.index);
      assert.equal(sample.mix, 0);
    }
  }
});

test('long stalls and extremely fast turns never skip or catch up', () => {
  const player = create();
  player.setDuration(.001);
  player.setSpeed(100);
  player.request('down');
  until(player, p => p.phase === 'out', 60);
  player.update(3600);
  assert.equal(player.index, 1);
  const state = pose(player);
  player.update(0);
  assert.deepEqual(pose(player), state);
  until(player, p => p.phase === 'center', 3600);
  assert.equal(player.index, 0);
  const normal = create(), stalled = create();
  normal.request('right'); stalled.request('right');
  normal.update(1 / 30); stalled.update(999);
  assert.deepEqual(pose(normal), pose(stalled), 'stall time is dropped');
});

test('queued requests preserve the active turn and return before each center switch', () => {
  const player = create();
  player.request('right');
  until(player, p => p.index === 8);
  player.request('up'); player.request('left'); player.request('down');
  until(player, p => p.phase === 'endpoint');
  assert.equal(player.index, 23);
  assert.equal(player.direction, 'right');
  for (const direction of ['up', 'left', 'down']) {
    until(player, p => p.direction === direction && p.phase === 'out');
    assert.equal(player.index, 0);
    until(player, p => p.phase === 'center');
  }
  assert.deepEqual(player.queue, []);
});

test('pause, queued track selection, duration, speed, and easing preserve the exact pose', () => {
  const player = create();
  player.request('right');
  until(player, p => p.index === 12 && p.progress > .1);
  player.setPlaying(false);
  const state = pose(player);
  player.request('left');
  player.setDuration(.8); player.setEased(false); player.setSpeed(.25);
  player.update(800);
  assert.deepEqual(pose(player), state);
  player.setPlaying(true);
  assert.deepEqual(pose(player), state);
  until(player, p => p.direction === 'left');
});

test('inspection is explicit and resume safely reverses from the selected frame', () => {
  const player = create();
  player.request('up');
  until(player, p => p.direction === 'up');
  player.inspect(23);
  player.request('down');
  assert.equal(player.inspecting, true);
  assert.equal(player.playing, false);
  assert.equal(player.direction, 'up');
  player.update(500);
  assert.equal(player.index, 23);
  player.setPlaying(true);
  const seen = [23];
  until(player, p => {
    if (seen.at(-1) !== p.index) seen.push(p.index);
    return p.phase === 'center';
  });
  assert.deepEqual(seen, Array.from({length: 24}, (_, i) => 23 - i));
  until(player, p => p.direction === 'down');
});

test('all-direction review repeats deterministically at direction travel limits', () => {
  const player = create();
  player.setCycle(true);
  for (const direction of [...DIRECTIONS, ...DIRECTIONS]) {
    until(player, p => p.phase === 'out');
    assert.equal(player.direction, direction);
    assert.equal(player.target, direction === 'up' || direction === 'down' ? 11 : 23);
    until(player, p => p.phase === 'center');
  }
  player.setCycle(false);
  for (let i = 0; i < 1000; i++) player.update(1 / 60);
  assert.equal(player.phase, 'center');
  assert.equal(player.index, 0);
});

test('random mode varies directions, holds, and depths without switching off center', () => {
  let seed = 42;
  const player = create({random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)});
  player.setAuto(true);
  const directions = new Set(), targets = new Set(), holds = new Set();
  for (let i = 0; i < 40; i++) {
    const previous = player.direction;
    until(player, p => p.phase === 'out');
    assert.notEqual(player.direction, previous);
    const limit = player.direction === 'up' || player.direction === 'down' ? 11 : 23;
    assert.ok(player.target >= Math.round(.55 * limit) && player.target <= limit);
    directions.add(player.direction); targets.add(player.target);
    until(player, p => p.phase === 'endpoint');
    if (player.direction === 'right') assert.equal(player.hold, .001);
    else holds.add(player.hold);
    until(player, p => p.phase === 'center'); holds.add(player.hold);
  }
  assert.equal(directions.size, DIRECTIONS.length);
  assert.ok(targets.size > 5);
  assert.ok(holds.size > 20);
});

test('vertical travel is capped at 50 percent for different sprite counts', () => {
  for (const count of [24, 33]) {
    for (const direction of DIRECTIONS) {
      const player = create({count});
      player.request(direction);
      until(player, p => p.phase === 'out');
      const factor = direction === 'up' || direction === 'down' ? .5 : 1;
      assert.equal(player.target, Math.floor((count - 1) * factor));
      assert.equal(player.count, count, 'all images remain available to inspection');
    }
  }
});

test('forced blink adds no head dwell or timing changes during an active turn and return', () => {
  const normal = create(), blinking = create();
  for (const player of [normal, blinking]) {
    player.request('right');
    until(player, p => p.index === 8);
  }
  blinking.requestBlink();
  const initial = blinking.index;
  let movedWhileBlinking = false;
  for (let i = 0; i < 700; i++) {
    const priorIndex = blinking.index, priorLevel = blinking.blinkLevel;
    const delta = i % 17 === 0 ? 30 : 1 / 60;
    normal.update(delta); blinking.update(delta);
    assert.deepEqual(
      [blinking.index, blinking.phase, blinking.progress, blinking.direction],
      [normal.index, normal.phase, normal.progress, normal.direction],
      'blink must not delay the head timeline'
    );
    assert.ok(Math.abs(blinking.index - priorIndex) <= 1);
    assert.ok(Math.abs(blinking.blinkLevel - priorLevel) <= 1);
    if (blinking.blinkLevel > 0 && blinking.index !== initial) movedWhileBlinking = true;
  }
  assert.equal(movedWhileBlinking, true);
});

test('stationary-center blink exactly reverses; global pause and disable never reset it', () => {
  const player = create();
  player.inspect(0);
  player.setPlaying(true);
  player.requestBlink();
  const levels = [0], head = player.index;
  until(player, p => p.blinkPhase === 'closing');
  until(player, p => p.blinkLevel === 2);
  player.setPlaying(false);
  const state = pose(player);
  player.setBlinks(false); player.update(100);
  assert.deepEqual(pose(player), state);
  player.setPlaying(true);
  levels.push(1, 2);
  until(player, p => {
    assert.equal(p.index, head);
    if (levels.at(-1) !== p.blinkLevel) levels.push(p.blinkLevel);
    return p.blinkPhase === 'idle';
  });
  assert.deepEqual(levels, [0, 1, 2, 3, 4, 3, 2, 1, 0]);
  assert.equal(player.index, head);
});

test('global pause freezes an active head turn and blink together', () => {
  const player = create();
  player.request('up');
  until(player, p => p.index === 8);
  player.requestBlink();
  until(player, p => p.blinkLevel === 2);
  player.setPlaying(false);
  const state = pose(player), elapsed = player.blinkElapsed;
  player.update(300);
  assert.deepEqual(pose(player), state);
  assert.equal(player.blinkElapsed, elapsed);
  player.setPlaying(true);
  player.update(1 / 60);
  assert.ok(Math.abs(player.index - state[1]) <= 1);
  assert.ok(Math.abs(player.blinkLevel - state[4]) <= 1);
});

test('blink requests while paused wait for Play; occasional doubles terminate', () => {
  const player = create({random: () => 0, playing: false});
  player.setBlinks(true);
  player.requestBlink(); player.update(100);
  assert.equal(player.blinkPhase, 'idle');
  assert.equal(player.blinkQueued, true);
  player.setPlaying(true);
  until(player, p => p.blinkPhase === 'closing');
  until(player, p => p.blinkPhase === 'idle');
  assert.equal(player.doublePending, true);
  until(player, p => p.blinkPhase === 'closing');
  assert.equal(player.doublePending, false);
  until(player, p => p.blinkPhase === 'idle');
  assert.equal(player.blinkWait, 3);
});

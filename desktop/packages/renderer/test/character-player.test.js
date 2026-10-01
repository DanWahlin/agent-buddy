import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CharacterPlayer, IDLE_BEFORE_SLEEP_SECONDS, PackRenderer, SLEEP_SECONDS,
} from '../dist/index.js';

const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'packs', 'marvin');
const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8'));

/** Deterministic, and cycles so track choices are not all the same. */
function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** Advance in 60fps slices so timing-dependent phases actually progress. */
function run(player, seconds, onFrame) {
  const dt = 1 / 60;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    player.update(dt);
    onFrame?.(player);
  }
}

function newPlayer(overrides = {}) {
  return new CharacterPlayer({ pack, random: sequence([0.1, 0.4, 0.7, 0.9]), ...overrides });
}

test('starts idle, gazing', () => {
  const player = newPlayer();
  assert.equal(player.state, 'idle');
  assert.equal(player.sleeping, false);
  const pose = player.pose();
  assert.ok(pack.tracks[pose.track], 'idle should sit on a real track');
  assert.equal(pose.from, 0, 'and start from the centre pose');
});

test('idle wanders across gaze tracks', () => {
  const player = newPlayer();
  const seen = new Set();
  run(player, 30, p => seen.add(p.pose().track));
  assert.ok(seen.size > 1, 'expected the look-around to change direction, saw ' + [...seen]);
  for (const track of seen) {
    assert.ok(pack.tracks[track], track + ' is not in the pack');
  }
});

test('idle blinks, and closes fully at some point', () => {
  const player = newPlayer();
  const levels = new Set();
  run(player, 40, p => levels.add(p.pose().blinkLevel));
  assert.ok(levels.has(0), 'should spend most of its time open');
  assert.ok(Math.max(...levels) === pack.blinkLevels.length - 1, 'should close fully mid-blink');
});

test('a state change waits for the centre pose, then ramps', () => {
  const player = newPlayer();
  // Get the gaze away from centre first, so the wait is observable.
  run(player, 3);
  assert.ok(player.pose().from > 0, 'the gaze should be mid-turn before we ask');

  player.setState('working');
  let framesWaited = 0;
  let firstExpression = null;
  run(player, 6, p => {
    if (p.state !== 'working') { framesWaited++; return; }
    firstExpression ??= p.pose();
  });

  // Frame 0 is the shared centre pose every track agrees on. Cutting to an
  // expression from a turned head is exactly the jump that invariant prevents.
  assert.ok(framesWaited > 1, 'should not cut away mid-turn, waited ' + framesWaited + ' frames');
  assert.equal(firstExpression.track, 'working');
  assert.equal(firstExpression.from, 0, 'an expression must start from the centre pose');
  assert.equal(player.state, 'working');
  assert.equal(player.pose().from, pack.steps - 1, 'and hold at full strength');
});

test('a state change from the centre pose is immediate', () => {
  const player = newPlayer();
  player.setState('attention');
  run(player, 1 / 30);
  assert.equal(player.state, 'attention', 'nothing to wait for when already centred');
  assert.equal(player.pose().from, 0);
});

test('an expression ramps out through every step rather than cutting', () => {
  const player = newPlayer();
  player.setState('working');
  run(player, 2);

  const visited = new Set();
  player.setState('idle');
  run(player, 2, p => {
    if (p.state === 'working') visited.add(p.pose().from);
  });
  assert.ok(visited.size > 3,
    'leaving should walk back down the track, saw steps ' + [...visited].sort((a, b) => a - b));
  assert.equal(player.state, 'idle');
});

test('attention picks from the tracks the pack offers', () => {
  const chosen = new Set();
  for (const value of [0, 0.99]) {
    const player = newPlayer({ random: () => value });
    player.setState('attention');
    run(player, 4);
    chosen.add(player.pose().track);
  }
  assert.deepEqual([...chosen].sort(), ['attention', 'attention_alternate']);
});

test('a state the pack cannot render falls back to idle rather than breaking', () => {
  const thin = structuredClone(pack);
  delete thin.tracks.working;
  thin.states.working = 'working';

  const player = new CharacterPlayer({ pack: thin, random: () => 0 });
  player.setState('working');
  run(player, 4);
  assert.equal(player.state, 'idle');
  assert.ok(thin.tracks[player.pose().track], 'should be gazing on a track it has');
});

test('sleep holds the centre pose with the eyes closed', () => {
  const player = newPlayer();
  player.setSleeping(true);
  run(player, 4);

  assert.equal(player.sleeping, true);
  const pose = player.pose();
  assert.equal(pose.track, pack.sleep.track);
  assert.equal(pose.from, pack.sleep.step);
  assert.equal(pose.blinkLevel, pack.sleep.blinkLevel);
  assert.equal(pose.mix, 0, 'a held pose should not cross-fade');
});

test('waking returns to the look-around', () => {
  const player = newPlayer();
  player.setSleeping(true);
  run(player, 3);
  player.setSleeping(false);
  run(player, 3);

  assert.equal(player.sleeping, false);
  assert.equal(player.state, 'idle');
  const levels = new Set();
  run(player, 20, p => levels.add(p.pose().blinkLevel));
  assert.ok(levels.has(0), 'the eyes should open again');
});

test('lookAt steers the gaze, and is ignored mid-expression', () => {
  const player = newPlayer();
  player.lookAt('up_left');
  let reached = false;
  run(player, 8, p => { if (p.pose().track === 'up_left') reached = true; });
  assert.ok(reached, 'a requested direction should be visited');

  player.setState('working');
  run(player, 3);
  const before = player.pose().track;
  player.lookAt('down_right');
  run(player, 1);
  assert.equal(player.pose().track, before, 'an expression should not be interrupted by a look');
});

test('never asks for a pose the pack does not have', () => {
  const player = newPlayer();
  const states = ['working', 'attention', 'complete', 'surprise', 'idle'];
  let index = 0;
  run(player, 40, p => {
    if (Math.random() < 0.01) p.setState(states[index++ % states.length]);
    const pose = p.pose();
    const track = pack.tracks[pose.track];
    assert.ok(track, 'unknown track ' + pose.track);
    for (const step of [pose.from, pose.to]) {
      assert.ok(Number.isInteger(step) && step >= 0 && step < pack.steps,
        'step ' + step + ' is outside 0..' + (pack.steps - 1));
    }
    assert.ok(pose.blinkLevel >= 0 && pose.blinkLevel < pack.blinkLevels.length,
      'blink level ' + pose.blinkLevel + ' is out of range');
    assert.ok(pose.mix >= 0 && pose.mix <= 1, 'mix ' + pose.mix + ' is out of range');
  });
});

test('imageNames lists exactly what the pack references', () => {
  const names = PackRenderer.imageNames(pack);
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  for (const track of Object.values(pack.tracks)) {
    assert.ok(names.includes(track.base));
    if (track.blinks) assert.ok(names.includes(track.blinks));
  }
  assert.ok(names.every(name => name.endsWith('.webp')));
});

// --- the idle cycle ---------------------------------------------------------

test('dozes off after two idle minutes and wakes a minute later', () => {
  const player = newPlayer();
  run(player, IDLE_BEFORE_SLEEP_SECONDS - 5);
  assert.equal(player.sleeping, false, 'still awake just before the threshold');

  run(player, 10);
  assert.equal(player.sleeping, true, 'asleep once the idle time passes');
  assert.equal(player.dozing, true, 'and it is the cycle keeping him under');

  run(player, SLEEP_SECONDS);
  assert.equal(player.sleeping, false, 'wakes on its own');

  // And round again, which is what upstream does rather than sleeping forever.
  run(player, IDLE_BEFORE_SLEEP_SECONDS + 1);
  assert.equal(player.sleeping, true);
});

test('an agent state keeps him up, and wakes him if he already went', () => {
  const player = newPlayer();
  run(player, IDLE_BEFORE_SLEEP_SECONDS - 10);
  player.setState('working');
  run(player, 30);
  assert.equal(player.sleeping, false, 'the clock restarted when the state changed');

  player.setState('idle');
  // Sleeping routes through the centre pose like any other change, so allow
  // for the walk home rather than asserting on the tick it is decided.
  run(player, IDLE_BEFORE_SLEEP_SECONDS + 5);
  assert.equal(player.sleeping, true);

  // A hook arriving mid-doze should wake him rather than queue behind the timer.
  player.setState('working');
  run(player, 2);
  assert.equal(player.sleeping, false);
  assert.equal(player.state, 'working');
});

test('being looked at or poked resets the clock', () => {
  for (const disturb of [p => p.lookAt('up_left'), p => p.pulse('surprise')]) {
    const player = newPlayer();
    run(player, IDLE_BEFORE_SLEEP_SECONDS - 5);
    disturb(player);
    run(player, 20);
    assert.equal(player.sleeping, false, 'attention should postpone sleeping');
  }
});

test('a hand-set sleep is left alone by the cycle', () => {
  const player = newPlayer();
  player.setSleeping(true);
  run(player, SLEEP_SECONDS + 30);
  assert.equal(player.sleeping, true, 'the cycle must not wake a deliberate sleep');
  assert.equal(player.dozing, false);

  player.setSleeping(false);
  run(player, 5);
  assert.equal(player.sleeping, false);
});

test('the cycle can be turned off, and off means off', () => {
  const player = newPlayer({ autoSleep: false });
  run(player, IDLE_BEFORE_SLEEP_SECONDS + SLEEP_SECONDS);
  assert.equal(player.sleeping, false);

  // Turning it on later starts the clock from then, not from whenever he
  // happened to go quiet.
  player.setAutoSleep(true);
  run(player, IDLE_BEFORE_SLEEP_SECONDS - 5);
  assert.equal(player.sleeping, false);
  run(player, 10);
  assert.equal(player.sleeping, true);

  // Turning it off should release a sleep it caused.
  player.setAutoSleep(false);
  run(player, 2);
  assert.equal(player.sleeping, false);
});

// --- pulses -----------------------------------------------------------------

test('a poke shows briefly and then gives the state back', () => {
  const player = newPlayer();
  player.setState('working');
  run(player, 3);
  assert.equal(player.state, 'working');

  player.pulse('surprise', 1.2);
  assert.equal(player.requestedState, 'surprise', 'requested at once, for the sparks');
  run(player, 1);
  assert.equal(player.state, 'surprise');

  run(player, 3);
  assert.equal(player.state, 'working', 'and back to what it was doing');
});

test('an agent event during a poke wins', () => {
  const player = newPlayer();
  player.pulse('surprise', 5);
  run(player, 0.5);

  player.setState('attention');
  run(player, 4);
  assert.equal(player.state, 'attention');

  // The pulse must not resurrect itself once its time is up.
  run(player, 4);
  assert.equal(player.state, 'attention');
});

test('poking twice extends rather than stacking', () => {
  const player = newPlayer();
  player.setState('working');
  run(player, 3);

  player.pulse('surprise', 1.2);
  run(player, 0.6);
  player.pulse('surprise', 1.2);
  run(player, 3);
  assert.equal(player.state, 'working', 'still returns to what it was, not to surprise');
});

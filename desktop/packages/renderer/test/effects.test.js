import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CharacterEffects, DEFAULT_PALETTE } from '../dist/index.js';

/** A context that records what the effects layer draws, and the clip it sets. */
function recordingContext() {
  const draws = [];
  const clips = [];
  let pending = null;
  return {
    draws, clips,
    fillStyle: '',
    save() {}, restore() {},
    beginPath() { pending = { rects: [], ellipses: [] }; },
    rect(x, y, w, h) { pending?.rects.push([x, y, w, h]); },
    ellipse(x, y, rx, ry) { pending?.ellipses.push([x, y, rx, ry]); },
    clip(rule) { clips.push({ rule, ...pending }); },
    arc(x, y, r) { draws.push({ kind: 'arc', x, y, r, fill: this.fillStyle }); },
    fill() {},
    fillRect(x, y, w, h) {
      draws.push({ kind: 'rect', x, y, w, h, fill: this.fillStyle });
    },
    clearRect() {},
  };
}

const W = 360;
const H = 336;

function draw(state, overrides = {}, palette = {}) {
  const context = recordingContext();
  new CharacterEffects(palette).draw(context, {
    state: 'idle', requested: 'idle', sleeping: false, seconds: 0, eventId: 1,
    ...{ state, requested: state }, ...overrides,
  }, W, H);
  return context;
}

/** Alpha out of an "rgba(r,g,b,a)" fill. */
function alphaOf(fill) {
  return Number(/rgba\([^)]*,([0-9.]+)\)$/.exec(fill)?.[1]);
}

test('idle draws nothing around the character', () => {
  assert.equal(draw('idle', { seconds: 2 }).draws.length, 0);
});

test('each reacting state draws something', () => {
  assert.ok(draw('working', { seconds: 1.5 }).draws.length > 0, 'working');
  assert.ok(draw('complete', { seconds: 1.0 }).draws.length > 0, 'complete');
  assert.ok(draw('attention', { seconds: 1.0 }).draws.length > 0, 'attention');
  assert.ok(draw('idle', { sleeping: true, seconds: 1.0 }).draws.length > 0, 'sleep');
});

test('the head is excluded by a clip, not by luck', () => {
  // Upstream guards every pixel with dx^2/160^2 + dy^2/135^2 < 1 about the
  // frame centre. Here that becomes one even-odd clip for the whole layer.
  const { clips } = draw('working', { seconds: 1 });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].rule, 'evenodd');

  const unit = W / 400;
  assert.deepEqual(clips[0].rects, [[0, 0, W, H]], 'the clip starts from the whole canvas');
  const [x, y, rx, ry] = clips[0].ellipses[0];
  assert.equal(rx, 160 * unit);
  assert.equal(ry, 135 * unit);
  assert.equal(x, 200 * unit, 'centred horizontally on the frame');
  // The effect frame is centred vertically when the view is a different shape.
  assert.equal(y, (H - 352 * unit) / 2 + 176 * unit);
});

test('the effect frame keeps one scale, so the orbit stays circular', () => {
  // A deliberately wrong-shaped view: the effects must not become elliptical.
  const context = recordingContext();
  new CharacterEffects().draw(context, {
    state: 'working', requested: 'working', sleeping: false, seconds: 1, eventId: 1,
  }, 400, 800);

  const [, , rx, ry] = context.clips[0].ellipses[0];
  assert.equal(rx / ry, 160 / 135, 'the head exclusion keeps the device proportions');
});

test('working draws an orbit whose tail brightens toward the leading dot', () => {
  const arcs = draw('working', { seconds: 1.5 }).draws.filter(d => d.kind === 'arc');
  assert.equal(arcs.length, 7, 'seven orbiting dots');

  const alphas = arcs.map(a => alphaOf(a.fill));
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(alphas[i] > alphas[i - 1], 'dot ' + i + ' should be brighter than the one behind');
  }
  // The leading dot is the large one.
  const radii = arcs.map(a => a.r);
  assert.ok(radii.at(-1) > radii[0], 'the leading dot is drawn larger');
});

test('working also rises ones and zeroes', () => {
  const rects = draw('working', { seconds: 1.5 }).draws.filter(d => d.kind === 'rect');
  assert.ok(rects.length > 0, 'the digit glyphs are drawn as blocks');
  assert.ok(rects.every(r => alphaOf(r.fill) <= 0.85),
    'upstream caps the digits at 0.85 opacity');
});

test('complete scatters differently for different events', () => {
  const first = draw('complete', { seconds: 1.2, eventId: 1 }).draws;
  const second = draw('complete', { seconds: 1.2, eventId: 2 }).draws;
  assert.notDeepEqual(first, second, 'the confetti seed comes from the event');

  const again = draw('complete', { seconds: 1.2, eventId: 1 }).draws;
  assert.deepEqual(first, again, 'but the same event scatters the same way');
});

test('complete stops after three seconds', () => {
  assert.ok(draw('complete', { seconds: 2.9 }).draws.length > 0);
  assert.equal(draw('complete', { seconds: 3.1 }).draws.length, 0);
});

test('attention breathes rather than sitting still', () => {
  const at = seconds => draw('attention', { seconds }).draws
    .map(d => alphaOf(d.fill)).reduce((a, b) => a + b, 0);
  // A quarter of the two second period apart, so the sine has actually moved.
  assert.notEqual(at(0).toFixed(3), at(1).toFixed(3));
});

test('surprise acknowledges before the state has even changed', () => {
  // Upstream fires this on the requested mode too, so the reaction is immediate
  // while the head is still walking back to centre.
  const early = draw('idle', { requested: 'surprise', seconds: 0.1, eventId: 3 });
  assert.ok(early.draws.length > 0, 'it should spark while still idle');

  const late = draw('idle', { requested: 'surprise', seconds: 0.6, eventId: 3 });
  assert.equal(late.draws.length, 0, 'and stop after half a second');
});

test('surprise does not fire before anything has happened', () => {
  assert.equal(draw('surprise', { seconds: 0.1, eventId: 0 }).draws.length, 0);
});

test('a pack can recolour the effects without supplying any art', () => {
  const plain = draw('working', { seconds: 1.5 });
  const themed = draw('working', { seconds: 1.5 }, { orbit: '255,0,0' });

  assert.ok(plain.draws.some(d => d.fill.includes(DEFAULT_PALETTE.orbit)));
  assert.ok(themed.draws.some(d => d.fill.includes('255,0,0')));
  assert.equal(plain.draws.length, themed.draws.length, 'only the colour changes');
});

test('an unspecified colour keeps its default', () => {
  const themed = draw('working', { seconds: 1.5 }, { orbit: '255,0,0' });
  assert.ok(themed.draws.some(d => d.fill.includes(DEFAULT_PALETTE.bits)),
    'the digits keep the default colour');
});

test('every alpha stays inside zero and one', () => {
  for (const [state, extra] of [
    ['working', {}], ['attention', {}], ['idle', { sleeping: true }],
    ['complete', {}], ['idle', { requested: 'surprise' }],
  ]) {
    for (let seconds = 0; seconds < 5; seconds += 0.05) {
      for (const { fill } of draw(state, { seconds, eventId: 5, ...extra }).draws) {
        const alpha = alphaOf(fill);
        assert.ok(alpha > 0 && alpha <= 1,
          state + ' at ' + seconds.toFixed(2) + 's produced alpha ' + alpha);
      }
    }
  }
});

test('nothing is ever drawn with a non-finite coordinate', () => {
  for (const [state, extra] of [
    ['working', {}], ['attention', {}], ['idle', { sleeping: true }], ['complete', {}],
  ]) {
    for (let seconds = 0; seconds < 5; seconds += 0.1) {
      for (const shape of draw(state, { seconds, eventId: 9, ...extra }).draws) {
        for (const value of [shape.x, shape.y, shape.r, shape.w, shape.h]) {
          if (value === undefined) continue;
          assert.ok(Number.isFinite(value),
            state + ' at ' + seconds.toFixed(1) + 's produced ' + value);
        }
      }
    }
  }
});

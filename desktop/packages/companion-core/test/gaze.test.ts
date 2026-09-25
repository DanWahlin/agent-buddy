import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gazeDirection, pointerDirection } from '../src/gaze.js';

/** A caret at a fraction across and down a 30-line viewport. */
function at(across: number, down: number) {
  return gazeDirection({
    line: Math.round(down * 30),
    column: Math.round(across * 100),
    firstVisibleLine: 0,
    lastVisibleLine: 30,
  });
}

test('the middle of the viewport leaves the look-around alone', () => {
  // Doing nothing matters as much as doing something: a head that snaps to a
  // direction on every keystroke reads as twitchy.
  assert.equal(at(0.5, 0.5), null);
  assert.equal(at(0.4, 0.6), null);
});

test('the corners and edges map to the eight directions', () => {
  assert.equal(at(0.1, 0.1), 'up_left');
  assert.equal(at(0.9, 0.1), 'up_right');
  assert.equal(at(0.1, 0.9), 'down_left');
  assert.equal(at(0.9, 0.9), 'down_right');
  assert.equal(at(0.5, 0.1), 'up');
  assert.equal(at(0.5, 0.9), 'down');
  assert.equal(at(0.1, 0.5), 'left');
  assert.equal(at(0.9, 0.5), 'right');
});

test('it is the position on screen, not in the file, that decides', () => {
  // Line 900 of a long file, but sitting at the top of the viewport: he should
  // look up, not down.
  assert.equal(gazeDirection({
    line: 900, column: 0, firstVisibleLine: 895, lastVisibleLine: 940,
  }), 'up_left');

  // The same line, now at the bottom of the viewport.
  assert.equal(gazeDirection({
    line: 900, column: 0, firstVisibleLine: 860, lastVisibleLine: 905,
  }), 'down_left');
});

test('a caret outside the visible range is clamped, not extrapolated', () => {
  assert.equal(gazeDirection({
    line: -50, column: 0, firstVisibleLine: 0, lastVisibleLine: 30,
  }), 'up_left');
  assert.equal(gazeDirection({
    line: 9999, column: 9999, firstVisibleLine: 0, lastVisibleLine: 30,
  }), 'down_right');
});

test('a viewport of one line does not divide by zero', () => {
  const direction = gazeDirection({
    line: 7, column: 4, firstVisibleLine: 7, lastVisibleLine: 7,
  });
  assert.ok(direction === null || typeof direction === 'string');
});

test('a long line reads as sideways, a short one does not', () => {
  const short = gazeDirection({
    line: 15, column: 10, firstVisibleLine: 0, lastVisibleLine: 30,
  });
  assert.equal(short, 'left', 'column 10 is near the start of the wrap width');

  const middle = gazeDirection({
    line: 15, column: 50, firstVisibleLine: 0, lastVisibleLine: 30,
  });
  assert.equal(middle, null, 'halfway across is the middle');
});

test('the pointer uses the same eight-way split, so hover and typing agree', () => {
  assert.equal(pointerDirection(10, 10, 300, 300), 'up_left');
  assert.equal(pointerDirection(150, 150, 300, 300), null);
  assert.equal(pointerDirection(290, 290, 300, 300), 'down_right');
  assert.equal(pointerDirection(150, 290, 300, 300), 'down');
});

test('a zero-sized canvas does not produce nonsense', () => {
  const direction = pointerDirection(0, 0, 0, 0);
  assert.ok(direction === null || typeof direction === 'string');
});

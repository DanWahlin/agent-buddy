/**
 * Working out where the character should look.
 *
 * A webview cannot see the pointer outside itself, so the host supplies the
 * other half: where the caret is on screen. What matters is its position within
 * the *visible* range, not within the file - looking down because you are on
 * line 900 of 1000 would be wrong when line 900 is at the top of the viewport.
 *
 * Kept as a pure function so it can be tested without a window.
 */

import type { Direction } from '@agent-companion/renderer';

/** A caret inside a viewport, both in whatever units the caller likes. */
export interface GazeInput {
  line: number;
  column: number;
  /** First and last lines currently on screen. */
  firstVisibleLine: number;
  lastVisibleLine: number;
  /** Columns across before the gaze counts as sideways. */
  wrapColumn?: number;
}

/**
 * The direction to look, or null to leave the idle look-around alone.
 *
 * Null near the centre matters: a head that snaps to a direction for every
 * keystroke reads as twitchy, and doing nothing lets the engine's own timing
 * carry the movement.
 */
export function gazeDirection(input: GazeInput): Direction | null {
  const { line, column, firstVisibleLine, lastVisibleLine, wrapColumn = 100 } = input;

  const height = Math.max(1, lastVisibleLine - firstVisibleLine);
  const down = clamp((line - firstVisibleLine) / height);
  const across = clamp(column / Math.max(1, wrapColumn));

  // A third either side is "the middle", which is most of the typing anyone
  // does and is where he should simply carry on looking around.
  const vertical = band(down);
  const horizontal = band(across);

  if (vertical === 0 && horizontal === 0) return null;
  if (vertical === 0) return horizontal < 0 ? 'left' : 'right';
  if (horizontal === 0) return vertical < 0 ? 'up' : 'down';
  return (vertical < 0 ? 'up_' : 'down_') + (horizontal < 0 ? 'left' : 'right') as Direction;
}

/**
 * The direction for a pointer over the character, measured from the centre of
 * the canvas. Same eight-way split, so hovering and typing agree.
 */
export function pointerDirection(
  x: number, y: number, width: number, height: number,
): Direction | null {
  return gazeDirection({
    line: y,
    column: x,
    firstVisibleLine: 0,
    lastVisibleLine: Math.max(1, height),
    wrapColumn: Math.max(1, width),
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** -1 for the near third, 0 for the middle, 1 for the far third. */
function band(value: number): -1 | 0 | 1 {
  if (value < 1 / 3) return -1;
  if (value > 2 / 3) return 1;
  return 0;
}

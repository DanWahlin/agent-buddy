/**
 * Agent Companion character pack format, version 1.
 *
 * A pack is a directory holding a `pack.json` plus one or two images per track.
 * It is deliberately dependency-free so the same module can validate a pack in
 * Node (the packer, the extension host) and in a webview.
 *
 * Storage follows the patch-diff idea the ESP32 firmware uses: the four
 * non-open blink levels are ~74% of a flat frame set, but only the eye
 * rectangle actually changes. So each track stores a strip of open-eyed frames
 * plus a much smaller strip holding just that rectangle at each closing level.
 */

/** The eight gaze tracks, in the order the motion engine cycles them. */
export const GAZE_TRACKS = [
  'right', 'left', 'up', 'down',
  'up_right', 'up_left', 'down_right', 'down_left',
] as const;

/** The five expression tracks. `attention_alternate` is derived from `attention`. */
export const EXPRESSION_TRACKS = [
  'surprise', 'working', 'complete', 'attention', 'attention_alternate',
] as const;

export const TRACK_NAMES = [...GAZE_TRACKS, ...EXPRESSION_TRACKS] as const;

export type GazeTrack = typeof GAZE_TRACKS[number];
export type ExpressionTrack = typeof EXPRESSION_TRACKS[number];
export type TrackName = typeof TRACK_NAMES[number];

/** The agent states a pack can render. Mirrors the daemon's `characterStates`. */
export const CHARACTER_STATES = ['idle', 'surprise', 'working', 'complete', 'attention'] as const;
export type CharacterState = typeof CHARACTER_STATES[number];

/** `[x, y, width, height]`, in frame pixels. */
export type Rect = [number, number, number, number];

/**
 * Where a track's blink cells land on the frame.
 *
 * The eyes travel as the head turns, so a single rect covering every step would
 * be several times the area actually needed - on a pitched track it ends up
 * larger than the base frames it was meant to shrink. Instead the cell size is
 * uniform (so the strip stays a clean grid) and each step carries its own
 * top-left corner. A null entry means that step has no visible eyes, which is
 * normal on the downward tracks, and nothing is composited.
 */
export interface PackPatch {
  /** `[width, height]` of every cell in the blink strip. */
  size: [number, number];
  /** Per-step `[x, y]` in frame coordinates, or null when the eyes are occluded. */
  cells: Array<[number, number] | null>;
}

export interface PackTrack {
  /** Horizontal strip of `steps` open-eyed frames, each `frame.width` wide. */
  base: string;
  /**
   * Optional strip of the eye rectangle at blink levels 1..4: `steps` columns
   * by 4 rows, each cell `patch.size` big. Omitted when a track never blinks -
   * `surprise` and `complete` are `expression-preserved` upstream, and most of
   * their blink frames are byte-identical to the base.
   */
  blinks?: string;
  /** Where `blinks` cells are composited onto the frame. Required with `blinks`. */
  patch?: PackPatch;
}

export interface Pack {
  format: 1;
  id: string;
  name: string;
  author?: string;
  license?: string;
  description?: string;
  /** Size of one rendered frame. */
  frame: { width: number; height: number };
  /**
   * Opaque backdrop colour. Source rigs are usually rendered on solid black
   * with no alpha, so the default presentation is a card rather than a cutout.
   * Omit for packs whose frames carry real alpha.
   */
  background?: string;
  /** Yaw steps per track. Index 0 is the shared centre pose every track returns to. */
  steps: number;
  /** Eye openness per blink level, 1 open through 0 closed. */
  blinkLevels: number[];
  /**
   * Colours for the reaction effects drawn around the character, each as
   * "r,g,b". Omitted keys keep the defaults. The effects themselves are
   * procedural and need no art, so a pack never has to provide anything here.
   */
  effects?: Partial<Record<
    'orbit' | 'bits' | 'attention' | 'sleep' | 'surprise', string>>;
  tracks: Partial<Record<TrackName, PackTrack>>;
  /** Which track (or tracks, chosen at random) renders each agent state. */
  states: Record<CharacterState, TrackName | TrackName[] | 'gaze'>;
  /** How sleep is synthesised. Needs no dedicated art. */
  sleep: { track: TrackName; step: number; blinkLevel: number };
}

/** What a validator needs to know about an image without depending on a decoder. */
export interface ImageProbe {
  (relativePath: string): { width: number; height: number } | null;
}

const EFFECT_COLOURS = ['orbit', 'bits', 'attention', 'sleep', 'surprise'];
/** `"r,g,b"`, each 0-255, as the effects layer interpolates into `rgba()`. */
const CHANNEL = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const RGB_TRIPLE = new RegExp('^\\s*' + [CHANNEL, CHANNEL, CHANNEL].join('\\s*,\\s*') + '\\s*$');
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isTrackName(value: string): value is TrackName {
  return (TRACK_NAMES as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/**
 * Check a parsed `pack.json` and, when `probe` is supplied, the dimensions of
 * every image it references. Returns a list of human-readable problems; empty
 * means the pack is valid.
 */
export function validatePack(pack: unknown, probe?: ImageProbe): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (typeof pack !== 'object' || pack === null) return ['pack.json is not an object'];
  const p = pack as Partial<Pack>;

  if (p.format !== 1) fail('format must be 1, got ' + JSON.stringify(p.format));
  for (const key of ['id', 'name'] as const) {
    if (typeof p[key] !== 'string' || !p[key]) fail(key + ' must be a non-empty string');
  }
  if (p.background !== undefined && !HEX_COLOUR.test(String(p.background))) {
    fail('background must be a hex colour, got ' + JSON.stringify(p.background));
  }

  const width = p.frame?.width;
  const height = p.frame?.height;
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    fail('frame.width and frame.height must be positive integers');
  }
  if (!isPositiveInt(p.steps) || (p.steps as number) < 2) {
    fail('steps must be an integer of at least 2');
  }
  if (!Array.isArray(p.blinkLevels) || p.blinkLevels.length < 1) {
    fail('blinkLevels must be a non-empty array');
  }

  if (p.effects !== undefined) {
    if (typeof p.effects !== 'object' || p.effects === null || Array.isArray(p.effects)) {
      fail('effects must be an object');
    } else {
      for (const [name, value] of Object.entries(p.effects)) {
        if (!EFFECT_COLOURS.includes(name)) {
          fail('unknown effect colour "' + name + '" (expected one of '
            + EFFECT_COLOURS.join(', ') + ')');
        } else if (!RGB_TRIPLE.test(String(value))) {
          // These are interpolated into rgba(), where a bad value paints
          // nothing and says nothing, so it is worth catching here.
          fail('effects.' + name + ' must be "r,g,b", got ' + JSON.stringify(value));
        }
      }
    }
  }

  const tracks = p.tracks;
  if (typeof tracks !== 'object' || tracks === null) {
    fail('tracks must be an object');
    return errors;
  }
  const names = Object.keys(tracks);
  if (names.length === 0) fail('tracks is empty');

  for (const name of names) {
    if (!isTrackName(name)) {
      fail('unknown track "' + name + '" (expected one of ' + TRACK_NAMES.join(', ') + ')');
      continue;
    }
    const track = tracks[name];
    if (!track || typeof track.base !== 'string' || !track.base) {
      fail('track "' + name + '" is missing base');
      continue;
    }
    if (track.blinks !== undefined && !track.patch) {
      fail('track "' + name + '" has blinks but no patch rect');
    }
    if (track.patch) {
      const { size, cells } = track.patch;
      const sizeOk = Array.isArray(size) && size.length === 2
        && size.every(n => isPositiveInt(n));
      if (!sizeOk) {
        fail('track "' + name + '" patch.size must be two positive integers');
      }
      if (!Array.isArray(cells)) {
        fail('track "' + name + '" patch.cells must be an array');
      } else {
        if (isPositiveInt(p.steps) && cells.length !== p.steps) {
          fail('track "' + name + '" has ' + cells.length + ' patch cells, expected ' + p.steps);
        }
        if (sizeOk && isPositiveInt(width) && isPositiveInt(height)) {
          const [w, h] = size;
          cells.forEach((cell, step) => {
            if (cell === null) return;
            const ok = Array.isArray(cell) && cell.length === 2
              && cell.every(n => Number.isInteger(n) && n >= 0);
            if (!ok) {
              fail('track "' + name + '" patch cell ' + step + ' must be two non-negative integers');
              return;
            }
            if (cell[0] + w > width || cell[1] + h > height) {
              fail('track "' + name + '" patch cell ' + step + ' at ' + cell.join(',')
                + ' plus ' + w + 'x' + h + ' falls outside the ' + width + 'x' + height + ' frame');
            }
          });
        }
      }
    }

    if (!probe) continue;
    const base = probe(track.base);
    if (!base) {
      fail('track "' + name + '" base image is missing: ' + track.base);
    } else if (isPositiveInt(width) && isPositiveInt(height) && isPositiveInt(p.steps)) {
      const wantWidth = (p.steps as number) * (width as number);
      if (base.width !== wantWidth || base.height !== height) {
        fail('track "' + name + '" base is ' + base.width + 'x' + base.height
          + ', expected ' + wantWidth + 'x' + height);
      }
    }
    if (track.blinks) {
      const blinks = probe(track.blinks);
      const rows = Array.isArray(p.blinkLevels) ? p.blinkLevels.length - 1 : 0;
      if (!blinks) {
        fail('track "' + name + '" blink image is missing: ' + track.blinks);
      } else if (track.patch && isPositiveInt(p.steps) && rows > 0) {
        const [w, h] = track.patch.size;
        const wantWidth = (p.steps as number) * w;
        const wantHeight = rows * h;
        if (blinks.width !== wantWidth || blinks.height !== wantHeight) {
          fail('track "' + name + '" blinks is ' + blinks.width + 'x' + blinks.height
            + ', expected ' + wantWidth + 'x' + wantHeight);
        }
      }
    }
  }

  const states = p.states;
  if (typeof states !== 'object' || states === null) {
    fail('states must be an object');
  } else {
    for (const state of CHARACTER_STATES) {
      const value = states[state];
      if (value === undefined) { fail('states.' + state + ' is missing'); continue; }
      if (value === 'gaze') continue;
      for (const candidate of Array.isArray(value) ? value : [value]) {
        if (!isTrackName(candidate)) {
          fail('states.' + state + ' names unknown track "' + candidate + '"');
        } else if (!names.includes(candidate)) {
          fail('states.' + state + ' names absent track "' + candidate + '"');
        }
      }
    }
  }

  const sleep = p.sleep;
  if (typeof sleep !== 'object' || sleep === null) {
    fail('sleep must be an object');
  } else {
    if (!isTrackName(String(sleep.track)) || !names.includes(String(sleep.track))) {
      fail('sleep.track "' + sleep.track + '" is not a track in this pack');
    }
    if (!Number.isInteger(sleep.step) || sleep.step < 0) {
      fail('sleep.step must be a non-negative integer');
    }
    if (!Number.isInteger(sleep.blinkLevel) || sleep.blinkLevel < 0) {
      fail('sleep.blinkLevel must be a non-negative integer');
    }
  }

  return errors;
}

/** Throwing wrapper around {@link validatePack}. */
export function assertValidPack(pack: unknown, probe?: ImageProbe): asserts pack is Pack {
  const errors = validatePack(pack, probe);
  if (errors.length) {
    throw new Error('Invalid character pack:\n  - ' + errors.join('\n  - '));
  }
}

/** Source rectangle of one frame inside a track's base strip. */
export function baseFrameRect(pack: Pack, step: number): Rect {
  return [step * pack.frame.width, 0, pack.frame.width, pack.frame.height];
}

/**
 * Source rectangle of one blink cell inside a track's blink strip, and the
 * destination rectangle it composites onto in the frame. Returns null when this
 * step has no blink art - either the track never blinks, the level is 0 (the
 * open-eyed base frame), or the eyes are occluded at this angle.
 */
export function blinkDraw(
  track: PackTrack, step: number, blinkLevel: number,
): { source: Rect; destination: Rect } | null {
  if (!track.blinks || !track.patch || blinkLevel <= 0) return null;
  const cell = track.patch.cells[step];
  if (!cell) return null;
  const [w, h] = track.patch.size;
  return {
    source: [step * w, (blinkLevel - 1) * h, w, h],
    destination: [cell[0], cell[1], w, h],
  };
}

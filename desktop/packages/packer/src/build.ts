/**
 * Building a character pack from a rig.
 *
 * Three things here are not obvious and all three come from the upstream art
 * notes or from measuring the frames:
 *
 * 1. Frame 0 is the hinge. The motion engine walks back to index 0 before
 *    switching tracks, so every track's frame 0 must be the same image or the
 *    seam shows on every idle glance. Marvin's five expression tracks are
 *    already byte-identical to `approved-center.png`; the seven non-`right`
 *    gaze tracks drift. We overwrite frame 0 with the anchor rather than
 *    regenerating anything - the delta then lands inside the 0 to 1 step, where
 *    real motion masks it.
 * 2. Blink levels are stored as eye patches, not whole frames. Flat storage
 *    makes the four closing levels ~74% of a pack; patched, ~16%.
 * 3. A track whose blink images are byte-identical to its base never blinks
 *    (`expression-preserved` upstream) and gets no blink strip at all.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import {
  CHARACTER_STATES, GAZE_TRACKS,
  type Pack, type PackPatch, type PackTrack, type Rect, type TrackName,
} from '@agent-companion/pack-format';
import { applyCutout } from './cutout.js';
import { resolveEyes } from './eyes.js';
import { eyeUnion, type Rig, type RigFrame } from './rig.js';

export interface BuildOptions {
  rig: Rig;
  outDir: string;
  id: string;
  name: string;
  author?: string;
  license?: string;
  description?: string;
  /** Poses to keep per track. Defaults to half the rig's poses. */
  steps?: number;
  /** Scale applied to every frame. Defaults to 0.5. */
  scale?: number;
  /** WebP quality, 1-100. Defaults to 82. */
  quality?: number;
  /** Bloom allowance around the detected eye boxes, in source pixels. */
  eyeMargin?: number;
  /**
   * Opaque card colour behind the character. Defaults to null, which cuts the
   * backdrop away instead - a companion should sit on the panel rather than in
   * a box, and a baked-in dark card is stark in a light theme.
   */
  background?: string | null;
  /** Path to the canonical centre pose. Defaults to `right` frame 0. */
  anchor?: string;
  onProgress?: (message: string) => void;
}

/** A pose that came out essentially empty, which almost always means bad input. */
export interface EmptyFrame {
  track: TrackName;
  step: number;
  file: string;
}

export interface BuildResult {
  pack: Pack;
  packPath: string;
  bytes: number;
  files: Array<{ name: string; bytes: number }>;
  /** Tracks whose frame 0 was replaced because it drifted from the anchor. */
  realigned: TrackName[];
  /** Tracks that turned out never to blink. */
  neverBlink: TrackName[];
  /** Poses whose eye region had to be measured, because the rig did not say. */
  derivedEyes: number;
  /** Poses that hold no character at all. */
  empty: EmptyFrame[];
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Pick `wanted` evenly spaced poses from `total`, always keeping index 0 (the
 * shared centre) and the final pose (the full turn, and the pose `surprise`
 * springs back from).
 */
export function chooseSteps(total: number, wanted: number): number[] {
  if (wanted >= total) return Array.from({ length: total }, (_, i) => i);
  if (wanted <= 1) return [0];
  const picked: number[] = [];
  for (let i = 0; i < wanted; i++) {
    picked.push(Math.round((i * (total - 1)) / (wanted - 1)));
  }
  return [...new Set(picked)];
}

export async function buildPack(options: BuildOptions): Promise<BuildResult> {
  const {
    rig, outDir, id, name, author, license, description,
    quality = 82, eyeMargin = 6, background = null, onProgress = () => {},
  } = options;
  const scale = options.scale ?? 0.5;
  const wantedSteps = options.steps ?? Math.round(rig.count / 2);

  if (scale <= 0 || scale > 1) throw new Error('scale must be greater than 0 and at most 1.');

  const frameWidth = Math.round(rig.width * scale);
  const frameHeight = Math.round(rig.height * scale);
  const stepIndices = chooseSteps(rig.count, wantedSteps);
  const steps = stepIndices.length;
  const blinkRows = Math.max(0, rig.blinkLevels.length - 1);

  const anchorPath = options.anchor ?? rig.tracks.get('right')?.frames[0]?.file;
  if (!anchorPath || !existsSync(anchorPath)) {
    throw new Error('Cannot locate the centre pose to anchor frame 0 on.');
  }
  const anchorHash = sha256(anchorPath);

  // The anchor must be a whole frame, not just an image. A bare PNG has no
  // sibling blink art, so realigning onto it would silently stop the centre
  // pose blinking - and the centre pose is exactly what sleep holds closed.
  // Prefer the frame of whichever track already matches the anchor, and prefer
  // one whose blinks actually change something: a track can list four blink
  // files that are byte-identical to their base, which looks like blink art
  // and is not.
  const anchorFrame: RigFrame = findAnchorFrame(rig, anchorHash)
    ?? { file: anchorPath, blinks: [], eyes: [] };
  if (!frameBlinks(anchorFrame) && blinkRows > 0) {
    onProgress('warning: the centre pose has no blink art that changes anything, '
      + 'so it will not blink and cannot be used for sleep');
  }

  await mkdir(outDir, { recursive: true });

  const tracks: Partial<Record<TrackName, PackTrack>> = {};
  const files: Array<{ name: string; bytes: number }> = [];
  const realigned: TrackName[] = [];
  const neverBlink: TrackName[] = [];
  let derivedEyes = 0;
  const empty: EmptyFrame[] = [];
  /** Steps whose blink art actually differs, per track, for choosing sleep. */
  const blinkingSteps = new Map<TrackName, Set<number>>();

  for (const [trackName, track] of rig.tracks) {
    const selected = stepIndices.map(index => track.frames[index]);
    if (selected.some(frame => !frame)) {
      throw new Error('Track "' + trackName + '" has fewer than ' + rig.count + ' poses.');
    }

    // 1. Frame 0 is the hinge - force it to the anchor, blink art and all.
    const frames: RigFrame[] = [...selected];
    if (sha256(frames[0].file) !== anchorHash) {
      realigned.push(trackName);
      frames[0] = anchorFrame;
    }

    // A frame with nothing in it survives every other check: the cutout removes
    // all of it, the blink levels all match because they are equally blank, and
    // the pack still validates. A renderer that dropped a track, or captured
    // before its canvas was ready, looks exactly like this.
    for (const [step, frame] of frames.entries()) {
      if (await isBlank(frame.file)) empty.push({ track: trackName, step, file: frame.file });
    }

    // A rig that records no eye boxes still knows where the eyes are: they are
    // whatever the blink levels change. Measure them rather than give up on
    // blinking altogether.
    //
    // Decided per track, not per pose. An empty box on one pose of a track that
    // records them elsewhere is a deliberate statement - the eyes are occluded
    // at this angle - and measuring over it would put a patch where the rig
    // says there is nothing to patch.
    const recordsEyes = frames.some(frame => frame.eyes.length > 0);
    const measured = recordsEyes
      ? { frames, derived: 0 }
      : await resolveEyes(frames);
    derivedEyes += measured.derived;
    const posed = measured.frames;

    onProgress('packing ' + trackName
      + (measured.derived ? ' (measured ' + measured.derived + ' eye boxes)' : ''));

    const baseName = trackName + '.webp';
    const baseBytes = await writeStrip({
      cells: posed.map(frame => ({ file: frame.file })),
      columns: steps, rows: 1,
      cellWidth: frameWidth, cellHeight: frameHeight,
      scaleTo: { width: frameWidth, height: frameHeight },
      background, quality,
      out: join(outDir, baseName),
    });
    files.push({ name: baseName, bytes: baseBytes });

    blinkingSteps.set(trackName,
      new Set(posed.flatMap((frame, step) => (frameBlinks(frame) ? [step] : []))));

    const packTrack: PackTrack = { base: baseName };

    // 2. Store only the eye rectangle at each closing level, per step. A single
    //    rect spanning the whole turn would cover the eyes' travel and end up
    //    bigger than the frames it was meant to shrink.
    const patch = blinkRows > 0 && framesBlink(posed)
      ? planPatch(posed, rig.width, rig.height, scale, frameWidth, frameHeight, eyeMargin)
      : null;

    if (patch) {
      const [cellWidth, cellHeight] = patch.size;
      const blinkName = trackName + '.blink.webp';
      const cells: Array<{ file: string; crop?: Rect } | null> = [];
      for (let level = 0; level < blinkRows; level++) {
        posed.forEach((frame, step) => {
          const cell = patch.cells[step];
          const source = frame.blinks[level];
          // An occluded step, or a pose whose blink art is absent, leaves the
          // cell empty - the renderer composites nothing there.
          if (!cell || !source || !existsSync(source)) { cells.push(null); return; }
          cells.push({ file: source, crop: [cell[0], cell[1], cellWidth, cellHeight] });
        });
      }
      const blinkBytes = await writeStrip({
        cells,
        columns: steps, rows: blinkRows,
        cellWidth, cellHeight,
        scaleTo: { width: frameWidth, height: frameHeight },
        background: null,
        quality,
        out: join(outDir, blinkName),
      });
      files.push({ name: blinkName, bytes: blinkBytes });
      packTrack.blinks = blinkName;
      packTrack.patch = patch;
    } else {
      neverBlink.push(trackName);
    }

    tracks[trackName] = packTrack;
  }

  const sleep = chooseSleep(tracks, blinkingSteps, blinkRows);
  if (!sleep.closes) {
    onProgress('warning: no pose in this rig closes its eyes, so sleep will '
      + 'look the same as idle');
  }
  const pack: Pack = {
    format: 1,
    id, name,
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(description ? { description } : {}),
    frame: { width: frameWidth, height: frameHeight },
    ...(background ? { background } : {}),
    steps,
    blinkLevels: rig.blinkLevels,
    tracks,
    states: buildStates(tracks),
    sleep: { track: sleep.track, step: sleep.step, blinkLevel: blinkRows },
  };

  const packPath = join(outDir, 'pack.json');
  const packJson = JSON.stringify(pack, null, 2) + '\n';
  await writeFile(packPath, packJson, 'utf8');

  const bytes = files.reduce((total, file) => total + file.bytes, 0) + Buffer.byteLength(packJson);
  return { pack, packPath, bytes, files, realigned, neverBlink, derivedEyes, empty };
}

function buildStates(tracks: Partial<Record<TrackName, PackTrack>>): Pack['states'] {
  const has = (name: TrackName) => Boolean(tracks[name]);
  const fallback: TrackName = has('right') ? 'right' : (Object.keys(tracks)[0] as TrackName);
  const states = {} as Pack['states'];

  for (const state of CHARACTER_STATES) {
    if (state === 'idle') { states.idle = 'gaze'; continue; }
    if (state === 'attention') {
      const options: TrackName[] = (['attention', 'attention_alternate'] as const)
        .filter(has);
      states.attention = options.length ? (options.length === 1 ? options[0] : options) : fallback;
      continue;
    }
    states[state] = has(state as TrackName) ? (state as TrackName) : fallback;
  }
  return states;
}

/**
 * Pick a pose to sleep on: one that can actually close its eyes.
 *
 * Sleep is the centre pose held shut, which assumes the centre pose has blink
 * art. A rig can arrive where it does not - OpenClaw renders every pose with
 * working blinks except the one every track shares as its centre - and pinning
 * sleep to step 0 there leaves the character wide awake while asleep. So the
 * step is chosen rather than assumed, preferring the centre and the track that
 * looks most restful.
 */
function chooseSleep(
  tracks: Partial<Record<TrackName, PackTrack>>,
  blinkingSteps: Map<TrackName, Set<number>>,
  blinkRows: number,
): { track: TrackName; step: number; closes: boolean } {
  const order: TrackName[] = ['down', 'down_left', 'down_right', 'right', 'left'];
  const candidates = [...order.filter(name => tracks[name]),
    ...(Object.keys(tracks) as TrackName[])];

  if (blinkRows > 0) {
    for (const name of candidates) {
      const cells = tracks[name]?.patch?.cells;
      if (!cells) continue;
      // Both conditions matter and they are not the same. A patch cell exists
      // wherever the eyes are visible; whether that pose has blink art which
      // changes anything is separate, and a pose can have the first without
      // the second.
      const blinking = blinkingSteps.get(name) ?? new Set<number>();
      const step = cells.findIndex((cell, index) => cell !== null && blinking.has(index));
      if (step !== -1) return { track: name, step, closes: true };
    }
  }
  const fallback = candidates[0] ?? ('right' as TrackName);
  return { track: fallback, step: 0, closes: false };
}

/**
 * Find a complete frame for the centre pose: a track whose frame 0 already
 * matches the anchor image, preferring one that carries blink art.
 */
function findAnchorFrame(rig: Rig, anchorHash: string): RigFrame | null {
  let fallback: RigFrame | null = null;
  for (const track of rig.tracks.values()) {
    const frame = track.frames[0];
    if (!frame || sha256(frame.file) !== anchorHash) continue;
    if (frameBlinks(frame)) return frame;
    fallback ??= frame;
  }
  return fallback;
}

/** True when a frame holds nothing but backdrop. */
async function isBlank(file: string, threshold = 24): Promise<boolean> {
  const { channels, data } = await sharp(file).stats().then(
    stats => ({ channels: stats.channels, data: null }),
    () => ({ channels: null, data: null }));
  if (!channels) return false;
  // The maximum across the colour channels; alpha says nothing about content.
  return channels.slice(0, 3).every(channel => channel.max <= threshold);
}

/** True when a pose has blink art that differs from the pose itself. */
function frameBlinks(frame: RigFrame): boolean {
  if (frame.blinks.length === 0) return false;
  const base = sha256(frame.file);
  return frame.blinks.some(blink => existsSync(blink) && sha256(blink) !== base);
}

/**
 * Work out the blink patch for a track: one rect per step from that step's own
 * eye boxes, all grown to a single cell size so the strip stays a clean grid.
 * Returns null when no step in the track has visible eyes.
 */
function planPatch(
  frames: RigFrame[], sourceWidth: number, sourceHeight: number,
  scale: number, frameWidth: number, frameHeight: number, margin: number,
): PackPatch | null {
  const perStep = frames.map(frame => {
    const rect = eyeUnion([frame], sourceWidth, sourceHeight, margin);
    return rect ? scaleRect(rect, scale, frameWidth, frameHeight) : null;
  });
  if (perStep.every(rect => rect === null)) return null;

  const cellWidth = Math.max(...perStep.map(rect => (rect ? rect[2] : 0)));
  const cellHeight = Math.max(...perStep.map(rect => (rect ? rect[3] : 0)));
  if (cellWidth === 0 || cellHeight === 0) return null;

  const cells = perStep.map(rect => {
    if (!rect) return null;
    // Grow each step's own rect to the shared cell size, keeping it on-frame.
    const x = Math.min(Math.max(0, rect[0] - Math.floor((cellWidth - rect[2]) / 2)),
      frameWidth - cellWidth);
    const y = Math.min(Math.max(0, rect[1] - Math.floor((cellHeight - rect[3]) / 2)),
      frameHeight - cellHeight);
    return [x, y] as [number, number];
  });

  return { size: [cellWidth, cellHeight], cells };
}

/** True when any selected pose has blink art that differs from its base. */
function framesBlink(frames: RigFrame[]): boolean {
  return frames.some(frameBlinks);
}

function scaleRect(rect: Rect, scale: number, maxWidth: number, maxHeight: number): Rect {
  const x = Math.max(0, Math.floor(rect[0] * scale));
  const y = Math.max(0, Math.floor(rect[1] * scale));
  const width = Math.min(maxWidth - x, Math.max(1, Math.ceil(rect[2] * scale)));
  const height = Math.min(maxHeight - y, Math.max(1, Math.ceil(rect[3] * scale)));
  return [x, y, width, height];
}

/** Load one source frame with its backdrop flooded away. */
async function cutoutOf(file: string): Promise<Sharp> {
  const { data, info } = await sharp(file).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  applyCutout(data, info.width, info.height);
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  });
}

interface StripOptions {
  /** One entry per grid cell, row-major. Null leaves the cell empty. */
  cells: Array<{ file: string; crop?: Rect } | null>;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** Size each source image is resized to before any crop. */
  scaleTo: { width: number; height: number };
  background: string | null;
  quality: number;
  out: string;
}

/**
 * Compose cells into a `columns` by `rows` grid and write it as WebP.
 *
 * Frames are resized first and cropped second, so a patch rect expressed in
 * output coordinates lines up with what the renderer will composite.
 */
async function writeStrip(options: StripOptions): Promise<number> {
  const { cells, columns, rows, cellWidth, cellHeight, scaleTo, background, quality, out } = options;

  const composites = (await Promise.all(cells.map(async (cell, index) => {
    if (!cell) return null;
    // Cut the backdrop away before resizing, so the silhouette is resampled
    // with its coverage rather than against a colour that is about to go.
    let image = background === null ? await cutoutOf(cell.file) : sharp(cell.file);
    image = image.resize(scaleTo.width, scaleTo.height, { fit: 'fill' });
    if (cell.crop) {
      const [left, top, width, height] = cell.crop;
      image = image.extract({ left, top, width, height });
    }
    return {
      input: await image.png().toBuffer(),
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * cellHeight,
    };
  }))).filter(entry => entry !== null);

  const canvas = sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  const buffer = await canvas
    .composite(composites)
    .webp({ quality, alphaQuality: 100, effort: 6 })
    .toBuffer();

  await writeFile(out, buffer);
  return buffer.length;
}

export { GAZE_TRACKS };

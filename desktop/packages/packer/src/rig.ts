/**
 * Reading a rendered character rig.
 *
 * The expected input is the `animation.json` an ESP32 Agent Companion art
 * pipeline emits. It already carries per-frame eye boxes and blink filenames,
 * which is precisely what the patch-diff packing needs, so we read it rather
 * than guessing from filenames.
 *
 * How the thirteen tracks are divided up varies by rig and none of it matters
 * here: Marvin renders gaze and expressions in two passes and so writes two
 * manifests in two directories, OpenClaw puts all thirteen under `directions`
 * in one, and Claude puts all thirteen in one manifest split between
 * `directions` and `expressions`. Every shape merges into the same 13-track
 * rig.
 *
 * A directory with no manifest falls back to the naming the same pipeline uses
 * on disk: `<track>-<NN>.png` for an open-eyed frame and
 * `<track>-<NN>-blink-<1..4>.png` for the closing levels, with an optional
 * `-generated` infix on the diagonal tracks.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TRACK_NAMES, type Rect, type TrackName } from '@agent-companion/pack-format';

/** One pose: the open-eyed image plus its four closing levels. */
export interface RigFrame {
  /** Absolute path to the open-eyed image. */
  file: string;
  /** Absolute paths to blink levels 1..4. Empty when the track never blinks. */
  blinks: string[];
  /**
   * Eye bounding boxes as `[x0, y0, x1, y1]` in source pixels. Empty when the
   * eyes are occluded at this angle, which is normal on the downward tracks.
   */
  eyes: Array<[number, number, number, number]>;
  blinkMaskState?: string;
}

export interface RigTrack {
  name: TrackName;
  frames: RigFrame[];
  /** `expression-preserved` tracks reuse the base image at every blink level. */
  blinkPolicy?: string;
}

export interface Rig {
  width: number;
  height: number;
  /** Poses per track, before any subsampling. */
  count: number;
  blinkLevels: number[];
  tracks: Map<TrackName, RigTrack>;
  /** Directories the frames were read from, for diagnostics. */
  sources: string[];
}

interface ManifestFrame {
  file: string;
  eyes?: Array<[number, number, number, number]>;
  blinks?: string[];
  blinkMaskState?: string;
}

interface ManifestTrack {
  frames: ManifestFrame[];
  blinkPolicy?: string;
}

interface Manifest {
  width: number;
  height: number;
  count: number;
  blinkLevels: number[];
  /**
   * The gaze tracks, or every track. A rig rendered in two passes writes one
   * manifest per pass and puts whatever that pass produced under this key.
   */
  directions: Record<string, ManifestTrack>;
  /**
   * The five expression tracks, when one pass rendered all thirteen and said
   * so - Claude's rig does. Merged with `directions` rather than read from a
   * second directory.
   */
  expressions?: Record<string, ManifestTrack>;
}

const FRAME_PATTERN = /^(.+?)-(\d+)(?:-blink-(\d))?\.png$/i;

function isTrackName(value: string): value is TrackName {
  return (TRACK_NAMES as readonly string[]).includes(value);
}

/**
 * Read every rig directory given and merge them into one 13-track rig.
 * Directories are typically `web/generated-sprites-<id>` and
 * `web/generated-expressions-<id>`.
 */
export function readRig(directories: string[]): Rig {
  if (directories.length === 0) throw new Error('No rig directories given.');

  const tracks = new Map<TrackName, RigTrack>();
  const sources: string[] = [];
  let width = 0;
  let height = 0;
  let count = 0;
  let blinkLevels: number[] = [];

  for (const directory of directories) {
    if (!existsSync(directory)) throw new Error('Rig directory not found: ' + directory);
    const manifestPath = join(directory, 'animation.json');
    const read = existsSync(manifestPath)
      ? readManifest(directory, manifestPath)
      : readByFilename(directory);

    if (read.tracks.size === 0) {
      throw new Error('No recognisable tracks in ' + directory);
    }
    if (width && read.width !== width) {
      throw new Error('Frame width differs between rig directories: '
        + width + ' vs ' + read.width + ' in ' + directory);
    }
    if (height && read.height !== height) {
      throw new Error('Frame height differs between rig directories: '
        + height + ' vs ' + read.height + ' in ' + directory);
    }
    width = read.width;
    height = read.height;
    count = count ? Math.min(count, read.count) : read.count;
    if (read.blinkLevels.length > blinkLevels.length) blinkLevels = read.blinkLevels;

    for (const [name, track] of read.tracks) {
      if (tracks.has(name)) {
        throw new Error('Track "' + name + '" appears in more than one rig directory.');
      }
      tracks.set(name, track);
    }
    sources.push(directory);
  }

  return { width, height, count, blinkLevels, tracks, sources };
}

function readManifest(directory: string, manifestPath: string): Rig {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const tracks = new Map<TrackName, RigTrack>();

  const entries = [
    ...Object.entries(manifest.directions ?? {}),
    ...Object.entries(manifest.expressions ?? {}),
  ];
  for (const [name, entry] of entries) {
    if (!isTrackName(name)) continue;
    if (tracks.has(name)) {
      throw new Error('Track "' + name + '" appears twice in ' + manifestPath);
    }
    const frames: RigFrame[] = entry.frames.map(frame => ({
      file: join(directory, frame.file),
      blinks: (frame.blinks ?? []).map(blink => join(directory, blink)),
      eyes: frame.eyes ?? [],
      blinkMaskState: frame.blinkMaskState,
    }));
    tracks.set(name, { name, frames, blinkPolicy: entry.blinkPolicy });
  }

  return {
    width: manifest.width,
    height: manifest.height,
    count: manifest.count,
    blinkLevels: manifest.blinkLevels ?? [1, 0.75, 0.5, 0.25, 0],
    tracks,
    sources: [directory],
  };
}

/**
 * Fallback for rigs shipped as loose PNGs with no manifest. Eye boxes are
 * unavailable here, so the caller derives patch rects by differencing the base
 * and blink images instead.
 */
function readByFilename(directory: string): Rig {
  const byTrack = new Map<TrackName, Map<number, { file?: string; blinks: string[] }>>();

  for (const entry of readdirSync(directory)) {
    const match = FRAME_PATTERN.exec(basename(entry));
    if (!match) continue;
    const [, rawTrack, rawIndex, rawBlink] = match;
    const name = rawTrack.replace(/-generated$/, '');
    if (!isTrackName(name)) continue;

    let poses = byTrack.get(name);
    if (!poses) { poses = new Map(); byTrack.set(name, poses); }
    const index = Number(rawIndex);
    let pose = poses.get(index);
    if (!pose) { pose = { blinks: [] }; poses.set(index, pose); }

    if (rawBlink) pose.blinks[Number(rawBlink) - 1] = join(directory, entry);
    else pose.file = join(directory, entry);
  }

  const tracks = new Map<TrackName, RigTrack>();
  let count = 0;
  for (const [name, poses] of byTrack) {
    const indices = [...poses.keys()].sort((a, b) => a - b);
    const frames: RigFrame[] = [];
    for (const index of indices) {
      const pose = poses.get(index)!;
      if (!pose.file) continue;
      frames.push({ file: pose.file, blinks: pose.blinks.filter(Boolean), eyes: [] });
    }
    if (frames.length === 0) continue;
    tracks.set(name, { name, frames });
    count = count ? Math.min(count, frames.length) : frames.length;
  }

  return { width: 0, height: 0, count, blinkLevels: [1, 0.75, 0.5, 0.25, 0], tracks, sources: [directory] };
}

/**
 * Union of every eye box in the given frames, as `[x, y, width, height]`,
 * grown by `margin` and clamped to the frame. Returns null when no frame in the
 * selection has visible eyes.
 *
 * The margin matters: the glow's anti-aliased bloom extends past the solid
 * pixels, and a rect tight to the detected box leaves a sliver of the "closed"
 * eye still glowing.
 */
export function eyeUnion(
  frames: RigFrame[], width: number, height: number, margin: number,
): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const frame of frames) {
    for (const [ex0, ey0, ex1, ey1] of frame.eyes) {
      x0 = Math.min(x0, ex0);
      y0 = Math.min(y0, ey0);
      x1 = Math.max(x1, ex1);
      y1 = Math.max(y1, ey1);
    }
  }
  if (!Number.isFinite(x0)) return null;

  const left = Math.max(0, Math.floor(x0) - margin);
  const top = Math.max(0, Math.floor(y0) - margin);
  const right = Math.min(width, Math.ceil(x1) + margin);
  const bottom = Math.min(height, Math.ceil(y1) + margin);
  return [left, top, right - left, bottom - top];
}

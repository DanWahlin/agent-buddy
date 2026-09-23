/**
 * A synthetic character rig, written to a temporary directory.
 *
 * The packer's real tests need a rendered rig, which only exists on a machine
 * that has one - so on CI, and on anyone else's clone, the whole pipeline went
 * untested. This builds a rig in the same shape, deliberately reproducing the
 * awkward properties that were found in a real one:
 *
 * - most tracks drift at frame 0, which is the seam the packer has to close;
 * - the downward tracks occlude the eyes past a certain angle, so some steps
 *   have no eye box at all;
 * - one track is "expression-preserved": its blink images are byte-identical
 *   to their base, so it should get no blink strip.
 *
 * Frames are generated rather than committed: 13 tracks by 8 poses by 5 blink
 * levels is 520 files, which is not something to keep in a repository.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export const GAZE_TRACKS = [
  'right', 'left', 'up', 'down', 'up_right', 'up_left', 'down_right', 'down_left',
];
export const EXPRESSION_TRACKS = [
  'surprise', 'working', 'complete', 'attention', 'attention_alternate',
];

/** Tracks whose eyes vanish at a steep angle, and the step it happens from. */
const OCCLUDES_FROM = { down: 5, down_left: 6, down_right: 5 };
/** Tracks that never blink, as `surprise` and `complete` do not upstream. */
const NEVER_BLINKS = new Set(['surprise', 'complete']);

export const FRAME = { width: 48, height: 44 };
export const POSES = 8;
export const BLINK_LEVELS = [1, 0.75, 0.5, 0.25, 0];
/** Where the eyes sit, in frame pixels. */
const EYES = [[10, 16, 20, 24], [28, 16, 38, 24]];

/**
 * A body on a black backdrop, which is how a rendered rig arrives: opaque, with
 * the character occupying the middle and nothing but backdrop around it. The
 * colour varies per pose so every frame is a distinct image.
 */
async function frame(red, green, blue) {
  const body = {
    width: Math.round(FRAME.width * 0.62),
    height: Math.round(FRAME.height * 0.62),
  };
  const blob = await sharp({
    create: { ...body, channels: 3, background: { r: red, g: green, b: blue } },
  }).png().toBuffer();

  return sharp({ create: { ...FRAME, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{
      input: blob,
      left: Math.round((FRAME.width - body.width) / 2),
      top: Math.round((FRAME.height - body.height) / 2),
    }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Build a rig under `root`, returning the two directories to read it from.
 *
 * `drift` controls whether the non-anchor tracks disagree at frame 0, which is
 * what the packer's realignment exists to fix.
 */
export async function createRig(root, { drift = true } = {}) {
  const gaze = join(root, 'gaze');
  const expressions = join(root, 'expressions');
  await mkdir(gaze, { recursive: true });
  await mkdir(expressions, { recursive: true });

  // The shared centre pose. Every track's frame 0 should end up as this.
  const anchor = await frame(40, 40, 44);
  const anchorPath = join(root, 'approved-center.png');
  await writeFile(anchorPath, anchor);

  // A handful of distinct images, reused by copying bytes rather than
  // re-encoding 520 times.
  const bodies = await Promise.all(
    Array.from({ length: POSES }, (_, step) => frame(60 + step * 8, 70, 90)));
  const blinks = await Promise.all(
    BLINK_LEVELS.slice(1).map((_, level) => frame(60, 70, 120 + level * 20)));

  const write = async (directory, tracks) => {
    const directions = {};
    for (const name of tracks) {
      const frames = [];
      for (let step = 0; step < POSES; step++) {
        const file = name + '-' + String(step).padStart(2, '0') + '.png';
        // Frame 0 is the anchor on one gaze track and every expression track,
        // matching how a real rig comes out; the rest drift.
        const isAnchored = !drift || step > 0 || name === 'right' || !GAZE_TRACKS.includes(name);
        await writeFile(join(directory, file),
          step === 0 ? (isAnchored ? anchor : bodies[1]) : bodies[step]);

        const occludedFrom = OCCLUDES_FROM[name];
        const occluded = occludedFrom !== undefined && step >= occludedFrom;

        const blinkFiles = [];
        for (let level = 0; level < blinks.length; level++) {
          const blinkFile = name + '-' + String(step).padStart(2, '0')
            + '-blink-' + (level + 1) + '.png';
          // A track that never blinks writes its base again, byte for byte.
          const body = NEVER_BLINKS.has(name)
            ? (step === 0 && isAnchored ? anchor : bodies[step])
            : blinks[level];
          await writeFile(join(directory, blinkFile), body);
          blinkFiles.push(blinkFile);
        }

        frames.push({
          file,
          eyes: occluded ? [] : EYES,
          blinkMaskState: occluded ? 'occluded-or-rim-clipped' : 'visible',
          blinks: blinkFiles,
        });
      }
      directions[name] = { frames, count: POSES };
    }

    await writeFile(join(directory, 'animation.json'), JSON.stringify({
      width: FRAME.width,
      height: FRAME.height,
      count: POSES,
      blinkLevels: BLINK_LEVELS,
      directions,
    }, null, 2));
  };

  await write(gaze, GAZE_TRACKS);
  await write(expressions, EXPRESSION_TRACKS);

  return { gaze, expressions, anchor: anchorPath };
}

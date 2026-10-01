/**
 * Turning a frame rendered on black into one with real transparency.
 *
 * Source rigs are rendered opaque on a solid backdrop, which is right for a
 * device with its own screen and wrong for a panel inside an editor: the
 * character ends up in a visible box, and in a light theme that box is stark.
 *
 * A brightness threshold alone cannot do this. The upstream art notes warn that
 * dark matte materials fragment under one - and measured on Marvin the backdrop
 * is exactly (0,0,0) while the darkest pixel inside the head is (14,19,19), so
 * a global threshold either keeps backdrop or eats the character. Instead the
 * backdrop is found by flooding inwards from the edges: only dark pixels
 * reachable from outside are background, so dark seams and shadowed interiors
 * are never touched however dark they get.
 */

export interface CutoutOptions {
  /** A pixel this dark or darker can be backdrop. Compared on the max channel. */
  threshold?: number;
  /** Soften the silhouette by this many pixels, to keep the edge from stepping. */
  feather?: number;
}

/**
 * Replace the alpha channel of an RGBA buffer in place.
 *
 * Returns the fraction of pixels judged to be background, which is a useful
 * sanity check: a frame that comes out nearly all background, or nearly none,
 * means the threshold is wrong for this art.
 */
export function applyCutout(
  data: Buffer | Uint8Array, width: number, height: number, options: CutoutOptions = {},
): number {
  const threshold = options.threshold ?? 24;
  const feather = options.feather ?? 1;
  const count = width * height;

  const background = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const isDark = (index: number): boolean => {
    const at = index * 4;
    return Math.max(data[at], data[at + 1], data[at + 2]) <= threshold;
  };
  const push = (index: number): void => {
    if (background[index] || !isDark(index)) return;
    background[index] = 1;
    queue[tail++] = index;
  };

  // Seed from every edge pixel; the backdrop is whatever connects to outside.
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }

  let opaque: Float32Array = new Float32Array(count);
  for (let i = 0; i < count; i++) opaque[i] = background[i] ? 0 : 1;

  // The rig is anti-aliased against the backdrop, so a hard mask leaves a
  // stepped rim. A small box blur of the coverage, not of the colour, softens
  // the silhouette without touching the character.
  for (let pass = 0; pass < feather; pass++) opaque = blur(opaque, width, height);

  for (let i = 0; i < count; i++) {
    data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, opaque[i])) * 255);
  }

  let backgroundPixels = 0;
  for (let i = 0; i < count; i++) if (background[i]) backgroundPixels++;
  return backgroundPixels / count;
}

/**
 * Make an already-built pack's base strips transparent, in place.
 *
 * The proper route is `--alpha` at build time, which cuts each frame before it
 * is resized so the silhouette is resampled with its coverage. This is for a
 * pack whose rig is no longer to hand: it cuts after the fact, which leaves the
 * rim very slightly dark because it was already blended against black at full
 * resolution. Rebuild from the rig when you can.
 *
 * Only base strips are touched. A blink strip is a crop from inside the head,
 * so its border pixels are the character's own dark material - flooding one
 * would eat the head rather than a backdrop.
 */
export async function cutoutPack(
  directory: string, options: CutoutOptions & { dryRun?: boolean } = {},
): Promise<Array<{ name: string; background: number }>> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const sharp = (await import('sharp')).default;

  const pack = JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8')) as {
    background?: string;
    tracks: Record<string, { base: string }>;
  };

  const done: Array<{ name: string; background: number }> = [];
  for (const track of Object.values(pack.tracks)) {
    const file = join(directory, track.base);
    const { data, info } = await sharp(file).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });

    // Every cell's backdrop reaches the top and bottom of the strip, so one
    // flood over the whole strip finds all of them.
    const background = applyCutout(data, info.width, info.height, options);
    done.push({ name: track.base, background });

    if (options.dryRun) continue;
    await writeFile(file, await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    }).webp({ quality: 82, alphaQuality: 100, effort: 6 }).toBuffer());
  }

  if (!options.dryRun && pack.background !== undefined) {
    delete pack.background;
    await writeFile(join(directory, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
  }
  return done;
}

/** Separable 3x1 box blur, clamped at the edges. */
function blur(source: Float32Array, width: number, height: number): Float32Array {
  const horizontal = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = source[row + Math.max(0, x - 1)];
      const right = source[row + Math.min(width - 1, x + 1)];
      horizontal[row + x] = (left + source[row + x] + right) / 3;
    }
  }

  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      result[row + x] = (horizontal[up + x] + horizontal[row + x] + horizontal[down + x]) / 3;
    }
  }
  return result;
}

/**
 * The tray icon's cut-out. The window can show the device's own black screen,
 * so the frames it draws can be opaque, but a tray icon must not be.
 */

/** engine.cpp's kKeyThreshold: channels at or below it count as the screen's black. */
const KEY_THRESHOLD = 24;

/**
 * A frame as straight-alpha RGBA, cut out as the engine cuts out a keyed frame
 * (engine.cpp findBackground): dark pixels that connect to the edge of the
 * frame are background, so dark parts inside the art, such as eyes, stay.
 */
export function cutOut(rgba: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const count = width * height;
  const background = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0, tail = 0;
  const push = (index: number): void => {
    if (background[index]) return;
    const at = index * 4;
    if (rgba[at + 3] && Math.max(rgba[at], rgba[at + 1], rgba[at + 2]) > KEY_THRESHOLD) return;
    background[index] = 1;
    queue[tail++] = index;
  };
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const index = y * width + x;
      // Outside the round display the engine writes no alpha.
      if (rgba[index * 4 + 3] === 0 || x === 0 || y === 0 || x === width - 1 || y === height - 1) push(index);
    }
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (index >= width) push(index - width);
    if (index < count - width) push(index + width);
  }
  const out = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; ++index) {
    const at = index * 4;
    const a = rgba[at + 3];
    let alpha = a;
    if (background[index]) {
      // Soften the silhouette by a pixel, as the art is anti-aliased against black.
      const x = index % width, y = (index - x) / width;
      let art = 0, seen = 0;
      for (let dy = -1; dy <= 1; ++dy) {
        for (let dx = -1; dx <= 1; ++dx) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          art += background[ny * width + nx] ? 0 : 1;
          ++seen;
        }
      }
      alpha = Math.round(a * art / seen);
    }
    if (!alpha || !a) continue;
    // The engine's pixels are premultiplied; ImageData is not.
    out[at] = rgba[at] * 255 / a;
    out[at + 1] = rgba[at + 1] * 255 / a;
    out[at + 2] = rgba[at + 2] * 255 / a;
    out[at + 3] = alpha;
  }
  return out;
}

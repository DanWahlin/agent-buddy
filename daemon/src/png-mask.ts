import {inflateSync} from 'node:zlib';

export interface PngMaskSource {
  width: number;
  height: number;
  hasAlpha: boolean;
  pixels: Array<{r: number; g: number; b: number; a: number}>;
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngToMask24(data: Buffer): Buffer {
  return sourceToMask24(decodePng(data));
}

export function decodePng(data: Buffer): PngMaskSource {
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) throw new Error('Not a PNG file.');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) throw new Error('Truncated PNG chunk.');
    const chunk = data.subarray(start, end);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8] ?? 0;
      colorType = chunk[9] ?? 0;
      interlace = chunk[12] ?? 0;
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0)
    throw new Error('Only 8-bit non-interlaced PNGs are supported.');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error('Unsupported PNG color type.');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG data length.');
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++] ?? 0;
    const row = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    unfilter(row, previous, channels, filter);
    rows.push(row);
    previous = row;
  }
  const pixels: PngMaskSource['pixels'] = [];
  const hasAlpha = colorType === 4 || colorType === 6;
  for (const row of rows) {
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      if (colorType === 0) {
        const g = row[i] ?? 0;
        pixels.push({r: g, g, b: g, a: 255});
      } else if (colorType === 2) {
        pixels.push({r: row[i] ?? 0, g: row[i + 1] ?? 0, b: row[i + 2] ?? 0, a: 255});
      } else if (colorType === 4) {
        const g = row[i] ?? 0;
        pixels.push({r: g, g, b: g, a: row[i + 1] ?? 0});
      } else {
        pixels.push({r: row[i] ?? 0, g: row[i + 1] ?? 0, b: row[i + 2] ?? 0, a: row[i + 3] ?? 0});
      }
    }
  }
  return {width, height, hasAlpha, pixels};
}

function unfilter(row: Buffer, previous: Buffer, channels: number, filter: number): void {
  for (let i = 0; i < row.length; i++) {
    const left = i >= channels ? row[i - channels] ?? 0 : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= channels ? previous[i - channels] ?? 0 : 0;
    let value = row[i] ?? 0;
    if (filter === 1) value += left;
    else if (filter === 2) value += up;
    else if (filter === 3) value += Math.floor((left + up) / 2);
    else if (filter === 4) value += paeth(left, up, upLeft);
    else if (filter !== 0) throw new Error('Unsupported PNG filter.');
    row[i] = value & 0xff;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function sourceToMask24(source: PngMaskSource): Buffer {
  const mask = Buffer.alloc(72);
  let totalLuma = 0;
  for (const pixel of source.pixels) totalLuma += pixel.r * 0.299 + pixel.g * 0.587 + pixel.b * 0.114;
  const average = totalLuma / Math.max(1, source.pixels.length);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / 24));
      const sy = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / 24));
      const pixel = source.pixels[sy * source.width + sx];
      if (!pixel) continue;
      const luma = pixel.r * 0.299 + pixel.g * 0.587 + pixel.b * 0.114;
      const on = source.hasAlpha ? pixel.a >= 64 : (average >= 128 ? luma < 160 : luma > 96);
      if (on) {
        const index = y * 3 + Math.floor(x / 8);
        mask[index] = (mask[index] ?? 0) | (0x80 >> (x % 8));
      }
    }
  }
  return mask;
}

import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {parseFirmwareImage} from './firmware-image.js';
import {defaultDataDirectory} from './paths.js';

// A release's firmware, checked and unpacked: the desktop app writes `dir` to the device over USB.
export interface ReleaseFirmware {
  version: string;
  dir: string;
  // The ID the device reports when it runs this firmware.
  id: string;
}

export type DownloadProgress = (received: number, total: number | null) => void;
export type Fetcher = (url: string) => Promise<Response>;

export interface FirmwareReleaseOptions {
  directory?: string;
  baseUrl?: string;
  fetch?: Fetcher;
}

export const releaseRepository = 'DanWahlin/esp32-agent-companion';
const imageNames = ['bin/bootloader.bin', 'bin/partitions.bin', 'bin/boot_app0.bin', 'bin/application.bin',
  'bin/character-copilot.acpk'] as const;
const bundleNames = ['manifest.json', ...imageNames];
const flashBytes = 16 * 1024 * 1024;
const fixedImages = [[0, 0x8000], [0x8000, 0x1000], [0xe000, 0x2000], [0x10000, 0x200000]];
const maxZipBytes = 64 * 1024 * 1024;
const maxSumsBytes = 64 * 1024;

export function releaseFirmwareDirectory(): string {
  if (process.env.AGENT_COMPANION_RELEASE_FIRMWARE) return process.env.AGENT_COMPANION_RELEASE_FIRMWARE;
  return join(defaultDataDirectory(process.platform, homedir(), process.env), 'firmware');
}

export function firmwareAssetName(version: string): string {
  return `esp32-agent-companion-v${version}-firmware.zip`;
}

// Downloads the firmware of one release from GitHub, checks it against the release's SHA256SUMS
// and its own manifest, and keeps it, so a second install needs no download.
export class FirmwareReleases {
  readonly #directory: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetcher;

  constructor(options: FirmwareReleaseOptions = {}) {
    this.#directory = options.directory ?? releaseFirmwareDirectory();
    this.#baseUrl = (options.baseUrl ?? process.env.AGENT_COMPANION_RELEASES_URL
      ?? `https://github.com/${releaseRepository}/releases/download`).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? (url => fetch(url));
  }

  // The release's firmware when it is saved already; null when it must be downloaded.
  async saved(version: string): Promise<ReleaseFirmware | null> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    const dir = join(this.#directory, `v${version}`);
    if (!existsSync(join(dir, 'manifest.json'))) return null;
    return readBundle(dir, version).catch(() => null);
  }

  async prepare(version: string, progress: DownloadProgress = () => undefined): Promise<ReleaseFirmware> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported release version: ${version}.`);
    const dir = join(this.#directory, `v${version}`);
    if (existsSync(join(dir, 'manifest.json'))) {
      try {
        return await readBundle(dir, version);
      } catch (error) {
        console.error(`[firmware] the saved v${version} firmware is not valid; downloading it again: ${message(error)}`);
      }
    }
    const asset = firmwareAssetName(version);
    const sums = parseSums((await this.#download(`v${version}/SHA256SUMS`, maxSumsBytes)).toString('utf8'));
    const expected = sums.get(asset);
    if (!expected) throw new Error(`Release v${version} has no SHA256 for ${asset}.`);
    const zip = await this.#download(`v${version}/${asset}`, maxZipBytes, progress);
    if (sha256(zip) !== expected) throw new Error(`SHA256 mismatch: ${asset}.`);
    const files = unzip(zip, new Set([...bundleNames, 'SHA256SUMS']));
    checkInnerSums(files);
    validateManifest(JSON.parse(files.get('manifest.json')!.toString('utf8')), files, version);

    const staging = `${dir}.partial-${process.pid}`;
    await rm(staging, {recursive: true, force: true});
    for (const name of bundleNames) {
      await mkdir(dirname(join(staging, name)), {recursive: true});
      await writeFile(join(staging, name), files.get(name)!);
    }
    await rm(dir, {recursive: true, force: true});
    await rename(staging, dir);
    console.log(`[firmware] saved release v${version} firmware in ${dir}`);
    return readBundle(dir, version);
  }

  async #download(path: string, limit: number, progress?: DownloadProgress): Promise<Buffer> {
    const url = `${this.#baseUrl}/${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      throw new Error(`Couldn't download ${url}: ${message(error)}`);
    }
    if (response.status === 404) throw new Error(`The release file ${url} does not exist.`);
    if (!response.ok) throw new Error(`Couldn't download ${url}: HTTP ${response.status}.`);
    const length = Number(response.headers.get('content-length'));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    if (total !== null && total > limit) throw new Error(`${url} is too large.`);
    if (!response.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limit) throw new Error(`${url} is too large.`);
      chunks.push(Buffer.from(chunk));
      progress?.(received, total);
    }
    return Buffer.concat(chunks);
  }
}

async function readBundle(dir: string, version: string): Promise<ReleaseFirmware> {
  const files = new Map<string, Buffer>();
  for (const name of bundleNames) files.set(name, await readFile(join(dir, name)));
  validateManifest(JSON.parse(files.get('manifest.json')!.toString('utf8')), files, version);
  return {version, dir, id: parseFirmwareImage(files.get('bin/application.bin')!).id};
}

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match || sums.has(match[2]!)) throw new Error('Invalid SHA256SUMS.');
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

function checkInnerSums(files: Map<string, Buffer>): void {
  const sums = files.get('SHA256SUMS');
  if (!sums) throw new Error('The firmware has no SHA256SUMS.');
  const expected = parseSums(sums.toString('utf8'));
  for (const name of bundleNames) {
    const data = files.get(name);
    if (!data) throw new Error(`The firmware has no ${name}.`);
    if (expected.get(name) !== sha256(data)) throw new Error(`SHA256 mismatch: ${name}.`);
  }
}

// The same rules as tools/flash_release.py, so only an ESP32-S3 bundle with safe offsets is written.
export function validateManifest(manifest: unknown, files: Map<string, Buffer>, version: string): void {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('Manifest must be an object.');
  const value = manifest as Record<string, unknown>;
  if (value.name !== 'esp32-agent-companion' || value.version !== version)
    throw new Error(`The firmware is not esp32-agent-companion v${version}.`);
  if (value.schema_version !== 1) throw new Error('Unsupported manifest schema.');
  if (value.chip !== 'esp32s3' || value.flash_size !== '16MB')
    throw new Error('Unsupported chip or flash size; expected ESP32-S3 with 16MB.');
  const images = value.images;
  if (!Array.isArray(images) || images.length !== imageNames.length)
    throw new Error('Manifest must contain exactly the five supported images.');
  let end = 0;
  images.forEach((image: Record<string, unknown> | null, index) => {
    const name = imageNames[index]!;
    if (typeof image !== 'object' || image === null || image.file !== name)
      throw new Error('Invalid image filename or order.');
    const [offset, budget, size] = [image.offset, image.max_size, image.size].map(item => {
      if (!Number.isSafeInteger(item) || (item as number) < 0) throw new Error(`Invalid numbers for ${name}.`);
      return item as number;
    }) as [number, number, number];
    const fixed = fixedImages[index];
    if (fixed && (offset !== fixed[0] || budget !== fixed[1])) throw new Error(`Unsafe offset or budget for ${name}.`);
    if (!fixed && offset % 0x10000 !== 0) throw new Error('Unsafe assets offset.');
    if (budget === 0 || size === 0 || size > budget || offset + budget > flashBytes)
      throw new Error(`Image exceeds its flash budget: ${name}.`);
    if (offset < end) throw new Error('Image partitions overlap.');
    end = offset + budget;
    const data = files.get(name);
    if (!data || data.length !== size || image.sha256 !== sha256(data))
      throw new Error(`Image size or SHA256 mismatch: ${name}.`);
  });
  if (value.asset_sha256 !== (images[imageNames.length - 1] as Record<string, unknown>).sha256)
    throw new Error('Asset SHA256 mismatch.');
}

// Reads the named files from a zip; release zips are stored, and deflate is read too.
export function unzip(zip: Buffer, wanted: ReadonlySet<string>): Map<string, Buffer> {
  const minimum = Math.max(0, zip.length - 0xffff - 22);
  let end = -1;
  for (let at = zip.length - 22; at >= minimum; at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('The firmware download is not a zip file.');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The firmware zip is damaged.');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (!wanted.has(name)) continue;
    if (files.has(name)) throw new Error(`The firmware zip has ${name} two times.`);
    if (flags & 1) throw new Error('The firmware zip is encrypted.');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('The firmware zip is damaged.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressed > zip.length) throw new Error('The firmware zip is damaged.');
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw)
      : method === 8 ? inflateRawSync(raw, {maxOutputLength: flashBytes})
      : (() => { throw new Error(`Unsupported zip compression for ${name}.`); })();
    if (data.length !== size) throw new Error(`The firmware zip is damaged: ${name}.`);
    files.set(name, data);
  }
  return files;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

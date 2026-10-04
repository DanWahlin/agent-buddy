import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface FirmwareImage {
  data: Buffer;
  // The first 16 hex digits of the ELF SHA-256, which the device reports as `firmware`.
  id: string;
  md5: string;
}

const imageMagic = 0xe9;
// esp_app_desc_t follows the 24-byte image header and the 8-byte first segment header.
const appDescOffset = 32;
const appDescMagic = 0xabcd5432;
const elfShaOffset = appDescOffset + 144;
// The OTA app slots in partitions.csv are 2 MB.
const maxImageBytes = 0x200000;

// The image that `bash tools/arduino.sh build` makes.
export function builtFirmwarePath(): string {
  if (process.env.AGENT_COMPANION_FIRMWARE) return process.env.AGENT_COMPANION_FIRMWARE;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build', 'firmware', 'AgentCompanion.ino.bin');
}

export function parseFirmwareImage(data: Buffer): FirmwareImage {
  if (data.length < elfShaOffset + 32 || data[0] !== imageMagic || data.readUInt32LE(appDescOffset) !== appDescMagic)
    throw new Error('This is not ESP32 app firmware.');
  if (data.length > maxImageBytes) throw new Error('The firmware is too large for an app slot.');
  return {
    data,
    id: data.subarray(elfShaOffset, elfShaOffset + 8).toString('hex'),
    md5: createHash('md5').update(data).digest('hex'),
  };
}

// Reads the built image again only when the file changes; null when there is none, or it is not valid.
export function builtFirmwareReader(path = builtFirmwarePath()): () => FirmwareImage | null {
  let key = '';
  let image: FirmwareImage | null = null;
  return () => {
    let next: string;
    try {
      const info = statSync(path);
      next = `${info.mtimeMs}:${info.size}`;
    } catch {
      next = '';
    }
    if (next === key) return image;
    key = next;
    try {
      image = next ? parseFirmwareImage(readFileSync(path)) : null;
    } catch (error) {
      console.error(`[firmware] ${error instanceof Error ? error.message : String(error)}`);
      image = null;
    }
    return image;
  };
}

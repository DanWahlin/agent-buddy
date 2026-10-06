import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
export const speechSampleRate = 24000;
export const maxSpeechSeconds = 15;
export const maxSpeechFrames = speechSampleRate * maxSpeechSeconds;
export const speechHeaderBytes = 16;
export const maxSpeechTextCharacters = 500;

export interface SpeechSynthesizer {
  synthesize(text: string): Promise<Buffer>;
}

export function validateSpeechText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('Speech text must be a string.');
  const normalized = text.trim();
  if (!normalized) throw new Error('Speech text cannot be empty.');
  if (normalized.includes('\0')) throw new Error('Speech text cannot contain null bytes.');
  if ([...normalized].length > maxSpeechTextCharacters)
    throw new Error(`Speech text cannot exceed ${maxSpeechTextCharacters} characters.`);
  return normalized;
}

export function speechPacketFromWave(wave: Buffer): Buffer {
  if (wave.length < 12 || wave.toString('ascii', 0, 4) !== 'RIFF'
      || wave.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('The speech synthesizer did not produce a WAV file.');
  let format: {encoding: number; channels: number; sampleRate: number; bits: number} | null = null;
  let pcm: Buffer | null = null;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const id = wave.toString('ascii', offset, offset + 4);
    const size = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wave.length) throw new Error('The speech WAV file is truncated.');
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: wave.readUInt16LE(start),
        channels: wave.readUInt16LE(start + 2),
        sampleRate: wave.readUInt32LE(start + 4),
        bits: wave.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      pcm = wave.subarray(start, end);
    }
    offset = end + (size & 1);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1
      || format.sampleRate !== speechSampleRate || format.bits !== 16)
    throw new Error('Speech audio must be mono 24 kHz signed 16-bit PCM.');
  if (!pcm || pcm.length === 0 || (pcm.length & 1) !== 0)
    throw new Error('Speech audio is empty or misaligned.');
  const frames = pcm.length / 2;
  if (frames > maxSpeechFrames)
    throw new Error(`Speech audio cannot exceed ${maxSpeechSeconds} seconds.`);
  const header = Buffer.alloc(speechHeaderBytes);
  header.write('ACSP', 0, 'ascii');
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt16LE(speechSampleRate, 6);
  header.writeUInt32LE(frames, 8);
  return Buffer.concat([header, pcm]);
}

export class MacOsSaySynthesizer implements SpeechSynthesizer {
  async synthesize(text: string): Promise<Buffer> {
    const speech = validateSpeechText(text);
    const folder = await mkdtemp(join(tmpdir(), 'agent-companion-speech-'));
    const source = join(folder, 'speech.aiff');
    const wave = join(folder, 'speech.wav');
    try {
      await execFileAsync('/usr/bin/say', ['-o', source, speech], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync('/usr/bin/afconvert', [
        '-f', 'WAVE', '-d', `LEI16@${speechSampleRate}`, '-c', '1', source, wave,
      ], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return speechPacketFromWave(await readFile(wave));
    } catch (error) {
      throw new Error(`macOS speech synthesis failed: ${
        error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(folder, {recursive: true, force: true});
    }
  }
}

export function createSpeechSynthesizer(platform = process.platform): SpeechSynthesizer {
  if (platform === 'darwin') return new MacOsSaySynthesizer();
  return {
    async synthesize(): Promise<Buffer> {
      throw new Error('Speech synthesis currently requires macOS with the built-in say and afconvert tools.');
    },
  };
}

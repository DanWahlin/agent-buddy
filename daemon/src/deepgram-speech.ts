import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {deepgramConfigPath} from './paths.js';
import {
  speechPacketFromPcm, speechSampleRate, validateSpeechText, type SpeechSynthesizer,
} from './speech.js';

// Deepgram Flux TTS voices (https://deepgram.com/product/text-to-speech/flux).
export const fluxVoices = [
  'flux-haley-en', 'flux-cole-en', 'flux-heather-en', 'flux-priya-en',
  'flux-jack-en', 'flux-bruce-en', 'flux-rufus-en', 'flux-drew-en',
] as const;
export type FluxVoice = typeof fluxVoices[number];
export const defaultFluxVoice: FluxVoice = 'flux-haley-en';

export const deepgramSpeakUrl = 'https://api.deepgram.com/v2/speak';
const requestTimeoutMs = 30_000;

export function isFluxVoice(value: unknown): value is FluxVoice {
  return typeof value === 'string' && (fluxVoices as readonly string[]).includes(value);
}

// Deepgram keys are 40 hex characters today; allow some room without accepting anything odd.
export function isDeepgramKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{20,128}$/.test(value);
}

export function validateDeepgramKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : value;
  if (!isDeepgramKey(key)) throw new Error('The Deepgram API key must be 20 to 128 characters with no spaces.');
  return key;
}

export async function loadDeepgramKey(path = deepgramConfigPath()): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {apiKey?: unknown};
    return isDeepgramKey(parsed.apiKey) ? parsed.apiKey : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Saves the key readable only by this user, or removes the file when the key is null.
export async function saveDeepgramKey(key: string | null, path = deepgramConfigPath()): Promise<void> {
  if (key === null) {
    await rm(path, {force: true});
    return;
  }
  const apiKey = validateDeepgramKey(key);
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, `${JSON.stringify({apiKey}, null, 2)}\n`, {mode: 0o600});
  await chmod(path, 0o600);
}

// The batch request both the daemon and the device make: raw 24 kHz mono 16-bit PCM.
export function deepgramSpeakRequestUrl(voice: string): URL {
  const url = new URL(deepgramSpeakUrl);
  url.searchParams.set('model', voice);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(speechSampleRate));
  url.searchParams.set('container', 'none');
  return url;
}

// Deepgram may still wrap linear16 in a WAV header; take the samples after its data chunk id.
export function pcmFromDeepgramAudio(audio: Buffer): Buffer {
  if (audio.length >= 12 && audio.toString('ascii', 0, 4) === 'RIFF'
      && audio.toString('ascii', 8, 12) === 'WAVE') {
    for (let offset = 12; offset + 8 <= audio.length;) {
      const id = audio.toString('ascii', offset, offset + 4);
      const size = audio.readUInt32LE(offset + 4);
      if (id === 'data') {
        // Streamed WAV headers can carry a placeholder size, so trust the bytes that arrived.
        const end = Math.min(audio.length, offset + 8 + size);
        return audio.subarray(offset + 8, end - ((end - offset - 8) & 1));
      }
      offset += 8 + size + (size & 1);
    }
    throw new Error('Deepgram returned a WAV file without audio.');
  }
  return audio;
}

async function deepgramError(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403)
    return new Error('Deepgram rejected the API key.');
  if (response.status === 429)
    return new Error('Deepgram rate limit reached. Try again shortly.');
  let detail = '';
  try {
    const body = await response.json() as {err_msg?: unknown; message?: unknown};
    const message = body.err_msg ?? body.message;
    if (typeof message === 'string') detail = `: ${message.slice(0, 200)}`;
  } catch {
    // Not JSON: the status alone says enough.
  }
  return new Error(`Deepgram speech failed (HTTP ${response.status})${detail}`);
}

export interface DeepgramFluxOptions {
  apiKey: () => string | null | Promise<string | null>;
  voice: () => string;
  fetch?: typeof fetch;
}

export class DeepgramFluxSynthesizer implements SpeechSynthesizer {
  readonly #options: DeepgramFluxOptions;

  constructor(options: DeepgramFluxOptions) {
    this.#options = options;
  }

  async synthesize(text: string): Promise<Buffer> {
    const speech = validateSpeechText(text);
    const key = await this.#options.apiKey();
    if (!key) throw new Error('Add a Deepgram API key in Settings before using Deepgram speech.');
    const voice = this.#options.voice();
    if (!isFluxVoice(voice)) throw new Error('Choose a Deepgram Flux voice in Settings.');
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(deepgramSpeakRequestUrl(voice), {
        method: 'POST',
        headers: {Authorization: `Token ${key}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({text: speech}),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new Error(`Could not reach Deepgram: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw await deepgramError(response);
    return speechPacketFromPcm(pcmFromDeepgramAudio(Buffer.from(await response.arrayBuffer())));
  }
}

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  DeepgramFluxSynthesizer, deepgramSpeakRequestUrl, isDeepgramKey, loadDeepgramKey, pcmFromDeepgramAudio,
  saveDeepgramKey,
} from '../src/deepgram-speech.js';
import {speechPacketFromPcm, speechSampleRate} from '../src/speech.js';

const key = '0123456789abcdef0123456789abcdef01234567';

function synthesizer(respond: (url: URL, init: RequestInit) => Response, options: {
  apiKey?: string | null; voice?: string;
} = {}) {
  const calls: Array<{url: URL; init: RequestInit}> = [];
  const synth = new DeepgramFluxSynthesizer({
    apiKey: () => options.apiKey === undefined ? key : options.apiKey,
    voice: () => options.voice ?? 'flux-haley-en',
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({url, init});
      return respond(url, init);
    }) as typeof fetch,
  });
  return {synth, calls};
}

test('asks Flux TTS for raw 24 kHz linear16 audio with a token header', async () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const {synth, calls} = synthesizer(() => new Response(pcm));
  const packet = await synth.synthesize('  Hello there  ');
  assert.deepEqual(packet, speechPacketFromPcm(pcm));
  assert.equal(calls.length, 1);
  const {url, init} = calls[0]!;
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v2/speak');
  assert.equal(url.searchParams.get('model'), 'flux-haley-en');
  assert.equal(url.searchParams.get('encoding'), 'linear16');
  assert.equal(url.searchParams.get('sample_rate'), String(speechSampleRate));
  assert.equal(url.searchParams.get('container'), 'none');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {Authorization: `Token ${key}`, 'Content-Type': 'application/json'});
  assert.equal(init.body, JSON.stringify({text: 'Hello there'}));
  assert.deepEqual(deepgramSpeakRequestUrl('flux-cole-en').searchParams.get('model'), 'flux-cole-en');
});

test('reports Deepgram failures without the key', async () => {
  for (const [status, pattern] of [[401, /rejected the API key/], [403, /rejected the API key/],
                                    [429, /rate limit/], [400, /HTTP 400\): bad model/]] as const) {
    const {synth} = synthesizer(() => new Response(JSON.stringify({err_msg: 'bad model'}), {status}));
    await assert.rejects(synth.synthesize('hello'), (error: Error) => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    });
  }
  const offline = new DeepgramFluxSynthesizer({
    apiKey: () => key, voice: () => 'flux-haley-en',
    fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch,
  });
  await assert.rejects(offline.synthesize('hello'), /Could not reach Deepgram: getaddrinfo/);
});

test('needs a key and a Flux voice before calling Deepgram', async () => {
  const missing = synthesizer(() => new Response(Buffer.alloc(2)), {apiKey: null});
  await assert.rejects(missing.synth.synthesize('hello'), /Add a Deepgram API key/);
  assert.equal(missing.calls.length, 0);
  const wrongVoice = synthesizer(() => new Response(Buffer.alloc(2)), {voice: 'aura-2-thalia-en'});
  await assert.rejects(wrongVoice.synth.synthesize('hello'), /Flux voice/);
  await assert.rejects(synthesizer(() => new Response(Buffer.alloc(2))).synth.synthesize(' '), /cannot be empty/);
});

test('takes the samples out of a WAV wrapper, even with a placeholder size', () => {
  const pcm = Buffer.from([5, 0, 6, 0]);
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(0xffffffff, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.write('data', 36);
  wav.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(pcmFromDeepgramAudio(Buffer.concat([wav, pcm])), pcm);
  assert.deepEqual(pcmFromDeepgramAudio(pcm), pcm);
});

test('stores the key for this user only and removes it on request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepgram-key-'));
  const path = join(directory, 'nested', 'deepgram.json');
  try {
    assert.equal(await loadDeepgramKey(path), null);
    await saveDeepgramKey(`  ${key} `, path);
    assert.equal(await loadDeepgramKey(path), key);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {apiKey: key});
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(saveDeepgramKey('too short', path), /20 to 128/);
    await saveDeepgramKey(null, path);
    assert.equal(await loadDeepgramKey(path), null);
    assert.equal(isDeepgramKey(key), true);
    assert.equal(isDeepgramKey('has spaces in the middle of it'), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

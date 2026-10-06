import assert from 'node:assert/strict';
import test from 'node:test';
import {speakText} from '../src/daemon.js';
import {
  createSpeechSynthesizer,
  maxSpeechFrames,
  speechHeaderBytes,
  speechPacketFromWave,
  speechSampleRate,
  validateSpeechText,
} from '../src/speech.js';
import {parseSpeechResponse} from '../src/wifi-transport.js';

function wave(pcm: Buffer, overrides: {channels?: number; rate?: number; bits?: number} = {}): Buffer {
  const result = Buffer.alloc(44 + pcm.length);
  result.write('RIFF', 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(overrides.channels ?? 1, 22);
  result.writeUInt32LE(overrides.rate ?? speechSampleRate, 24);
  result.writeUInt32LE(speechSampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(overrides.bits ?? 16, 34);
  result.write('data', 36);
  result.writeUInt32LE(pcm.length, 40);
  pcm.copy(result, 44);
  return result;
}

test('validates bounded speech text', () => {
  assert.equal(validateSpeechText('  hello  '), 'hello');
  assert.throws(() => validateSpeechText('  '), /cannot be empty/);
  assert.throws(() => validateSpeechText('a'.repeat(501)), /500 characters/);
  assert.throws(() => validateSpeechText('hello\0world'), /null bytes/);
});

test('builds the versioned mono PCM speech packet', () => {
  const packet = speechPacketFromWave(wave(Buffer.from([1, 2, 3, 4])));
  assert.equal(packet.toString('ascii', 0, 4), 'ACSP');
  assert.equal(packet.readUInt8(4), 1);
  assert.equal(packet.readUInt8(5), 1);
  assert.equal(packet.readUInt16LE(6), speechSampleRate);
  assert.equal(packet.readUInt32LE(8), 2);
  assert.deepEqual(packet.subarray(speechHeaderBytes), Buffer.from([1, 2, 3, 4]));
  assert.throws(() => speechPacketFromWave(wave(Buffer.from([1, 2]), {channels: 2})), /mono 24 kHz/);
  assert.throws(() => speechPacketFromWave(wave(Buffer.alloc(maxSpeechFrames * 2 + 2))), /15 seconds/);
  assert.throws(() => speechPacketFromWave(Buffer.from('not wave')), /WAV file/);
});

test('reports unsupported synthesis platforms explicitly', async () => {
  await assert.rejects(createSpeechSynthesizer('linux').synthesize('hello'), /requires macOS/);
});

test('surfaces malformed and rejected device speech responses', () => {
  assert.doesNotThrow(() => parseSpeechResponse(202, '{"ok":true,"playing":true}'));
  assert.throws(() => parseSpeechResponse(409, '{"ok":false,"error":"Speech playback is already in progress."}'),
    /already in progress/);
  assert.throws(() => parseSpeechResponse(500, '<html>'), /invalid speech response/);
});

test('synthesizes then sends one packet through the Wi-Fi transport', async () => {
  const packet = Buffer.from('packet');
  let sent: Buffer | undefined;
  assert.deepEqual(await speakText(' hello ', {
    async speak(value: Buffer) {
      sent = value;
    },
  }, {
    async synthesize(text: string) {
      assert.equal(text, 'hello');
      return packet;
    },
  }), {ok: true});
  assert.equal(sent, packet);
});

test('does not mask synthesis or transport failures', async () => {
  await assert.rejects(speakText('', {speak: async () => undefined}, {
    synthesize: async () => Buffer.alloc(0),
  }), /cannot be empty/);
  await assert.rejects(speakText('hello', {speak: async () => {
    throw new Error('device rejected speech');
  }}, {
    synthesize: async () => Buffer.from('packet'),
  }), /device rejected speech/);
});

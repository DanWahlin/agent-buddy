import {speechSampleRate, validateSpeechText, type SpeechSynthesizer} from './speech.js';

// A line that is ready to play. Preparing it first lets the caller check it is still relevant
// after slow synthesis and before the device hears it.
export interface PreparedSpeech {
  // Resolves once the device has the line, with how long it still has left to play.
  play(): Promise<number>;
}

export interface SpeechRoute {
  prepare(text: string): Promise<PreparedSpeech>;
}

// The computer synthesizes the audio (macOS say or Deepgram) and streams it to /speech.
export function packetRoute(
    synthesizer: SpeechSynthesizer, output: {speak(packet: Buffer): Promise<void>}): SpeechRoute {
  return {
    async prepare(text) {
      const packet = await synthesizer.synthesize(text);
      return {
        async play() {
          await output.speak(packet);
          // /speech acknowledges acceptance, not playback completion.
          return packet.readUInt32LE(8) / speechSampleRate * 1000;
        },
      };
    },
  };
}

// The device asks Deepgram for the audio itself; the computer only sends the text.
export function deviceRoute(output: {speakText(text: string): Promise<void>}): SpeechRoute {
  return {
    async prepare(text) {
      const speech = validateSpeechText(text);
      return {
        async play() {
          // speakText resolves once the device has finished playing.
          await output.speakText(speech);
          return 0;
        },
      };
    },
  };
}

// Where speech comes from: macOS say, Deepgram called by this computer, or Deepgram called by the device.
export const speechProviders = ['system', 'deepgram', 'deepgram-device'] as const;
export type SpeechProvider = typeof speechProviders[number];

export function isSpeechProvider(value: unknown): value is SpeechProvider {
  return typeof value === 'string' && (speechProviders as readonly string[]).includes(value);
}

/**
 * The device's sound cues, played by the desktop when its character changes
 * mode, as the device plays them. The same WAV files the firmware embeds
 * (assets/audio), bundled into the page so it needs nothing beside itself.
 */
import working from '../../../../../assets/audio/working.wav';
import attention from '../../../../../assets/audio/needs-attention.wav';
import complete from '../../../../../assets/audio/complete.wav';
import surprise from '../../../../../assets/audio/surprise.wav';
import tick from '../../../../../assets/audio/settings-tick.wav';

export type Cue = 'working' | 'attention' | 'complete' | 'surprise' | 'tick';

const FILES: Record<Cue, Uint8Array> = { working, attention, complete, surprise, tick };
/** The volume, 0 to 1, until Settings gives one: 30%, soft beside other apps' sounds. */
let volume = 0.3;

/** The device's CharacterMode values that have a cue; idle and sleep are silent. */
const MODE_CUES: Record<number, Cue> = { 1: 'surprise', 2: 'working', 3: 'complete', 4: 'attention' };

export function cueForMode(mode: number): Cue | null {
  return MODE_CUES[mode] ?? null;
}

let context: AudioContext | null = null;
let gain: GainNode | null = null;
const buffers = new Map<Cue, Promise<AudioBuffer>>();

function decoded(cue: Cue, audio: AudioContext): Promise<AudioBuffer> {
  let buffer = buffers.get(cue);
  if (!buffer) {
    // decodeAudioData takes the buffer it is given, so give it a copy.
    buffer = audio.decodeAudioData(FILES[cue].slice().buffer);
    buffers.set(cue, buffer);
  }
  return buffer;
}

/**
 * Make the audio context on first use. A webview can keep it suspended until
 * the user clicks in the page; a click calls `unlock`, which resumes it.
 */
function audio(): AudioContext {
  if (!context) {
    context = new AudioContext();
    gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(context.destination);
  }
  return context;
}

/** Set how loud the cues play, from 0 (silent) to 100 (full scale). */
export function setVolume(percent: number): void {
  volume = Math.min(Math.max(percent, 0), 100) / 100;
  if (gain) gain.gain.value = volume;
}

export function unlock(): void {
  void audio().resume().catch(() => {});
}

export async function play(cue: Cue): Promise<void> {
  const audioContext = audio();
  if (audioContext.state === 'suspended') await audioContext.resume().catch(() => {});
  const source = audioContext.createBufferSource();
  source.buffer = await decoded(cue, audioContext);
  source.connect(gain!);
  source.start();
}

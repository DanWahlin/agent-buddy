import type {CharacterState} from './protocol.js';
import {createSpeechSynthesizer, validateSpeechText, type SpeechSynthesizer} from './speech.js';
import {packetRoute, type PreparedSpeech, type SpeechRoute} from './speech-route.js';

export const voiceNotificationModes = ['off', 'milestones', 'chatty', 'contextual'] as const;
export type VoiceNotificationMode = typeof voiceNotificationModes[number];
export const maxNarrationCharacters = 180;

export function isVoiceNotificationMode(value: unknown): value is VoiceNotificationMode {
  return typeof value === 'string' && (voiceNotificationModes as readonly string[]).includes(value);
}

export function validateNarrationText(value: unknown): string {
  const text = validateSpeechText(value);
  if ([...text].length > maxNarrationCharacters)
    throw new Error(`Contextual narration cannot exceed ${maxNarrationCharacters} characters.`);
  if (/[\r\n\t]/.test(text)) throw new Error('Contextual narration must be a single spoken line.');
  if (/\b(?:https?:\/\/|www\.)\S+/i.test(text) || /\b\S+@\S+\.\S+\b/.test(text))
    throw new Error('Contextual narration cannot contain URLs or email addresses.');
  return text;
}

const phrases: Record<Exclude<CharacterState, 'surprise'>, readonly string[]> = {
  working: [
    'On it.',
    'Mmmm... let me think.',
    'Working on that now.',
    'Okay, gears are turning.',
    'Let me poke at that.',
  ],
  attention: [
    'I need your attention.',
    'I have a question for you.',
    'Could you take a look?',
    'Psst. I need a quick decision.',
  ],
  complete: [
    'All done.',
    'That is finished.',
    'Wrapped that up.',
    'Your task is complete.',
    'Ta-da. All done.',
  ],
  idle: [
    'Ready when you are.',
    'I am standing by.',
    'Everything is quiet now.',
    'Let me know what is next.',
    'I will be right here, contemplating the void.',
  ],
};

interface VoiceOutput {
  speak(packet: Buffer): Promise<void>;
}

type SpokenState = Exclude<CharacterState, 'surprise'>;
interface Announcement {
  state: SpokenState;
  previous: CharacterState;
  readyAt: number;
}

const quietMs = 2000;
const stableMs = 3000;
const routineCooldownMs = 15_000;
const playbackMarginMs = 250;

export interface VoiceNotifierOptions {
  synthesizer?: SpeechSynthesizer;
  // How lines reach the device; when absent, the synthesizer's audio goes to the output.
  route?: SpeechRoute;
  random?: () => number;
  available?: () => boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export class VoiceNotifier {
  #mode: VoiceNotificationMode;
  #lastState: CharacterState = 'idle';
  readonly #lastPhrase = new Map<CharacterState, string>();
  #pending = Promise.resolve();
  #announcement: Announcement | undefined;
  #timer: NodeJS.Timeout | undefined;
  #automaticQueued = false;
  #quietSince: number | undefined;
  #workingAnnounced = false;
  #lastSpeechAt = -Infinity;
  #suppressWorkingUntil = -Infinity;
  #narrationsPending = 0;
  #playbackUntil = 0;
  readonly #route: SpeechRoute;
  readonly #random: () => number;
  readonly #available: () => boolean;
  readonly #log: (message: string) => void;
  readonly #error: (message: string) => void;

  constructor(output: VoiceOutput, mode: VoiceNotificationMode, options: VoiceNotifierOptions = {}) {
    this.#mode = mode;
    this.#route = options.route ?? packetRoute(options.synthesizer ?? createSpeechSynthesizer(), output);
    this.#random = options.random ?? Math.random;
    this.#available = options.available ?? (() => true);
    this.#log = options.log ?? (message => console.log(message));
    this.#error = options.error ?? (message => console.error(message));
  }

  get mode(): VoiceNotificationMode {
    return this.#mode;
  }

  setMode(mode: VoiceNotificationMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#announcement = undefined;
    this.#schedule();
  }

  narrate(value: unknown): Promise<void> {
    const text = validateNarrationText(value);
    if (this.#mode !== 'contextual')
      return Promise.reject(new Error('Contextual narration is not enabled.'));
    if (!this.#available())
      return Promise.reject(new Error('Contextual narration needs the device connected over Wi-Fi.'));
    this.#narrationsPending++;
    this.#suppressWorkingUntil = Date.now() + routineCooldownMs;
    this.#workingAnnounced = true;
    const work = this.#enqueue(async () => {
      await this.#waitForPlayback();
      if (this.#mode !== 'contextual') throw new Error('Contextual narration was disabled.');
      if (!this.#available()) throw new Error('The device is no longer connected over Wi-Fi.');
      const speech = await this.#route.prepare(text);
      if (this.#mode !== 'contextual') throw new Error('Contextual narration was disabled.');
      if (!this.#available()) throw new Error('The device is no longer connected over Wi-Fi.');
      await this.#send(speech);
      this.#log('[voice] contextual narration sent');
    }).finally(() => {
      this.#narrationsPending--;
      this.#suppressWorkingUntil = Date.now() + routineCooldownMs;
    });
    return work;
  }

  stateChanged(state: CharacterState): void {
    if (state === this.#lastState) return;
    const previous = this.#lastState;
    this.#lastState = state;
    const now = Date.now();
    if (this.#quietSince !== undefined && now - this.#quietSince >= quietMs)
      this.#workingAnnounced = false;
    if (state === 'complete' || state === 'idle') this.#quietSince ??= now;
    else this.#quietSince = undefined;

    // The coordinator clears the completion animation after four seconds; a
    // completion waiting for synthesis/playback remains relevant until work resumes.
    if (state === 'idle' && previous === 'complete') return;
    this.#announcement = this.#shouldAnnounce(state, previous) ? {
      state, previous, readyAt: now + (state === 'complete' || state === 'idle' ? quietMs : stableMs),
    } : undefined;
    this.#schedule();
  }

  settled(): Promise<void> {
    return this.#pending;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#announcement || this.#automaticQueued) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#automaticQueued = true;
      void this.#enqueue(async () => {
        let event: Announcement | undefined;
        try {
          if (!this.#announcement || this.#announcement.readyAt > Date.now()) return;
          event = this.#announcement;
          await this.#waitForPlayback();
          if (!this.#relevant(event)) return;
          const phrase = this.#choose(event.state);
          const speech = await this.#route.prepare(phrase);
          if (!this.#relevant(event)) return;
          await this.#send(speech);
          this.#lastPhrase.set(event.state, phrase);
          if (event.state === 'working') this.#workingAnnounced = true;
          this.#log(`[voice] ${event.state}: ${phrase}`);
        } finally {
          if (this.#announcement === event) this.#announcement = undefined;
          this.#automaticQueued = false;
          this.#schedule();
        }
      });
    }, Math.max(0, this.#announcement.readyAt - Date.now(), this.#playbackUntil - Date.now()));
    this.#timer.unref();
  }

  #relevant(event: Announcement): boolean {
    return this.#announcement === event
      && this.#shouldAnnounce(event.state, event.previous)
      && this.#available()
      && (event.state === 'attention' || Date.now() - this.#lastSpeechAt >= routineCooldownMs)
      && (event.state !== 'working' || (!this.#workingAnnounced
        && this.#narrationsPending === 0 && Date.now() >= this.#suppressWorkingUntil));
  }

  #enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.#pending.then(action);
    this.#pending = work.catch(error => {
      this.#error(`[voice] ${error instanceof Error ? error.message : String(error)}`);
    });
    return work;
  }

  async #waitForPlayback(): Promise<void> {
    const delay = this.#playbackUntil - Date.now();
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
  }

  async #send(speech: PreparedSpeech): Promise<void> {
    const remainingMs = await speech.play();
    this.#lastSpeechAt = Date.now();
    // The device can accept a line before it finishes playing. Leave time for
    // this clip to finish before sending another notifier-owned clip.
    this.#playbackUntil = Date.now() + remainingMs + playbackMarginMs;
  }

  #shouldAnnounce(state: CharacterState, previous: CharacterState): state is Exclude<CharacterState, 'surprise'> {
    if (this.#mode === 'off' || state === 'surprise') return false;
    if (state === 'attention' || state === 'complete') return true;
    if (this.#mode !== 'chatty' && this.#mode !== 'contextual') return false;
    // Complete already says the task ended; do not follow it four seconds later with an idle line.
    return state === 'working' || (state === 'idle' && previous !== 'complete');
  }

  #choose(state: Exclude<CharacterState, 'surprise'>): string {
    const choices = phrases[state];
    const previous = this.#lastPhrase.get(state);
    const available = choices.length > 1 ? choices.filter(choice => choice !== previous) : choices;
    const index = Math.min(available.length - 1, Math.floor(this.#random() * available.length));
    const phrase = available[Math.max(0, index)]!;
    return phrase;
  }
}

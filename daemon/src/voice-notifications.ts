import type {CharacterState} from './protocol.js';
import {createSpeechSynthesizer, type SpeechSynthesizer} from './speech.js';

export const voiceNotificationModes = ['off', 'milestones', 'chatty'] as const;
export type VoiceNotificationMode = typeof voiceNotificationModes[number];

export function isVoiceNotificationMode(value: unknown): value is VoiceNotificationMode {
  return typeof value === 'string' && (voiceNotificationModes as readonly string[]).includes(value);
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

export interface VoiceNotifierOptions {
  synthesizer?: SpeechSynthesizer;
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
  readonly #output: VoiceOutput;
  readonly #synthesizer: SpeechSynthesizer;
  readonly #random: () => number;
  readonly #available: () => boolean;
  readonly #log: (message: string) => void;
  readonly #error: (message: string) => void;

  constructor(output: VoiceOutput, mode: VoiceNotificationMode, options: VoiceNotifierOptions = {}) {
    this.#output = output;
    this.#mode = mode;
    this.#synthesizer = options.synthesizer ?? createSpeechSynthesizer();
    this.#random = options.random ?? Math.random;
    this.#available = options.available ?? (() => true);
    this.#log = options.log ?? (message => console.log(message));
    this.#error = options.error ?? (message => console.error(message));
  }

  get mode(): VoiceNotificationMode {
    return this.#mode;
  }

  setMode(mode: VoiceNotificationMode): void {
    this.#mode = mode;
  }

  stateChanged(state: CharacterState): void {
    if (state === this.#lastState) return;
    const previous = this.#lastState;
    this.#lastState = state;
    if (!this.#shouldAnnounce(state, previous)) return;
    const phrase = this.#choose(state);
    this.#pending = this.#pending.then(async () => {
      if (!this.#shouldAnnounce(state, previous) || !this.#available()) return;
      const packet = await this.#synthesizer.synthesize(phrase);
      await this.#output.speak(packet);
      this.#log(`[voice] ${state}: ${phrase}`);
    }).catch(error => {
      this.#error(`[voice] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  settled(): Promise<void> {
    return this.#pending;
  }

  #shouldAnnounce(state: CharacterState, previous: CharacterState): state is Exclude<CharacterState, 'surprise'> {
    if (this.#mode === 'off' || state === 'surprise') return false;
    if (state === 'attention' || state === 'complete') return true;
    if (this.#mode !== 'chatty') return false;
    // Complete already says the task ended; do not follow it four seconds later with an idle line.
    return state === 'working' || (state === 'idle' && previous !== 'complete');
  }

  #choose(state: Exclude<CharacterState, 'surprise'>): string {
    const choices = phrases[state];
    const previous = this.#lastPhrase.get(state);
    const available = choices.length > 1 ? choices.filter(choice => choice !== previous) : choices;
    const index = Math.min(available.length - 1, Math.floor(this.#random() * available.length));
    const phrase = available[Math.max(0, index)]!;
    this.#lastPhrase.set(state, phrase);
    return phrase;
  }
}

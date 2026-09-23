/**
 * Deciding which pose to show.
 *
 * The vendored engine knows about the eight gaze tracks and about blinking. It
 * does not know about expressions, because upstream those live in the device
 * firmware rather than in the browser. This wraps it with the missing layer:
 *
 * - idle hands over to the engine entirely, so the look-around and blink timing
 *   are the ones that were tuned on the device;
 * - an expression is a ramp along its own track, from the centre pose at index 0
 *   to full strength at the last index, held until the state changes;
 * - every transition passes through index 0. That is the shared centre pose all
 *   thirteen tracks agree on, and going through it is what stops a track change
 *   from reading as a jump. It is the reason the packer enforces that invariant.
 * - sleep needs no art: hold the centre pose with the eyes fully closed.
 */

import type { CharacterState, Pack, TrackName } from '@agent-companion/pack-format';
import { spritePlayer, type Direction, type SpriteMotionLike } from './motion.js';

export interface CharacterPlayerOptions {
  pack: Pack;
  /** Seconds for an expression to ramp from centre to full strength. */
  rampSeconds?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  motion?: SpriteMotionLike;
  /** Doze off when left alone, and wake again. Upstream's device does. */
  autoSleep?: boolean;
}

/**
 * Upstream's idle cycle, from `CharacterMotion.h`: two uninterrupted idle
 * minutes, one minute asleep, then round again.
 */
export const IDLE_BEFORE_SLEEP_SECONDS = 2 * 60;
export const SLEEP_SECONDS = 60;

/** The pose to draw this frame. */
export interface Pose {
  track: TrackName;
  /** Pose index to draw. */
  from: number;
  /** Pose index to cross-fade toward, equal to `from` when not moving. */
  to: number;
  /** 0..1 blend between `from` and `to`. */
  mix: number;
  /** 0 is open; the last index of `pack.blinkLevels` is fully closed. */
  blinkLevel: number;
}

type Phase = 'gaze' | 'ramp' | 'hold' | 'leaving';

export class CharacterPlayer {
  readonly #pack: Pack;
  readonly #motion: SpriteMotionLike;
  readonly #random: () => number;
  readonly #rampSeconds: number;

  #state: CharacterState = 'idle';
  #target: CharacterState = 'idle';
  #sleeping = false;
  #sleepWanted = false;

  /** Seconds since the shown state began, for the effects layer. */
  #stateSeconds = 0;
  /** Rises on every committed change, so a celebration differs each time. */
  #eventId = 0;

  #phase: Phase = 'gaze';
  #track: TrackName | null = null;
  /** Fractional pose index along an expression track. */
  #position = 0;

  #autoSleep: boolean;
  /** Seconds left undisturbed. Drives the idle cycle, and nothing else. */
  #undisturbedSeconds = 0;
  /** True while the idle cycle is what is keeping him asleep. */
  #dozing = false;

  /** A temporary state, and what to go back to when it expires. */
  #pulseSeconds = 0;
  #pulseReturn: CharacterState = 'idle';

  constructor(options: CharacterPlayerOptions) {
    const { pack, rampSeconds = 0.55, random = Math.random, autoSleep = true } = options;
    this.#pack = pack;
    this.#random = random;
    this.#rampSeconds = rampSeconds;
    this.#autoSleep = autoSleep;

    const { SpriteMotion } = spritePlayer();
    this.#motion = options.motion ?? new SpriteMotion({ count: pack.steps, random });
  }

  get state(): CharacterState { return this.#state; }
  /** The state asked for, which may not have reached the centre pose yet. */
  get requestedState(): CharacterState { return this.#target; }
  get sleeping(): boolean { return this.#sleeping; }
  get stateSeconds(): number { return this.#stateSeconds; }
  get eventId(): number { return this.#eventId; }
  /** True while the idle cycle, rather than a caller, is keeping him asleep. */
  get dozing(): boolean { return this.#dozing; }
  /** Exposed so a host can pause, change speed, or queue a look. */
  get motion(): SpriteMotionLike { return this.#motion; }

  /** Ask for a state. It takes effect once the character reaches the centre pose. */
  setState(state: CharacterState): void {
    this.#target = state;
    this.#pulseSeconds = 0;
    this.#rouse();
  }

  /**
   * Show a state briefly, then go back to whatever was wanted before.
   *
   * A poke is the reason this exists: `setState` holds until told otherwise, so
   * a tap would leave him permanently surprised. Anything arriving through
   * `setState` while a pulse is running wins, because a real agent event
   * matters more than a reaction to a click.
   */
  pulse(state: CharacterState, seconds = 1.2): void {
    if (this.#pulseSeconds <= 0) this.#pulseReturn = this.#target;
    this.#target = state;
    this.#pulseSeconds = seconds;
    this.#rouse();
  }

  /** Sleep and waking both route through the centre pose, like any other change. */
  setSleeping(sleeping: boolean): void {
    this.#sleepWanted = sleeping;
    // Asked for by hand, so the idle cycle should not take it back.
    this.#dozing = false;
    this.#undisturbedSeconds = 0;
  }

  /** Turn the idle cycle on or off without disturbing anything else. */
  setAutoSleep(autoSleep: boolean): void {
    if (this.#autoSleep === autoSleep) return;
    this.#autoSleep = autoSleep;
    this.#undisturbedSeconds = 0;
    // Only undo a sleep the cycle itself caused.
    if (!autoSleep && this.#dozing) {
      this.#dozing = false;
      this.#sleepWanted = false;
    }
  }

  /** Look in a particular direction next, if the pack has that track. */
  lookAt(direction: Direction): void {
    this.#rouse();
    if (this.#phase !== 'gaze') return;
    if (!this.#pack.tracks[direction]) return;
    this.#motion.request(direction);
  }

  update(deltaSeconds: number): void {
    if (!(deltaSeconds > 0)) return;
    this.#stateSeconds += deltaSeconds;
    this.#updatePulse(deltaSeconds);
    this.#updateIdleCycle(deltaSeconds);

    // Blinking runs in every phase; the engine only advances it from update(),
    // which also walks the gaze, so drive it directly when the gaze is parked.
    if (this.#phase === 'gaze') this.#motion.update(deltaSeconds);
    else this.#motion.updateBlink(deltaSeconds);

    switch (this.#phase) {
      case 'gaze': this.#updateGaze(); break;
      case 'ramp': this.#updateRamp(deltaSeconds); break;
      case 'hold': this.#updateHold(); break;
      case 'leaving': this.#updateLeaving(deltaSeconds); break;
    }
  }

  /** The pose to draw. `crossfade` blends toward the next pose mid-move. */
  pose(crossfade = true): Pose {
    if (this.#phase === 'gaze') {
      const sample = this.#motion.sample(crossfade);
      return {
        track: this.#motion.direction,
        from: sample.from,
        to: crossfade ? sample.to : sample.from,
        mix: crossfade ? sample.mix : 0,
        blinkLevel: this.#motion.blinkLevel,
      };
    }

    if (this.#sleeping) {
      const { track, step } = this.#pack.sleep;
      return { track, from: step, to: step, mix: 0, blinkLevel: this.#pack.sleep.blinkLevel };
    }

    const track = this.#track ?? this.#motion.direction;
    const from = Math.floor(this.#position);
    const to = Math.min(this.#pack.steps - 1, from + 1);
    return {
      track,
      from,
      to: crossfade ? to : from,
      mix: crossfade ? this.#position - from : 0,
      blinkLevel: this.#motion.blinkLevel,
    };
  }

  // The gaze owns the character until something else is asked for. A change is
  // only committed at the centre pose, so hurry the engine back there rather
  // than cutting away mid-turn.
  #updateGaze(): void {
    if (!this.#wantsChange()) return;
    if (this.#atCentre()) {
      this.#commit();
      return;
    }
    this.#motion.hold = 0;
  }

  #updateRamp(deltaSeconds: number): void {
    if (this.#wantsChange()) { this.#phase = 'leaving'; return; }
    const last = this.#pack.steps - 1;
    this.#position = Math.min(last, this.#position + this.#stepsPerSecond() * deltaSeconds);
    if (this.#position >= last) this.#phase = 'hold';
  }

  #updateHold(): void {
    if (this.#wantsChange()) this.#phase = 'leaving';
  }

  // Walk back down the expression track to the centre pose before handing the
  // character to whatever comes next.
  #updateLeaving(deltaSeconds: number): void {
    this.#position = Math.max(0, this.#position - this.#stepsPerSecond() * deltaSeconds);
    if (this.#position > 0) return;
    this.#commit();
  }

  /** A pulse expires back to whatever was wanted before it. */
  #updatePulse(deltaSeconds: number): void {
    if (this.#pulseSeconds <= 0) return;
    this.#pulseSeconds -= deltaSeconds;
    if (this.#pulseSeconds > 0) return;
    this.#pulseSeconds = 0;
    this.#target = this.#pulseReturn;
  }

  /**
   * Upstream's idle cycle: doze off when left alone, wake a minute later, round
   * again. Only ever runs while genuinely idle, so an agent state or a poke
   * keeps him up simply by resetting the clock.
   */
  #updateIdleCycle(deltaSeconds: number): void {
    if (!this.#autoSleep) return;

    const settled = this.#target === 'idle' && this.#state === 'idle';
    if (!settled && !this.#dozing) {
      this.#undisturbedSeconds = 0;
      return;
    }

    this.#undisturbedSeconds += deltaSeconds;
    if (this.#dozing) {
      if (this.#undisturbedSeconds < SLEEP_SECONDS) return;
      this.#dozing = false;
      this.#sleepWanted = false;
      this.#undisturbedSeconds = 0;
      return;
    }
    if (this.#undisturbedSeconds < IDLE_BEFORE_SLEEP_SECONDS) return;
    this.#dozing = true;
    this.#sleepWanted = true;
    this.#undisturbedSeconds = 0;
  }

  /** Anything that counts as attention: restart the clock, and wake a dozer. */
  #rouse(): void {
    this.#undisturbedSeconds = 0;
    if (!this.#dozing) return;
    this.#dozing = false;
    this.#sleepWanted = false;
  }

  #wantsChange(): boolean {
    return this.#target !== this.#state || this.#sleepWanted !== this.#sleeping;
  }

  #atCentre(): boolean {
    return this.#motion.index === 0 && this.#motion.phase === 'center';
  }

  /** Adopt the requested state, starting from the centre pose. */
  #commit(): void {
    this.#state = this.#target;
    this.#sleeping = this.#sleepWanted;
    this.#position = 0;
    this.#stateSeconds = 0;
    this.#eventId++;

    if (this.#sleeping) {
      this.#track = this.#pack.sleep.track;
      this.#phase = 'hold';
      return;
    }

    if (this.#state === 'idle') {
      this.#track = null;
      this.#phase = 'gaze';
      // Resume the look-around from the centre it was left at.
      this.#motion.setPlaying(true);
      return;
    }

    this.#track = this.#chooseTrack(this.#state);
    this.#phase = this.#track ? 'ramp' : 'gaze';
    if (!this.#track) this.#state = 'idle';
  }

  /** Resolve a state to a track the pack actually has, picking at random from a list. */
  #chooseTrack(state: CharacterState): TrackName | null {
    const mapping = this.#pack.states[state];
    if (!mapping || mapping === 'gaze') return null;
    const candidates = (Array.isArray(mapping) ? mapping : [mapping])
      .filter(name => Boolean(this.#pack.tracks[name]));
    if (candidates.length === 0) return null;
    const index = Math.min(candidates.length - 1, Math.floor(this.#random() * candidates.length));
    return candidates[index];
  }

  #stepsPerSecond(): number {
    return (this.#pack.steps - 1) / this.#rampSeconds;
  }
}

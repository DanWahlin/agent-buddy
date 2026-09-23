/**
 * The reaction effects drawn around the character.
 *
 * Ported from `firmware/Copilot/src/CharacterEffects.cpp` in the ESP32 Agent
 * Companion. Those are procedural - no art, nothing in a pack - so they port
 * cleanly, and the timings and easing are copied exactly because they are what
 * makes the motion read as designed rather than random.
 *
 * Three things are deliberately different:
 *
 * 1. Coordinates stay in the device's 400x352 effect frame and are mapped onto
 *    the canvas at draw time. The constants below are therefore the upstream
 *    ones, unchanged, which is what makes them checkable against the original.
 * 2. Half of the C++ is damage tracking - the 4096-entry buffers, `restore()`,
 *    the double-buffer bookkeeping - because the device repaints only changed
 *    pixels. A canvas is cleared and repainted every frame, so none of that
 *    is needed.
 * 3. The device guards each pixel twice: an elliptical exclusion around the
 *    head, and a test that refuses to paint over any non-black artwork pixel.
 *    The first becomes a clip path. The second cannot be done cheaply on a
 *    canvas without reading pixels back every frame, and the ellipse already
 *    covers the head, so it is dropped - see `HEAD_*` below.
 */

/** The device's effect frame. Every constant in this file is in its units. */
const FRAME_WIDTH = 400;
const FRAME_HEIGHT = 352;

/**
 * The head exclusion, from the upstream per-pixel guard
 * `dx*dx*135*135 + dy*dy*160*160 < 160*160*135*135`, which is the ellipse
 * `dx^2/160^2 + dy^2/135^2 < 1` about the frame centre.
 */
const HEAD_CENTRE_X = FRAME_WIDTH / 2;
const HEAD_CENTRE_Y = FRAME_HEIGHT / 2;
const HEAD_RADIUS_X = 160;
const HEAD_RADIUS_Y = 135;

/** Upstream's `kFrameY`, which `workingBits` uses to recycle above the frame. */
const FRAME_Y = 57;

export interface EffectPalette {
  /** Dots orbiting during `working`. */
  orbit: string;
  /** The rising and falling ones and zeroes during `working`. */
  bits: string;
  /** The question mark and its ring during `attention`. */
  attention: string;
  /** Drifting Zs while asleep. */
  sleep: string;
  /** The acknowledging sparks on `surprise`. */
  surprise: string;
  /** Firework shell, its trail, and the three confetti colours. */
  celebration: { shell: string; trail: string; rays: [string, string] };
  confetti: [string, string, string];
}

/** Upstream's colours, as passed to its `color(r, g, b)`. */
export const DEFAULT_PALETTE: EffectPalette = {
  orbit: '80,215,239',
  bits: '124,222,242',
  attention: '255,192,86',
  sleep: '174,190,255',
  surprise: '174,217,251',
  celebration: {
    shell: '255,222,154',
    trail: '190,161,247',
    rays: ['121,229,209', '247,206,118'],
  },
  confetti: ['121,229,209', '247,206,118', '190,161,247'],
};

/** What the effects need to know about the character. */
export interface EffectState {
  /** The state being shown. */
  state: string;
  /** The state asked for, which may not have taken effect yet. */
  requested: string;
  sleeping: boolean;
  /** Seconds since this state began. */
  seconds: number;
  /** Rises on every state change, so a celebration differs each time. */
  eventId: number;
}

const TAU = Math.PI * 2;

/** Upstream's integer hash, so confetti scatters identically. */
function hash(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** The glyph bitmaps, five bits wide, most significant bit leftmost. */
const GLYPH_ONE = [4, 12, 4, 4, 4, 4, 4, 4, 14];
const GLYPH_ZERO = [14, 17, 17, 17, 17, 17, 17, 17, 14];
const GLYPH_Z = [31, 1, 2, 4, 8, 16, 31];
const GLYPH_QUESTION = [14, 17, 1, 2, 4, 0, 4];

export class CharacterEffects {
  readonly #palette: EffectPalette;

  #context: CanvasRenderingContext2D | null = null;
  #unit = 1;
  #originX = 0;
  #originY = 0;

  constructor(palette: Partial<EffectPalette> = {}) {
    this.#palette = { ...DEFAULT_PALETTE, ...palette };
  }

  /**
   * Paint the effects for a state over an already-drawn frame.
   *
   * `width` and `height` are canvas pixels; the effect frame is centred inside
   * them at a single scale, so circles stay circular whatever the view's shape.
   */
  draw(
    context: CanvasRenderingContext2D, state: EffectState, width: number, height: number,
  ): void {
    // One scale for both axes, or the orbit would become an ellipse.
    this.#unit = width / FRAME_WIDTH;
    this.#originX = 0;
    this.#originY = (height - FRAME_HEIGHT * this.#unit) / 2;
    this.#context = context;

    context.save();
    // The head exclusion, as a clip rather than a test per pixel.
    context.beginPath();
    context.rect(0, 0, width, height);
    context.ellipse(
      this.#x(HEAD_CENTRE_X), this.#y(HEAD_CENTRE_Y),
      HEAD_RADIUS_X * this.#unit, HEAD_RADIUS_Y * this.#unit,
      0, 0, TAU);
    context.clip('evenodd');

    const seconds = state.seconds;
    if (state.sleeping) {
      this.#sleepingZs(seconds);
    } else if (state.state === 'working') {
      this.#working(seconds);
    } else if (state.state === 'attention') {
      this.#attention(seconds);
    } else if (state.state === 'complete' && seconds < 3) {
      this.#complete(seconds, state.eventId);
    }

    // An immediate, quiet acknowledgement, even while a surprise is still
    // waiting to reach the centre pose.
    if (state.eventId && seconds < 0.5
      && (state.requested === 'surprise' || state.state === 'surprise')) {
      const alpha = (0.5 - seconds) * 1.6;
      this.#spark(38 - seconds * 10, 65 - seconds * 14, 3, this.#palette.surprise, alpha);
      this.#spark(362 + seconds * 10, 65 - seconds * 14, 3, this.#palette.surprise, alpha);
    }

    context.restore();
    this.#context = null;
  }

  // --- states ---------------------------------------------------------------

  #working(t: number): void {
    const orbitRadius = 200;
    let x = Math.cos((t * Math.PI) / 6);
    let y = Math.sin((t * Math.PI) / 6);
    // A fixed rotation between trailing dots, so the tail keeps its shape.
    const cosine = 0.9872272833756269;
    const sine = 0.15931820661424598;

    for (let i = 0; i < 7; i++) {
      this.#dot(
        HEAD_CENTRE_X + Math.round(orbitRadius * x),
        HEAD_CENTRE_Y + Math.round(orbitRadius * y),
        i === 6 ? 5 : 2,
        this.#palette.orbit, 0.3 + i * 0.108);
      const nextX = x * cosine - y * sine;
      y = x * sine + y * cosine;
      x = nextX;
    }
    this.#workingBits(t);
  }

  /** Ones and zeroes rising on two lanes and falling on two others. */
  #workingBits(seconds: number): void {
    const lanes = [-24, -12, 10, 22];
    const top = -FRAME_Y - 9;
    const bottom = 34;
    const cycle = seconds / 4;

    for (let lane = 0; lane < 4; lane++) {
      for (let slot = 0; slot < 2; slot++) {
        let phase = cycle + lane * 0.125 + slot * 0.5;
        phase -= Math.floor(phase);
        const ramp = Math.min(1, (lane < 2 ? 1 - phase : phase) / 0.15);
        // Smoothstep, so a digit does not pop in at the edge of its lane.
        const alpha = 0.85 * ramp * ramp * (3 - 2 * ramp);
        if (alpha <= 0) continue;

        const travel = Math.round((bottom - top) * phase);
        const y = lane < 2 ? top + travel : bottom - travel;
        const x = HEAD_CENTRE_X + lanes[lane];
        const glyph = (lane + slot) % 2 === 0 ? GLYPH_ZERO : GLYPH_ONE;
        this.#glyph(glyph, x, y, 1, this.#palette.bits, alpha);
      }
    }
  }

  #attention(t: number): void {
    const breath = 0.78 + 0.17 * Math.sin((t * Math.PI) / 2);
    const colour = this.#palette.attention;

    // A ring of 32 dots, stepped by a fixed rotation like the orbit.
    let ringX = 1;
    let ringY = 0;
    for (let i = 0; i < 32; i++) {
      this.#dot(348 + Math.round(23 * ringX), 56 + Math.round(23 * ringY), 1,
        colour, breath * 0.3);
      const nextX = ringX * 0.9807852804032304 - ringY * 0.19509032201612825;
      ringY = ringX * 0.19509032201612825 + ringY * 0.9807852804032304;
      ringX = nextX;
    }

    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 5; x++) {
        if (GLYPH_QUESTION[y] & (1 << (4 - x))) {
          this.#dot(340 + x * 4, 44 + y * 4, 2, colour, breath);
        }
      }
    }
    this.#dot(35, 70, 2, colour, breath * 0.45);
  }

  /** Two shells launching, bursting, and a scatter of confetti under gravity. */
  #complete(t: number, eventId: number): void {
    const rayX = [1, 0.809017, 0.309017, -0.309017, -0.809017,
      -1, -0.809017, -0.309017, 0.309017, 0.809017];
    const rayY = [0, 0.587785, 0.951057, 0.951057, 0.587785,
      0, -0.587785, -0.951057, -0.951057, -0.587785];
    const { shell, trail, rays } = this.#palette.celebration;

    for (const side of [-1, 1]) {
      const launch = (t - 0.3) / 0.5;
      if (launch >= 0 && launch < 1) {
        const x = 200 + side * (160 - Math.trunc(20 * launch));
        const y = 278 - Math.trunc(198 * (2 * launch - launch * launch));
        this.#dot(x, y, 2, shell, 1);
        for (let tail = 3; tail < 11; tail++) {
          this.#pixel(x, y + tail, trail, (11 - tail) / 12);
        }
      }

      const age = t - 0.8;
      if (age >= 0 && age < 1.5) {
        // Expansion that eases out on its own, with no separate curve.
        const radius = (80 * age) / (1 + age);
        const brightness = 1 - age / 1.5;
        const centreX = 200 + side * 140;
        const centreY = 80 + Math.trunc(20 * age * age);
        for (let ray = 0; ray < 10; ray++) {
          const x = centreX + Math.trunc(radius * rayX[ray]);
          const y = centreY + Math.trunc(radius * rayY[ray]);
          this.#dot(x, y, 1, ray % 2 ? rays[0] : rays[1], brightness);
          this.#pixel(
            centreX + Math.trunc((radius - 4) * rayX[ray]),
            centreY + Math.trunc((radius - 4) * rayY[ray]),
            trail, brightness * 0.5);
        }
      }
    }

    const fade = t < 1.8 ? 1 : (3 - t) / 1.2;
    for (let i = 0; i < 36; i++) {
      // Seeded off the event, so two celebrations never scatter the same way.
      const seed = hash(eventId * 37 + i);
      const age = t - (seed % 300) / 1000;
      if (age < 0) continue;

      const side = i % 2 ? 1 : -1;
      const x = HEAD_CENTRE_X + side * (154 + ((seed >>> 8) % 32)) + side * 14 * age;
      const y = 42 + ((seed >>> 16) % 65) - 48 * age + 62 * age * age;
      const colour = this.#palette.confetti[i % 3];

      if (i % 7 === 0) {
        this.#spark(x, y, 3, colour, fade);
      } else {
        // A small block rather than a single pixel, as upstream draws it.
        this.#rect(x, y, 3, 2, colour, fade);
      }
    }
  }

  #sleepingZs(seconds: number): void {
    const rightXs = [228, 253, 281];
    const leftXs = [167, 142, 105];
    const scales = [1, 1, 2];
    const bottom = 72;
    const top = -18;

    for (let lane = 0; lane < 3; lane++) {
      const position = seconds / 3.6 + lane * 0.31;
      const sequence = Math.floor(position);
      const phase = position - sequence;
      // Fade in and out symmetrically at both ends of the drift.
      const edge = Math.min(phase, 1 - phase);
      const alpha = 0.85 * Math.min(1, edge / 0.14);
      const y = bottom - Math.round((bottom - top) * phase);
      const right = (hash(sequence * 13 + lane * 101) & 1) === 1;
      this.#glyph(GLYPH_Z, right ? rightXs[lane] : leftXs[lane], y,
        scales[lane], this.#palette.sleep, alpha);
    }
  }

  // --- primitives, in device units -------------------------------------------

  #x(value: number): number { return this.#originX + value * this.#unit; }
  #y(value: number): number { return this.#originY + value * this.#unit; }

  #fill(colour: string, alpha: number): boolean {
    const context = this.#context;
    // Upstream quantises to RGB565 and skips when the colour comes out zero.
    // The equivalent here is to skip once the alpha rounds away, rather than
    // spend a draw call on something that paints nothing.
    if (!context || !(alpha >= 0.0005)) return false;
    context.fillStyle = 'rgba(' + colour + ',' + Math.min(1, alpha).toFixed(3) + ')';
    return true;
  }

  #dot(x: number, y: number, radius: number, colour: string, alpha: number): void {
    if (!this.#fill(colour, alpha)) return;
    const context = this.#context!;
    context.beginPath();
    // Upstream fills a pixel disc of this radius; a circle is the same shape
    // without the stair-stepping, which suits a scaled canvas better.
    context.arc(this.#x(x), this.#y(y), Math.max(0.5, (radius + 0.5) * this.#unit), 0, TAU);
    context.fill();
  }

  /** A plus sign, as upstream draws it: one horizontal and one vertical run. */
  #spark(x: number, y: number, radius: number, colour: string, alpha: number): void {
    if (!this.#fill(colour, alpha)) return;
    const context = this.#context!;
    const span = (radius * 2 + 1) * this.#unit;
    const thickness = Math.max(1, this.#unit);
    context.fillRect(this.#x(x - radius), this.#y(y), span, thickness);
    context.fillRect(this.#x(x), this.#y(y - radius), thickness, span);
  }

  #pixel(x: number, y: number, colour: string, alpha: number): void {
    this.#rect(x, y, 1, 1, colour, alpha);
  }

  #rect(x: number, y: number, w: number, h: number, colour: string, alpha: number): void {
    if (!this.#fill(colour, alpha)) return;
    this.#context!.fillRect(
      this.#x(x), this.#y(y),
      Math.max(1, w * this.#unit), Math.max(1, h * this.#unit));
  }

  #glyph(
    rows: number[], x: number, y: number, scale: number, colour: string, alpha: number,
  ): void {
    if (!this.#fill(colour, alpha)) return;
    const context = this.#context!;
    const size = Math.max(1, scale * this.#unit);
    for (let row = 0; row < rows.length; row++) {
      for (let column = 0; column < 5; column++) {
        if (rows[row] & (1 << (4 - column))) {
          context.fillRect(
            this.#x(x + column * scale), this.#y(y + row * scale), size, size);
        }
      }
    }
  }
}

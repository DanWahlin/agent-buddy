(function (root) {
  'use strict';
  const DIRECTIONS = ['right', 'left', 'up', 'down', 'up_right', 'up_left', 'down_right', 'down_left'];
  const TRAVEL_LIMITS = {right: 1, left: 1, up: .5, down: .5,
    up_right: 1, up_left: 1, down_right: 1, down_left: 1};
  const MAX_DELTA = 1 / 30;
  const quintic = t => t * t * t * (t * (6 * t - 15) + 10);
  function inverseQuintic(value) {
    if (value <= 0 || value >= 1) return Math.max(0, Math.min(1, value));
    let low = 0, high = 1;
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (quintic(middle) < value) low = middle; else high = middle;
    }
    return (low + high) / 2;
  }

  class SpriteMotion {
    constructor({count = 24, random = Math.random, playing = true} = {}) {
      if (!Number.isInteger(count) || count < 2) throw new Error('At least two sprite frames are required.');
      this.count = count;
      this.random = random;
      this.playing = playing;
      this.direction = 'right';
      this.index = 0;
      this.target = count - 1;
      this.phase = 'center';
      this.progress = 0;
      this.hold = .7;
      this.duration = 1.8;
      this.speed = 1;
      this.eased = true;
      this.auto = true;
      this.cycling = false;
      this.cycleIndex = 0;
      this.queue = [];
      this.inspecting = false;
      this.blinks = true;
      this.blinkLevel = 0;
      this.blinkPhase = 'idle';
      this.blinkElapsed = 0;
      this.blinkWait = this.range(3, 7);
      this.blinkQueued = false;
      this.doublePending = false;
    }
    range(low, high) { return low + this.random() * (high - low); }
    setPlaying(value) { this.playing = Boolean(value); if (value) this.inspecting = false; }
    setDuration(value) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Turn duration must be positive.');
      this.duration = value;
    }
    setSpeed(value) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Playback speed must be positive.');
      this.speed = value;
    }
    setEased(value) { this.eased = Boolean(value); }
    setAuto(value) { this.auto = Boolean(value); if (value) this.cycling = false; }
    setCycle(value) {
      this.cycling = Boolean(value);
      if (value) { this.auto = false; this.cycleIndex = 0; }
    }
    request(direction) {
      if (!DIRECTIONS.includes(direction)) throw new Error(`Unknown sprite direction: ${direction}`);
      this.queue.push(direction);
      if (this.phase === 'center' && this.index === 0) this.hold = 0;
    }
    inspect(index) {
      this.setPlaying(false);
      this.inspecting = true;
      this.index = Math.max(0, Math.min(this.count - 1, Math.round(index)));
      // Inspection is an explicit frame selection, never a live track switch.
      // Resume from that exact pose, safely retracing it to the shared center.
      this.phase = this.index ? 'return' : 'center';
      this.target = Math.max(1, this.index);
      this.progress = 0;
    }
    setBlinks(value) {
      this.blinks = Boolean(value);
      if (!value) this.doublePending = false;
      // An active blink always opens normally, including when disabled.
    }
    requestBlink() { this.blinkQueued = true; }
    startBlink() {
      this.blinkPhase = 'closing';
      this.blinkElapsed = 0;
      this.blinkQueued = false;
    }
    updateBlink(dt) {
      if (this.blinkPhase === 'idle') {
        if (this.blinks || this.doublePending) this.blinkWait -= dt;
        if (this.blinkQueued || ((this.blinks || this.doublePending) && this.blinkWait <= 0)) {
          const second = this.doublePending;
          this.doublePending = !second && this.blinks && this.random() < .15;
          this.startBlink();
          return true;
        }
        return false;
      }
      this.blinkElapsed += dt;
      const interval = this.blinkPhase === 'closing' ? .09 / 4
        : this.blinkPhase === 'closed' ? .04 : .14 / 4;
      if (this.blinkElapsed < interval) return true;
      this.blinkElapsed = Math.min(this.blinkElapsed - interval, interval);
      if (this.blinkPhase === 'closing') {
        this.blinkLevel++;
        if (this.blinkLevel === 4) { this.blinkPhase = 'closed'; this.blinkElapsed = 0; }
      } else if (this.blinkPhase === 'closed') {
        this.blinkPhase = 'opening';
        this.blinkElapsed = 0;
      } else {
        this.blinkLevel--;
        if (this.blinkLevel === 0) {
          this.blinkPhase = 'idle';
          this.blinkWait = this.doublePending ? this.range(.16, .28) : this.range(3, 7);
        }
      }
      return true;
    }
    startTurn() {
      let direction, fullDepth = true;
      if (this.queue.length) direction = this.queue.shift();
      else if (this.cycling) direction = DIRECTIONS[this.cycleIndex++ % DIRECTIONS.length];
      else if (this.auto) {
        const choices = DIRECTIONS.filter(value => value !== this.direction);
        direction = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
        fullDepth = false;
      } else return;
      this.direction = direction;
      const limit = Math.max(1, Math.floor((this.count - 1) * TRAVEL_LIMITS[direction]));
      this.target = fullDepth ? limit : Math.round(this.range(.55, 1) * limit);
      this.phase = 'out';
      this.progress = 0;
    }
    edgeDuration() {
      const travelled = this.phase === 'out' ? this.index : this.target - this.index;
      const before = travelled / this.target, after = (travelled + 1) / this.target;
      const turnDuration = this.duration * Math.sqrt(this.target / (this.count - 1));
      const eased = this.eased && this.direction !== 'right';
      return turnDuration * (eased ? inverseQuintic(after) - inverseQuintic(before) : after - before);
    }
    sample(crossfade = false) {
      if (!crossfade || this.inspecting || (this.phase !== 'out' && this.phase !== 'return')) {
        return {from: this.index, to: this.index, mix: 0};
      }
      return {
        from: this.index,
        to: this.phase === 'out' ? Math.min(this.target, this.index + 1) : Math.max(0, this.index - 1),
        mix: Math.max(0, Math.min(1, this.progress)),
      };
    }
    update(deltaSeconds) {
      if (!this.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return this;
      // Drop wall-clock stalls, rather than accumulating a catch-up timeline.
      const dt = Math.min(deltaSeconds, MAX_DELTA) * this.speed;
      this.updateBlink(Math.min(dt, MAX_DELTA));
      if (this.phase === 'center' || this.phase === 'endpoint') {
        this.progress += dt / this.hold;
        if (this.progress < 1) return this;
        this.progress = 0;
        if (this.phase === 'center') this.startTurn();
        else this.phase = 'return';
        return this;
      }
      const interval = this.edgeDuration();
      this.progress += dt / interval;
      if (this.progress < 1) return this;
      const remainder = (this.progress - 1) * interval;
      this.progress = 0;
      this.index += this.phase === 'out' ? 1 : -1;
      if (this.index === this.target && this.phase === 'out') {
        this.phase = 'endpoint';
        this.hold = this.direction === 'right' ? .001 : this.cycling ? .6 : this.range(.35, 1.4);
      } else if (this.index === 0 && this.phase === 'return') {
        this.phase = 'center';
        this.hold = this.cycling ? .6 : this.range(.35, 1.6);
      } else {
        // Preserve fractional frame time without accumulating a catch-up backlog.
        this.progress = Math.min(remainder / this.edgeDuration(), 1);
      }
      return this;
    }
  }
  const api = {SpriteMotion, DIRECTIONS, quintic, inverseQuintic};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritePlayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

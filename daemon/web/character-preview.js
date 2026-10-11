const FRAME_MS = 1000 / 30;
let engineScript;

function createEngine() {
  engineScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/character-engine.js';
    script.onload = () => {
      if (typeof window.createEngine === 'function') resolve();
      else {
        script.remove();
        reject(new Error('The character renderer is unavailable.'));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('The character renderer could not be loaded.'));
    };
    document.head.append(script);
  }).catch(error => {
    engineScript = null;
    throw error;
  });
  return engineScript.then(() => {
    if (typeof window.createEngine !== 'function') throw new Error('The character renderer is unavailable.');
    return window.createEngine();
  });
}

export class CharacterPreview {
  constructor(canvas, {loadPack, notify, changed, engineFactory = createEngine}) {
    this.canvas = canvas;
    this.loadPack = loadPack;
    this.notify = notify;
    this.changed = changed;
    this.engineFactory = engineFactory;
    this.character = null;
    this.loaded = null;
    this.loading = null;
    this.engine = null;
    this.enginePromise = null;
    this.abort = null;
    this.generation = 0;
    this.frame = 0;
    this.active = false;
    this.failed = false;
    this.last = 0;
    this.context = null;
    this.image = null;
    this.dirty = false;
    canvas.hidden = true;
    canvas.dataset.previewState = 'paused';
  }

  setCanvas(canvas) {
    if (this.canvas === canvas) return;
    this.stop();
    this.canvas = canvas;
    this.context = null;
    this.image = null;
    if (!this.loading) this.failed = false;
    canvas.hidden = true;
    canvas.dataset.previewState = this.failed ? 'error' : 'paused';
  }

  update(character, active) {
    const wasActive = this.active;
    if (character !== this.character) {
      this.stop();
      this.abort?.abort();
      this.generation++;
      this.character = character;
      this.loaded = null;
      this.loading = null;
      this.failed = false;
      this.context = null;
      this.image = null;
    }
    this.active = Boolean(character && active);
    if (!this.active) {
      this.stop();
      return Promise.resolve(false);
    }
    if (!wasActive && this.failed && !this.loading) this.failed = false;
    if (this.loaded === character) {
      return Promise.resolve(this.start());
    }
    if (!this.loading && !this.failed) {
      const generation = this.generation;
      this.loading = this.load(character, generation).finally(() => {
        if (generation === this.generation) {
          this.loading = null;
          this.abort = null;
        }
      });
    }
    return this.loading ?? Promise.resolve(false);
  }

  async load(character, generation) {
    const abort = new AbortController();
    this.abort = abort;
    this.canvas.dataset.previewState = 'loading';
    try {
      this.enginePromise ??= Promise.resolve().then(() => this.engineFactory()).catch(error => {
        this.enginePromise = null;
        throw error;
      });
      const [engine, data] = await Promise.all([this.enginePromise, this.loadPack(character, abort.signal)]);
      if (generation !== this.generation || abort.signal.aborted) return false;
      const bytes = new Uint8Array(data);
      const at = engine._ac_reserve(bytes.length);
      if (!at) throw new Error('The character renderer has no room for this pack.');
      // Reserving can grow WebAssembly memory, so read HEAPU8 only afterward.
      engine.HEAPU8.set(bytes, at);
      if (!engine._ac_load_reserved((Math.random() * 0xffffffff) >>> 0))
        throw new Error(engine.UTF8ToString(engine._ac_error()) || 'The character pack is invalid.');
      this.engine = engine;
      this.context = null;
      this.image = null;
      engine._ac_mode(0, 0);
      this.loaded = character;
      this.dirty = true;
      if (this.active) return this.start();
      this.canvas.dataset.previewState = 'paused';
      return true;
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return false;
      this.fail(error);
      return false;
    }
  }

  show(visible) {
    const changed = this.canvas.hidden === visible;
    this.canvas.hidden = !visible;
    if (changed) this.changed();
  }

  start() {
    if (this.frame) return true;
    if (!this.active || !this.loaded) return false;
    this.last = performance.now();
    this.dirty = true;
    if (!this.context) {
      try {
        this.context = this.canvas.getContext('2d', {alpha: false});
        if (!this.context) throw new Error('This window cannot display the character animation.');
        this.canvas.width = this.canvas.height = this.engine._ac_display();
        this.image = this.context.createImageData(this.engine._ac_width(), this.engine._ac_height());
      } catch (error) {
        this.fail(error);
        return false;
      }
    }
    if (!this.paint(0)) return false;
    this.canvas.dataset.previewState = 'playing';
    this.show(true);
    this.frame = requestAnimationFrame(now => this.tick(now));
    return true;
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.canvas.dataset.previewState = this.failed ? 'error' : 'paused';
    this.show(false);
  }

  tick(now) {
    this.frame = 0;
    if (!this.active || !this.loaded) return;
    if (now - this.last >= FRAME_MS - 2) {
      const seconds = Math.min(.25, (now - this.last) / 1000);
      this.last = now;
      if (!this.paint(seconds)) return;
    }
    this.frame = requestAnimationFrame(next => this.tick(next));
  }

  paint(seconds) {
    try {
      const engine = this.engine;
      const pixels = engine._ac_frame(seconds, 0);
      if (!pixels) throw new Error(engine.UTF8ToString(engine._ac_error()) || 'The character renderer stopped.');
      if (this.dirty || engine._ac_changed()) {
        // Device frames use only opaque or zero-alpha pixels; no alpha conversion is needed.
        this.image.data.set(engine.HEAPU8.subarray(pixels, pixels + this.image.data.length));
        this.context.putImageData(this.image, engine._ac_frame_x(), 0);
        this.dirty = false;
      }
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  fail(error) {
    this.failed = true;
    this.loaded = null;
    this.stop();
    this.notify(`The character animation could not start: ${error.message} A still preview is used when available.`, 'error');
  }
}

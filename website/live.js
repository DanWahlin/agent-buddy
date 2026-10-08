'use strict';
/*
 * The live demo: the device's own animation engine (the firmware's code,
 * compiled to WebAssembly in desktop/engine) on a canvas in the page. It reads
 * the same .acpk character packs the device installs. website/scripts/build.mjs
 * puts the engine and the packs in engine/.
 */
window.AgentBuddyLive = (() => {
  const MODES = { idle: 0, surprise: 1, working: 2, complete: 3, attention: 4 };
  const SLEEP = 5;
  // The device sleeps after two idle minutes. The engine counts only short steps.
  const DOZE_STEP = 1 / 30;
  const DOZE_LIMIT = 150;
  // The device animates at about 30 fps. Drawing at a 120 Hz display's rate costs four times the work for no gain.
  const FRAME_MS = 1000 / 30;
  let engine = null;
  let presenter = null;
  let canvas = null;
  let loaded = false;
  let running = false;
  let frame = 0;
  let last = 0;
  let dirty = true;
  let iconPackets = [];
  let packs = null;
  let loadToken = 0;
  let dozeToken = 0;
  let dozing = false;
  let shownMode = -1;
  const wanted = { mode: 'idle', badges: '', usage: '' };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(script);
    });
  }

  function withString(fn, text) {
    const at = engine.stringToNewUTF8(text);
    try { return fn(at); } finally { engine._free(at); }
  }

  /** Engine, pack list, and badge glyphs. Resolves with the packs that exist. */
  async function init(target) {
    canvas = target;
    const [list, icons] = await Promise.all([
      fetch('engine/packs.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('No character packs.')))),
      fetch('assets/badges/packets.json').then((r) => r.json()),
      loadScript('engine/engine.js'),
    ]);
    packs = list.packs || [];
    if (!packs.length) throw new Error('No character packs.');
    iconPackets = icons;
    engine = await window.createEngine();
    return packs.map((p) => p.id);
  }

  async function fetchPack(id, onProgress) {
    const response = await fetch(`engine/${id}.acpk`);
    if (!response.ok) throw new Error(`Could not load the ${id} character (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || packs.find((p) => p.id === id)?.bytes || 0;
    if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
    const bytes = new Uint8Array(total);
    const reader = response.body.getReader();
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error('The character pack is larger than expected.');
      bytes.set(value, offset);
      offset += value.length;
      onProgress?.(offset / total);
    }
    return bytes.subarray(0, offset);
  }

  /** Load a character. A later call wins over one that is still downloading. */
  async function loadCharacter(id, onProgress) {
    const token = ++loadToken;
    const bytes = await fetchPack(id, onProgress);
    if (token !== loadToken) return false;
    dozeToken++;
    dozing = false;
    shownMode = -1;
    // Reserve first: reserving can grow the memory, which detaches any earlier HEAPU8.
    const at = engine._ac_reserve(bytes.length);
    engine.HEAPU8.set(bytes, at);
    if (!engine._ac_load_reserved((Math.random() * 0xffffffff) >>> 0)) {
      throw new Error(engine.UTF8ToString(engine._ac_error()) || 'The character pack is invalid.');
    }
    for (const packet of iconPackets) withString(engine._ac_badge_icon, packet);
    loaded = true;
    if (!presenter) presenter = createPresenter(canvas, engine._ac_width(), engine._ac_height());
    apply();
    dirty = true;
    return true;
  }

  function apply() {
    if (!loaded) return;
    engine._ac_mode(MODES[wanted.mode], 0);
    withString(engine._ac_badge_active, wanted.badges);
    withString(engine._ac_usage, wanted.usage);
    dirty = true;
  }

  function setMode(mode) {
    dozeToken++;
    dozing = false;
    wanted.mode = mode;
    if (loaded) engine._ac_mode(MODES[mode], 0);
  }

  /*
   * Sleep, as the device reaches it: idle for two minutes. Runs those minutes
   * in chunks between frames, without drawing them, then shows the result.
   * Resolves true when the character is asleep, false when cancelled.
   */
  function sleep() {
    const token = ++dozeToken;
    wanted.mode = 'idle';
    if (!loaded) return Promise.resolve(false);
    engine._ac_mode(MODES.idle, 0);
    dozing = true;
    let simulated = 0;
    return new Promise((resolve) => {
      const chunk = () => {
        if (token !== dozeToken || !loaded) return resolve(false);
        const until = performance.now() + 12;
        while (performance.now() < until && simulated < DOZE_LIMIT && engine._ac_shown_mode() !== SLEEP) {
          if (!engine._ac_frame(DOZE_STEP, 0)) break;
          simulated += DOZE_STEP;
        }
        if (engine._ac_shown_mode() === SLEEP || simulated >= DOZE_LIMIT) {
          dozing = false;
          dirty = true;
          last = performance.now();
          return resolve(engine._ac_shown_mode() === SLEEP);
        }
        setTimeout(chunk, 0);
      };
      chunk();
    });
  }
  function setBadges(packet) { wanted.badges = packet; if (loaded) withString(engine._ac_badge_active, packet); }
  function setUsage(text) { wanted.usage = text; if (loaded) withString(engine._ac_usage, text); }
  function tap() {
    if (!loaded) return;
    dozeToken++;
    dozing = false;
    engine._ac_mode(MODES.surprise, 1);
  }

  function step(now) {
    frame = requestAnimationFrame(step);
    if (now - last < FRAME_MS - 2) return;
    const seconds = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!loaded || dozing) return;
    const pixels = engine._ac_frame(seconds, 0);
    if (!pixels) {
      stop();
      loaded = false;
      document.dispatchEvent(new CustomEvent('agentbuddy:error', { detail: engine.UTF8ToString(engine._ac_error()) }));
      return;
    }
    const mode = engine._ac_shown_mode();
    if (mode !== shownMode) {
      const from = shownMode;
      shownMode = mode;
      document.dispatchEvent(new CustomEvent('agentbuddy:mode', { detail: { from, to: mode, asleep: mode === SLEEP } }));
    }
    if (!engine._ac_changed() && !dirty) return;
    const width = engine._ac_width();
    const height = engine._ac_height();
    const rgba = engine.HEAPU8.subarray(pixels, pixels + width * height * 4);
    const count = engine._ac_dirty_count();
    const rects = dirty || !count ? null : new Int32Array(engine.HEAPU8.buffer, engine._ac_dirty_rects(), count * 4);
    dirty = false;
    presenter.present(rgba, rects);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    dirty = true;
    frame = requestAnimationFrame(step);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(frame);
  }

  /* WebGL keeps one texture and updates only the tiles that changed. */
  function createPresenter(target, width, height) {
    target.width = width;
    target.height = height;
    return webgl(target, width, height) || canvas2d(target, width, height);
  }

  function webgl(target, width, height) {
    const options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false };
    const gl2 = target.getContext('webgl2', options);
    const gl = gl2 || target.getContext('webgl', options);
    if (!gl) return null;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER,
      'attribute vec2 corner;varying vec2 uv;void main(){uv=vec2(corner.x,1.0-corner.y);gl_Position=vec4(corner*2.0-1.0,0.0,1.0);}'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER,
      'precision mediump float;uniform sampler2D frame;varying vec2 uv;void main(){gl_FragColor=texture2D(frame,uv);}'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.viewport(0, 0, width, height);
    if (gl2) gl2.pixelStorei(gl2.UNPACK_ROW_LENGTH, width);
    return {
      present(rgba, rects) {
        if (gl2 && rects) {
          for (let i = 0; i + 3 < rects.length; i += 4) {
            gl2.pixelStorei(gl2.UNPACK_SKIP_PIXELS, rects[i]);
            gl2.pixelStorei(gl2.UNPACK_SKIP_ROWS, rects[i + 1]);
            gl2.texSubImage2D(gl2.TEXTURE_2D, 0, rects[i], rects[i + 1], rects[i + 2], rects[i + 3], gl2.RGBA, gl2.UNSIGNED_BYTE, rgba);
          }
        } else {
          if (gl2) {
            gl2.pixelStorei(gl2.UNPACK_SKIP_PIXELS, 0);
            gl2.pixelStorei(gl2.UNPACK_SKIP_ROWS, 0);
          }
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  }

  function canvas2d(target, width, height) {
    const context = target.getContext('2d');
    const image = context.createImageData(width, height);
    return {
      present(rgba) {
        // ImageData is straight alpha; the engine's pixels are premultiplied.
        const out = image.data;
        for (let i = 0; i < out.length; i += 4) {
          const a = rgba[i + 3];
          const scale = a ? 255 / a : 0;
          out[i] = rgba[i] * scale;
          out[i + 1] = rgba[i + 1] * scale;
          out[i + 2] = rgba[i + 2] * scale;
          out[i + 3] = a;
        }
        context.putImageData(image, 0, 0);
      },
    };
  }

  return { init, loadCharacter, setMode, sleep, setBadges, setUsage, tap, start, stop, get ready() { return loaded; } };
})();

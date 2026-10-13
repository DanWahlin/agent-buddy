/**
 * The system can take the window's WebGL context away (after sleep, or when the
 * GPU process restarts). The presenter must ask for it back, skip drawing while
 * it is gone, rebuild its texture when it returns, and ask the page for a whole
 * frame: before this, the character vanished until the app was restarted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresenter } from '../../apps/desktop/src/webview/present.ts';

function fakeGl() {
  const calls = [];
  let lost = false;
  const gl = new Proxy({
    TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, TRIANGLE_STRIP: 4, LINK_STATUS: 5,
    UNPACK_SKIP_PIXELS: 6, UNPACK_SKIP_ROWS: 7, UNPACK_ROW_LENGTH: 8,
    isContextLost: () => lost,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
  }, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => { calls.push(name); return undefined; };
    },
  });
  return { gl, calls, lose(value) { lost = value; } };
}

function fakeCanvas(gl) {
  const listeners = {};
  return {
    width: 0, height: 0,
    getContext: kind => (kind === 'webgl2' ? gl : null),
    addEventListener: (type, listener) => { listeners[type] = listener; },
    fire(type) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      listeners[type]?.(event);
      return event;
    },
  };
}

test('the presenter recovers its WebGL context and asks for a whole frame', () => {
  const { gl, calls, lose } = fakeGl();
  const canvas = fakeCanvas(gl);
  let restored = 0;
  const presenter = createPresenter(canvas, 4, 2, () => { restored += 1; });
  const frame = new Uint8Array(4 * 2 * 4);

  presenter.present(frame, null);
  assert.equal(calls.filter(name => name === 'drawArrays').length, 1);

  lose(true);
  assert.equal(canvas.fire('webglcontextlost').defaultPrevented, true, 'asks for the context back');
  calls.length = 0;
  presenter.present(frame, null);
  assert.deepEqual(calls, [], 'draws nothing while the context is gone');

  lose(false);
  canvas.fire('webglcontextrestored');
  assert.equal(restored, 1, 'asks the page for a whole frame');
  assert.ok(calls.includes('texImage2D') && calls.includes('linkProgram'), 'rebuilds the program and texture');
  calls.length = 0;
  presenter.present(frame, null);
  assert.deepEqual(calls.filter(name => name === 'texSubImage2D' || name === 'drawArrays'),
    ['texSubImage2D', 'drawArrays']);
});

test('a context lost before the presenter exists is set up when it returns', () => {
  const { gl, calls, lose } = fakeGl();
  lose(true);
  const canvas = fakeCanvas(gl);
  let restored = 0;
  const presenter = createPresenter(canvas, 4, 2, () => { restored += 1; });
  presenter.present(new Uint8Array(4 * 2 * 4), null);
  assert.deepEqual(calls, [], 'sets up and draws nothing while lost');
  lose(false);
  canvas.fire('webglcontextrestored');
  assert.equal(restored, 1);
  assert.ok(calls.includes('texImage2D') && calls.includes('linkProgram'));
});

/**
 * Putting the engine's frame on screen, as cheaply as the platform allows.
 *
 * WebGL keeps one texture the size of the frame and updates it in place; the
 * GPU scales it for free. The engine writes premultiplied pixels, so WebKit
 * uploads them as they are (converting every upload was its hottest path), and
 * says which tiles changed, so with WebGL2 only those are uploaded. A 2D canvas
 * fed by putImageData cost a new GPU surface every frame: about 400 MB of GPU
 * memory against 240 MB, and more CPU. It is kept only for a WebView without
 * WebGL.
 *
 * The system can take a WebGL context away (after sleep, or when the GPU process
 * restarts). Every draw then does nothing, so the character vanishes inside the
 * case while the engine runs on. The presenter asks for the context back, rebuilds
 * its program and texture when it returns, and calls `onRestored` so the page
 * sends a whole frame: the new texture starts empty.
 */

export interface Presenter {
  /**
   * Show `rgba` (premultiplied, width x height x 4 bytes). `rects` are the
   * changed regions as x, y, width, height; null means all of it.
   */
  present(rgba: Uint8Array, rects: Int32Array | null): void;
}

const VERTEX = `
attribute vec2 corner;
varying vec2 uv;
void main() {
  uv = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D frame;
varying vec2 uv;
void main() { gl_FragColor = texture2D(frame, uv); }`;

export function createPresenter(canvas: HTMLCanvasElement, width: number, height: number,
                                onRestored: () => void = () => {}): Presenter {
  canvas.width = width;
  canvas.height = height;
  return webgl(canvas, width, height, onRestored) ?? canvas2d(canvas, width, height);
}

function webgl(canvas: HTMLCanvasElement, width: number, height: number,
               onRestored: () => void): Presenter | null {
  const options: WebGLContextAttributes = {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power',
  };
  const gl2 = canvas.getContext('webgl2', options);
  const gl = gl2 ?? canvas.getContext('webgl', options);
  if (!gl || !setUp(gl, gl2, width, height)) return null;

  let lost = false;
  canvas.addEventListener('webglcontextlost', event => {
    // Without preventDefault the context never comes back.
    event.preventDefault();
    lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = !setUp(gl, gl2, width, height);
    if (!lost) onRestored();
  });

  return {
    present(rgba, rects) {
      if (lost || gl.isContextLost()) return;
      if (gl2 && rects) {
        for (let i = 0; i + 3 < rects.length; i += 4) {
          const [x, y, w, h] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
          gl2.pixelStorei(gl2.UNPACK_SKIP_PIXELS, x);
          gl2.pixelStorei(gl2.UNPACK_SKIP_ROWS, y);
          gl2.texSubImage2D(gl2.TEXTURE_2D, 0, x, y, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, rgba);
        }
      } else {
        if (gl2) {
          gl2.pixelStorei(gl2.UNPACK_SKIP_PIXELS, 0);
          gl2.pixelStorei(gl2.UNPACK_SKIP_ROWS, 0);
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      }
      // The drawing buffer is not preserved, so the whole quad is drawn every
      // time, from the texture that keeps everything that did not change.
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

/** The program, quad and frame texture; again after a lost context returns. */
function setUp(gl: WebGLRenderingContext | WebGL2RenderingContext, gl2: WebGL2RenderingContext | null,
               width: number, height: number): boolean {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
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
  // Already premultiplied by the engine: upload as is, with no conversion.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.viewport(0, 0, width, height);
  // WebGL2 can upload a rectangle straight out of the whole frame.
  if (gl2) gl2.pixelStorei(gl2.UNPACK_ROW_LENGTH, width);
  return true;
}

function canvas2d(canvas: HTMLCanvasElement, width: number, height: number): Presenter {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const image = context.createImageData(width, height);
  return {
    present(rgba) {
      // ImageData is straight alpha; undo the engine's premultiplying.
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

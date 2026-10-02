/**
 * Putting the engine's frame on screen, as cheaply as the platform allows.
 *
 * WebGL keeps one texture the size of the frame and updates it in place; the
 * GPU scales it for free. A 2D canvas fed by putImageData looks simpler, but
 * WebKit turns every one of those into a fresh GPU surface: measured on macOS,
 * about 400 MB of GPU memory against 240 MB, and more CPU, for the same
 * picture. An ImageBitmap per frame measured worse still. The 2D path is kept
 * only for a WebView without WebGL.
 */

export interface Presenter {
  /** Show `rgba` (straight alpha, width x height x 4 bytes). */
  present(rgba: Uint8Array): void;
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

export function createPresenter(canvas: HTMLCanvasElement, width: number, height: number): Presenter {
  canvas.width = width;
  canvas.height = height;
  return webgl(canvas, width, height) ?? canvas2d(canvas, width, height);
}

function webgl(canvas: HTMLCanvasElement, width: number, height: number): Presenter | null {
  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power',
  });
  if (!gl) return null;

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
  // The engine's alpha is straight; the page composites premultiplied.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.viewport(0, 0, width, height);

  return {
    present(rgba) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

function canvas2d(canvas: HTMLCanvasElement, width: number, height: number): Presenter {
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const image = context.createImageData(width, height);
  return {
    present(rgba) {
      image.data.set(rgba);
      context.putImageData(image, 0, 0);
    },
  };
}

// Emscripten's loader for the device engine (desktop/engine), built as CommonJS.
declare module '*/engine/prebuilt/engine.js' {
  const createEngine: () => Promise<unknown>;
  export default createEngine;
}

// The device's sound cues, bundled as bytes (esbuild's binary loader).
declare module '*.wav' {
  const bytes: Uint8Array;
  export default bytes;
}

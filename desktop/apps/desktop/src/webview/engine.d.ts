// Emscripten's loader for the device engine (desktop/engine), built as CommonJS.
declare module '*/engine/dist/engine.js' {
  const createEngine: () => Promise<unknown>;
  export default createEngine;
}

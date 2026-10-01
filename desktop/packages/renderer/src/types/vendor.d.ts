/**
 * Types for the vendored motion engine.
 *
 * Declared here rather than beside the file so `src/vendor/` stays a
 * byte-identical copy of upstream.
 */
declare module '*/vendor/sprite-motion.js' {
  import type { SpritePlayerModule } from '../motion.js';
  const spritePlayer: SpritePlayerModule;
  export default spritePlayer;
}

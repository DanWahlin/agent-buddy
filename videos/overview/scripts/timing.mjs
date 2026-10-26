// Scene timing, shared by build.mjs (the composition) and render-device.mjs
// (the device clips), so a device event such as "Needs attention at states +5 s"
// lands on the same frame as the caption that explains it.
//
// video.config.json "sequence" lists the scenes in order. "chapters" is the
// group of screenshot cards in cfg.chapters. Every other name is a scene block
// with a "duration", except "states", whose length is the sum of its steps.
export const SCENES = ["hook", "meet", "states", "agents", "touches", "characters", "chapters", "values", "end"];

export function sceneDuration(cfg, key) {
  if (key === "chapters") return (cfg.chapters || []).reduce((sum, c) => sum + (c.duration || 0), 0);
  if (key === "states") return (cfg.states?.steps || []).reduce((sum, s) => sum + (s.duration || 0), 0);
  return cfg[key]?.duration || 0;
}

export function timing(cfg) {
  const order = (cfg.sequence || SCENES).filter((key) => sceneDuration(cfg, key) > 0);
  const T = {};
  let cursor = 0;
  for (const key of order) {
    const dur = sceneDuration(cfg, key);
    T[key] = { start: cursor, dur };
    cursor += dur;
  }
  return { order, T, total: Math.round(cursor * 1000) / 1000 };
}

// The start of a take's clip in video time: the start of its "from" scene,
// plus its "offset" (negative to start early).
export function takeStart(cfg, take) {
  const { T } = timing(cfg);
  const scene = T[take.from];
  if (!scene) throw new Error(`Take starts at scene "${take.from}", which is not in the sequence.`);
  return Math.round((scene.start + (take.offset || 0)) * 1000) / 1000;
}

// An event's time in clip seconds. "scene" makes "at" relative to that scene.
export function eventTime(cfg, take, event) {
  if (!event.scene) return event.at;
  const { T } = timing(cfg);
  const scene = T[event.scene];
  if (!scene) throw new Error(`Event refers to scene "${event.scene}", which is not in the sequence.`);
  return Math.round((scene.start + event.at - takeStart(cfg, take)) * 1000) / 1000;
}

#!/usr/bin/env node
// Render the device screen clips from the firmware's own animation engine.
//
//   node scripts/render-device.mjs [take ...]
//
// Each take in video.config.json "takes" runs the desktop engine (the
// firmware's CharacterMotion, renderers, effects, and badges compiled to
// WebAssembly, desktop/engine/prebuilt/engine.js) with a fixed seed, so every
// render is the same. Frames are the device's own 466x466 round screen, and
// ffmpeg scales them 2x with Lanczos so they stay sharp at video size.
//
// Needs the character packs (python3 tools/character_pack.py build) and the
// built daemon (cd daemon && npm run build) for the agent badge icons.
//
// A take:
//   "hero": {
//     "character": "copilot", "seed": 7, "from": "meet", "duration": 29, "preroll": 2,
//     "events": [ { "at": 3, "touch": true },
//                 { "scene": "states", "at": 0.3, "mode": "working", "badges": "copilot=w" },
//                 { "scene": "states", "at": 5.3, "mode": "attention", "badges": "copilot=w,claude=a" },
//                 { "at": 0, "usage": "AIC: 1,248" } ]
//   }
// "then": { "at": 4.5, "fade": 0.7, "events": [...] } renders the take a second
// time with those events from the start, and crossfades to it at "at". The seed
// and modes are the same, so the character matches and only the changed parts
// fade (for example the usage line and its agent badge, which the device swaps
// at once). "at" can use "scene" as events do.
// "lens": { "x": 0.5, "y": 0.92, "span": 0.3 } also writes device-<take>-lens.mp4,
// a close-up of that point (x, y as fractions of the screen; span is the part of
// the screen width it shows), for a magnifier over small text such as usage.
// The clip starts at the "from" scene (plus "offset"). "at" is seconds from the
// start of the clip, or from the start of "scene" when it is set. "preroll" runs
// the engine first, without output, so the character is settled (or asleep)
// when the clip starts. build.mjs places each clip at the same time.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventTime } from "./timing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "video.config.json"), "utf8"));
const takes = cfg.takes || {};
const only = process.argv.slice(2);
const FPS = 30;
const MODES = { idle: 0, surprise: 1, working: 2, complete: 3, attention: 4 };

const enginePath = path.join(repo, "desktop/engine/prebuilt/engine.js");
const badgesPath = path.join(repo, "daemon/dist/src/agent-badges.js");
for (const [file, fix] of [
  [enginePath, "Build the desktop engine (desktop/engine/build.mjs)."],
  [badgesPath, "Build the daemon: cd daemon && npm run build"],
]) {
  if (!fs.existsSync(file)) {
    console.error(`error: ${path.relative(repo, file)} is missing. ${fix}`);
    process.exit(1);
  }
}
const { loadAgentBadgeIcons, iconPacket } = await import(pathToFileURL(badgesPath));
// A folder with no custom icons gives the project's default pixel-art badges.
const icons = await loadAgentBadgeIcons(path.join(root, ".no-custom-icons"));
const createEngine = createRequire(import.meta.url)(enginePath);

const outDir = path.join(root, "assets/clips");
fs.mkdirSync(outDir, { recursive: true });

const names = Object.keys(takes).filter((n) => !only.length || only.includes(n));
if (!names.length) {
  console.error(only.length ? `error: No take named ${only.join(", ")}.` : 'error: video.config.json has no "takes".');
  process.exit(1);
}

for (const name of names) {
  const take = takes[name];
  if (!take.then) {
    await renderTake(name, take);
    continue;
  }
  const out = path.join(outDir, `device-${name}.mp4`);
  const a = await renderTake(name, { ...take, lens: null }, out.replace(/\.mp4$/, ".a.mp4"));
  const later = { ...take, lens: null, events: [...(take.events || []), ...take.then.events.map((e) => ({ ...e, at: 0, scene: undefined }))] };
  const b = await renderTake(name, later, out.replace(/\.mp4$/, ".b.mp4"));
  const at = eventTime(cfg, take, take.then);
  const fade = take.then.fade || 0.7;
  await ffmpegRun(["-i", a, "-i", b, "-filter_complex",
    `[0:v][1:v]blend=all_expr='A*(1-clip((T-${at})/${fade},0,1))+B*clip((T-${at})/${fade},0,1)',format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-movflags", "+faststart", "-an", out]);
  fs.rmSync(a);
  fs.rmSync(b);
  console.log(`${path.relative(root, out)}: crossfade at ${at}s over ${fade}s`);
  if (take.lens) await renderLens(out, take.lens, 932);
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

async function renderTake(name, take, outFile) {
  const engine = await createEngine();
  const call = (fn, ...args) => {
    const ok = fn(...args);
    if (!ok) throw new Error(`${name}: ${engine.UTF8ToString(engine._ac_error())}`);
    return ok;
  };
  const withString = (fn, text) => {
    const at = engine.stringToNewUTF8(text);
    try {
      return call(fn, at);
    } finally {
      engine._free(at);
    }
  };

  const pack = path.join(repo, "build/characters", `${take.character || "copilot"}.acpk`);
  if (!fs.existsSync(pack)) throw new Error(`${name}: ${path.relative(repo, pack)} is missing. Run python3 tools/character_pack.py build`);
  const bytes = fs.readFileSync(pack);
  engine.HEAPU8.set(bytes, engine._ac_reserve(bytes.length));
  call(engine._ac_load_reserved, take.seed ?? 1);
  for (const icon of icons) withString(engine._ac_badge_icon, iconPacket(icon).slice(1).trim());

  const width = engine._ac_width();
  const height = engine._ac_height();
  const display = engine._ac_display();
  const left = engine._ac_frame_x();
  const dt = 1 / FPS;

  const apply = (event) => {
    if (event.mode !== undefined) call(engine._ac_mode, MODES[event.mode], 0);
    if (event.touch) call(engine._ac_mode, MODES.surprise, 1);
    if (event.badges !== undefined) withString(engine._ac_badge_active, event.badges);
    if (event.usage !== undefined) withString(engine._ac_usage, event.usage);
  };

  // Events at or before 0 apply before the preroll, so the clip starts in that state.
  const events = (take.events || []).map((e) => ({ ...e, at: eventTime(cfg, take, e) })).sort((a, b) => a.at - b.at);
  for (const e of events) if (e.at > take.duration) throw new Error(`${name}: an event at ${e.at}s is after the clip ends (${take.duration}s).`);
  for (const event of events.filter((e) => e.at <= 0)) apply(event);
  // Same step as the clip: the motion code does not count all of a long step.
  const preroll = take.preroll ?? 1;
  for (let f = 0; f < Math.round(preroll * FPS); f++) if (!engine._ac_frame(1 / FPS, 0)) throw new Error(engine.UTF8ToString(engine._ac_error()));

  const frames = Math.round(take.duration * FPS);
  const out = outFile || path.join(outDir, `device-${name}.mp4`);
  const size = display * 2;
  const ffmpeg = spawn("ffmpeg", [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(FPS), "-i", "-",
    // The frame is premultiplied with black outside the round screen, so the
    // colour channels already show it on black. Centre it on the square screen.
    "-vf", `pad=${display}:${display}:${left}:0:black,scale=${size}:${size}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-movflags", "+faststart", "-an", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));

  let next = 0;
  const pending = events.filter((e) => e.at > 0);
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    while (next < pending.length && pending[next].at <= t + 1e-6) apply(pending[next++]);
    const pixels = engine._ac_frame(dt, 0);
    if (!pixels) throw new Error(`${name}: ${engine.UTF8ToString(engine._ac_error())}`);
    const frame = Buffer.from(engine.HEAPU8.subarray(pixels, pixels + width * height * 4));
    if (!ffmpeg.stdin.write(frame)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
  }
  ffmpeg.stdin.end();
  await done;
  if (take.lens) await renderLens(out, take.lens, size);
  return out;
  if (!outFile) console.log(`${path.relative(root, out)}: ${take.duration}s, ${take.character || "copilot"}, seed ${take.seed ?? 1}`);
}

// A close-up from the finished clip: crop around the point, scale up 2x.
async function renderLens(clip, lens, size) {
  const span = Math.round(size * (lens.span || 0.3) / 2) * 2;
  const pad = span;
  const x = Math.round(lens.x * size - span / 2 + pad);
  const y = Math.round(lens.y * size - span / 2 + pad);
  const out = clip.replace(/\.mp4$/, "-lens.mp4");
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-v", "error", "-y", "-i", clip,
      "-vf", `pad=${size + pad * 2}:${size + pad * 2}:${pad}:${pad}:black,crop=${span}:${span}:${x}:${y},scale=${span * 2}:${span * 2}:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-movflags", "+faststart", "-an", out,
    ], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  console.log(`${path.relative(root, out)}: close-up at ${lens.x}, ${lens.y}`);
}

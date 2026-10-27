#!/usr/bin/env node
// Build index.html for the Agent Buddy overview video from video.config.json.
//
//   node scripts/build.mjs
//
// The script works out every scene time (scripts/timing.mjs), device position,
// camera move, and tile layout, then writes one self-contained HyperFrames
// composition. It inlines src/styles.css and src/motion.js. Do not edit
// index.html by hand.
//
// Device clips come from scripts/render-device.mjs (the firmware's own engine),
// the case from scripts/render-case.mjs, and the agent badges from
// scripts/render-badges.mjs. Run "npm run assets" when the takes change.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { timing, takeStart } from "./timing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => Boolean(p) && fs.existsSync(path.join(root, p));
const cfg = JSON.parse(read("video.config.json"));
const W = 1920;
const H = 1080;
const SHOT_W = 1920;
const SHOT_H = 1080;
const OVERLAP = 0.5;
const warnings = new Set();
validateConfig(cfg);
const { order, T, total: TOTAL } = timing(cfg);

// Stop early with a clear message when the config cannot make a good video.
function validateConfig(c) {
  const errors = [];
  const warn = (msg) => warnings.add(msg);
  const need = (cond, msg) => cond || errors.push(msg);
  need(c.meta?.title && c.meta?.subtitle && c.meta?.url, "meta.title, meta.subtitle, and meta.url are required.");
  need(c.meta?.width === 1920 && c.meta?.height === 1080, "Only 1920x1080 (16:9) is supported.");
  need(Array.isArray(c.sequence) && c.sequence.length, "sequence lists the scenes in order.");
  for (const key of ["hook", "end"]) need(c[key]?.duration > 0, `${key}.duration is required.`);
  need(Array.isArray(c.hook?.lines) && c.hook.lines.length === 3, "hook.lines needs 3 lines.");
  for (const [name, take] of Object.entries(c.takes || {})) {
    need(take.from && take.duration > 0, `takes.${name} needs "from" and "duration".`);
    if (!exists(`assets/clips/device-${name}.mp4`)) errors.push(`assets/clips/device-${name}.mp4 is missing. Run "npm run assets".`);
  }
  for (const f of ["assets/device/case.png", "assets/device/case.json", "assets/badges/badges.json"])
    need(exists(f), `${f} is missing. Run "npm run assets".`);
  (c.chapters || []).forEach((ch, i) => {
    const at = `chapters[${i}]`;
    need(Array.isArray(ch.headline) && ch.headline.length >= 2 && ch.headline.length <= 4, `${at}.headline needs 2 to 4 lines.`);
    if (ch.duration < 5.5) warn(`${at} is ${ch.duration}s. Beginners need about 5.5 s or more for each card.`);
    if ((ch.shots || []).length > 3) warn(`${at} has ${ch.shots.length} shots. Use 3 or fewer.`);
    for (const line of ch.headline || []) if (line.length > 18) warn(`${at} headline line "${line}" is ${line.length} characters. Keep it to about 17.`);
  });
  (c.states?.steps || []).forEach((st, i) => {
    if (st.duration < 4.5) warn(`states.steps[${i}] is ${st.duration}s. Give each state about 5 s.`);
  });
  const durs = [...order_(c).map((k) => k)].flatMap((k) =>
    k === "chapters" ? (c.chapters || []).map((x) => x.duration) : k === "states" ? (c.states?.steps || []).map((x) => x.duration) : [c[k]?.duration || 0]
  );
  if (durs.some((d) => Math.abs(d * 2 - Math.round(d * 2)) > 1e-6)) warn("Some durations are not on the 0.5 s grid, so cuts will not land on a 120 BPM beat.");
  const segs = c.music?.segments;
  if (Array.isArray(segs)) need(segs.every((sg, i) => i === 0 || sg.at > segs[i - 1].at), 'music.segments must be in time order (increasing "at").');
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
}
function order_(c) {
  return c.sequence || [];
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261005);

const iconCache = new Map();
function icon(name, cls = "") {
  if (!iconCache.has(name)) {
    const file = path.join(root, "assets/icons", `${name}-24.svg`);
    if (!fs.existsSync(file)) throw new Error(`Missing icon: ${file}. Copy it from @primer/octicons build/svg.`);
    const body = fs.readFileSync(file, "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    iconCache.set(name, body);
  }
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${iconCache.get(name)}</svg>`;
}

// The device's own agent badges (scripts/render-badges.mjs).
const BADGES = Object.fromEntries(JSON.parse(read("assets/badges/badges.json")).map((b) => [b.id, b]));
const glyphCache = new Map();
function badge(id, size) {
  const b = BADGES[id];
  if (!b) throw new Error(`Unknown agent "${id}". Use one of: ${Object.keys(BADGES).join(", ")}.`);
  if (!glyphCache.has(id)) glyphCache.set(id, read(`assets/badges/${id}.svg`).trim().replace('fill="#fff"', 'fill="currentColor"'));
  return `<span class="badge" style="--c:${b.color};width:${size}px;height:${size}px">${glyphCache.get(id)}</span>`;
}

// Split text into masked words. Gradient words get a shared gradient offset.
function words(text, { grad = false } = {}) {
  const parts = text.split(" ");
  return parts
    .map((word, i) => {
      const style = grad ? ` style="--gs:${parts.length * 100}%;--gp:${parts.length === 1 ? 0 : round((i / (parts.length - 1)) * 100, 1)}%"` : "";
      return `<span class="w"><span class="wi"${style}>${esc(word)}</span></span>`;
    })
    .join(" ");
}

// ---------- devices ----------
// A device is the case image plus a round screen that plays an engine clip.
// Devices sit at the root, not inside a timed scene: a <video> must not be
// inside an element that has data-start. motion.js shows and moves them.
const CASE = JSON.parse(read("assets/device/case.json"));
const devices = [];
let videoTrack = 20;
function addDevice({ id, take, cx, cy, size, lens = null }) {
  const t = cfg.takes[take];
  const d = round(size * CASE.screenRadius * 2, 2);
  const off = round((size - d) / 2, 2);
  const dev = { id, take, cx, cy, size, d, off, start: takeStart(cfg, t), dur: t.duration, track: videoTrack++, lens };
  if (lens) dev.lensTrack = videoTrack++;
  devices.push(dev);
  return dev;
}
function deviceHtml(dv) {
  const src = `assets/clips/device-${dv.take}.mp4`;
  const media = (id, track, extra = "") =>
    `<video id="${id}" class="device-video" src="${src}" muted playsinline data-start="${dv.start}" data-duration="${dv.dur}" data-track-index="${track}"${extra}></video>`;
  // A magnifier: the take's close-up clip (render-device.mjs "lens").
  let lens = "";
  if (dv.lens) {
    const L = dv.lens.size || 230;
    const lx = round(dv.size * (dv.lens.cx ?? 0.84) - L / 2, 2);
    const ly = round(dv.size * (dv.lens.cy ?? 0.84) - L / 2, 2);
    const lensSrc = `assets/clips/device-${dv.take}-lens.mp4`;
    if (!exists(lensSrc)) throw new Error(`${lensSrc} is missing. Add "lens" to takes.${dv.take}, then run "npm run assets".`);
    lens = `<div class="lens" id="${dv.id}-lens" style="left:${lx}px;top:${ly}px;width:${L}px;height:${L}px"><video id="${dv.id}-lv" src="${lensSrc}" muted playsinline data-start="${dv.start}" data-duration="${dv.dur}" data-track-index="${dv.lensTrack}" style="left:0;top:0;width:${L}px;height:${L}px"></video></div>`;
  }
  const box = `left:${dv.off}px;top:${dv.off}px;width:${dv.d}px;height:${dv.d}px`;
  return `<div class="device" id="${dv.id}" style="left:${round(dv.cx - dv.size / 2, 2)}px;top:${round(dv.cy - dv.size / 2, 2)}px;width:${dv.size}px;height:${dv.size}px">
  <div class="device-glow" id="${dv.id}-glow" style="${box}"></div>
  <div class="device-case"></div>
  <div class="device-screen" id="${dv.id}-scr" style="${box}">${media(`${dv.id}-v`, dv.track)}</div>
  <div class="device-shine" style="${box}"></div>
  <div class="ripple" id="${dv.id}-rp" style="left:${round(dv.size / 2 - 60)}px;top:${round(dv.size / 2 - 20)}px;width:120px;height:120px"></div>
  ${lens}
</div>`;
}

// Real device footage replaces a rendered device when the file exists. Until
// then the rendered device is the fallback, and the build says so.
const footage = [];
function useFootage(scene, f, fallbackFor) {
  if (!f) return null;
  if (!exists(f.src)) {
    warnings.add(`Footage ${f.src} is missing. Using the ${f.fallback || "rendered device"} (fallback) in ${fallbackFor}.`);
    return null;
  }
  const [l, t, r, b] = f.box || [0, 0, W, H];
  const item = { id: `ft-${footage.length}`, scene, src: f.src, left: l, top: t, width: r - l, height: b - t, start: T[scene].start, dur: T[scene].dur, mediaStart: f.mediaStart || 0, track: videoTrack++ };
  footage.push(item);
  return item;
}
const footageHtml = (f) =>
  `<div class="footage" id="${f.id}" style="left:${f.left}px;top:${f.top}px;width:${f.width}px;height:${f.height}px"><video src="${esc(f.src)}" muted playsinline data-start="${f.start}" data-duration="${f.dur}" data-track-index="${f.track}"${f.mediaStart ? ` data-media-start="${f.mediaStart}"` : ""}></video></div>`;

// The hero device: one engine take from the meet scene through the agents scene,
// so the character never cuts. It moves between the scenes' layouts.
const hero = T.meet ? addDevice({ id: "dv-hero", take: "hero", ...cfg.meet.device }) : null;
const pose = (dv, p) => (p ? { x: round(p.cx - dv.cx), y: round(p.cy - dv.cy), s: round(p.size / dv.size, 4) } : null);
const heroPoses = hero ? { meet: { x: 0, y: 0, s: 1 }, states: pose(hero, cfg.states?.device), agents: pose(hero, cfg.agents?.device) } : null;
const meetFootage = T.meet ? useFootage("meet", cfg.meet.footage, "the meet scene") : null;

const touchDevices = T.touches
  ? cfg.touches.items.map((it, i) => {
      const n = cfg.touches.items.length;
      const size = cfg.touches.size || 420;
      const cx = round(W / 2 + (i - (n - 1) / 2) * (cfg.touches.spacing || 560));
      const cy = cfg.touches.cy || 520;
      const dv = addDevice({ id: `dv-t${i}`, take: it.take, cx, cy, size, lens: it.lens ? { ...it.lens } : null });
      dv.tap = it.tap || [];
      dv.footage = useFootage("touches", it.footage && { ...it.footage, box: it.footage.box || [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2] }, `touches item "${it.title}"`);
      return dv;
    })
  : [];

const charSlots = T.characters
  ? cfg.characters.items.map((it, i) => {
      const n = cfg.characters.items.length;
      const size = cfg.characters.size || 380;
      const cx = round(W / 2 + (i - (n - 1) / 2) * (cfg.characters.spacing || 440));
      const cy = cfg.characters.cy || 520;
      return { ...it, i, cx, cy, size, dv: it.take ? addDevice({ id: `dv-c${i}`, take: it.take, cx, cy, size }) : null };
    })
  : [];

const endDevice = T.end && cfg.takes.end ? addDevice({ id: "dv-end", take: "end", ...cfg.end.device }) : null;
const endFootage = T.end ? useFootage("end", cfg.end.footage, "the end card") : null;

// ---------- hook tiles ----------
const tiles = (cfg.hook.tiles || []).map((t, i) => {
  const ang = rand() * Math.PI * 2;
  return {
    id: `tl${i}`, ...t,
    ox: round(Math.cos(ang) * 1300), oy: round(Math.sin(ang) * 900 + 200),
    rot: round((rand() - 0.5) * 50), order: round(rand(), 3),
    period: round(1.1 + rand() * 1.3, 2), low: round(0.12 + rand() * 0.25, 2), high: round(0.62 + rand() * 0.3, 2),
  };
});
const meetDevice = cfg.meet?.device || { cx: W / 2, cy: H / 2 };
function tileHtml(t) {
  const status = t.outcome === "done" ? "Done · 5 min ago" : t.outcome === "attention" ? "Needs your approval" : "";
  const mark = t.outcome === "done" ? icon("check") : t.outcome === "attention" ? "?" : "";
  return `<div class="tile ${t.outcome || ""}" id="${t.id}" style="left:${t.x}px;top:${t.y}px">
    <span class="tile-edge" id="${t.id}-edge"></span>${t.outcome === "attention" ? `<span class="tile-pulse" id="${t.id}-pulse"></span>` : ""}
    ${badge(t.agent, 62)}
    <div class="tile-body"><div class="tile-name">${esc(BADGES[t.agent].name)}</div>
      <div class="tile-task"><span id="${t.id}-task">${esc(t.task)}</span>${status ? `<span class="tile-status" id="${t.id}-st">${esc(status)}</span>` : ""}</div>
      <div class="tile-bar"><span class="tile-fill" id="${t.id}-f"></span></div></div>
    ${mark ? `<span class="tile-mark" id="${t.id}-mk">${mark}</span>` : ""}
  </div>`;
}

// ---------- states ----------
const stateSteps = [];
if (T.states) {
  let at = T.states.start;
  for (const [k, st] of cfg.states.steps.entries()) {
    stateSteps.push({ k, start: round(at), dur: st.duration, state: st.state, rows: st.events.length });
    at += st.duration;
  }
}
const markFor = (kind) => (kind === "complete" ? icon("check") : kind === "attention" ? "?" : "");
function statesHtml() {
  const c = cfg.states;
  const dv = cfg.states.device;
  return `<section id="s-states" class="clip scene" data-start="${T.states.start}" data-duration="${T.states.dur}" data-track-index="3">
  <div class="st-label label mono" id="st-label"><span class="dot"></span>${esc(c.label)}</div>
  ${c.steps.map((st, k) => `<div class="st-step" id="st${k}"><div class="st-title ${st.state}">${words(st.title)}</div><p class="st-sub">${esc(st.sub)}</p></div>`).join("")}
  <div class="st-events">${c.steps
    .map(
      (st, k) => `<div class="ev-group" id="evg${k}">${st.events
        .map(
          (ev, r) => `<div class="ev ${ev.kind}" style="top:${r * 124}px">${badge(ev.agent, 62)}<div><div class="ev-name">${esc(BADGES[ev.agent].name)}</div><div class="ev-text">${esc(ev.text)}</div></div><span class="ev-mark" id="evg${k}-m${r}">${markFor(ev.kind)}</span></div>`
        )
        .join("")}</div>`
    )
    .join("")}</div>
  ${c.badgeNote ? `<div class="st-note" id="st-note" style="left:${dv.cx - 360}px;width:720px">${esc(c.badgeNote)}</div>` : ""}
</section>`;
}

// ---------- agents ----------
function agentsChips() {
  const c = cfg.agents;
  const ids = Object.keys(BADGES);
  const r = c.device.size / 2;
  const rows = [-170, 0, 170];
  return ids.map((id, i) => {
    const left = i < 3;
    const dy = rows[i % 3];
    const reach = Math.sqrt(Math.max(0, r * r - dy * dy));
    const gap = 70;
    const y = c.device.cy + dy - 46;
    const pos = left ? `right:${round(W - (c.device.cx - reach - gap))}px` : `left:${round(c.device.cx + reach + gap)}px`;
    return `<div class="chip ${left ? "left" : "right"}" id="chip-${id}" style="${pos};top:${round(y)}px">${badge(id, 62)}<span>${esc(BADGES[id].name)}</span></div>`;
  });
}

// ---------- chapters (screenshot cards) ----------
const FRAMES = cfg.meta.framesDir || "assets/frames";
const shotPath = (name) => `${FRAMES}/${name}.webp`;
// Shots are 1920 wide. A taller shot (for a pan) keeps its own height.
function shotHeight(file) {
  if (!file) return SHOT_H;
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=height", "-of", "csv=p=0", shotPath(file)]).toString().trim()) || SHOT_H;
  } catch {
    return SHOT_H;
  }
}
function resolveShot(name, fallback) {
  if (name && exists(shotPath(name))) return name;
  if (fallback && exists(shotPath(fallback))) {
    warnings.add(`Shot "${name}" is missing. Using fallback "${fallback}".`);
    return fallback;
  }
  warnings.add(`Shot "${name}" is missing. A "capture pending" card shows in its place.`);
  return null;
}
// The shot (or its crop region [l, t, r, b]) covers the stage.
function camera(cw, ch, focus, ringOverride, maxZoom = 2.0, crop, SHOT_W = 1920, SHOT_H = 1080) {
  const [cl, ct, cr, cb] = crop || [0, 0, SHOT_W, SHOT_H];
  const s0 = Math.max(cw / (cr - cl), ch / (cb - ct));
  const fit = (stage, center, size) => Math.min(0, Math.max(stage - size * s0, stage / 2 - center * s0));
  const base = { x: round(fit(cw, (cl + cr) / 2, SHOT_W), 2), y: round(fit(ch, (ct + cb) / 2, SHOT_H), 2), s: round(s0, 5) };
  if (!focus) return { from: base, to: base, ring: null };
  const [l, t, r, b] = focus;
  const rw = r - l;
  const rh = b - t;
  let z = Math.min((0.84 * cw) / (rw * s0), (0.84 * ch) / (rh * s0), maxZoom);
  z = Math.max(z, 1);
  const s1 = s0 * z;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const x = clamp(cw / 2 - ((l + r) / 2) * s1, cw - SHOT_W * s1, 0);
  const y = clamp(ch / 2 - ((t + b) / 2) * s1, ch - SHOT_H * s1, 0);
  const pad = 14;
  const box = (bl, bt, br, bb) => ({ left: bl - pad, top: bt - pad, width: br - bl + pad * 2, height: bb - bt + pad * 2 });
  let ring = null;
  if (Array.isArray(ringOverride)) ring = box(...ringOverride);
  else if (ringOverride !== false && rw * rh < 0.3 * SHOT_W * SHOT_H) ring = box(l, t, r, b);
  return { from: base, to: { x: round(x, 2), y: round(y, 2), s: round(s1, 5) }, ring };
}
const STAGE = { left: 850, top: 160, width: 960, height: 540 };
const stageStyle = (st) => `left:${st.left}px;top:${st.top}px;width:${st.width}px;height:${st.height}px`;
let chCursor = T.chapters ? T.chapters.start : 0;
const chapters = (T.chapters ? cfg.chapters : []).map((c, i) => {
  const start = round(chCursor);
  chCursor += c.duration;
  const id = `ch${i}`;
  const stage = { ...STAGE, ...(c.stage || {}) };
  const plan = { id, start, dur: c.duration, stage, shots: [] };
  const fixed = c.shots.reduce((sum, s) => sum + (s.duration || 0), 0);
  const flexible = c.shots.filter((s) => !s.duration).length;
  const share = flexible ? (c.duration - fixed) / flexible : 0;
  let shotCursor = start;
  c.shots.forEach((s, k) => {
    const video = s.video && exists(s.video) ? s.video : null;
    const file = video ? null : resolveShot(s.src, s.fallback);
    if (s.video && !video) warnings.add(`Clip "${s.video}" is missing. Using ${file ? `the still "${file}"` : "a capture pending card"}.`);
    const h = shotHeight(file);
    const cam = camera(stage.width, stage.height, s.focus, s.ring, 2.0, s.crop, SHOT_W, h);
    const len = s.duration || share;
    const moves = (s.moves || []).map((m) => ({ at: round(shotCursor + m.at), dur: m.dur || 1, to: camera(stage.width, stage.height, m.focus, false, 2.0, s.crop, SHOT_W, h).to }));
    plan.shots.push({ id: `${id}-s${k}`, name: s.src, file, video, h, mediaStart: s.mediaStart || 0, rate: s.rate || 1, t0: round(shotCursor), t1: round(shotCursor + len), from: cam.from, to: cam.to, ring: cam.ring, moves });
    shotCursor += len;
  });
  return plan;
});
function chapterHtml(c, p, i) {
  const gradFrom = c.gradFrom ?? c.headline.length - 1;
  const head = c.headline.map((l, k) => (k >= gradFrom ? `<span class="line grad">${words(l, { grad: true })}</span>` : `<span class="line">${words(l)}</span>`)).join("");
  const inner = p.shots
    .map(
      (s) => `<div class="shot" id="${s.id}"><div class="shot-inner" id="${s.id}-in"${s.h !== SHOT_H ? ` style="height:${s.h}px"` : ""}>${
        s.video ? "" : s.file ? `<img src="${shotPath(s.file)}" alt=""${s.h !== SHOT_H ? ` style="height:${s.h}px"` : ""}>` : `<div class="shot-missing" style="width:${SHOT_W}px;height:${SHOT_H}px">Capture pending: ${esc(s.name)}</div>`
      }${s.ring ? `<div class="ring" id="${s.id}-ring" style="left:${s.ring.left}px;top:${s.ring.top}px;width:${s.ring.width}px;height:${s.ring.height}px"></div>` : ""}</div></div>`
    )
    .join("");
  return `<section id="${p.id}" class="clip scene" data-start="${p.start}" data-duration="${round(p.dur + OVERLAP)}" data-track-index="${7 + (i % 2)}">
    <div class="ch-text" id="${p.id}-text">
      <span class="label mono ch-label"><span class="dot"></span>${esc(c.label || "")}</span>
      <h2 class="ch-head"${c.headSize ? ` style="font-size:${c.headSize}px"` : ""}>${head}</h2>
      <p class="ch-sub">${esc(c.sub)}</p>
    </div>
    <div class="persp stage" id="${p.id}-stage" style="${stageStyle(p.stage)}">
      <div class="card-wrap" id="${p.id}-wrap"><div class="card" id="${p.id}-card">${inner}<div class="sheen" id="${p.id}-sheen" data-layout-allow-overflow></div></div></div>
    </div>
  </section>`;
}
// Video shots live in a root-level copy of the card (see devices above).
function videoOverlayHtml(p) {
  const vids = p.shots.filter((s) => s.video);
  if (!vids.length) return "";
  return `<div class="persp stage" id="${p.id}-vstage" style="${stageStyle(p.stage)}"><div class="card-wrap" id="${p.id}-vwrap">${vids
    .map((s) => {
      const last = s === p.shots[p.shots.length - 1];
      const start = round(s.t0 - 0.3);
      const dur = round(s.t1 - s.t0 + 0.3 + (last ? 0.2 : 0.3));
      return `<div class="card vcard" id="${s.id}-vcard"><div class="shot"><div class="shot-inner" id="${s.id}-vin"><video id="${s.id}-video" class="clip-video" src="${esc(s.video)}" muted playsinline data-start="${start}" data-duration="${dur}" data-track-index="${videoTrack++}"${s.mediaStart ? ` data-media-start="${s.mediaStart}"` : ""}${s.rate !== 1 ? ` data-playback-rate="${s.rate}"` : ""}></video></div></div></div>`;
    })
    .join("")}</div></div>`;
}

// ---------- background ----------
const particles = Array.from({ length: 48 }, (_, i) => ({
  id: `pt${i}`, x: round(rand() * W, 1), y: round(rand() * H, 1), size: round(1.6 + rand() * 2.6, 2),
  op: round(0.12 + rand() * 0.4, 3), dy: round(50 + rand() * 120, 1), tw: round(1.6 + rand() * 2.8, 2),
}));

// One <audio> per music segment (see scripts/add-music.mjs for the format).
function musicHtml(music) {
  if (!music || !music.src) return "<!-- No music yet. Set music.src in video.config.json, or run scripts/add-music.mjs after render. -->";
  const segs = Array.isArray(music.segments) && music.segments.length ? music.segments : [{ at: 0, trackAt: music.start || 0 }];
  const xf = music.crossfade ?? 0.3;
  const fadeIn = music.fadeIn ?? 0.4;
  const fadeOut = music.fadeOut ?? 2.5;
  return segs
    .map((seg, i) => {
      const first = i === 0;
      const last = i === segs.length - 1;
      let v0 = first ? 0 : seg.at - xf / 2;
      const v1 = last ? TOTAL : segs[i + 1].at + xf / 2;
      let ts = v0 - seg.at + seg.trackAt;
      if (ts < 0) {
        v0 -= ts;
        ts = 0;
      }
      const len = round(v1 - v0);
      const a = first ? Math.min(fadeIn, len) : xf;
      const z = last ? fadeOut : xf;
      const points = [{ t: 0, v: 0 }, { t: round(a), v: 1 }, { t: round(len - z), v: 1 }, { t: len, v: 0 }];
      return `<audio id="music${i ? i + 1 : ""}" src="${esc(music.src)}" data-start="${round(v0)}" data-duration="${len}" data-track-index="${40 + i}" data-volume="${music.volume ?? 0.9}"${
        ts ? ` data-media-start="${round(ts)}"` : ""
      } data-automation='${JSON.stringify({ version: 1, lanes: [{ target: "volume", points }] })}'></audio>`;
    })
    .join("\n");
}

// ---------- plan for motion.js ----------
const plan = {
  total: TOTAL,
  T,
  tiles: tiles.map(({ id, outcome, at, ox, oy, rot, order, period, low, high, x, y }) => ({
    id, outcome: outcome || null, at: at ?? null, ox, oy, rot, order, period, low, high,
    tx: round(meetDevice.cx - (x + 173)), ty: round(meetDevice.cy - (y + 54)),
  })),
  hero: hero ? { id: hero.id, poses: heroPoses, footage: meetFootage?.id || null } : null,
  stateSteps,
  touches: touchDevices.map((d) => ({ id: d.id, tap: d.tap, lens: Boolean(d.lens), footage: d.footage?.id || null })),
  chars: charSlots.map((s) => ({ id: s.dv?.id || null, slot: s.dv ? null : `slot${s.i}` })),
  end: endDevice ? { id: endDevice.id, footage: endFootage?.id || null } : null,
  chapters,
  particles,
  sweeps: ["meet", "touches", "chapters", "values", "end"].filter((k) => T[k]).map((k) => T[k].start),
};

// ---------- markup ----------
const c = cfg;
const scene = (key, track, body) =>
  T[key] ? `<section id="s-${key}" class="clip scene" data-start="${T[key].start}" data-duration="${T[key].dur}" data-track-index="${track}">\n${body}\n</section>` : "";

const hookHtml = scene(
  "hook",
  1,
  `<div class="tiles" id="tiles">${tiles.map(tileHtml).join("")}</div>
  <div class="hook-wrap" id="hook-wrap">
    <div class="hook-l1" id="hook-l1">${words(c.hook.lines[0])}</div>
    <div class="hook-l2" id="hook-l2">${words(c.hook.lines[1])}</div>
    <div class="hook-l3 grad" id="hook-l3">${words(c.hook.lines[2], { grad: true })}</div>
  </div>`
);

const meetHtml = scene(
  "meet",
  2,
  `<div class="meet-text" id="meet-text">
    <div class="meet-kicker" id="meet-kicker">${words(c.meet.introducing || "Introducing")}</div>
    <div class="meet-title" id="meet-title"><div>${words(c.meta.title)}</div><div class="grad">${words(c.meta.subtitle, { grad: true })}</div></div>
    <p class="meet-sub" id="meet-sub">${esc(c.meet.sub)}</p>
  </div>`
);

const agentsHtml = scene(
  "agents",
  4,
  `<div class="ag-lines"><div class="ag-l1" id="ag-l1">${words(c.agents.lines[0])}</div><div class="ag-l2 grad" id="ag-l2">${words(c.agents.lines[1], { grad: true })}</div></div>
  ${agentsChips().join("")}
  <div class="ag-sub" id="ag-sub">${esc(c.agents.sub)}</div>`
);

const capHtml = (id, cx, top, title, sub, tag) =>
  `<div class="cap" id="${id}" style="left:${round(cx - 260)}px;top:${round(top)}px"><div class="cap-t">${esc(title)}</div>${sub ? `<div class="cap-s">${esc(sub)}</div>` : ""}${tag ? `<span class="cap-tag mono">${esc(tag)}</span>` : ""}</div>`;

const touchesHtml = scene(
  "touches",
  5,
  `<div class="tc-title" id="tc-title"><span>${words(c.touches.title[0])}</span> <span class="grad">${words(c.touches.title[1], { grad: true })}</span></div>
  ${touchDevices.map((d, i) => capHtml(`tcap${i}`, d.cx, d.cy + d.size / 2 + 26, c.touches.items[i].title, c.touches.items[i].sub)).join("")}`
);

const charactersHtml = scene(
  "characters",
  6,
  `<div class="tc-title" id="ch-title"><span>${words(c.characters.title[0])}</span> <span class="grad">${words(c.characters.title[1], { grad: true })}</span></div>
  ${c.characters.note ? `<div class="tc-note" id="ch-note">${esc(c.characters.note)}</div>` : ""}
  ${charSlots
    .map((s) => {
      const slot = s.dv
        ? ""
        : `<div class="custom-slot" id="slot${s.i}" style="left:${round(s.cx - (s.size * CASE.screenRadius))}px;top:${round(s.cy - s.size * CASE.screenRadius)}px;width:${round(s.size * CASE.screenRadius * 2)}px;height:${round(s.size * CASE.screenRadius * 2)}px"><span class="custom-plus">${icon("plus")}</span></div>`;
      return `${slot}${capHtml(`ccap${s.i}`, s.cx, s.cy + s.size / 2 + 22, s.name, null, s.custom || "Built in")}`;
    })
    .join("")}`
);

const valuesHtml = scene(
  "values",
  9,
  `<div class="values-words" id="values-words">${c.values.words
    .map((w, i) => {
      const last = i === c.values.words.length - 1;
      return `<span class="vword ${last ? "grad" : ""}" id="vw${i}">${words(w, { grad: last })}${last ? '<span class="v-underline" id="v-underline"></span>' : ""}</span>`;
    })
    .join("")}</div>
  <div class="chips" id="chips">${c.values.chips.map((ch, i) => `<span class="pill" id="chip${i}">${icon(ch.icon)}<span>${esc(ch.text)}</span></span>`).join("")}</div>`
);

const endHtml = scene(
  "end",
  10,
  `<div class="end-text" id="end-text">
    <div class="end-title"><span class="line">${words(c.meta.title)}</span><span class="line grad">${words(c.meta.subtitle, { grad: true })}</span></div>
    <div class="end-options">${c.end.options
      .map((o, i) => `<div class="end-opt" id="end-opt${i}"><span class="end-opt-ic">${icon(o.icon)}</span><span><span class="end-opt-l mono">${esc(o.label)}</span><span class="end-opt-t">${esc(o.text)}</span></span></div>`)
      .join("")}</div>
    <div class="end-get" id="end-get">
      <div class="end-cta" id="end-cta">${icon("download")}<span>${esc(c.end.cta)}</span></div>
      <div class="end-url" id="end-url">${icon("mark-github")}<span>${esc(c.meta.url)}</span></div>
    </div>
  </div>`
);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, height=${H}">
<title>${esc(c.meta.title)} ${esc(c.meta.subtitle)} | Overview video</title>
<!-- Generated by scripts/build.mjs from video.config.json. Do not edit by hand. -->
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
${read("src/styles.css")}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="${W}" data-height="${H}">

<div id="bg" class="clip layer" data-start="0" data-duration="${TOTAL}" data-track-index="0">
  <div class="aurora a1" id="a1"></div><div class="aurora a2" id="a2"></div><div class="aurora a3" id="a3"></div>
  <div class="hexgrid" id="hexgrid"></div>
  <div class="vignette"></div>
  <div id="particles">${particles.map((p) => `<span class="pt" id="${p.id}" style="left:${p.x}px;top:${p.y}px;width:${p.size}px;height:${p.size}px;opacity:0"></span>`).join("")}</div>
</div>

${hookHtml}
${meetHtml}
${T.states ? statesHtml() : ""}
${agentsHtml}
${touchesHtml}
${charactersHtml}
${cfg.chapters && T.chapters ? cfg.chapters.map((ch, i) => chapterHtml(ch, chapters[i], i)).join("\n") : ""}
${chapters.map(videoOverlayHtml).join("\n")}
${valuesHtml}
${endHtml}

<div id="devices">
${devices.map(deviceHtml).join("\n")}
${footage.map(footageHtml).join("\n")}
</div>

<div id="fx" class="clip layer" data-start="0" data-duration="${TOTAL}" data-track-index="15">
  <div class="sweep-band" id="sweep"></div>
  <div class="grain" id="grain"></div>
  <div class="fade-black" id="fade-black"></div>
</div>
${musicHtml(c.music)}
</div>
<script>
window.__PLAN__ = ${JSON.stringify(plan)};
${read("src/motion.js")}
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, "index.html"), html);
console.log(`index.html written: ${TOTAL}s, scenes ${order.map((k) => `${k}@${T[k].start}`).join(" ")}, ${devices.length} devices.`);
for (const w of warnings) console.warn(`warning: ${w}`);

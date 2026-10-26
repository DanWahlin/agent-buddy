#!/usr/bin/env node
// Add a music track to the rendered video without a new video render.
//
//   node scripts/add-music.mjs <music-file> [--start 12.5] [--volume 0.9]
//                              [--in renders/video.mp4] [--out renders/video-with-music.mp4]
//
// --start skips into the track (use it to begin on a strong section).
// For a longer track, set music.segments in video.config.json to edit it on
// the beat: [{ "at": videoSeconds, "trackAt": trackSeconds }, ...]. Each segment
// plays from "at" until the next one starts, with a short crossfade
// (music.crossfade, default 0.3 s) centered on the change. A negative trackAt
// delays the music, so its beats can line up with the video's cut grid.
// The script trims the track to the video length, adds a short fade-in and a
// longer fade-out, and normalizes loudness to -14 LUFS (YouTube and social
// targets). It needs ffmpeg and ffprobe. Defaults come from video.config.json.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "video.config.json"), "utf8"));
const music = cfg.music || {};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const track = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) || music.src;
if (!track) {
  console.error("Usage: node scripts/add-music.mjs <music-file> [--start SECONDS] [--volume 0.9]");
  process.exit(1);
}
const trackPath = path.resolve(root, track);
const input = path.resolve(root, opt("in", "renders/video.mp4"));
const output = path.resolve(root, opt("out", "renders/video-with-music.mp4"));
const start = Number(opt("start", music.start ?? 0));
const volume = Number(opt("volume", music.volume ?? 0.9));
const fadeIn = Number(music.fadeIn ?? 0.4);
const fadeOut = Number(music.fadeOut ?? 2.5);

for (const f of [trackPath, input]) {
  if (!fs.existsSync(f)) {
    console.error(`Not found: ${f}`);
    process.exit(1);
  }
}

const duration = Number(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input]).toString().trim()
);
const trackDuration = Number(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", trackPath]).toString().trim()
);
const usingSegments = !args.includes("--start") && Array.isArray(music.segments) && music.segments.length > 0;
if (!usingSegments && trackDuration - start < duration) {
  console.warn(`warning: the track has ${(trackDuration - start).toFixed(1)}s after --start, but the video is ${duration.toFixed(1)}s. The script pads the end with silence.`);
}

// Build one input chain for each segment, then mix them.
const segments = usingSegments ? music.segments : [{ at: 0, trackAt: start }];
const xf = Number(music.crossfade ?? 0.3);
const chains = segments.map((seg, i) => {
  const first = i === 0;
  const last = i === segments.length - 1;
  const v0 = first ? 0 : seg.at - xf / 2;
  const v1 = last ? duration : segments[i + 1].at + xf / 2;
  let ts = v0 - seg.at + seg.trackAt;
  let lead = 0;
  if (ts < 0) {
    lead = -ts;
    ts = 0;
  }
  const len = v1 - v0 - lead;
  if (ts + len > trackDuration + 0.01 && !last) {
    console.warn(`warning: segment ${i + 1} runs past the end of the track.`);
  }
  const delayMs = Math.round((v0 + lead) * 1000);
  return [
    `[1:a]atrim=start=${ts.toFixed(3)}:duration=${len.toFixed(3)}`,
    "asetpts=PTS-STARTPTS",
    first ? null : `afade=t=in:st=0:d=${xf}:curve=qsin`,
    last ? null : `afade=t=out:st=${Math.max(0, len - xf).toFixed(3)}:d=${xf}:curve=qsin`,
    `adelay=${delayMs}:all=1`,
    `apad=whole_dur=${duration}[s${i}]`,
  ]
    .filter(Boolean)
    .join(",");
});
const mix = segments.length > 1 ? `${segments.map((_, i) => `[s${i}]`).join("")}amix=inputs=${segments.length}:normalize=0` : "[s0]anull";

const filter = [
  ...chains.map((c) => c + ";"),
  mix,
  `volume=${volume}`,
  `afade=t=in:st=0:d=${fadeIn}`,
  `afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`,
  "loudnorm=I=-14:TP=-1.5:LRA=11",
  // Pad with silence when the track is shorter, so the video is never cut.
  `apad=whole_dur=${duration}`,
  `atrim=duration=${duration}`,
  "aresample=48000[a]",
].join(",").replace(/;,/g, ";");

execFileSync(
  "ffmpeg",
  ["-v", "error", "-y", "-i", input, "-i", trackPath, "-filter_complex", filter, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-t", String(duration), "-movflags", "+faststart", output],
  { stdio: "inherit" }
);
console.log(`wrote ${path.relative(root, output)} (${duration.toFixed(2)}s, ${usingSegments ? `${segments.length} music segments` : `music from ${start}s`})`);

#!/usr/bin/env node
// Write a web copy of the finished video that is small enough to commit.
//
//   node scripts/export.mjs [--in renders/video-with-music.mp4] [--out export/video.mp4] [--crf 20]
//
// The default input is the music render. When it does not exist, the script
// uses the silent render and warns. H.264 CRF 20 with -tune animation keeps
// this kind of video visually the same as the render (SSIM about 0.996) at
// about a third of the size. GitHub warns about files over 50 MB.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "video.config.json"), "utf8"));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const withMusic = path.join(root, "renders/video-with-music.mp4");
const silent = path.join(root, "renders/video.mp4");
let input = opt("in") ? path.resolve(root, opt("in")) : withMusic;
if (!opt("in") && !fs.existsSync(withMusic)) {
  if (!fs.existsSync(silent)) {
    console.error('No render found. Run "npm run render" (and "npm run music") first.');
    process.exit(1);
  }
  console.warn('warning: renders/video-with-music.mp4 not found. Exporting the render without music. Run "npm run music" to add it.');
  input = silent;
}
if (!fs.existsSync(input)) {
  console.error(`Not found: ${input}`);
  process.exit(1);
}
const output = path.resolve(root, opt("out", cfg.export?.out || "export/video.mp4"));
const crf = String(opt("crf", cfg.export?.crf ?? 20));
fs.mkdirSync(path.dirname(output), { recursive: true });

execFileSync(
  "ffmpeg",
  ["-v", "error", "-y", "-i", input, "-c:v", "libx264", "-preset", "slow", "-crf", crf, "-tune", "animation", "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-map_metadata", "-1", "-movflags", "+faststart", output],
  { stdio: "inherit" }
);
const mb = fs.statSync(output).size / 1e6;
console.log(`wrote ${path.relative(root, output)} (${mb.toFixed(1)} MB from ${path.relative(root, input)})`);
if (mb > 50) console.warn("warning: the export is over 50 MB. GitHub warns above 50 MB and blocks files over 100 MB. Try --crf 23.");

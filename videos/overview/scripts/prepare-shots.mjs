#!/usr/bin/env node
// Prepare video frames from the course capture screenshots.
//
//   node scripts/prepare-shots.mjs
//
// capture-window.sh adds a 2px #cccccc border to every screenshot for the
// course pages. A video card does not need it, so this script removes the
// border and scales each image back to 1920x1080 (a 0.2% change). Input is
// <name>.png or <name>.webp in meta.shotsDir. Output goes
// to assets/frames/<name>.webp. It uses ImageMagick when available, else ffmpeg.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "video.config.json"), "utf8"));
const src = path.join(root, cfg.meta.shotsDir);
const out = path.join(root, cfg.meta.framesDir || "assets/frames");
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(src)) {
  fs.mkdirSync(src, { recursive: true });
  console.log(`Created ${path.relative(root, src)}. Put 1920x1080 PNG or WebP captures there, then run "npm run build".`);
  process.exit(0);
}

const has = (cmd) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const tool = has("magick") ? "magick" : has("ffmpeg") ? "ffmpeg" : null;
if (!tool) {
  console.error("Install ImageMagick (magick) or ffmpeg, then run again.");
  process.exit(1);
}

const force = process.argv.includes("--force");
// meta.shotBorder: pixels to trim from each edge (the course captures had a 2px border; Playwright captures have none).
const border = cfg.meta.shotBorder ?? 2;
let made = 0;
// Prefer the PNG capture when it exists. The committed lossless WebP is the fallback.
const names = [...new Set(fs.readdirSync(src).filter((f) => /\.(png|webp)$/.test(f)).map((f) => f.replace(/\.(png|webp)$/, "")))].sort();
for (const name of names) {
  const png = path.join(src, `${name}.png`);
  const input = fs.existsSync(png) ? png : path.join(src, `${name}.webp`);
  const output = path.join(out, `${name}.webp`);
  if (!force && fs.existsSync(output) && fs.statSync(output).mtimeMs > fs.statSync(input).mtimeMs) continue;
  // A 16:9 capture becomes exactly 1920x1080. A taller capture (for a pan) keeps its aspect at 1920 wide.
  const [w, h] = tool === "magick"
    ? execFileSync("magick", ["identify", "-format", "%w %h", input]).toString().split(" ").map(Number)
    : execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", input]).toString().trim().split("x").map(Number);
  const wide = Math.abs(w / h - 16 / 9) < 0.02;
  if (tool === "magick") {
    execFileSync("magick", [input, "-shave", `${border}x${border}`, "-resize", wide ? "1920x1080!" : "1920x", "-strip", "-quality", "92", output]);
  } else {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `crop=iw-${border * 2}:ih-${border * 2}:${border}:${border},scale=${wide ? "1920:1080" : "1920:-2"}`, "-quality", "92", output]);
  }
  made++;
}
console.log(`frames ready in ${path.relative(root, out)} (${made} updated, tool: ${tool})`);

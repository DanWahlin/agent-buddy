#!/usr/bin/env node
// Render the device case as a transparent PNG, from the desktop app's own
// drawing code, so the video's device matches the Desktop Agent Companion.
//
//   node scripts/render-case.mjs
//
// It copies drawDevice() from desktop/apps/desktop/src/webview/main.ts, removes
// the TypeScript types, and draws it in headless Chrome at 4 px per unit.
// Output: assets/device/case.png (2240x2240) and assets/device/case.json (the
// screen's centre and radius as fractions of the image, for build.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const source = fs.readFileSync(path.join(repo, "desktop/apps/desktop/src/webview/main.ts"), "utf8");

const constant = (name) => {
  const match = new RegExp(`(?:const|let) ${name} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`main.ts has no ${name}.`);
  return match[1];
};
const start = source.indexOf("function drawDevice(");
if (start < 0) throw new Error("main.ts has no drawDevice().");
let depth = 0;
let end = source.indexOf("{", start);
for (let i = end; i < source.length; i++) {
  if (source[i] === "{") depth++;
  if (source[i] === "}" && --depth === 0) {
    end = i + 1;
    break;
  }
}
const drawDevice = source
  .slice(start, end)
  .replace(/: Array<\[number, number\]>/g, "")
  .replace(/\): (void|number)/g, ")")
  .replace(/(\w+): (number|CanvasRenderingContext2D)/g, "$1")
  .replace(/\)!\./g, ").");

const SCALE = 4;
const units = `2 * (${constant("CASE_RADIUS")} + ${constant("BUTTON_REACH")} + 4)`;
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c"></canvas>
<script>
const CASE_RADIUS = ${constant("CASE_RADIUS")};
const BUTTON_REACH = ${constant("BUTTON_REACH")};
const BUTTON_DEGREES = ${constant("BUTTON_DEGREES")};
const SOUNDS_BUTTON = ${constant("SOUNDS_BUTTON")};
const SOUNDS_LIGHT = ${constant("SOUNDS_LIGHT")};
const RIM_GAIN = ${constant("RIM_GAIN")};
const SCREEN = ${constant("SCREEN")};
const UNITS = ${units};
const soundsOn = () => false;
${drawDevice}
const size = UNITS * ${SCALE};
const canvas = document.getElementById("c");
canvas.width = size; canvas.height = size;
canvas.style.width = size + "px"; canvas.style.height = size + "px";
drawDevice(size, canvas.getContext("2d"));
document.title = JSON.stringify({ units: UNITS, screen: SCREEN });
</script></body></html>`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));
const page = path.join(work, "case.html");
fs.writeFileSync(page, html);
const units_ = eval(units.replace(/[A-Z_]+/g, (n) => constant(n)));
const size = units_ * SCALE;
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = path.join(root, "assets/device");
fs.mkdirSync(out, { recursive: true });
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--default-background-color=00000000", `--window-size=${size},${size}`,
  `--screenshot=${path.join(out, "case.png")}`, `file://${page}`,
], { stdio: "ignore" });
fs.rmSync(work, { recursive: true, force: true });
const screen = Number(constant("SCREEN"));
fs.writeFileSync(path.join(out, "case.json"), `${JSON.stringify({ units: units_, screen, screenRadius: screen / 2 / units_ }, null, 2)}\n`);
console.log(`assets/device/case.png: ${size}x${size}, screen ${screen}/${units_} units`);

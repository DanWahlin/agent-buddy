#!/usr/bin/env node
// Write the agent badges as SVG, from the daemon's own 24x24 pixel-art masks,
// so the video's agent tiles and chips match the badges on the device.
//
//   node scripts/render-badges.mjs
//
// Needs the built daemon (cd daemon && npm run build).
// Output: assets/badges/<id>.svg (white pixels; CSS colours them) and
// assets/badges/badges.json (id, name, color, in the daemon's order).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const badgesPath = path.join(repo, "daemon/dist/src/agent-badges.js");
if (!fs.existsSync(badgesPath)) {
  console.error("error: daemon/dist is missing. Build the daemon: cd daemon && npm run build");
  process.exit(1);
}
const { loadAgentBadgeIcons } = await import(pathToFileURL(badgesPath));
const icons = await loadAgentBadgeIcons(path.join(root, ".no-custom-icons"));
const out = path.join(root, "assets/badges");
fs.mkdirSync(out, { recursive: true });

for (const icon of icons) {
  // One rect per horizontal run of lit pixels keeps the SVG small.
  const rects = [];
  for (let y = 0; y < 24; y++) {
    let run = -1;
    for (let x = 0; x <= 24; x++) {
      const on = x < 24 && (icon.mask[y * 3 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
      if (on && run < 0) run = x;
      if (!on && run >= 0) {
        rects.push(`<rect x="${run}" y="${y}" width="${x - run}" height="1"/>`);
        run = -1;
      }
    }
  }
  fs.writeFileSync(
    path.join(out, `${icon.id}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges" fill="#fff">${rects.join("")}</svg>\n`
  );
}
fs.writeFileSync(path.join(out, "badges.json"), `${JSON.stringify(icons.map(({ id, name, color }) => ({ id, name, color })), null, 2)}\n`);
console.log(`assets/badges: ${icons.map((i) => i.id).join(", ")}`);

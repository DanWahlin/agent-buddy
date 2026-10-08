#!/usr/bin/env node
// Build the Agent Buddy website into website/dist (or --out <folder>).
//
//   node website/scripts/build.mjs [--out <folder>] [--download]
//
// The page itself is static. The build adds what the live demo needs and the
// repository does not keep in website/:
//
// - engine/engine.js: the firmware's animation engine, compiled to
//   WebAssembly (desktop/engine/prebuilt/engine.js).
// - engine/<character>.acpk: the character packs. They come from
//   build/characters when you built them (python3 tools/character_pack.py
//   build), or from the latest release's -characters.zip with --download or
//   when build/characters is empty. The download needs the GitHub CLI (gh).
//
// Without the packs, the site still works: the live demo shows a recording.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(site, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(site, "dist");
const download = args.includes("--download");
const CHARACTERS = ["copilot", "claude", "openclaw"];
const SKIP = new Set(["dist", "scripts", "README.md"]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const entry of fs.readdirSync(site)) {
  if (SKIP.has(entry) || entry.startsWith(".")) continue;
  fs.cpSync(path.join(site, entry), path.join(out, entry), { recursive: true });
}

const engineDir = path.join(out, "engine");
fs.mkdirSync(engineDir, { recursive: true });
fs.copyFileSync(path.join(repo, "desktop/engine/prebuilt/engine.js"), path.join(engineDir, "engine.js"));

const local = path.join(repo, "build/characters");
const found = !download && CHARACTERS.every((id) => fs.existsSync(path.join(local, `${id}.acpk`)));
const packsFrom = found ? local : downloadPacks();
const packs = [];
for (const id of CHARACTERS) {
  const file = packsFrom && path.join(packsFrom, `${id}.acpk`);
  if (!file || !fs.existsSync(file)) {
    console.warn(`warning: ${id}.acpk is missing. The live demo will not offer ${id}.`);
    continue;
  }
  fs.copyFileSync(file, path.join(engineDir, `${id}.acpk`));
  packs.push({ id, bytes: fs.statSync(file).size });
}
if (packsFrom && packsFrom !== local) fs.rmSync(packsFrom, { recursive: true, force: true });
fs.writeFileSync(path.join(engineDir, "packs.json"), JSON.stringify({ packs }, null, 2) + "\n");
fs.writeFileSync(path.join(out, ".nojekyll"), "");

console.log(`Built ${path.relative(process.cwd(), out) || "."} with ${packs.length} character pack(s).`);

function downloadPacks() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-buddy-packs-"));
  try {
    execFileSync("gh", ["release", "download", "--repo", "DanWahlin/agent-buddy",
      "--pattern", "*-characters.zip", "--dir", temp], { stdio: "inherit" });
    const zip = fs.readdirSync(temp).find((name) => name.endsWith("-characters.zip"));
    if (!zip) throw new Error("The latest release has no -characters.zip asset.");
    execFileSync("unzip", ["-o", "-j", "-q", path.join(temp, zip), "*.acpk", "-d", temp], { stdio: "inherit" });
    return temp;
  } catch (error) {
    console.warn(`warning: Could not download the character packs: ${error.message}`);
    fs.rmSync(temp, { recursive: true, force: true });
    return null;
  }
}

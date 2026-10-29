#!/usr/bin/env node
// Build the Agent Buddy website into website/dist (or --out <folder>).
//
//   node website/scripts/build.mjs [--out <folder>] [--download] [--packs <folder>]
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
// - packs/: the character packs that the gallery (gallery.html) offers, from
//   website/packs/packs.json, or from the packs.json in --packs <folder>, such as
//   agent-buddy-packs/dist/preview. Each pack holds one or more characters. The
//   build checks every character's .acpk file, writes packs/index.json and each
//   character's image, and copies the .acpk files to engine/, where the live
//   preview and the Download buttons both use them. One copy keeps the site small.
//
// Without the packs, the site still works: the live demo shows a recording.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(site, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(site, "dist");
const download = args.includes("--download");
const packsIndex = args.indexOf("--packs");
const addOnSource = packsIndex >= 0 ? path.resolve(args[packsIndex + 1]) : path.join(site, "packs");
const CHARACTERS = ["copilot", "claude", "grok", "openclaw"];
const SKIP = new Set(["dist", "scripts", "README.md", "packs"]);
// The pack format (tools/character_pack.py) and Agent Buddy's limits (daemon/src/character-pack.ts).
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,15}$/;
const HEADER_BYTES = 256;
const SHA_OFFSET = 160;
const MAX_PACK_BYTES = 16 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Larger blink patches than Copilot's need firmware with adaptive patch RAM (legacyMaxPatchPixels).
const LEGACY_MAX_PATCH_PIXELS = 7452;
const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Every pack is checked before anything is written, so a bad file never reaches the site.
const addOns = readAddOns(addOnSource);
const addOnCharacters = addOns.flatMap((pack) => pack.characters);

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

const addOnDir = path.join(out, "packs");
fs.mkdirSync(addOnDir, { recursive: true });
for (const character of addOnCharacters) {
  fs.copyFileSync(character.path, path.join(engineDir, `${character.id}.acpk`));
  if (character.poster) fs.copyFileSync(character.poster, path.join(addOnDir, `${character.id}.webp`));
  else if (character.thumbnail) fs.writeFileSync(path.join(addOnDir, `${character.id}.png`), character.thumbnail);
  packs.push({ id: character.id, bytes: character.bytes });
}
fs.writeFileSync(path.join(addOnDir, "index.json"), JSON.stringify({
  packs: addOns.map(({ id, name, description, note, preview, characters }) => ({
    id, name, description, note, preview,
    characters: characters.map((character) => ({
      id: character.id, name: character.name, kind: character.kind, description: character.description,
      bytes: character.bytes, sha256: character.sha256, file: `engine/${character.id}.acpk`,
      image: character.poster ? `packs/${character.id}.webp` : character.thumbnail ? `packs/${character.id}.png` : null,
      newerFirmware: character.newerFirmware,
    })),
  })),
}, null, 2) + "\n");

fs.writeFileSync(path.join(engineDir, "packs.json"), JSON.stringify({ packs }, null, 2) + "\n");
fs.writeFileSync(path.join(out, ".nojekyll"), "");

console.log(`Built ${path.relative(process.cwd(), out) || "."} with ${packs.length} character pack(s), `
  + `${addOnCharacters.length} of them in ${addOns.length} gallery pack(s).`);

// The gallery's packs, in the order of packs.json:
//
//   { "packs": [{ "id": "animal-pack", "name": "Animal Pack", "description": "...",
//                 "note": "...", "preview": true,
//                 "characters": [{ "id": "dog", "name": "Biscuit", "kind": "puppy",
//                                  "description": "..." }] }] }
//
// "note", "preview" (free previews of paid characters), and each character's "name"
// (instead of the name in its pack) and "kind" are optional. Each character is
// <folder>/<id>.acpk, and can have a poster, <folder>/<id>.webp: a square still of
// the character, like assets/media/<id>.webp. Without a poster, the card shows the
// small thumbnail inside the character's pack.
function readAddOns(folder) {
  const list = path.join(folder, "packs.json");
  if (!fs.existsSync(list)) {
    if (packsIndex >= 0) throw new Error(`${list} is missing.`);
    return [];
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(list, "utf8")).packs;
  } catch (error) {
    throw new Error(`${list}: ${error.message}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${list}: "packs" must be a list.`);
  const text = (value) => typeof value === "string" && value.trim() !== "";
  const groups = new Set();
  const seen = new Set();
  return entries.map((entry) => {
    const { id, name, description, note, preview, characters } = entry ?? {};
    if (typeof id !== "string" || !GROUP_ID.test(id)) throw new Error(`${list}: "${id}" is not a valid pack id.`);
    if (groups.has(id)) throw new Error(`${list}: the pack "${id}" is in the list twice.`);
    groups.add(id);
    if (!text(name) || !text(description)) throw new Error(`${list}: the pack "${id}" needs a name and a description.`);
    if (note !== undefined && !text(note)) throw new Error(`${list}: the note of the pack "${id}" must be text.`);
    if (preview !== undefined && typeof preview !== "boolean") throw new Error(`${list}: "preview" of the pack "${id}" must be true or false.`);
    if (!Array.isArray(characters) || !characters.length) throw new Error(`${list}: the pack "${id}" needs characters.`);
    return {
      id, name: name.trim(), description: description.trim(), note: note?.trim() ?? null, preview: preview === true,
      characters: characters.map((character) => readAddOnCharacter(folder, list, seen, character)),
    };
  });
}

function readAddOnCharacter(folder, list, seen, entry) {
  const { id, name, kind, description } = entry ?? {};
  if (typeof id !== "string" || !PACK_ID.test(id)) throw new Error(`${list}: "${id}" is not a valid character id.`);
  // Agent Buddy refuses an added pack with a built-in's id.
  if (CHARACTERS.includes(id)) throw new Error(`${list}: "${id}" is a built-in character.`);
  if (seen.has(id)) throw new Error(`${list}: "${id}" is in the list twice.`);
  seen.add(id);
  if (typeof description !== "string" || !description.trim()) throw new Error(`${list}: "${id}" needs a description.`);
  for (const [field, value] of [["name", name], ["kind", kind]]) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${list}: the ${field} of "${id}" must be text.`);
    }
  }
  const file = path.join(folder, `${id}.acpk`);
  const pack = readPack(file);
  if (pack.id !== id) throw new Error(`${file} holds the character "${pack.id}", not "${id}".`);
  const poster = path.join(folder, `${id}.webp`);
  if (fs.existsSync(poster)) {
    const head = fs.readFileSync(poster).subarray(0, 12);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WEBP") {
      throw new Error(`${poster} is not a WebP image.`);
    }
  }
  return {
    ...pack, name: name?.trim() ?? pack.name, kind: kind?.trim() ?? null, description: description.trim(),
    path: file, poster: fs.existsSync(poster) ? poster : null,
  };
}

// Checks a pack as Agent Buddy checks one that you add (daemon/src/character-pack.ts),
// and its SHA-256 as tools/character_pack.py does. Format version 1: see that tool.
function readPack(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing.`);
  const data = fs.readFileSync(file);
  const fail = (reason) => new Error(`${file}: ${reason}`);
  if (data.length < HEADER_BYTES || data.toString("ascii", 0, 4) !== "ACPK"
      || data.readUInt16LE(4) !== 1 || data.readUInt16LE(6) !== HEADER_BYTES) {
    throw fail("it is not a version 1 character pack (.acpk).");
  }
  if (data.readUInt32LE(8) !== data.length) throw fail("its size does not match its header.");
  if (data.length > MAX_PACK_BYTES) throw fail("it is larger than 16 MB, the largest pack that Agent Buddy accepts.");
  const zeroed = Buffer.from(data);
  zeroed.fill(0, SHA_OFFSET, SHA_OFFSET + 32);
  if (!createHash("sha256").update(zeroed).digest().equals(data.subarray(SHA_OFFSET, SHA_OFFSET + 32))) {
    throw fail("its SHA-256 does not match its contents.");
  }
  const text = (offset, length) => {
    const raw = data.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return raw.toString("ascii", 0, end < 0 ? length : end);
  };
  const id = text(16, 16);
  const name = text(32, 24);
  if (!PACK_ID.test(id) || !name) throw fail("its id or name is not valid.");
  const dataOffset = data.readUInt32LE(140);
  const thumbnailOffset = data.readUInt32LE(148);
  const thumbnailBytes = data.readUInt32LE(152);
  const thumbnail = thumbnailBytes > 0 && thumbnailOffset >= HEADER_BYTES
    && thumbnailOffset + thumbnailBytes <= dataOffset && dataOffset <= data.length
    ? data.subarray(thumbnailOffset, thumbnailOffset + thumbnailBytes) : null;
  return {
    id, name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"),
    thumbnail: thumbnail && thumbnail.subarray(0, PNG.length).equals(PNG) ? thumbnail : null,
    // Layout 1 is base and patch; its largest blink patch is at offset 68.
    newerFirmware: data.readUInt8(12) === 1 && data.readUInt32LE(68) > LEGACY_MAX_PATCH_PIXELS,
  };
}

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

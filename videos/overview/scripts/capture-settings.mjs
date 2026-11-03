#!/usr/bin/env node
// Capture the Settings page (dark theme) for the video, with demo data.
//
//   node scripts/capture-settings.mjs [shot-name ...]
//
// Give shot names to capture only those shots.
//
// Needs the companion service running (the desktop app or npm run setup) and
// Playwright with Google Chrome (npm i -g playwright). It opens the page at
// 1440x810 CSS pixels and saves 1920x1080 PNGs to assets/shots/.
//
// The page draws live status. Before it does, this script rewrites the data:
// home folder paths become "~", the Wi-Fi network gets a demo name, usage shows
// demo numbers, and the agents get demo states and versions, so no personal data
// reaches a screenshot. Look at every capture before you commit it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
}

const dataDir = process.platform === "darwin"
  ? path.join(os.homedir(), "Library/Application Support/ESP32 Agent Companion")
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "ESP32 Agent Companion")
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "esp32-agent-companion");
const { url } = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));

const on = { detected: true, installed: true, enabled: true, hookStatus: "installed", activeSessions: 0, driving: false,
  action: null, hint: null, warning: null };
const DEMO = {
  home: os.homedir(),
  user: os.userInfo().username,
  ssid: "home-wifi",
  usage: { aic: "AIC: 1,248", tokens: "Tokens: 2.4M" },
  // The Agents tab: Copilot (running), Claude, Codex, and Grok are on, Hermes waits for approval,
  // and OpenClaw is not on this computer. The versions are examples.
  agents: {
    copilot: { ...on, version: "CLI 1.0.103 · app 1.1.32", activeSessions: 1, driving: true },
    claude: { ...on, version: "CLI 2.1.296 · Claude app 2.31226.0" },
    codex: { ...on, version: "CLI 0.162.1 · ChatGPT app 26.715.72359" },
    grok: { ...on, version: "grok 1.0.41 (4220f3b224a6) [stable]",
      hint: "Grok also runs Claude’s hooks, and reports the Agent Buddy Claude hook as failed. This does not change "
        + "the display. To stop it, add [compat.claude] hooks = false to ~/.grok/config.toml. Grok then skips all of "
        + "your Claude hooks." },
    hermes: { ...on, hookStatus: "needs-approval", version: "Hermes Agent v0.21.6 (2026.9.24)",
      action: { kind: "approve", title: "Approve the hooks in Hermes", steps: [] } },
    openclaw: { ...on, detected: false, installed: false, enabled: false, hookStatus: "missing", version: null,
      hint: "Install the native plugin. Gateway WebSocket approvals aren’t used yet." },
  },
};

// Runs in the page before its own scripts: sanitizes every status and API reply.
function sanitizer(demo) {
  const clean = (value) => {
    if (typeof value === "string") {
      let s = value.split(demo.home).join("~");
      s = s.replace(new RegExp(`\\b${demo.user}\\b`, "g"), "you");
      return s;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = clean(v);
      if (out.network && typeof out.network === "object" && out.network.ssid) out.network = { ...out.network, ssid: demo.ssid };
      if (out.usage && typeof out.usage === "object") {
        out.usage = { ...out.usage, summary: [demo.usage.aic, demo.usage.tokens], lines: [demo.usage.aic] };
        if ("aic" in out.usage) out.usage.aic = 1248;
        if ("tokens" in out.usage) out.usage.tokens = 2400000;
      }
      if (Array.isArray(out.agents)) {
        out.agents = out.agents.map((agent) => (demo.agents[agent.id] ? { ...agent, ...demo.agents[agent.id] } : agent));
      }
      return out;
    }
    return value;
  };
  const NativeES = window.EventSource;
  window.EventSource = class extends NativeES {
    addEventListener(type, listener, options) {
      if (type !== "status") return super.addEventListener(type, listener, options);
      return super.addEventListener(type, (event) => listener({ data: JSON.stringify(clean(JSON.parse(event.data))) }), options);
    }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (!(response.headers.get("content-type") || "").includes("json")) return response;
    const body = clean(await response.json());
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  localStorage.setItem("companion-theme", "dark");
}

// "scroll": put the tabs at the top, so the tab's content fills the frame.
// "full": capture from the tabs to the end of the page (taller than 16:9, for a pan).
const allShots = [
  { name: "settings-status", tab: "tab-characters", scroll: false },
  { name: "settings-characters", tab: "tab-characters", scroll: true },
  { name: "settings-agents", tab: "tab-agents", scroll: true },
  { name: "settings-desktop", tab: "tab-desktop", scroll: true },
  { name: "settings-device", tab: "tab-wifi", scroll: true },
  { name: "settings-agents-full", tab: "tab-agents", scroll: true, full: true },
];
const only = process.argv.slice(2);
const shots = only.length ? allShots.filter((s) => only.includes(s.name)) : allShots;
if (only.length && shots.length !== only.length) {
  console.error(`Unknown shot name. Use: ${allShots.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

const out = path.join(root, "assets/shots");
fs.mkdirSync(out, { recursive: true });
const browser = await playwright.chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark" });
await page.addInitScript(sanitizer, DEMO);
await page.goto(url);
// The setup notice lists steps this computer still needs; a finished install has none.
// The page's CSP blocks injected styles, so hide it from script; renders may unhide it.
await page.evaluate(() => {
  const setup = document.getElementById("setup");
  if (!setup) return;
  const hide = () => setup.style.setProperty("display", "none", "important");
  hide();
  new MutationObserver(hide).observe(setup, { attributes: true });
});
await page.waitForFunction(() => !/Waiting|Connecting/.test(document.getElementById("summary")?.textContent || ""), null, { timeout: 15000 });
for (const shot of shots) {
  await page.click(`#${shot.tab}`);
  await page.mouse.move(0, 0);
  // The character list loads after the page, so wait for its cards and thumbnails before framing the shot.
  if (shot.tab === "tab-characters") {
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll("#characters .character img")];
      return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
    }, null, { timeout: 15000 });
  }
  await page.evaluate((scroll) => {
    const tabs = document.querySelector(".tabs");
    window.scrollTo(0, scroll && tabs ? tabs.getBoundingClientRect().top + window.scrollY - 28 : 0);
  }, shot.scroll);
  await page.waitForTimeout(900);
  const file = path.join(out, `${shot.name}.png`);
  if (shot.full) {
    const top = await page.evaluate(() => document.querySelector(".tabs").getBoundingClientRect().top + window.scrollY - 28);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: top, width: 1440, height: height - top } });
  } else await page.screenshot({ path: file });
  console.log(path.relative(root, file));
}
await browser.close();

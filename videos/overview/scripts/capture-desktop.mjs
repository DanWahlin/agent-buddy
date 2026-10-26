#!/usr/bin/env node
// Record the Desktop Agent Companion over a neutral backdrop, with demo events.
//
//   node scripts/capture-desktop.mjs [--display "Built-in Retina Display"] [--seconds 18]
//
// Quit the desktop app first. This script:
//   1. Runs a private demo companion service (its own data folder, socket, and
//      settings port, Wi-Fi mode with no pairing, so it never takes the USB device
//      from your real service). Only the events below reach it.
//   2. Covers the chosen display with scripts/backdrop.html (Chrome app window, temp profile).
//   3. Opens the installed app against the demo service, on that display.
//   4. Records the display (no cursor), keeps a 720x405-point area around the companion, and sends
//      Working, Needs attention, and Complete events on a schedule.
//   5. Closes everything, puts the app's saved window position back, and writes
//      assets/clips/desktop-app.mp4 (1920x1080, 30 fps, no audio).
// Then open the app again. Check every frame of the clip for private data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DISPLAY = arg("display", "Built-in Retina Display");
const SECONDS = Number(arg("seconds", 18));
const APP = "/Applications/Agent Companion.app/Contents/MacOS/agent-companion-desktop";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CLI = path.join(repo, "daemon/dist/src/cli.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "darwin") throw new Error("This capture script is for macOS.");
for (const f of [APP, CHROME, CLI]) if (!fs.existsSync(f)) throw new Error(`${f} is missing.`);
try {
  execFileSync("pgrep", ["-f", "agent-companion-desktop"], { stdio: "ignore" });
  throw new Error("The desktop app is running. Quit it first (tray > Quit Agent Companion), then run this again.");
} catch (error) {
  if (error.message.startsWith("The desktop app")) throw error;
}

// Screens in top-left global points (Cocoa reports bottom-left origins).
function screens() {
  const js = `ObjC.import("AppKit"); const s=$.NSScreen.screens; const r=[]; for (let i=0;i<s.count;i++){const c=s.objectAtIndex(i); const f=c.frame; r.push({name: ObjC.unwrap(c.localizedName), x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height, scale: c.backingScaleFactor});} JSON.stringify(r)`;
  const list = JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", js]).toString());
  const mainH = list[0].h;
  return list.map((s) => ({ ...s, top: mainH - (s.y + s.h) }));
}
function windows() {
  const js = `ObjC.import("CoreGraphics"); const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID))); JSON.stringify(l.map(w => ({ owner: w.kCGWindowOwnerName || "", pid: w.kCGWindowOwnerPID, ...w.kCGWindowBounds })))`;
  return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", js]).toString());
}

const all = screens();
const screen = all.find((s) => s.name === DISPLAY);
// screencapture numbers displays in the same order as NSScreen, from 1.
const displayNumber = all.indexOf(screen) + 1;
if (!screen) throw new Error(`No display named "${DISPLAY}". Displays: ${screens().map((s) => s.name).join(", ")}`);

// 1. Demo service with its own data.
const demo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-demo-"));
const home = path.join(demo, "home");
fs.mkdirSync(home, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(demo, name), `${JSON.stringify(value, null, 2)}\n`);
write("connection.json", { mode: "wifi" });
write("display.json", { showAgentBadges: true, showDesktopCompanion: true, desktopBackdrop: "device", desktopSounds: false, desktopVolume: 30, showUsage: false, usageWindow: "today" });
const socket = path.join(demo, "daemon.sock");
const env = {
  ...process.env,
  HOME: home,
  AGENT_COMPANION_SOCKET: socket,
  AGENT_COMPANION_SETTINGS_PORT: "4691",
  AGENT_COMPANION_STATE: path.join(demo, "state.json"),
  AGENT_COMPANION_WIFI_CONFIG: path.join(demo, "wifi.json"),
  AGENT_COMPANION_CONNECTION_CONFIG: path.join(demo, "connection.json"),
  AGENT_COMPANION_USER_CHARACTERS: path.join(demo, "characters"),
  AGENT_COMPANION_SETTINGS_INFO: path.join(demo, "settings.json"),
  AGENT_COMPANION_AGENTS_CONFIG: path.join(demo, "agents.json"),
  AGENT_COMPANION_CHARACTER_CONFIG: path.join(demo, "character.json"),
  AGENT_COMPANION_DISPLAY_CONFIG: path.join(demo, "display.json"),
  AGENT_COMPANION_DESKTOP_APP: path.join(demo, "desktop-app.json"),
  AGENT_COMPANION_USAGE_CACHE: path.join(demo, "usage-cache.json"),
  AGENT_COMPANION_DEVICE_HISTORY: path.join(demo, "device.json"),
  AGENT_COMPANION_SERVICE_STOPPED: path.join(demo, "service-stopped"),
};
const children = [];
const start = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: "ignore", ...opts });
  children.push(child);
  return child;
};
const hook = (agent, event, payload) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "hook", agent, event], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify(payload));
    child.on("close", resolve);
  });

// The app keeps its own window position; put it on the chosen display for now.
const placement = path.join(os.homedir(), "Library/Application Support/dev.agentcompanion.desktop/placement.json");
const savedPlacement = fs.existsSync(placement) ? fs.readFileSync(placement) : null;
const restore = () => {
  for (const child of children.reverse()) {
    try {
      process.kill(child.pid);
    } catch {
      // Already gone.
    }
  }
  // Chrome's helpers outlive their parent for a moment; stop any left in the demo profile.
  try {
    for (const pid of execFileSync("pgrep", ["-f", demo]).toString().trim().split("\n")) process.kill(Number(pid));
  } catch {
    // None left.
  }
  if (savedPlacement) fs.writeFileSync(placement, savedPlacement);
  fs.rmSync(demo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
};
process.on("SIGINT", () => {
  restore();
  process.exit(1);
});

try {
  start(process.execPath, [CLI, "daemon"], { env });
  for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await sleep(200);
  if (!fs.existsSync(socket)) throw new Error("The demo service did not start.");

  // 2. Backdrop: an app window that fills the display. Not full screen: a
  // full-screen Space hides the companion, and the recording skips the edges.
  start(CHROME, [
    `--user-data-dir=${path.join(demo, "chrome")}`, "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
    `--window-position=${Math.round(screen.x)},${Math.round(screen.top)}`, `--window-size=${Math.round(screen.w)},${Math.round(screen.h)}`,
    `--app=file://${path.join(root, "scripts/backdrop.html")}`,
  ]);
  await sleep(4000);

  // 3. The app, a little right of the display's centre. Its saved position is
  // in physical pixels, but the app converts it with the scale of the screen it
  // starts on, so try 1x, then the display's scale, until the window lands there.
  fs.mkdirSync(path.dirname(placement), { recursive: true });
  const SIZE = 280;
  const wantX = screen.x + screen.w * 0.5 + 60 - SIZE / 2;
  const wantY = screen.top + screen.h * 0.52 - SIZE / 2;
  let app = null;
  let bounds = null;
  for (const factor of [1, screen.scale]) {
    fs.writeFileSync(placement, JSON.stringify({ x: Math.round(wantX * factor), y: Math.round(wantY * factor) }));
    app = start(APP, [], { env: { ...process.env, AGENT_COMPANION_SOCKET: socket } });
    bounds = null;
    for (let i = 0; i < 40 && !bounds; i++) {
      await sleep(250);
      bounds = windows().find((w) => w.pid === app.pid && w.Width >= 200);
    }
    await sleep(2500);
    bounds = windows().find((w) => w.pid === app.pid && w.Width >= 200) || bounds;
    if (bounds && Math.abs(bounds.X - wantX) < 60 && Math.abs(bounds.Y - wantY) < 60) break;
    console.log(`The window opened at ${bounds?.X},${bounds?.Y} with a ${factor}x position; trying again.`);
    process.kill(app.pid);
    await sleep(1500);
    bounds = null;
  }
  if (!bounds) throw new Error(`The companion window did not open on ${DISPLAY}.`);

  // 4. Record around the companion, a little right of centre, with part of a
  // blurred backdrop window on the left.
  const W = 720;
  const H = 405;
  const cx = bounds.X + bounds.Width / 2 - 90;
  const cy = bounds.Y + bounds.Height / 2;
  const rx = Math.round(Math.min(Math.max(cx - W / 2, screen.x), screen.x + screen.w - W));
  const ry = Math.round(Math.min(Math.max(cy - H / 2, screen.top + 40), screen.top + screen.h - H));
  const mov = path.join(demo, "desktop.mov");
  // Record the whole display and crop afterwards: -R is offset on displays other than the main one.
  const recorder = spawn("screencapture", ["-v", "-V", String(SECONDS), "-D", String(displayNumber), mov], { stdio: "ignore" });
  const t0 = Date.now();
  const at = async (seconds, fn) => {
    await sleep(Math.max(0, t0 + seconds * 1000 - Date.now()));
    await fn();
  };
  await at(2.0, () => hook("copilot", "preToolUse", { sessionId: "demo-copilot", toolName: "bash" }));
  await at(6.5, () => hook("claude", "Notification", { session_id: "demo-claude", notification_type: "permission_prompt" }));
  await at(10.5, () => hook("claude", "PostToolUse", { session_id: "demo-claude", tool_name: "Bash" }));
  await at(11.0, () => Promise.all([
    hook("copilot", "agentStop", { sessionId: "demo-copilot" }),
    hook("claude", "Stop", { session_id: "demo-claude" }),
  ]));
  await new Promise((resolve) => recorder.on("close", resolve));

  // 5. A 1920x1080 clip for the video.
  const out = path.join(root, "assets/clips/desktop-app.mp4");
  const k = screen.scale;
  const crop = `crop=${Math.round(W * k)}:${Math.round(H * k)}:${Math.round((rx - screen.x) * k)}:${Math.round((ry - screen.top) * k)}`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mov, "-vf", `${crop},scale=1920:1080:flags=lanczos,fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-an", "-map_metadata", "-1", "-movflags", "+faststart", out]);
  console.log(`${path.relative(root, out)}: ${SECONDS}s from ${rx},${ry} ${W}x${H} on ${DISPLAY}`);
  console.log("Events: Working at 2 s, Needs attention at 6.5 s, Complete at 11 s.");
} finally {
  restore();
}

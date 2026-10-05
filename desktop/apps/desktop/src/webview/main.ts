/**
 * The page inside the window: the device's own engine, drawn on the desktop.
 *
 * Every pixel of the character and its effects comes from the firmware's code,
 * compiled to WebAssembly (`desktop/engine`), fed the same `.acpk` pack and the
 * same badge packets the device gets. This page only does what the device's
 * screen does around it: steps the engine each frame, shows the result, and
 * passes on what the agent is doing. Around the screen it draws the device
 * itself, case and buttons, unless Settings asks for the character on its own.
 * It plays the device's sound cues too, when sounds are on.
 */

// Emscripten's loader, CommonJS, bundled by esbuild.
import createEngine from '../../../../engine/prebuilt/engine.js';
import { createPresenter, type Presenter } from './present.js';
import { cueForMode, play, setVolume, unlock } from './sounds.js';

interface TauriApi {
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
  event: { listen(name: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}
declare global {
  interface Window { __TAURI__: TauriApi }
}

interface Engine {
  HEAPU8: Uint8Array;
  _free(pointer: number): void;
  UTF8ToString(pointer: number): string;
  stringToNewUTF8(text: string): number;
  _ac_reserve(bytes: number): number;
  _ac_load_reserved(seed: number): number;
  _ac_changed(): number;
  _ac_dirty_count(): number;
  _ac_dirty_rects(): number;
  _ac_error(): number;
  _ac_width(): number;
  _ac_height(): number;
  _ac_display(): number;
  _ac_frame_x(): number;
  _ac_mode(mode: number, touch: number): number;
  _ac_badge_icon(packet: number): number;
  _ac_badge_active(packet: number): number;
  _ac_usage(packet: number): number;
  _ac_frame(seconds: number, key: number): number;
  _ac_shown_mode(): number;
}

interface DaemonSnapshot {
  state: string;
  installing?: { name: string; percent: number } | null;
  connected?: boolean;
  lastInstall?: { ok: boolean; name?: string; error?: string } | null;
  backdrop: string;
  badges: Array<{ id: string; role: 'working' | 'attention' | 'complete' }>;
  icons: Array<{ id: string; color: string; mask: string }>;
  /** "AIC: 902", "Tokens: 1.2M"; an older app or daemon may send none. */
  usage?: string[];
  /** Whether to play the device's sound cues; off when missing. */
  sounds?: boolean;
  /** How loud the cues play, 0 to 100; 30 when missing. */
  volume?: number;
}

type HostMessage =
  | { type: 'state'; state: string }
  | { type: 'daemon'; daemon: DaemonSnapshot | null }
  | { type: 'showing'; showing: boolean }
  | { type: 'error'; message: string };

/** The device's CharacterMode values. */
const MODES: Record<string, number> = { idle: 0, surprise: 1, working: 2, complete: 3, attention: 4 };
const ROLE_LETTER = { working: 'w', attention: 'a', complete: 'c' } as const;

/**
 * The window shows a small copy of the device: its round 466 px screen inside
 * a matte black case, with the two buttons on its right edge. Everything is
 * laid out in device pixels; the case and buttons need this much room.
 */
// The device's display size, kDisplaySize; replaced by the engine's own value
// as soon as it loads, so the two cannot disagree.
let SCREEN = 466;
const CASE_RADIUS = 269;
const BUTTON_REACH = 7;
/**
 * Where the buttons sit on the case's edge, in degrees below the right-hand
 * side. The upper one opens Settings; the lower one mutes and unmutes sounds.
 */
const BUTTON_DEGREES = [-24, 24];
const SETTINGS_BUTTON = 0;
const SOUNDS_BUTTON = 1;
/** The small light on the lower button while sounds are on: the install bar's blue. */
const SOUNDS_LIGHT = '#5AA1CD';
const UNITS = 2 * (CASE_RADIUS + BUTTON_REACH + 4);
/** How strongly the case's rim catches the light. */
const RIM_GAIN = 1.8;

const tauri = window.__TAURI__;
const device = document.getElementById('device') as HTMLDivElement;
const caseCanvas = document.getElementById('case') as HTMLCanvasElement;
const caseContext = caseCanvas.getContext('2d')!;
const stage = document.getElementById('stage') as HTMLCanvasElement;
const installCanvas = document.getElementById('install') as HTMLCanvasElement;
const installContext = installCanvas.getContext('2d')!;
const message = document.getElementById('message') as HTMLParagraphElement;
let presenter: Presenter | null = null;
// The last frame shown, kept for the tray icon.
let lastFrame: Uint8Array | null = null;

let engine: Engine | null = null;
let backdrop = 'device';
let wantedMode = 0;
let iconsKey = '';
let activeKey = '';
let usageKey: string | null = null;
let loaded = false;
// Sounds, as the daemon has them, and a click's change until the daemon agrees.
let soundsSetting = false;
let soundsClicked: { on: boolean; until: number } | null = null;
// The volume the daemon gave last; null until the first snapshot.
let volumeSetting: number | null = null;
// The mode the engine showed last: a cue plays when it changes, as on the device.
// -1 after a pack loads, so the first mode shown plays nothing.
let shownMode = -1;
const SOUNDS_CLICK_MS = 3000;
let pendingDaemon: DaemonSnapshot | null = null;
let last = performance.now();

function say(text: string): void {
  message.textContent = text;
  message.classList.add('visible');
  device.classList.add('hidden');
}

function call(name: keyof Engine, text: string): number {
  const e = engine!;
  const pointer = e.stringToNewUTF8(text);
  try {
    return (e[name] as (pointer: number) => number)(pointer);
  } finally {
    e._free(pointer);
  }
}

/** Load a pack and keep the agent's mode and badges, as a device keeps them across an install. */
async function loadPack(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the character (' + response.status + ').');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const e = engine!;
  // Straight into the engine's own buffer, which it keeps as the pack. Reserve
  // first: reserving can grow the memory, which detaches any earlier HEAPU8.
  const at = e._ac_reserve(bytes.length);
  e.HEAPU8.set(bytes, at);
  // The last frame is the old character's, and its view may be detached.
  lastFrame = null;
  const ok = e._ac_load_reserved((Math.random() * 0xffffffff) >>> 0);
  if (!ok) throw new Error(e.UTF8ToString(e._ac_error()) || 'The character pack is invalid.');
  iconsKey = '';
  activeKey = '';
  usageKey = null;
  shownMode = -1;
  loaded = true;
  if (wantedMode !== 0) e._ac_mode(wantedMode, 0);
  applyBadges(pendingDaemon);
  applyUsage(pendingDaemon);
  message.classList.remove('visible');
  device.classList.remove('hidden');
  dirty = true;
  resize();
  sendTrayIcon();
}

/** The usage lines, as the device's '$' packet carries them: joined by '|'. */
function applyUsage(daemon: DaemonSnapshot | null): void {
  if (!engine || !loaded) return;
  const packet = (daemon?.usage ?? []).join('|');
  if (packet === usageKey) return;
  call('_ac_usage', packet);
  usageKey = packet;
  dirty = true;
}

function setState(state: string): void {
  const mode = MODES[state];
  if (mode === undefined) return;
  wantedMode = mode;
  if (engine && loaded) engine._ac_mode(mode, 0);
}

/** The device gets badges as two packets; so does the engine, built the same way. */
function applyBadges(daemon: DaemonSnapshot | null): void {
  if (!engine || !loaded) return;
  const icons = daemon?.icons ?? [];
  const key = JSON.stringify(icons);
  if (key !== iconsKey) {
    for (const icon of icons) call('_ac_badge_icon', `${icon.id}:${icon.color.replace('#', '')}:${icon.mask}`);
    iconsKey = key;
  }
  const active = (daemon?.badges ?? []).map(badge => `${badge.id}=${ROLE_LETTER[badge.role]}`).join(',');
  if (active !== activeKey) {
    call('_ac_badge_active', active);
    activeKey = active;
  }
}

function receive(incoming: HostMessage): void {
  switch (incoming.type) {
    case 'state':
      setState(incoming.state);
      break;
    case 'daemon':
      pendingDaemon = incoming.daemon;
      if (incoming.daemon && incoming.daemon.backdrop !== backdrop) {
        backdrop = incoming.daemon.backdrop;
        drawCase();
        drawInstall();
        dirty = true;
        reportRegion();
      }
      applyBadges(incoming.daemon);
      applyUsage(incoming.daemon);
      followInstall(incoming.daemon);
      followSounds(incoming.daemon);
      break;
    case 'showing':
      // Hidden from Settings or from the character's menu: stop entirely.
      setShowing(incoming.showing);
      break;
    case 'error':
      say(incoming.message);
      break;
  }
}

// --- sounds --------------------------------------------------------------------

function soundsOn(): boolean {
  if (soundsClicked && performance.now() < soundsClicked.until) return soundsClicked.on;
  return soundsSetting;
}

/** Sounds are off unless the daemon says on: they start muted. */
function followSounds(daemon: DaemonSnapshot | null): void {
  const before = soundsOn();
  soundsSetting = daemon?.sounds === true;
  if (soundsClicked && soundsClicked.on === soundsSetting) soundsClicked = null;
  if (soundsOn() !== before) drawCase();
  followVolume(daemon?.volume);
}

/**
 * Use the volume Settings has. When it changes while sounds are on, play the
 * tick so the user hears the new level.
 */
function followVolume(volume: number | undefined): void {
  const next = typeof volume === 'number' && volume >= 0 && volume <= 100 ? volume : 30;
  if (next === volumeSetting) return;
  const first = volumeSetting === null;
  volumeSetting = next;
  setVolume(next);
  if (!first && soundsOn()) void play('tick').catch(() => {});
}

/**
 * The lower button. The light changes at once; the daemon keeps the setting,
 * so Settings shows the same. Turning sounds on plays the device's tick, so
 * the click is heard, and lets the page play sounds at all.
 */
function toggleSounds(): void {
  const on = !soundsOn();
  soundsClicked = { on, until: performance.now() + SOUNDS_CLICK_MS };
  drawCase();
  if (on) void play('tick').catch(() => {});
  void (tauri.core.invoke('set_sounds', { on }) as Promise<boolean>).then(ok => {
    if (ok) return;
    soundsClicked = null;
    drawCase();
  }, () => {
    soundsClicked = null;
    drawCase();
  });
}

/** The device plays a cue each time the mode it shows changes; so does this. */
function followShownMode(mode: number): void {
  if (mode === shownMode) return;
  const first = shownMode === -1;
  shownMode = mode;
  const cue = cueForMode(mode);
  if (!first && cue && soundsOn()) void play(cue).catch(() => {});
}

// --- drawing -----------------------------------------------------------------

/**
 * The window is square and holds the device. The case is drawn once per size;
 * the frame canvas stays at the engine's own size (412x466), and CSS places and
 * scales it over the screen, so on a Retina display it is not scaled at all.
 */
function resize(): void {
  const size = Math.max(1, Math.min(document.body.clientWidth, document.body.clientHeight));
  const ratio = window.devicePixelRatio || 1;
  const unit = size / UNITS;
  device.style.width = size + 'px';
  device.style.height = size + 'px';
  caseCanvas.style.width = size + 'px';
  caseCanvas.style.height = size + 'px';
  caseCanvas.width = Math.round(size * ratio);
  caseCanvas.height = Math.round(size * ratio);
  installCanvas.style.width = size + 'px';
  installCanvas.style.height = size + 'px';
  installCanvas.width = caseCanvas.width;
  installCanvas.height = caseCanvas.height;
  drawCase();
  drawInstall();
  if (engine) {
    if (!presenter) {
      presenter = createPresenter(stage, engine._ac_width(), engine._ac_height());
      dirty = true;
    }
    const screen = (UNITS - SCREEN) / 2;
    stage.style.left = (screen + engine._ac_frame_x()) * unit + 'px';
    stage.style.top = screen * unit + 'px';
    stage.style.width = stage.width * unit + 'px';
    stage.style.height = stage.height * unit + 'px';
  }
  dirty = true;
  reportRegion();
}

function drawCase(): void {
  caseContext.clearRect(0, 0, caseCanvas.width, caseCanvas.height);
  if (backdrop === 'device') drawDevice(caseCanvas.width, caseContext);
}

/** The device: case, buttons, bezel lip and the black screen the frame is drawn on. */
function drawDevice(size: number, context: CanvasRenderingContext2D): void {
  const unit = size / UNITS;
  const centre = size / 2;
  const at = (value: number) => value * unit;

  // The two buttons on the right edge, behind the case so it overlaps them,
  // lit along their top like the rim.
  BUTTON_DEGREES.forEach((degrees, index) => {
    const angle = degrees * Math.PI / 180;
    context.save();
    context.translate(centre + at(CASE_RADIUS - 2) * Math.cos(angle), centre + at(CASE_RADIUS - 2) * Math.sin(angle));
    context.rotate(angle);
    const key = context.createLinearGradient(0, -at(17), 0, at(17));
    key.addColorStop(0, '#3a3c42');
    key.addColorStop(.35, '#1d1e22');
    key.addColorStop(1, '#0e0e10');
    context.beginPath();
    context.roundRect(0, -at(17), at(BUTTON_REACH + 2), at(34), at(3));
    context.fillStyle = key;
    context.fill();
    if (index === SOUNDS_BUTTON && soundsOn()) {
      context.beginPath();
      context.roundRect(at(3), -at(8), at(BUTTON_REACH - 1), at(16), at(2));
      context.fillStyle = SOUNDS_LIGHT;
      context.shadowColor = SOUNDS_LIGHT;
      context.shadowBlur = at(6);
      context.fill();
    }
    context.restore();
  });

  // The case: matte black, a touch lighter towards the top left.
  const shell = context.createLinearGradient(centre - at(CASE_RADIUS), centre - at(CASE_RADIUS),
    centre + at(CASE_RADIUS), centre + at(CASE_RADIUS));
  shell.addColorStop(0, '#2c2d32');
  shell.addColorStop(.45, '#151619');
  shell.addColorStop(1, '#0a0a0c');
  context.beginPath();
  context.arc(centre, centre, at(CASE_RADIUS), 0, Math.PI * 2);
  context.fillStyle = shell;
  context.fill();

  // Gloss: a broad soft reflection across the top left of the case, kept off
  // the screen by clipping to the ring between the case edge and the bezel.
  context.save();
  context.beginPath();
  context.arc(centre, centre, at(CASE_RADIUS), 0, Math.PI * 2);
  context.arc(centre, centre, at(SCREEN / 2 + 6), 0, Math.PI * 2, true);
  context.clip();
  const gloss = context.createLinearGradient(centre - at(CASE_RADIUS), centre - at(CASE_RADIUS),
    centre + at(CASE_RADIUS * .2), centre + at(CASE_RADIUS * .2));
  gloss.addColorStop(0, 'rgba(255, 255, 255, .28)');
  gloss.addColorStop(.35, 'rgba(255, 255, 255, .10)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gloss;
  context.fillRect(0, 0, size, size);
  context.restore();

  // Rim light: a sheen around the rounded edge, brightest where light from the
  // top left catches it, with a fainter bounce at the bottom right.
  ring(at(CASE_RADIUS - 8), at(14), [
    [0, .04], [.40, .06], [.52, .28], [.625, .50], [.72, .28], [.85, .06], [1, .04],
  ]);
  ring(at(CASE_RADIUS - 8), at(14), [[0, .22], [.07, .08], [.2, 0], [.8, 0], [.93, .08], [1, .22]], 45);
  // A crisp highlight on the very edge.
  ring(at(CASE_RADIUS - 1.2), at(2.2), [
    [0, .18], [.42, .2], [.56, .75], [.625, .95], [.69, .75], [.84, .2], [1, .18],
  ]);
  // The bevel down into the screen catches light on the opposite side.
  ring(at(SCREEN / 2 + 9), at(4), [
    [0, .40], [.08, .55], [.18, .40], [.36, .08], [.62, .03], [.88, .08], [1, .40],
  ]);

  // A ring of light whose brightness varies around it. `stops` run clockwise
  // from `startDegrees`, measured from 3 o'clock, so with a start of 0 stop .625
  // sits at the top left (225°). Computed per pixel, with soft edges: the case
  // is drawn once, and this has no seams and needs no conic gradient support.
  function ring(radius: number, width: number, stops: Array<[number, number]>, startDegrees = 0): void {
    const alphaAt = (position: number): number => {
      for (let i = 1; i < stops.length; i++) {
        const [to, high] = stops[i];
        const [from, low] = stops[i - 1];
        if (position <= to) return low + (high - low) * ((position - from) / Math.max(1e-6, to - from));
      }
      return stops[stops.length - 1][1];
    };
    const half = Math.max(.5, width / 2);
    const reach = Math.ceil(radius + half + 1);
    const left = Math.max(0, Math.floor(centre - reach));
    const span = Math.min(size, Math.ceil(centre + reach)) - left;
    const light = context.createImageData(span, span);
    const start = startDegrees * Math.PI / 180;
    for (let y = 0; y < span; y++) {
      for (let x = 0; x < span; x++) {
        const dx = left + x + .5 - centre;
        const dy = left + y + .5 - centre;
        // Coverage of this pixel by the band, softened over one pixel at each edge.
        const edge = half + .5 - Math.abs(Math.hypot(dx, dy) - radius);
        if (edge <= 0) continue;
        let position = (Math.atan2(dy, dx) - start) / (Math.PI * 2);
        position -= Math.floor(position);
        const alpha = Math.min(1, Math.min(1, edge) * alphaAt(position) * RIM_GAIN);
        const at = (y * span + x) * 4;
        light.data[at] = 255;
        light.data[at + 1] = 255;
        light.data[at + 2] = 255;
        light.data[at + 3] = Math.round(alpha * 255);
      }
    }
    const layer = document.createElement('canvas');
    layer.width = span;
    layer.height = span;
    layer.getContext('2d')!.putImageData(light, 0, 0);
    context.drawImage(layer, left, left);
  }

  // The bezel's inner lip, then the screen.
  context.beginPath();
  context.arc(centre, centre, at(SCREEN / 2 + 6), 0, Math.PI * 2);
  context.fillStyle = '#050506';
  context.fill();
  context.beginPath();
  context.arc(centre, centre, at(SCREEN / 2), 0, Math.PI * 2);
  context.fillStyle = '#000';
  context.fill();
}

/**
 * The device draws at 30 frames a second (kTargetFps), so this does too, on a
 * timer rather than at the display's refresh rate, which can be 120 Hz. Most
 * frames of an idle character are identical; those cost one engine step and
 * nothing else.
 */
const FRAME_MS = 1000 / 30;
let timer = 0;
let showing = true;
let dirty = true;

function schedule(): void {
  if (!timer && showing && !document.hidden) timer = window.setTimeout(tick, FRAME_MS);
}

function tick(): void {
  timer = 0;
  draw(performance.now());
  schedule();
}

/** Hidden in Settings, or by the system: stop entirely, and resume where it was. */
function setShowing(value: boolean): void {
  if (value === showing) return;
  showing = value;
  if (showing) {
    last = performance.now();
    // Whatever changed while hidden was not heard, and is not now.
    shownMode = -1;
    schedule();
  } else if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    timer = 0;
  } else {
    last = performance.now();
    schedule();
  }
});

function draw(now: number): void {
  const seconds = Math.min(.25, (now - last) / 1000);
  last = now;
  if (!engine || !loaded) return;

  const e = engine;
  const width = e._ac_width();
  const height = e._ac_height();
  // The device's own pixels on its own screen; anything else needs a cut-out.
  const pixels = e._ac_frame(seconds, backdrop === 'device' ? 0 : 1);
  if (!pixels) {
    say(e.UTF8ToString(e._ac_error()) || 'The engine stopped.');
    loaded = false;
    return;
  }
  followShownMode(e._ac_shown_mode());
  if (!e._ac_changed() && !dirty) return;
  if (!presenter) return;
  lastFrame = e.HEAPU8.subarray(pixels, pixels + width * height * 4);
  // Only the tiles that changed, unless the page needs the whole frame again.
  const count = e._ac_dirty_count();
  const rects = dirty || !count ? null
    : new Int32Array(e.HEAPU8.buffer, e._ac_dirty_rects(), count * 4);
  dirty = false;
  presenter.present(lastFrame, rects);
}

// --- installing a character -------------------------------------------------------

/**
 * The device takes about a minute to install a character; the desktop has the
 * pack already and switches at once. Meanwhile a ring round the screen shows
 * the device's progress, in its install screen's colours, and flashes green or
 * red when it finishes. The character keeps going throughout.
 */
interface InstallView {
  name: string;
  percent: number;
  result: { ok: boolean } | null;
}
let install: InstallView | null = null;
let installDone = 0;
const INSTALL_RESULT_MS = 2500;

// The device install screen's RGB565 colours, as they come out on its screen.
const INSTALL_TEXT = '#E6E6FF';
const INSTALL_BAR_EDGE = '#5AA1CD';
const INSTALL_BAR = '#206D94';
const INSTALL_OK = '#41FF4A';
const INSTALL_FAILED = '#F6484A';

function followInstall(daemon: DaemonSnapshot | null): void {
  // Only an install on a connected device; desktop-only users never see this.
  if (daemon?.installing && daemon.connected) {
    clearTimeout(installDone);
    install = { name: daemon.installing.name, percent: daemon.installing.percent, result: null };
  } else if (install && !install.result) {
    const last = daemon?.lastInstall;
    if (last) {
      install = { ...install, percent: 100, result: { ok: last.ok } };
      installDone = window.setTimeout(() => {
        install = null;
        drawInstall();
      }, INSTALL_RESULT_MS);
    } else {
      install = null;
    }
  } else {
    return;
  }
  drawInstall();
}

function drawInstall(): void {
  installCanvas.hidden = !install;
  if (!install) return;
  const context = installContext;
  const unit = installCanvas.width / UNITS;
  const centre = installCanvas.width / 2;
  context.clearRect(0, 0, installCanvas.width, installCanvas.height);

  // On the bezel when the device is drawn, else just inside the screen's edge.
  const radius = (backdrop === 'device' ? (SCREEN / 2 + CASE_RADIUS) / 2 : SCREEN / 2 - 8) * unit;
  const width = 7 * unit;
  const top = -Math.PI / 2;
  context.lineCap = 'round';
  context.lineWidth = width;
  context.strokeStyle = INSTALL_BAR;
  context.beginPath();
  context.arc(centre, centre, radius, 0, Math.PI * 2);
  context.stroke();
  const done = install.result;
  const share = done ? 1 : Math.max(0.01, Math.min(1, install.percent / 100));
  context.strokeStyle = done ? (done.ok ? INSTALL_OK : INSTALL_FAILED) : INSTALL_BAR_EDGE;
  context.beginPath();
  context.arc(centre, centre, radius, top, top + share * Math.PI * 2);
  context.stroke();

  // A line of text near the bottom of the screen, high enough that the round
  // screen's edge leaves it room.
  const label = done
    ? (done.ok ? `${install.name} installed on the device` : 'Install on the device failed')
    : `Installing on device · ${Math.round(install.percent)}%`;
  const offset = (UNITS - SCREEN) / 2;
  context.font = `${15 * unit}px ui-monospace, Menlo, Consolas, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const y = (offset + SCREEN - 78) * unit;
  const textWidth = context.measureText(label).width;
  context.fillStyle = 'rgba(0, 0, 0, .72)';
  context.beginPath();
  context.roundRect(centre - textWidth / 2 - 8 * unit, y - 11 * unit, textWidth + 16 * unit, 22 * unit, 11 * unit);
  context.fill();
  context.fillStyle = done ? (done.ok ? INSTALL_OK : INSTALL_FAILED) : INSTALL_TEXT;
  context.fillText(label, centre, y);
}

// --- the shell -----------------------------------------------------------------

/**
 * Tell the shell where the character is, in CSS pixels within the window: the
 * ellipse the device keeps its effects off, which is the character's head. The
 * shell takes the mouse only inside it, so every other click passes through.
 */
function reportRegion(): void {
  const box = device.getBoundingClientRect();
  if (box.width < 1) return;
  const unit = box.width / UNITS;
  void tauri.core.invoke('set_region', {
    region: {
      cx: box.left + box.width / 2, cy: box.top + box.height / 2, rx: 160 * unit, ry: 135 * unit,
      // Always two, empty when the case is hidden: the shell keeps a fixed pair.
      buttons: [...buttonBoxes(), ...Array(2).fill({ x: 0, y: 0, width: 0, height: 0 })].slice(0, 2),
    },
  });
}

interface Box { x: number; y: number; width: number; height: number }

/**
 * The case's buttons, in CSS pixels within the window: each one's upright
 * bounding box, a little larger than the button so it is easy to hit, upper
 * first. Without the case there are no buttons to press.
 */
function buttonBoxes(): Box[] {
  const box = device.getBoundingClientRect();
  if (backdrop !== 'device' || box.width < 1) return [];
  const unit = box.width / UNITS;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return BUTTON_DEGREES.map(degrees => {
    const angle = degrees * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const xs: number[] = [], ys: number[] = [];
    // The button's corners as drawDevice places them, with 4 units of slack all round.
    for (const along of [-4, BUTTON_REACH + 6]) {
      for (const across of [-21, 21]) {
        const radial = CASE_RADIUS - 2 + along;
        xs.push(cx + (radial * cos - across * sin) * unit);
        ys.push(cy + (radial * sin + across * cos) * unit);
      }
    }
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  });
}

/** Which button is under the pointer: SETTINGS_BUTTON, SOUNDS_BUTTON, or -1. */
function buttonAt(x: number, y: number): number {
  return buttonBoxes().findIndex(box => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height);
}

/** The tray shows the character it is showing, cut from a real frame. */
function sendTrayIcon(tries = 30): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!loaded || !engine) return;
    // Wait for the new character's first frame.
    if (!lastFrame) {
      if (tries > 0) sendTrayIcon(tries - 1);
      return;
    }
    const width = engine._ac_width();
    const height = engine._ac_height();
    const frame = document.createElement('canvas');
    frame.width = width;
    frame.height = height;
    frame.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(lastFrame), width, height), 0, 0);
    const size = 32;
    const icon = document.createElement('canvas');
    icon.width = size;
    icon.height = size;
    const iconContext = icon.getContext('2d')!;
    // The middle of the frame, where the face is.
    const crop = 300;
    iconContext.drawImage(frame, (width - crop) / 2, (height - crop) / 2,
      crop, crop, 0, 0, size, size);
    const rgba = Array.from(iconContext.getImageData(0, 0, size, size).data);
    void tauri.core.invoke('set_tray_icon', { rgba, width: size, height: size });
  }));
}

/**
 * Dragging the character moves the window; a click is a poke, the same as a
 * tap on the device's screen. A click on the case's upper button opens
 * Settings, and on the lower one mutes or unmutes sounds. Only the page sees
 * whether the pointer moved before it came up, so it decides which: a drag
 * that starts on a button only moves the window.
 */
const DRAG_THRESHOLD_PX = 4;
let pressedAt: { x: number; y: number; button: number } | null = null;

function hoverButton(button: number): void {
  device.classList.toggle('over-button', button !== -1);
  device.title = button === SETTINGS_BUTTON ? 'Open Settings'
    : button === SOUNDS_BUTTON ? (soundsOn() ? 'Mute sounds' : 'Unmute sounds') : '';
}

device.addEventListener('pointerdown', event => {
  // Only the main button pokes or drags; the right one opens the menu.
  if (event.button !== 0) return;
  // A click lets the page play sounds, which a webview may not allow before one.
  if (soundsOn()) unlock();
  pressedAt = { x: event.clientX, y: event.clientY, button: buttonAt(event.clientX, event.clientY) };
});
device.addEventListener('pointermove', event => {
  if (!pressedAt) {
    hoverButton(buttonAt(event.clientX, event.clientY));
    return;
  }
  if (Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) < DRAG_THRESHOLD_PX) return;
  pressedAt = null;
  hoverButton(-1);
  void tauri.core.invoke('start_drag');
});
device.addEventListener('pointerup', event => {
  if (pressedAt?.button === SETTINGS_BUTTON) void tauri.core.invoke('open_settings');
  else if (pressedAt?.button === SOUNDS_BUTTON) {
    toggleSounds();
    hoverButton(buttonAt(event.clientX, event.clientY));
  } else if (pressedAt && engine && loaded) engine._ac_mode(MODES.surprise, 1);
  pressedAt = null;
});
for (const done of ['pointercancel', 'pointerleave']) {
  device.addEventListener(done, () => {
    pressedAt = null;
    hoverButton(-1);
  });
}
window.addEventListener('resize', resize);

// A right-click opens the character's own menu (Hide, Settings, Close),
// never the WebView's (Reload, Inspect Element).
window.addEventListener('contextmenu', event => {
  event.preventDefault();
  pressedAt = null;
  void tauri.core.invoke('show_context_menu');
});

async function main(): Promise<void> {
  say('Starting…');
  // Listen before saying anything: the shell answers `ready` at once.
  await Promise.all([
    tauri.event.listen('to-view', event => receive(event.payload as HostMessage)),
    tauri.event.listen('to-view-pack', event => {
      const { url } = event.payload as { url?: string };
      if (!url) return;
      loadPack(url).catch(error => {
        const text = error instanceof Error ? error.message : String(error);
        say(text);
        void tauri.core.invoke('from_view', { message: { type: 'failed', message: text } });
      });
    }),
  ]);
  engine = await (createEngine as () => Promise<Engine>)();
  SCREEN = engine._ac_display();
  schedule();
  void tauri.core.invoke('from_view', { message: { type: 'ready' } });
}

void main().catch(error => say(error instanceof Error ? error.message : String(error)));

/**
 * The page inside the window: the device's own engine, drawn on the desktop.
 *
 * Every pixel of the character and its effects comes from the firmware's code,
 * compiled to WebAssembly (`desktop/engine`), fed the same `.acpk` pack and the
 * same badge packets the device gets. This page only does what the device's
 * screen does around it: steps the engine each frame, shows the result, and
 * passes on what the agent is doing. Around the screen it draws the device
 * itself, case and buttons, unless Settings asks for the character on its own.
 */

// Emscripten's loader, CommonJS, bundled by esbuild.
import createEngine from '../../../../engine/dist/engine.js';

interface TauriApi {
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
  event: { listen(name: string, handler: (event: { payload: unknown }) => void): Promise<unknown> };
}
declare global {
  interface Window { __TAURI__: TauriApi }
}

interface Engine {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  UTF8ToString(pointer: number): string;
  stringToNewUTF8(text: string): number;
  _ac_load(pointer: number, bytes: number, seed: number): number;
  _ac_error(): number;
  _ac_width(): number;
  _ac_height(): number;
  _ac_display(): number;
  _ac_frame_x(): number;
  _ac_mode(mode: number, touch: number): number;
  _ac_playing(playing: number): void;
  _ac_badge_icon(packet: number): number;
  _ac_badge_active(packet: number): number;
  _ac_frame(seconds: number, key: number): number;
  _ac_state_mode(): number;
}

interface DaemonSnapshot {
  state: string;
  backdrop: string;
  badges: Array<{ id: string; role: 'working' | 'attention' | 'complete' }>;
  icons: Array<{ id: string; color: string; mask: string }>;
}

type HostMessage =
  | { type: 'state'; state: string }
  | { type: 'daemon'; daemon: DaemonSnapshot | null }
  | { type: 'error'; message: string };

/** The device's CharacterMode values. */
const MODES: Record<string, number> = { idle: 0, surprise: 1, working: 2, complete: 3, attention: 4 };
const ROLE_LETTER = { working: 'w', attention: 'a', complete: 'c' } as const;

/**
 * The window shows a small copy of the device: its round 466 px screen inside
 * a matte black case, with the two buttons on its right edge. Everything is
 * laid out in device pixels; the case and buttons need this much room.
 */
const SCREEN = 466;
const CASE_RADIUS = 269;
const BUTTON_REACH = 7;
const UNITS = 2 * (CASE_RADIUS + BUTTON_REACH + 4);

const tauri = window.__TAURI__;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const message = document.getElementById('message') as HTMLParagraphElement;
const context = canvas.getContext('2d')!;

let engine: Engine | null = null;
let frameCanvas: HTMLCanvasElement | null = null;
let frameContext: CanvasRenderingContext2D | null = null;
let frameImage: ImageData | null = null;
let backdrop = 'device';
let wantedMode = 0;
let iconsKey = '';
let activeKey = '';
let loaded = false;
let pendingDaemon: DaemonSnapshot | null = null;
let last = performance.now();

function say(text: string): void {
  message.textContent = text;
  message.classList.add('visible');
  canvas.classList.add('hidden');
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
  const pointer = e._malloc(bytes.length);
  e.HEAPU8.set(bytes, pointer);
  const ok = e._ac_load(pointer, bytes.length, (Math.random() * 0xffffffff) >>> 0);
  e._free(pointer);
  if (!ok) throw new Error(e.UTF8ToString(e._ac_error()) || 'The character pack is invalid.');
  iconsKey = '';
  activeKey = '';
  loaded = true;
  if (wantedMode !== 0) e._ac_mode(wantedMode, 0);
  applyBadges(pendingDaemon);
  message.classList.remove('visible');
  canvas.classList.remove('hidden');
  resize();
  sendTrayIcon();
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
      backdrop = incoming.daemon?.backdrop ?? backdrop;
      applyBadges(incoming.daemon);
      break;
    case 'error':
      say(incoming.message);
      break;
  }
}

// --- drawing -----------------------------------------------------------------

/** The window is square, and holds the device's round display. */
function resize(): void {
  const size = Math.max(1, Math.min(document.body.clientWidth, document.body.clientHeight));
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  reportRegion();
}

/** The device: case, buttons, bezel lip and the black screen the frame is drawn on. */
function drawDevice(size: number): void {
  const unit = size / UNITS;
  const centre = size / 2;
  const at = (value: number) => value * unit;

  // The two buttons on the right edge, behind the case so it overlaps them.
  context.fillStyle = '#16171a';
  for (const degrees of [-24, 24]) {
    const angle = degrees * Math.PI / 180;
    context.save();
    context.translate(centre + at(CASE_RADIUS - 2) * Math.cos(angle), centre + at(CASE_RADIUS - 2) * Math.sin(angle));
    context.rotate(angle);
    context.beginPath();
    context.roundRect(0, -at(17), at(BUTTON_REACH + 2), at(34), at(3));
    context.fill();
    context.restore();
  }

  // The case: matte black, a touch lighter towards the top left.
  const shell = context.createLinearGradient(centre - at(CASE_RADIUS), centre - at(CASE_RADIUS),
    centre + at(CASE_RADIUS), centre + at(CASE_RADIUS));
  shell.addColorStop(0, '#2a2b2f');
  shell.addColorStop(.45, '#151619');
  shell.addColorStop(1, '#0b0b0d');
  context.beginPath();
  context.arc(centre, centre, at(CASE_RADIUS), 0, Math.PI * 2);
  context.fillStyle = shell;
  context.fill();
  context.lineWidth = Math.max(1, at(1.5));
  context.strokeStyle = 'rgba(255, 255, 255, .10)';
  context.stroke();

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

function draw(now: number): void {
  requestAnimationFrame(draw);
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
  if (!frameCanvas || !frameContext || !frameImage) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameContext = frameCanvas.getContext('2d')!;
    frameImage = frameContext.createImageData(width, height);
  }
  frameImage.data.set(e.HEAPU8.subarray(pixels, pixels + width * height * 4));
  frameContext.putImageData(frameImage, 0, 0);

  const size = canvas.width;
  const scale = size / UNITS;
  const screenLeft = (size - SCREEN * scale) / 2;
  context.clearRect(0, 0, size, size);
  if (backdrop === 'device') drawDevice(size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(frameCanvas, screenLeft + e._ac_frame_x() * scale, screenLeft,
    width * scale, height * scale);
}

// --- the shell -----------------------------------------------------------------

/**
 * Tell the shell where the character is, in CSS pixels within the window: the
 * ellipse the device keeps its effects off, which is the character's head. The
 * shell takes the mouse only inside it, so every other click passes through.
 */
function reportRegion(): void {
  const box = canvas.getBoundingClientRect();
  if (box.width < 1) return;
  const unit = box.width / UNITS;
  void tauri.core.invoke('set_region', {
    region: { cx: box.left + box.width / 2, cy: box.top + box.height / 2, rx: 160 * unit, ry: 135 * unit },
  });
}

/** The tray shows the character it is showing, cut from a real frame. */
function sendTrayIcon(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!frameCanvas) return;
    const size = 32;
    const icon = document.createElement('canvas');
    icon.width = size;
    icon.height = size;
    const iconContext = icon.getContext('2d')!;
    // The middle of the frame, where the face is.
    const crop = 300;
    iconContext.drawImage(frameCanvas, (frameCanvas.width - crop) / 2, (frameCanvas.height - crop) / 2,
      crop, crop, 0, 0, size, size);
    const rgba = Array.from(iconContext.getImageData(0, 0, size, size).data);
    void tauri.core.invoke('set_tray_icon', { rgba, width: size, height: size });
  }));
}

/**
 * Dragging the character moves the window; a click is a poke, the same as a
 * tap on the device's screen. Only the page sees whether the pointer moved
 * before it came up, so it decides which.
 */
const DRAG_THRESHOLD_PX = 4;
let pressedAt: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', event => {
  pressedAt = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointermove', event => {
  if (!pressedAt) return;
  if (Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) < DRAG_THRESHOLD_PX) return;
  pressedAt = null;
  void tauri.core.invoke('start_drag');
});
canvas.addEventListener('pointerup', () => {
  if (pressedAt && engine && loaded) engine._ac_mode(MODES.surprise, 1);
  pressedAt = null;
});
for (const done of ['pointercancel', 'pointerleave']) {
  canvas.addEventListener(done, () => { pressedAt = null; });
}
window.addEventListener('resize', resize);

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
  requestAnimationFrame(draw);
  void tauri.core.invoke('from_view', { message: { type: 'ready' } });
}

void main().catch(error => say(error instanceof Error ? error.message : String(error)));

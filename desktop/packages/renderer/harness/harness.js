/**
 * Drives the renderer against a real pack, in a real browser, so the animation
 * can be watched before any of it is wired into VS Code.
 */

import { CharacterPlayer, PackRenderer, loadPack } from '../dist/index.js';

const $ = id => document.getElementById(id);
const canvas = $('screen');
const context = canvas.getContext('2d', { alpha: false });

const STATES = ['idle', 'working', 'complete', 'attention', 'surprise'];
const LOOKS = ['up_left', 'up', 'up_right', 'left', 'right', 'down_left', 'down', 'down_right'];

let player;
let renderer;
let pack;
let last = 0;
let paused = false;
let frames = 0;
let fpsSince = 0;

function fail(error) {
  $('error').textContent = error.message;
  $('meta').textContent = 'failed to load';
}

function button(label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label.replaceAll('_', '-');
  element.addEventListener('click', onClick);
  return element;
}

function buildControls() {
  for (const state of STATES) {
    const element = button(state, () => {
      player.setState(state);
      syncStateButtons();
    });
    element.dataset.state = state;
    $('states').append(element);
  }
  for (const look of LOOKS) {
    // A pack need not carry every direction.
    if (!pack.tracks[look]) continue;
    $('looks').append(button(look, () => player.lookAt(look)));
  }

  $('sleep').addEventListener('click', () => {
    const next = !player.sleeping;
    player.setSleeping(next);
    $('sleep').setAttribute('aria-pressed', String(next));
  });
  $('blink').addEventListener('click', () => player.motion.requestBlink());
  $('pause').addEventListener('click', () => {
    paused = !paused;
    $('pause').setAttribute('aria-pressed', String(paused));
    $('pause').textContent = paused ? 'Resume' : 'Pause';
  });
  $('scale').addEventListener('change', resize);

  // The same pointer handling the extension uses, so it can be checked here
  // without packaging anything.
  let lastSteer = 0;
  canvas.addEventListener('pointermove', event => {
    const now = performance.now();
    if (now - lastSteer < 100) return;
    lastSteer = now;
    const box = canvas.getBoundingClientRect();
    const direction = pointerDirection(
      event.clientX - box.left, event.clientY - box.top, box.width, box.height);
    if (direction) player.lookAt(direction);
  });
  canvas.addEventListener('pointerdown', () => player.pulse('surprise'));
  canvas.style.cursor = 'pointer';
}

/** Mirrors extension/src/gaze.ts; duplicated only so the harness stays dependency-free. */
function pointerDirection(x, y, width, height) {
  const band = value => (value < 1 / 3 ? -1 : value > 2 / 3 ? 1 : 0);
  const horizontal = band(Math.max(0, Math.min(1, x / Math.max(1, width))));
  const vertical = band(Math.max(0, Math.min(1, y / Math.max(1, height))));
  if (!vertical && !horizontal) return null;
  if (!vertical) return horizontal < 0 ? 'left' : 'right';
  if (!horizontal) return vertical < 0 ? 'up' : 'down';
  return (vertical < 0 ? 'up_' : 'down_') + (horizontal < 0 ? 'left' : 'right');
}

/**
 * Follow a real agent, when the server has a bridge behind it.
 *
 * `setState` rouses him on its own, so nothing here touches sleep - doing that
 * would take back a sleep asked for by hand. This is the same one-line handler
 * the extension uses; the only difference is what carried the state here.
 */
function followAgent() {
  const source = new EventSource('/events');

  source.addEventListener('message', event => {
    const { state, bridge } = JSON.parse(event.data);
    $('agent').textContent = bridge
      ? bridge + ' · ' + state
      : 'no bridge · build @agent-companion/agent-state';
    if (bridge && STATES.includes(state)) player.setState(state);
  });

  source.addEventListener('error', () => {
    $('agent').textContent = 'server unreachable';
  });
}

function syncStateButtons() {
  for (const element of $('states').children) {
    element.setAttribute('aria-pressed', String(element.dataset.state === player.state));
  }
}

/** Match the backing store to the display size and the device pixel ratio. */
function resize() {
  const fill = $('scale').checked;
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = fill ? Math.min(480, document.body.clientWidth - 32) : pack.frame.width;
  const cssHeight = Math.round(cssWidth * (pack.frame.height / pack.frame.width));

  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
}

function loop(now) {
  requestAnimationFrame(loop);
  const delta = (now - last) / 1000;
  last = now;

  if (!paused) player.update(Math.min(delta, 1 / 20));

  const pose = player.pose($('crossfade').checked);
  renderer.draw(context, pose, canvas.width, canvas.height);

  frames++;
  if (now - fpsSince >= 500) {
    $('fps').textContent = Math.round((frames * 1000) / (now - fpsSince)) + ' fps';
    frames = 0;
    fpsSince = now;
  }

  $('pose').textContent = pose.track.replaceAll('_', '-')
    + ' · step ' + pose.from + '/' + (pack.steps - 1)
    + (pose.mix > 0 ? ' → ' + pose.to + ' (' + Math.round(pose.mix * 100) + '%)' : '');
  const openness = pack.blinkLevels[pose.blinkLevel];
  $('eyes').textContent = Math.round(openness * 100) + '% open'
    + (player.sleeping ? (player.dozing ? ' · dozing' : ' · asleep') : '');
  syncStateButtons();
}

async function main() {
  const loaded = await loadPack('/pack/pack.json');
  pack = loaded.pack;
  renderer = new PackRenderer({ pack, images: loaded.images });
  player = new CharacterPlayer({ pack });

  $('meta').textContent = pack.name + ' · ' + Object.keys(pack.tracks).length + ' tracks · '
    + pack.steps + ' steps · ' + pack.frame.width + '×' + pack.frame.height;

  buildControls();
  resize();
  window.addEventListener('resize', resize);
  followAgent();

  last = performance.now();
  fpsSince = last;
  requestAnimationFrame(loop);
}

main().catch(fail);

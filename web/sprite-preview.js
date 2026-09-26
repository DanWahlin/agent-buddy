/* global SpritePlayer */
const $ = id => document.getElementById(id);
const screen = $('screen'), context = screen.getContext('2d', {alpha: false});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const {SpriteMotion, DIRECTIONS} = SpritePlayer;
let player, manifest, tracks, last = 0, stripDirection, lastSprite, lastTelemetry, lastControls;
const assetVersion = Date.now().toString(36);
const assetURL = file => `/characters/copilot/sprites/${file}?v=${assetVersion}`;
const directionLabel = direction => direction.replaceAll('_', '-');
const eyesAreOccluded = frame => frame.eyesOccluded === true || frame.blinkMaskState === 'occluded-or-rim-clipped';
const controls = document.querySelectorAll('button, input:not(#notes), select');
controls.forEach(control => { control.disabled = true; });

function reportError(error) {
  if (player) player.setPlaying(false);
  $('error').hidden = false;
  $('error').textContent = `${error.message} No substitute sprites were used. Reload after the assets are ready.`;
  $('mode').textContent = 'Sprite loading failed';
  controls.forEach(control => { control.disabled = true; });
}
function updateControls() {
  if (!player) return;
  const state = JSON.stringify([player.playing, player.auto, player.cycling, player.inspecting,
    player.direction, player.blinkQueued, player.queue]);
  if (state === lastControls) return;
  lastControls = state;
  $('play').textContent = player.playing ? 'Pause' : 'Play';
  $('track').disabled = player.playing;
  $('auto').checked = player.auto;
  $('cycle').setAttribute('aria-pressed', String(player.cycling));
  $('cycle').textContent = player.cycling ? 'Stop direction review' : 'Review all directions';
  $('mode').textContent = player.inspecting ? 'Explicit frame inspection'
    : !player.playing ? 'Paused — pose retained'
      : player.cycling ? 'All-direction review' : player.auto ? 'Random look-around' : 'Queued sprite playback';
  const waiting = player.queue.length ? `Queued: ${player.queue.map(directionLabel).join(' → ')}.` : 'No queued directions.';
  $('queue-status').textContent = `${waiting}${player.blinkQueued ? ' Blink queued.' : ''} ${player.playing ? 'Switches only at center.' : 'Press Play to continue safely.'}`;
  document.querySelectorAll('[data-direction]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.direction === player.direction));
  });
}
function buildFilmstrip() {
  stripDirection = player.direction;
  $('filmstrip').replaceChildren();
  tracks[stripDirection].forEach((images, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.frame = index;
    button.setAttribute('aria-label', `Inspect ${directionLabel(stripDirection)} frame ${index + 1}`);
    const thumbnail = images[0].cloneNode(); thumbnail.alt = '';
    button.append(thumbnail, document.createTextNode(String(index + 1)));
    button.addEventListener('click', () => inspect(index));
    $('filmstrip').append(button);
  });
  $('sheet').href = assetURL(manifest.directions[stripDirection].sheet);
  $('source').textContent = manifest.directions[stripDirection].provider;
}
function draw() {
  if (stripDirection !== player.direction) buildFilmstrip();
  const crossfade = $('crossfade').checked;
  const sample = player.sample(crossfade);
  const poseKey = `${player.direction}:${player.index}:${player.blinkLevel}`;
  const key = `${poseKey}:${sample.to}:${sample.mix}`;
  if (key !== lastSprite) {
    const image = tracks[player.direction][sample.from][player.blinkLevel];
    const next = tracks[player.direction][sample.to][player.blinkLevel];
    if (!image || !next) throw new Error(`Missing sprite ${key}`);
    context.fillStyle = '#000'; context.fillRect(0, 0, screen.width, screen.height);
    const width = 396, height = width * manifest.height / manifest.width;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(image, (screen.width - width) / 2, (screen.height - height) / 2, width, height);
    if (sample.mix > 0 && sample.to !== sample.from) {
      context.save();
      context.globalAlpha = sample.mix;
      context.drawImage(next, (screen.width - width) / 2, (screen.height - height) / 2, width, height);
      context.restore();
    }
    lastSprite = key;
  }
  const telemetry = `${poseKey}:${player.phase}:${player.inspecting}:${crossfade}`;
  if (telemetry !== lastTelemetry) {
    $('frame').textContent = `${player.index + 1} / ${player.count}`;
    $('scrub').value = player.index; $('scrub-value').textContent = player.index + 1;
    const label = directionLabel(player.direction);
    const movements = {center: 'Centered', out: `Turning ${label}`,
      endpoint: `Looking ${label}`, return: `Returning from ${label}`};
    $('movement').textContent = player.inspecting ? `Inspecting ${label}` : movements[player.phase];
    const eyesOccluded = eyesAreOccluded(manifest.directions[player.direction].frames[player.index]);
    const eyeState = eyesOccluded ? 'Occluded' : `${Math.round(manifest.blinkLevels[player.blinkLevel] * 100)}%`;
    $('eyes').textContent = `${eyeState} / ${crossfade ? 'on' : 'off'}`;
    document.querySelectorAll('[data-frame]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.frame) === player.index));
    });
    lastTelemetry = telemetry;
  }
  updateControls();
}
function pause() { if (player) { player.setPlaying(false); last = performance.now(); draw(); } }
function inspect(index) { if (player) { player.inspect(index); last = performance.now(); draw(); } }
function loop(now) {
  try {
    player.update((now - last) / 1000);
    last = now;
    draw();
    requestAnimationFrame(loop);
  } catch (error) { reportError(error); }
}
function validateManifest(value) {
  if (!Number.isInteger(value.count) || value.count < 2 || !(value.width > 0) || !(value.height > 0)
    || JSON.stringify(value.blinkLevels) !== JSON.stringify([1, .75, .5, .25, 0])) {
    throw new Error('Invalid animation dimensions, frame count, or blink levels.');
  }
  for (const direction of DIRECTIONS) {
    const track = value.directions?.[direction];
    if (!track || !Array.isArray(track.frames) || track.frames.length !== value.count || !track.sheet) {
      throw new Error(`Incomplete ${direction} sprite track.`);
    }
    for (const [index, frame] of track.frames.entries()) {
      if (!frame.file || !Array.isArray(frame.blinks) || frame.blinks.length !== 4 || frame.blinks.some(file => !file)) {
        throw new Error(`Missing ${direction} frame ${index + 1} or its four blink sprites.`);
      }
    }
  }
}
async function initialize() {
  try {
    const response = await fetch('/characters/copilot/sprites/animation.json', {cache: 'no-store'});
    if (!response.ok) throw new Error(`Cannot load animation.json (HTTP ${response.status}).`);
    manifest = await response.json();
    validateManifest(manifest);
    const images = new Map();
    const load = file => {
      if (!images.has(file)) images.set(file, new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = async () => {
          if (image.naturalWidth !== manifest.width || image.naturalHeight !== manifest.height) {
            reject(new Error(`Wrong dimensions for ${file}.`));
          } else {
            try { await image.decode(); resolve(image); }
            catch { reject(new Error(`Cannot decode ${file}.`)); }
          }
        };
        image.onerror = () => reject(new Error(`Cannot load ${file}.`));
        image.src = assetURL(file);
      }));
      return images.get(file);
    };
    tracks = Object.fromEntries(await Promise.all(DIRECTIONS.map(async direction => [
      direction, await Promise.all(manifest.directions[direction].frames.map(frame =>
        Promise.all([frame.file, ...frame.blinks].map(load))))
    ])));
    player = new SpriteMotion({count: manifest.count, playing: !reducedMotion.matches && !document.hidden});
    $('scrub').max = player.count - 1;
    if (manifest.status) $('asset-status').append(document.createTextNode(` Asset status: ${manifest.status}`));
    controls.forEach(control => { control.disabled = false; });
    draw();
    last = performance.now();
    requestAnimationFrame(loop);
  } catch (error) { reportError(error); }
}
$('play').addEventListener('click', () => {
  if (!player) return;
  player.setPlaying(!player.playing); last = performance.now(); draw();
});
$('previous').addEventListener('click', () => { if (player) inspect(player.index - 1); });
$('next').addEventListener('click', () => { if (player) inspect(player.index + 1); });
$('scrub').addEventListener('input', event => inspect(Number(event.target.value)));
$('duration').addEventListener('input', event => {
  player.setDuration(Number(event.target.value));
  $('duration-value').textContent = player.duration.toFixed(1) + ' s';
});
$('ease').addEventListener('change', event => player.setEased(event.target.checked));
$('crossfade').addEventListener('change', () => draw());
document.querySelectorAll('[data-speed]').forEach(button => button.addEventListener('click', () => {
  player.setSpeed(Number(button.dataset.speed));
  document.querySelectorAll('[data-speed]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
}));
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => {
  player.request(button.dataset.direction); updateControls();
}));
$('track').addEventListener('change', event => {
  if (event.target.value) player.request(event.target.value);
  event.target.value = ''; updateControls();
});
$('auto').addEventListener('change', event => { player.setAuto(event.target.checked); updateControls(); });
$('cycle').addEventListener('click', () => { player.setCycle(!player.cycling); updateControls(); });
$('blinks').addEventListener('change', event => player.setBlinks(event.target.checked));
$('blink').addEventListener('click', () => { player.requestBlink(); updateControls(); });
$('snapshot').addEventListener('click', () => {
  const filename = `copilot-${player.direction}-frame-${player.index + 1}-eyes-${player.blinkLevel}${$('crossfade').checked ? '-crossfade' : ''}.png`;
  screen.toBlob(blob => {
    if (!blob) { $('feedback-status').textContent = 'Screenshot could not be created.'; return; }
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify({prototype: 'GPT Image directional sprites', direction: player.direction,
    frame: player.index + 1, eyeOpenness: manifest.blinkLevels[player.blinkLevel],
    eyesOccluded: eyesAreOccluded(manifest.directions[player.direction].frames[player.index]), phase: player.phase,
    inspecting: player.inspecting, speed: player.speed, duration: player.duration, easing: player.eased,
    auto: player.auto, cycle: player.cycling, queued: player.queue, blinks: player.blinks,
    crossfade: $('crossfade').checked, blend: player.sample($('crossfade').checked),
    warping: false, notes: $('notes').value}, null, 2);
  try { await navigator.clipboard.writeText(text); $('feedback-status').textContent = 'Copied pose, playback settings, and your notes.'; }
  catch { $('feedback-status').textContent = 'Clipboard unavailable; select and copy the report.'; $('notes').value = text; $('notes').select(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
reducedMotion.addEventListener('change', event => { if (event.matches) pause(); });
initialize();

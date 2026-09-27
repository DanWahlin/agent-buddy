'use strict';
(() => {
  const names = ['Idle', 'Surprise', 'Working', 'Complete', 'Needs attention', 'Sleeping'];
  const characterStorageKey = 'agent-companion.character-lab.character';
  const characterCookie = 'agent_companion_character';
  const characterLabels = {copilot: 'Copilot', openclaw: 'OpenClaw', claude: 'Claude'};
  const knownCharacter = value => Object.hasOwn(characterLabels, value);
  const session = crypto.randomUUID();
  const canvas = document.getElementById('screen');
  const context = canvas.getContext('2d', {alpha: false});
  const image = context.createImageData(412, 466);
  const play = document.getElementById('play');
  const wave = document.getElementById('wave');
  const errorBox = document.getElementById('error');
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pending = null, pendingDirection = null;
  let inFlight = false, ready = false, stopped = false, dirty = true;
  let errorRequiresAction = false;
  let speed = 1;
  let character = 'copilot';
  let last = performance.now(), due = 0;

  function savedCharacter() {
    try {
      const value = localStorage.getItem(characterStorageKey);
      if (knownCharacter(value)) return value;
    } catch {
      // Fall through to the cookie when browser storage is unavailable.
    }
    const cookie = document.cookie.split('; ').find(value =>
      value.startsWith(`${characterCookie}=`))?.split('=')[1];
    return knownCharacter(cookie) ? cookie : null;
  }
  function saveCharacter(value) {
    try {
      localStorage.setItem(characterStorageKey, value);
    } catch {
      // Storage can be unavailable in private or policy-restricted contexts.
    }
    document.cookie = `${characterCookie}=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
    const url = new URL(location.href);
    url.searchParams.set('character', value);
    history.replaceState(null, '', url);
  }
  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  function signal(mode) {
    pending = mode;  // Latest explicit signal wins, with no unbounded command queue.
    due = performance.now();
    document.getElementById('status').textContent = `${names[mode]} requested — waiting for native confirmation.`;
  }
  function updatePlay() {
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(!playing));
  }
  updatePlay();
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.addEventListener('click', () => signal(Number(button.dataset.mode)));
  });
  document.getElementById('character').addEventListener('click', () => signal(1));
  wave.addEventListener('click', () => {
    if (character !== 'openclaw') {
      character = 'openclaw';
      saveCharacter(character);
      document.querySelector('input[name="character"][value="openclaw"]').checked = true;
      document.getElementById('character').setAttribute('aria-label', 'Surprise OpenClaw');
    }
    pending = 0;
    pendingDirection = 0;
    playing = true;
    updatePlay();
    last = performance.now();
    dirty = true;
    due = performance.now();
    document.getElementById('status').textContent =
      'Wave requested — returning through center first if needed.';
  });
  document.querySelectorAll('input[name="character"]').forEach(input => {
    input.addEventListener('change', event => {
      character = event.target.value;
      saveCharacter(character);
      dirty = true;
      due = performance.now();
      document.getElementById('character').setAttribute(
        'aria-label', `Surprise ${characterLabels[character]}`);
      document.getElementById('status').textContent =
        `${characterLabels[character]} selected. Motion state preserved.`;
    });
  });
  document.addEventListener('keydown', event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (/^[1-6]$/.test(event.key)) { event.preventDefault(); signal(Number(event.key) - 1); }
  });
  play.addEventListener('click', () => {
    playing = !playing; dirty = true; updatePlay(); last = performance.now();
    document.getElementById('connection').textContent = playing ? 'Resuming…' : 'Paused';
  });

  async function frame(now) {
    if (inFlight || stopped) return;
    const mode = pending;
    const direction = pendingDirection;
    pending = null;
    pendingDirection = null;
    dirty = false;
    inFlight = true;
    const delta = ready && playing ? Math.min((now - last) / 1000, 1 / 30) * speed : 0;
    last = now;
    try {
      const payload = {session, delta, playing, character};
      if (mode !== null) payload.mode = mode;
      if (direction !== null) payload.direction = direction;
      const response = await fetch('/api/character/frame', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) {
        const raw = await response.text();
        const documentError = new DOMParser().parseFromString(raw, 'text/html');
        const message = [...documentError.querySelectorAll('p')].map(p => p.textContent)
          .find(text => text.startsWith('Message:'));
        throw new Error(message?.replace(/^Message:\s*/, '') || `Native renderer failed (${response.status}).`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== 412 * 466 * 2) throw new Error('Native framebuffer has an invalid size.');
      for (let i = 0, j = 0; i < bytes.length; i += 2, j += 4) {
        const pixel = (bytes[i] << 8) | bytes[i + 1];
        image.data[j] = Math.round(((pixel >> 11) & 31) * 255 / 31);
        image.data[j + 1] = Math.round(((pixel >> 5) & 63) * 255 / 63);
        image.data[j + 2] = Math.round((pixel & 31) * 255 / 31);
        image.data[j + 3] = 255;
      }
      context.fillStyle = '#000';
      context.fillRect(0, 0, 466, 466);
      context.putImageData(image, 27, 0);
      const value = key => response.headers.get(`X-Copilot-${key}`);
      const visible = Number(value('mode')), requested = Number(value('requestedMode'));
      document.getElementById('visible').textContent = names[visible];
      document.getElementById('pending').textContent = names[requested];
      document.getElementById('pose').textContent = `${value('direction')}:${value('index')} / ${value('blink')}`;
      document.getElementById('timing').textContent = `${Number(value('renderMs')).toFixed(2)} ms`;
      document.getElementById('connection').textContent = playing ? 'Live · 30 Hz target' : 'Paused';
      document.getElementById('assets').textContent = character === 'openclaw'
        ? 'All 13 OpenClaw tracks are pre-rendered 3D sprites, including both attention tilts.'
        : character === 'claude'
        ? 'All 13 Claude tracks are rendered offline from a box model of the pixel art.'
        : Number(value('availableDirections')) >= 13
        ? 'All 13 native Copilot tracks are available, including both attention tilts. Original artwork is retained.'
        : 'Expression artwork is incomplete. Re-export all 13 tracks before requesting expression modes.';
      document.querySelectorAll('[data-mode]').forEach(button =>
        button.setAttribute('aria-pressed', String(Number(button.dataset.mode) === requested)));
      if (pending === null) {
        document.getElementById('status').textContent = visible !== requested
          ? `Settling to center → ${names[requested]}.`
          : visible === 1 ? 'A quick spring recoil. The previous persistent state will resume.'
          : visible === 3 ? 'A celebration, then back to idle.'
          : `${names[visible]}${playing ? ' active' : ' paused'}. New signals take effect through the shared center.`;
      }
      // Keep a rejected signal visible until a subsequent successful explicit action.
      if (!errorRequiresAction || mode !== null) {
        errorBox.hidden = true;
        errorRequiresAction = false;
      }
      if (!ready) due = performance.now() + 1000 / 30;
      ready = true;
      play.disabled = false;
    } catch (error) {
      errorRequiresAction = mode !== null;
      showError(error.message);
      due = performance.now() + 1000;
      if (mode !== null) document.getElementById('status').textContent = `${names[mode]} was not accepted. Previous state preserved.`;
      if (!ready) document.getElementById('connection').textContent = 'Native renderer unavailable';
    } finally {
      inFlight = false;
    }
  }
  function tick(now) {
    if (stopped) return;
    if (!inFlight && now + 1 >= due && !document.hidden && (!ready || playing || pending !== null || dirty)) {
      due = now + (ready ? 1000 / 30 : 1000);
      frame(now);
    }
    requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  window.addEventListener('pagehide', () => {
    stopped = true;
    navigator.sendBeacon('/api/character/close', new Blob([JSON.stringify({session})], {type: 'application/json'}));
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  document.getElementById('speed').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (![.25, .5, 1].includes(value)) { showError('Invalid playback speed.'); return; }
    speed = value;
    last = performance.now();
    dirty = true;
  });
  const initialMode = new URLSearchParams(location.search).get('mode');
  const initialCharacter = new URLSearchParams(location.search).get('character');
  const preferredCharacter = initialCharacter ?? savedCharacter();
  if (preferredCharacter !== null) {
    const input = document.querySelector(
      `input[name="character"][value="${CSS.escape(preferredCharacter)}"]`);
    if (!input) { showError('Unknown character in this link.'); errorRequiresAction = true; }
    else { input.checked = true; input.dispatchEvent(new Event('change')); }
  }
  if (initialMode !== null) {
    const index = ['idle', 'surprise', 'working', 'complete', 'attention', 'sleep'].indexOf(initialMode);
    if (index < 0) { showError('Unknown character mode in this link.'); errorRequiresAction = true; }
    else signal(index);
  }
  requestAnimationFrame(tick);
})();

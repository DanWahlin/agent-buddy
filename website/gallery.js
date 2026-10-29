'use strict';
/* Agent Buddy character gallery: the character packs from packs/index.json (made by
   website/scripts/build.mjs), and a live preview that runs the device's own engine
   (live.js) on any of the characters. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Mark one button in a group as pressed. */
function press(buttons, isOn) {
  for (const b of buttons) {
    const on = isOn(b);
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

const { element, fullName, showChips, hideMissing } = window.AgentBuddyPacks;

/* ---------- Nav ---------- */

const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 10);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---------- Character packs ---------- */

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// Made with DOM methods, so names and descriptions from packs/index.json are always text, never markup.
function characterCard(pack, character) {
  const screen = element('div', 'device-screen');
  if (character.image) {
    const image = element('img');
    image.src = character.image;
    image.alt = '';
    image.loading = 'lazy';
    screen.append(image);
  }
  const device = element('div', 'device device-sm');
  device.append(screen);
  const title = element('div', 'pack-title');
  title.append(element('h4', '', character.name), element('span', 'tag is-add-on', pack.preview ? 'Free preview' : 'Add-on'));
  const preview = element('button', 'btn btn-ghost btn-small', 'Preview');
  preview.type = 'button';
  preview.dataset.preview = character.id;
  preview.setAttribute('aria-label', `Preview ${fullName(character)}`);
  const download = element('a', 'btn btn-small', pack.preview ? 'Download preview' : 'Download');
  download.href = character.file;
  download.download = `${character.id}${pack.preview ? '-preview' : ''}.acpk`;
  // The name starts with the visible text, so voice control finds the link by what it shows.
  download.setAttribute('aria-label', `${download.textContent} of ${character.name}, ${megabytes(character.bytes)}`);
  const actions = element('div', 'pack-actions');
  actions.append(preview, download);
  const card = element('article', 'card pack-card');
  card.append(device, title, element('p', '', character.description),
    element('p', 'pack-meta', `${megabytes(character.bytes)} · .acpk file`));
  if (character.newerFirmware) card.append(element('p', 'pack-meta pack-firmware', 'Needs current device firmware'));
  card.append(actions);
  return card;
}

function packGroup(pack) {
  const title = element('h3', 'pack-group-title', pack.name);
  title.id = `pack-${pack.id}`;
  const head = element('div', 'pack-head');
  head.append(title, element('p', '', pack.description));
  if (pack.note) head.append(element('p', 'pack-note', pack.note));
  const grid = element('div', 'gallery-grid pack-grid');
  grid.append(...pack.characters.map((character) => characterCard(pack, character)));
  const group = element('section', 'pack-group');
  group.setAttribute('aria-labelledby', title.id);
  group.append(head, grid);
  return group;
}

// Resolves with the gallery's packs. Without them, the page keeps its "coming soon" card.
const packsLoaded = showChips().then((packs) => {
  if (!packs.length) return packs;
  $('#add-ons-empty').remove();
  $('#add-ons').append(...packs.map(packGroup));
  // A link to a pack, such as gallery.html#pack-animal-pack from the home page, can only scroll once the pack is here.
  const target = location.hash.startsWith('#pack-') && document.getElementById(location.hash.slice(1));
  if (target) target.scrollIntoView();
  return packs;
});

/* ---------- Live preview ---------- */

const live = window.AgentBuddyLive;
const device = $('#live-device');
const status = $('#live-status');
const loading = $('#live-loading');
// Two agents give the states their badges, as in the home page's demo.
const AGENTS = ['copilot', 'claude'];
const view = { mode: 'idle', character: 'copilot', chosen: false };
let engineReady = false;
let engineFailed = false;
let visible = false;

function badgePacket() {
  if (view.mode === 'idle' || view.mode === 'sleep') return '';
  const role = { working: 'w', complete: 'c' };
  return AGENTS.map((id, i) =>
    `${id}=${view.mode === 'attention' ? (i === 0 ? 'a' : 'w') : role[view.mode]}`).join(',');
}

function failed(message) {
  engineFailed = true;
  device.classList.add('live-failed');
  device.classList.remove('live-ready');
  status.textContent = `${message} Showing a recording instead.`;
  const fallback = $('.live-fallback', device);
  fallback.preload = 'auto';
  fallback.play().catch(() => {});
  $$('#console button').forEach((b) => { b.disabled = true; });
}

async function loadCharacter(id) {
  device.classList.remove('live-ready');
  loading.style.setProperty('--p', 0);
  status.textContent = `Loading the ${$(`#console [data-char="${id}"]`)?.textContent ?? ''} character…`;
  const ok = await live.loadCharacter(id, (p) => loading.style.setProperty('--p', p));
  if (!ok) return;
  device.classList.add('live-ready');
  status.textContent = '';
  if (visible) live.start();
  if (view.mode === 'sleep') doze();
}

let dozeCall = 0;
async function doze() {
  const call = ++dozeCall;
  device.classList.add('live-dozing');
  status.textContent = 'Fast-forwarding two quiet minutes…';
  const asleep = await live.sleep();
  // A later doze (after a character switch) owns the result.
  if (call !== dozeCall) return;
  device.classList.remove('live-dozing');
  if (asleep) {
    status.textContent = 'Asleep · it wakes after a minute, or when you tap it';
  } else if (view.mode === 'sleep') {
    // A tap woke it before it fell asleep.
    showMode('idle');
    status.textContent = '';
  }
}

function showMode(mode) {
  view.mode = mode;
  device.dataset.state = mode;
  press($$('#live-states .chip'), (c) => c.dataset.mode === mode);
}

// The character wakes on its own after a minute, or when tapped, as on the device.
document.addEventListener('agentbuddy:mode', (e) => {
  if (view.mode === 'sleep' && e.detail.wasAsleep && !e.detail.asleep) {
    showMode('idle');
    status.textContent = '';
  }
});
document.addEventListener('agentbuddy:error', (e) => failed(e.detail || 'The engine stopped.'));

async function startLive() {
  // The preview runs even if the pack cards could not be shown.
  const packs = await packsLoaded.catch(() => []);
  try {
    const available = await live.init($('#live-canvas'));
    engineReady = true;
    $$('#live-chars [data-char]').forEach((b) => { if (!available.includes(b.dataset.char)) b.hidden = true; });
    $$('[data-preview]').forEach((b) => { if (!available.includes(b.dataset.preview)) b.hidden = true; });
    hideMissing(available);
    // A pack character shows first, because new characters are what the gallery is for.
    const offered = $$('#console [data-char]').filter((b) => !b.hidden).map((b) => b.dataset.char);
    const first = packs.flatMap((pack) => pack.characters).find((character) => offered.includes(character.id))?.id
      ?? (offered.includes('copilot') ? 'copilot' : offered[0]);
    if (!first) throw new Error('No character packs.');
    if (!view.chosen || !offered.includes(view.character)) view.character = first;
    press($$('#console [data-char]'), (c) => c.dataset.char === view.character);
    live.setMode(view.mode === 'sleep' ? 'idle' : view.mode);
    live.setBadges(badgePacket());
    await loadCharacter(view.character);
  } catch (error) {
    failed(error.message || 'The live engine could not start.');
  }
}

function select(id) {
  // Kept even when it is already the shown character, so the first add-on doesn't replace it at start.
  view.chosen = true;
  if (engineFailed || id === view.character) return;
  view.character = id;
  press($$('#console [data-char]'), (c) => c.dataset.char === id);
  if (engineReady) loadCharacter(id).catch((error) => failed(error.message));
}

// The built-in and the pack chips are one choice: one character shows at a time.
$('#console').addEventListener('click', (e) => {
  const b = e.target.closest('[data-char]');
  if (b) select(b.dataset.char);
});
$('#live-states').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  if (b.dataset.mode === view.mode && b.dataset.mode !== 'sleep') return;
  showMode(b.dataset.mode);
  live.setBadges(badgePacket());
  device.classList.remove('live-dozing');
  if (view.mode === 'sleep') {
    if (live.ready) doze();
    return;
  }
  live.setMode(view.mode);
  if (live.ready) status.textContent = '';
});
$('#live-tap').addEventListener('click', () => live.tap());

// A card's Preview button shows that character in the live preview at the top.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-preview]');
  if (!b) return;
  select(b.dataset.preview);
  device.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
});

new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  if (visible && live.ready) live.start(); else live.stop();
}).observe(device);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) live.stop(); else if (visible && live.ready) live.start();
});

startLive();

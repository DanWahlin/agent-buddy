'use strict';
/* Agent Buddy website: scroll scenes, media, and the live demo controls. */

// Set this to the film's YouTube video ID (the part after "v=") when it is published.
const FILM_YOUTUBE_ID = 'YOUTUBE_VIDEO_ID';
const REPO = 'DanWahlin/agent-buddy';

const AGENTS = [
  { id: 'copilot', name: 'GitHub Copilot', color: '#8F9BFF' },
  { id: 'claude', name: 'Claude Code', color: '#E5896A' },
  { id: 'codex', name: 'Codex CLI', color: '#5EE0A0' },
  { id: 'grok', name: 'Grok Build', color: '#E8EAED' },
  { id: 'hermes', name: 'Hermes Agent', color: '#F0C050' },
  { id: 'openclaw', name: 'OpenClaw', color: '#FF6B6B' },
];
const agent = (id) => AGENTS.find((a) => a.id === id);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function badge(id, extra = '') {
  const a = agent(id);
  return `<span class="badge ${extra}" style="--c:${a.color};--icon:url(assets/badges/${id}.svg)" aria-hidden="true"></span>`;
}

/* ---------- Generated content ---------- */

const TILES = [
  ['copilot', 'Refactor auth module', 72, 'done'], ['codex', 'Write unit tests', 55], ['grok', 'Fix flaky build', 40], ['hermes', 'Summarize issues', 30],
  ['openclaw', 'Update the docs', 50], ['claude', 'Upgrade dependencies', 64, 'attn'], ['copilot', 'Add dark mode', 70],
  ['claude', 'Review pull request', 35], ['codex', 'Plan the API', 45], ['hermes', 'Triage bug reports', 52], ['grok', 'Speed up the query', 80],
];
$('#tiles').innerHTML = TILES.map(([id, task, p, outcome], i) => `
  <div class="tile${i >= 4 && i < 7 ? ' row-offset' : ''}" data-outcome="${outcome || ''}" style="--p:${p}%">
    ${badge(id)}<b>${agent(id).name}</b><small data-task="${task}">${task}</small>
    <div class="bar"><i></i></div><span class="mark">${outcome === 'done' ? '✓' : '?'}</span>
  </div>`).join('');

$('#agent-list').innerHTML = AGENTS.map((a) => `<li><i style="--c:${a.color}"></i>${a.name}</li>`).join('');
$('#orbit').innerHTML = AGENTS.map((a) => badge(a.id)).join('');
$('.badges-cluster').innerHTML = AGENTS.map((a) => badge(a.id)).join('');
$('#live-agents').innerHTML = AGENTS.map((a, i) =>
  `<button class="chip${i < 2 ? ' is-on' : ''}" data-agent="${a.id}" aria-pressed="${i < 2}">${badge(a.id)}${a.name}</button>`).join('');

/* ---------- Video: play only what is on screen ---------- */

const visible = new Set();
function syncVideo(video) {
  const on = visible.has(video) && (!video.classList.contains('layer') || video.classList.contains('is-on'));
  if (on && video.paused) video.play().catch(() => {});
  else if (!on && !video.paused) video.pause();
}
const videoObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    syncVideo(entry.target);
  }
}, { rootMargin: '200px 0px' });
$$('video.autoplay, video.layer').forEach((v) => videoObserver.observe(v));

function showLayer(container, attr, value) {
  for (const layer of $$('.layer', container)) {
    layer.classList.toggle('is-on', layer.dataset[attr] === value);
    if (layer.tagName === 'VIDEO') {
      if (layer.classList.contains('is-on')) layer.currentTime = 0;
      syncVideo(layer);
    }
  }
}

/* ---------- Nav ---------- */

const nav = $('#nav');
const navLinks = $$('.nav-links a');
const sections = navLinks.map((a) => $(a.getAttribute('href')));

/* ---------- Scroll-driven scenes (no library needed) ---------- */

const hero = $('.hero');
const heroCopy = $('.hero-copy');
const heroStage = $('.hero-stage');
const states = $('#states');
const statesDevice = $('#states-device');
const steps = $$('.step');
const bars = $$('.step-bars span');
const events = $('#events');
const valuesWords = $$('#values-words span');
const desktopWindow = $('#desktop-window');

const STATE_EVENTS = {
  working: [['copilot', 'Running tests…', 'working']],
  attention: [['copilot', 'Running tests…', 'working'], ['claude', 'Needs your approval', 'attention']],
  complete: [['copilot', 'Done', 'complete'], ['claude', 'Done', 'complete']],
};
let currentState = '';
function setState(state) {
  if (state === currentState) return;
  currentState = state;
  steps.forEach((s) => s.classList.toggle('is-active', s.dataset.state === state));
  statesDevice.dataset.state = state;
  showLayer(statesDevice, 'state', state);
  events.innerHTML = STATE_EVENTS[state].map(([id, text, kind]) =>
    `<div class="event" data-kind="${kind}">${badge(id)}<div><b>${agent(id).name}</b><span>${text}</span></div></div>`).join('');
}

// 0 when the element's top reaches the top of the viewport, 1 when its bottom reaches the bottom.
function pinProgress(el) {
  const r = el.getBoundingClientRect();
  return clamp(-r.top / Math.max(1, r.height - innerHeight), 0, 1);
}
// 0 when the element enters at the bottom, 1 when it leaves at the top.
function passProgress(el) {
  const r = el.getBoundingClientRect();
  return clamp((innerHeight - r.top) / (innerHeight + r.height), 0, 1);
}

let ticking = false;
function onScroll() {
  ticking = false;
  nav.classList.toggle('scrolled', scrollY > 10);

  let active = -1;
  sections.forEach((s, i) => { if (s && s.getBoundingClientRect().top < innerHeight * 0.45) active = i; });
  navLinks.forEach((a, i) => a.classList.toggle('is-active', i === active));

  if (!reduceMotion) {
    const h = pinProgress(hero);
    heroCopy.style.transform = `translateY(${-h * 140}px) scale(${1 - h * 0.08})`;
    heroCopy.style.opacity = String(clamp(1 - h * 1.8, 0, 1));
    heroStage.style.transform = `translateX(-50%) translateY(${-h * 30}vh) scale(${1 + h * 0.45})`;
  }

  const p = pinProgress(states);
  setState(['working', 'attention', 'complete'][Math.min(2, Math.floor(p * 3))]);
  bars.forEach((b, i) => b.style.setProperty('--fill', clamp(p * 3 - i, 0, 1)));

  const v = passProgress($('#values'));
  valuesWords.forEach((w, i) => w.classList.toggle('lit', v > 0.3 + i * 0.08));

  if (!reduceMotion) {
    const d = clamp(passProgress(desktopWindow) * 2.2, 0, 1);
    desktopWindow.style.transform = `rotateX(${(1 - d) * 26}deg) scale(${0.86 + d * 0.14})`;
    desktopWindow.style.opacity = String(0.4 + d * 0.6);
  }
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener('resize', onScroll);
onScroll();

/* ---------- Pointer tilt on devices ---------- */

if (!reduceMotion && matchMedia('(pointer: fine)').matches) {
  for (const device of $$('.tilt')) {
    const host = device.closest('section');
    host.addEventListener('pointermove', (e) => {
      const r = device.getBoundingClientRect();
      const x = clamp((e.clientX - (r.left + r.width / 2)) / r.width, -1, 1);
      const y = clamp((e.clientY - (r.top + r.height / 2)) / r.height, -1, 1);
      device.style.transform = `rotateY(${x * 10}deg) rotateX(${-y * 8}deg)`;
    });
    host.addEventListener('pointerleave', () => { device.style.transform = ''; });
    device.style.transition = 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
  }
}

/* ---------- Agents orbit ---------- */

const orbit = $('#orbit');
const orbitBadges = $$('.badge', orbit);
let orbitOn = false;
let orbitFrame = 0;
function spin(now) {
  const r = orbit.getBoundingClientRect();
  const rx = r.width * 0.48;
  const ry = r.height * 0.24;
  const t = reduceMotion ? 0 : now / 1000;
  orbitBadges.forEach((b, i) => {
    const a = t * 0.35 + (i / orbitBadges.length) * Math.PI * 2;
    const depth = Math.sin(a);
    const scale = 0.78 + (depth + 1) * 0.2;
    b.style.transform = `translate(${Math.cos(a) * rx}px, ${depth * ry}px) scale(${scale})`;
    b.style.zIndex = depth > 0 ? 3 : 0;
    b.style.opacity = String(0.55 + (depth + 1) * 0.225);
  });
  if (orbitOn && !reduceMotion) orbitFrame = requestAnimationFrame(spin);
}
new IntersectionObserver(([entry]) => {
  orbitOn = entry.isIntersecting;
  cancelAnimationFrame(orbitFrame);
  orbitFrame = requestAnimationFrame(spin);
}).observe(orbit);

/* ---------- Character picker ---------- */

const CHARACTERS = {
  copilot: { glow: '#4f7dff', caption: 'Built in. The device holds one character at a time, and you can switch over USB or Wi-Fi.' },
  claude: { glow: '#e5896a', caption: 'Built in. A pixel-art character that needs current firmware.' },
  openclaw: { glow: '#ff5a5a', caption: 'Built in. It even walks around the screen.' },
  custom: { glow: '#8f86ff', caption: 'Make your own .acpk pack and add it in Settings. <a href="https://github.com/DanWahlin/agent-buddy/blob/main/characters/README.md">How to make a character</a>' },
};
const charDevice = $('#char-device');
const charButtons = $$('#char-picker button');
let charAuto = true;
function pickCharacter(id) {
  charButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.char === id)));
  showLayer(charDevice, 'char', id);
  charDevice.style.setProperty('--state', CHARACTERS[id].glow);
  $('#char-caption').innerHTML = CHARACTERS[id].caption;
}
charButtons.forEach((b) => b.addEventListener('click', () => { charAuto = false; pickCharacter(b.dataset.char); }));
let charTimer = 0;
new IntersectionObserver(([entry]) => {
  clearInterval(charTimer);
  if (!entry.isIntersecting || reduceMotion) return;
  charTimer = setInterval(() => {
    if (!charAuto) return clearInterval(charTimer);
    const i = charButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    pickCharacter(charButtons[(i + 1) % charButtons.length].dataset.char);
  }, 3800);
}, { threshold: 0.5 }).observe(charDevice);

/* ---------- Settings tabs ---------- */

const shotButtons = $$('#settings-tabs button');
let shotAuto = true;
function pickShot(id) {
  shotButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.shot === id)));
  $$('#shots .shot').forEach((s) => s.classList.toggle('is-on', s.dataset.shot === id));
}
shotButtons.forEach((b) => b.addEventListener('click', () => { shotAuto = false; pickShot(b.dataset.shot); }));
let shotTimer = 0;
new IntersectionObserver(([entry]) => {
  clearInterval(shotTimer);
  if (!entry.isIntersecting || reduceMotion) return;
  shotTimer = setInterval(() => {
    if (!shotAuto) return clearInterval(shotTimer);
    const i = shotButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    pickShot(shotButtons[(i + 1) % shotButtons.length].dataset.shot);
  }, 3600);
}, { threshold: 0.4 }).observe($('#shots'));

/* ---------- Live demo ---------- */

const live = window.AgentBuddyLive;
const liveDevice = $('#live-device');
const liveStatus = $('#live-status');
const liveLoading = $('#live-loading');
const liveState = { mode: 'idle', agents: ['copilot', 'claude'], character: 'copilot' };
let liveStarted = false;
let liveEngine = false;
let liveVisible = false;

function badgePacket() {
  if (liveState.mode === 'idle') return '';
  const role = { working: 'w', complete: 'c' };
  return liveState.agents.map((id, i) =>
    `${id}=${liveState.mode === 'attention' ? (i === 0 ? 'a' : 'w') : role[liveState.mode]}`).join(',');
}
function liveFailed(message) {
  liveDevice.classList.add('live-failed');
  liveDevice.classList.remove('live-ready');
  liveStatus.textContent = `${message} Showing a recording instead.`;
  const fallback = $('.live-fallback', liveDevice);
  fallback.classList.add('autoplay');
  videoObserver.observe(fallback);
  $$('#console button').forEach((b) => { b.disabled = true; });
}
async function loadLiveCharacter(id) {
  liveDevice.classList.remove('live-ready');
  liveLoading.style.setProperty('--p', 0);
  liveStatus.textContent = `Loading the ${id === 'openclaw' ? 'OpenClaw' : id[0].toUpperCase() + id.slice(1)} character…`;
  const ok = await live.loadCharacter(id, (p) => liveLoading.style.setProperty('--p', p));
  if (!ok) return;
  liveDevice.classList.add('live-ready');
  liveStatus.textContent = 'Live · the firmware engine in WebAssembly';
  if (liveVisible) live.start();
}
async function startLive() {
  if (liveStarted) return;
  liveStarted = true;
  liveStatus.textContent = 'Waking the engine…';
  try {
    const available = await live.init($('#live-canvas'));
    liveEngine = true;
    $$('#live-chars .chip').forEach((b) => { if (!available.includes(b.dataset.char)) b.hidden = true; });
    if (!available.includes(liveState.character)) liveState.character = available[0];
    live.setMode(liveState.mode);
    live.setBadges(badgePacket());
    await loadLiveCharacter(liveState.character);
  } catch (error) {
    liveFailed(error.message || 'The live engine could not start.');
  }
}
document.addEventListener('agentbuddy:error', (e) => liveFailed(e.detail || 'The engine stopped.'));
new IntersectionObserver(([entry]) => { if (entry.isIntersecting) startLive(); }, { rootMargin: '900px 0px' }).observe(liveDevice);
new IntersectionObserver(([entry]) => {
  liveVisible = entry.isIntersecting;
  if (liveVisible && live.ready) live.start(); else live.stop();
}).observe(liveDevice);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) live.stop(); else if (liveVisible && live.ready) live.start();
});

function choose(group, button) {
  $$('.chip', group).forEach((b) => b.classList.toggle('is-on', b === button));
}
$('#live-states').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  choose(e.currentTarget, b);
  liveState.mode = b.dataset.mode;
  liveDevice.dataset.state = liveState.mode;
  live.setMode(liveState.mode);
  live.setBadges(badgePacket());
});
$('#live-agents').addEventListener('click', (e) => {
  const b = e.target.closest('[data-agent]');
  if (!b) return;
  const id = b.dataset.agent;
  if (liveState.agents.includes(id)) liveState.agents = liveState.agents.filter((a) => a !== id);
  else liveState.agents = [...liveState.agents, id].slice(-4);
  $$('[data-agent]', e.currentTarget).forEach((c) => {
    const on = liveState.agents.includes(c.dataset.agent);
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-pressed', String(on));
  });
  live.setBadges(badgePacket());
});
$('#live-chars').addEventListener('click', (e) => {
  const b = e.target.closest('[data-char]');
  if (!b || b.dataset.char === liveState.character) return;
  choose(e.currentTarget, b);
  liveState.character = b.dataset.char;
  if (liveEngine) loadLiveCharacter(liveState.character).catch((error) => liveFailed(error.message));
});
$('#live-usage').addEventListener('click', (e) => {
  const b = e.target.closest('[data-usage]');
  if (!b) return;
  choose(e.currentTarget, b);
  live.setUsage(b.dataset.usage);
});
$('#live-tap').addEventListener('click', () => live.tap());

/* ---------- Film ---------- */

const filmButton = $('#film-play');
const modal = $('#film-modal');
const hasFilm = FILM_YOUTUBE_ID && FILM_YOUTUBE_ID !== 'YOUTUBE_VIDEO_ID';
if (!hasFilm) {
  filmButton.classList.add('is-soon');
  filmButton.setAttribute('aria-label', 'The Agent Buddy film is coming soon');
  $('#film-soon').hidden = false;
}
function closeFilm() {
  modal.hidden = true;
  $('#film-body').innerHTML = '';
  filmButton.focus();
}
filmButton.addEventListener('click', () => {
  if (!hasFilm) return;
  $('#film-body').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(FILM_YOUTUBE_ID)}?autoplay=1&rel=0" title="Agent Buddy film" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  modal.hidden = false;
  $('#film-close').focus();
});
$('#film-close').addEventListener('click', closeFilm);
modal.addEventListener('click', (e) => { if (e.target === modal) closeFilm(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeFilm(); });

/* ---------- Downloads ---------- */

(function downloads() {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  let os = '';
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) os = 'mac';
  else if (/Win/i.test(platform) || /Windows/.test(ua)) os = /ARM|aarch64/i.test(ua) ? 'win-arm' : 'win';
  else if (/Linux/i.test(platform) && !/Android/i.test(ua)) os = 'linux';
  const mine = $(`.dl[data-os="${os}"]`);
  if (mine) {
    mine.classList.add('is-yours');
    mine.parentElement.prepend(mine);
  }
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((release) => {
      for (const link of $$('.dl')) {
        const asset = release.assets.find((a) => a.name.endsWith(link.dataset.match));
        if (asset) link.href = asset.browser_download_url;
      }
      const note = document.createElement('span');
      note.textContent = ` Latest: ${release.tag_name}.`;
      $('#release-note').append(note);
    })
    .catch(() => {});
})();

/* ---------- Copy ---------- */

$('#copy-code').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('#dev-code').textContent);
    button.classList.add('copied');
    $('span', button).textContent = 'Copied';
    setTimeout(() => { button.classList.remove('copied'); $('span', button).textContent = 'Copy'; }, 1800);
  } catch { /* Clipboard access can be blocked; the text stays selectable. */ }
});

/* ---------- GSAP flourishes (optional: the page works without them) ---------- */

function flourish() {
  const { gsap, ScrollTrigger } = window;
  if (!gsap || !ScrollTrigger || reduceMotion) return;
  gsap.registerPlugin(ScrollTrigger);
  const ease = 'expo.out';

  // Hero intro.
  gsap.timeline({ defaults: { ease } })
    .from('.hero-title .mask > span', { yPercent: 110, duration: 1.4, stagger: 0.12 }, 0.15)
    .from('.hero-copy .reveal-up', { y: 24, opacity: 0, duration: 1.2, stagger: 0.1 }, 0.35)
    .from('.hero-rise', { y: 140, scale: 0.86, opacity: 0, duration: 1.8 }, 0.2)
    .from('.hero-bg', { opacity: 0, duration: 2 }, 0);

  // Headlines rise out of a mask, line by line.
  for (const heading of $$('.lines')) {
    gsap.from($$('.line > span', heading), {
      yPercent: 110, duration: 1.3, ease, stagger: 0.1,
      scrollTrigger: { trigger: heading, start: 'top 85%' },
    });
  }

  gsap.set('.fade-up, .rise', { opacity: 0 });
  ScrollTrigger.batch('.fade-up', {
    start: 'top 88%',
    onEnter: (els) => gsap.fromTo(els, { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 1.1, ease, stagger: 0.08 }),
  });
  ScrollTrigger.batch('.rise', {
    start: 'top 90%',
    onEnter: (els) => gsap.fromTo(els, { y: 70, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1, duration: 1.3, ease, stagger: 0.12 }),
  });

  // The notice tiles drift in, then one finishes and one needs you.
  const tiles = $$('.tile');
  gsap.from(tiles, {
    y: 60, opacity: 0, scale: 0.94, duration: 1.2, ease, stagger: { each: 0.05, from: 'random' },
    scrollTrigger: { trigger: '#tiles', start: 'top 85%' },
  });
  ScrollTrigger.create({
    trigger: '#tiles', start: 'top 55%', end: 'bottom top',
    onEnter: () => outcomes(true), onLeaveBack: () => outcomes(false),
  });

  // Devices settle into place as they arrive.
  for (const device of $$('.agents .device, .picker-stage .device, .finale .device, .try-stage')) {
    gsap.from(device, {
      scale: 0.8, opacity: 0, y: 60, duration: 1.6, ease,
      scrollTrigger: { trigger: device, start: 'top 90%' },
    });
  }
  gsap.from('.orbit', { scale: 0.6, opacity: 0, duration: 1.8, ease, scrollTrigger: { trigger: '.orbit-stage', start: 'top 80%' } });
  gsap.from('.shots', { y: 80, opacity: 0, duration: 1.4, ease, scrollTrigger: { trigger: '.shots', start: 'top 92%' } });
  gsap.from('.film-frame', { y: 80, opacity: 0, scale: 0.95, duration: 1.4, ease, scrollTrigger: { trigger: '.film-frame', start: 'top 92%' } });
  gsap.from('.finale-title, .finale .btn', { y: 30, opacity: 0, duration: 1.2, ease, stagger: 0.1, scrollTrigger: { trigger: '.finale-title', start: 'top 90%' } });

  // Events travel along the flow line, from the hooks to your buddy.
  const flow = $('#flow');
  ['var(--work)', 'var(--attn)', 'var(--done)'].forEach((color, i) => {
    const dot = document.createElement('span');
    dot.className = 'flow-dot';
    dot.style.setProperty('--c', color);
    flow.append(dot);
    gsap.timeline({ repeat: -1, delay: i * 1.2 })
      .fromTo(dot, { left: '16%' }, { left: '84%', duration: 3.6, ease: 'power1.inOut' }, 0)
      .fromTo(dot, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0)
      .to(dot, { opacity: 0, duration: 0.4 }, 3.2);
  });
}

function outcomes(on) {
  $('#tiles').classList.toggle('focus', on);
  for (const tile of $$('.tile')) {
    const small = $('small', tile);
    const outcome = tile.dataset.outcome;
    if (!outcome) continue;
    tile.classList.toggle(outcome, on);
    small.textContent = on ? (outcome === 'done' ? 'Done · just now' : 'Needs your approval') : small.dataset.task;
  }
}

if (window.gsap) flourish();
else addEventListener('load', flourish);
if (!window.gsap || reduceMotion) {
  // Without GSAP, still show the outcome once the tiles are on screen.
  new IntersectionObserver(([entry]) => outcomes(entry.isIntersecting), { threshold: 0.6 }).observe($('#tiles'));
}

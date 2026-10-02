const $ = id => document.getElementById(id);
const stateNames = {
  idle: 'Idle', surprise: 'Surprise', working: 'Working', complete: 'Complete', attention: 'Needs attention',
};
const statePhrases = {
  idle: 'is idle', surprise: 'is surprised', working: 'is working', complete: 'just finished',
  attention: 'needs your attention',
};
const modeHints = {
  auto: 'Uses USB when the cable is connected, otherwise Wi-Fi.',
  wifi: 'Always uses Wi-Fi. A connected USB cable only provides power.',
  usb: 'Only uses USB.',
};

// The session token arrives in the URL fragment, so it's never sent in a request line.
function sessionToken() {
  const match = /(?:^|&)token=([0-9a-f]+)/.exec(location.hash.slice(1));
  if (match) {
    sessionStorage.setItem('companion-token', match[1]);
    history.replaceState(null, '', location.pathname);
  }
  return sessionStorage.getItem('companion-token');
}

const token = sessionToken();
let status = null;
let characters = [];
let lastResult = null;
let toastTimer;
let wifiScanning = false;
let wifiScanned = false;

function toast(message, kind = 'info') {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, kind === 'error' ? 8000 : 4500);
}

async function api(path, {method = 'GET', body, type} = {}) {
  const headers = {'X-Companion-Token': token};
  if (type) headers['Content-Type'] = type;
  const response = await fetch(path, {method, headers, body});
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

function characterName(id) {
  return characters.find(entry => entry.id === id)?.name ?? id ?? '—';
}

const glyphCache = new Map();

// Turns the device's 24x24 1-bit mask into a smooth glyph: upscale in smoothed 2x steps, then
// sharpen the soft ramp into a crisp, anti-aliased contour so stair-steps become rounded outlines.
function smoothGlyph(mask, size, accent) {
  const key = `${mask}:${size}:${accent}`;
  if (glyphCache.has(key)) return glyphCache.get(key);
  const bytes = Uint8Array.from(atob(mask ?? ''), c => c.charCodeAt(0));
  let source = document.createElement('canvas');
  source.width = source.height = 24;
  const pixels = source.getContext('2d').createImageData(24, 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      if (bytes[y * 3 + Math.floor(x / 8)] & (0x80 >> (x % 8))) pixels.data[(y * 24 + x) * 4 + 3] = 255;
    }
  }
  source.getContext('2d').putImageData(pixels, 0, 0);
  let current = 24;
  while (current < size) {
    const next = Math.min(size, current * 2);
    const step = document.createElement('canvas');
    step.width = step.height = next;
    const context = step.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, next, next);
    source = step;
    current = next;
  }
  const context = source.getContext('2d');
  const image = context.getImageData(0, 0, current, current);
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(accent.slice(offset, offset + 2), 16));
  // A low threshold keeps one-pixel diagonals (like the Grok slash) continuous after smoothing.
  const low = 55, high = 135;
  for (let i = 0; i < image.data.length; i += 4) {
    const t = Math.min(1, Math.max(0, (image.data[i + 3] - low) / (high - low)));
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = Math.round(255 * t * t * (3 - 2 * t));
  }
  context.putImageData(image, 0, 0);
  glyphCache.set(key, source);
  return source;
}

// Mirrors the device: a dark disc with the glyph and ring in the agent color, drawn at full screen resolution.
function drawAgentIcon(canvas, icon) {
  const cssSize = 48;
  const ratio = window.devicePixelRatio || 1;
  const size = Math.round(cssSize * ratio);
  canvas.width = canvas.height = size;
  canvas.style.width = canvas.style.height = `${cssSize}px`;
  const unit = size / 38;
  const accent = /^#[0-9a-f]{6}$/i.test(icon?.color ?? '') ? icon.color : '#8f9bff';
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, size, size);
  context.beginPath();
  context.arc(size / 2, size / 2, 17.5 * unit, 0, Math.PI * 2);
  context.fillStyle = '#11141b';
  context.fill();
  context.lineWidth = 1.8 * unit;
  context.strokeStyle = accent;
  context.globalAlpha = .85;
  context.stroke();
  context.globalAlpha = 1;
  if (!icon?.mask) return;
  const glyphSize = Math.round(24 * unit);
  context.imageSmoothingEnabled = true;
  context.drawImage(smoothGlyph(icon.mask, glyphSize * 2, accent), (size - glyphSize) / 2,
                    (size - glyphSize) / 2, glyphSize, glyphSize);
}

function renderAgents() {
  const list = $('agents');
  if (!list) return;
  list.replaceChildren();
  for (const agent of status?.agents ?? []) {
    const item = document.createElement('li');
    item.className = `agent${agent.enabled ? '' : ' disabled'}${agent.driving ? ' driving' : ''}`;
    const preview = document.createElement('canvas');
    preview.className = 'agent-icon';
    preview.setAttribute('aria-hidden', 'true');
    drawAgentIcon(preview, status?.badges?.icons?.find(icon => icon.id === agent.id));

    const body = document.createElement('div');
    body.className = 'agent-body';
    const title = document.createElement('strong');
    title.textContent = agent.name;
    const meta = document.createElement('p');
    meta.className = 'hint';
    const detected = agent.detected ? (agent.version || 'detected') : 'not detected';
    meta.textContent = `${detected} · hook ${agent.hookStatus} · ${agent.enabled ? 'enabled' : 'disabled'}`
      + `${agent.activeSessions ? ` · ${agent.activeSessions} active` : ''}`;
    body.append(title, meta);
    if (agent.action) {
      const badge = document.createElement('span');
      badge.className = `badge action ${agent.action.kind}`;
      badge.textContent = agent.action.kind === 'approve' ? 'Needs approval' : 'Waiting for first event';
      title.after(badge);
    } else if (agent.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = agent.hint;
      body.append(hint);
    }

    const actions = document.createElement('div');
    actions.className = 'actions agent-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'secondary';
    toggle.textContent = agent.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', () => agentAction(agent.id, agent.enabled ? 'disable' : 'enable'));
    const install = document.createElement('button');
    install.type = 'button';
    install.textContent = agent.installed ? 'Reinstall' : 'Install hook';
    install.disabled = !agent.detected && agent.id !== 'copilot';
    install.addEventListener('click', () => agentAction(agent.id, 'install'));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove hook';
    remove.disabled = !agent.installed;
    remove.addEventListener('click', () => agentAction(agent.id, 'remove'));
    actions.append(toggle, install, remove);

    item.append(preview, body, actions);
    list.append(item);
  }
}

async function agentAction(id, action) {
  try {
    const path = action === 'remove' ? `/api/agents/${encodeURIComponent(id)}`
      : `/api/agents/${encodeURIComponent(id)}/${action}`;
    status.agents = await api(path, {method: action === 'remove' ? 'DELETE' : 'POST'});
    renderAgents();
    toast('Agent settings updated.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderStatus() {
  const pill = $('connection');
  if (!status) {
    pill.textContent = 'Service offline';
    pill.className = 'pill offline';
    $('summary').textContent = 'Waiting for the companion service…';
    return;
  }
  const connected = status.connected;
  pill.textContent = connected ? (status.transport === 'wifi' ? 'Wi-Fi' : 'USB') : 'Not connected';
  pill.className = `pill ${connected ? status.transport : 'warning'}`;
  $('summary').textContent = connected
    ? (status.character === 'none' ? 'No character is installed yet.'
      : `${characterName(status.character)} ${statePhrases[status.state] ?? status.state}.`)
    : 'Plug in the device, or turn it on if it\'s already on Wi-Fi.';
  const where = status.transport === 'wifi' ? String(status.port).replace(/^https?:\/\//, '').replace(/:80$/, '')
    : String(status.port).replace(/^\/dev\//, '');
  const connection = $('fact-connection');
  connection.textContent = connected
    ? `${status.transport === 'wifi' ? 'Wi-Fi' : 'USB'} · ${where}` : 'Not connected';
  // Network names can hold any character, so they only ever go in as text.
  if (connected && status.network?.ssid) {
    const network = document.createElement('span');
    network.className = 'fact-detail';
    network.textContent = `Network: ${status.network.ssid}${status.network.connected ? '' : ' (not connected)'}`;
    connection.append(network);
  }
  $('fact-character').textContent = connected
    ? (status.character === 'none' ? 'None installed' : characterName(status.character)) : '—';
  const driving = status.drivingAgents?.length
    ? ` · ${status.drivingAgents.map(id => status.agents?.find(agent => agent.id === id)?.name ?? id).join(', ')}`
    : '';
  $('fact-state').textContent = `${stateNames[status.state] ?? status.state}${driving}`;
  $('fact-sessions').textContent = String(status.sessions);
  const badgesToggle = $('badges-toggle');
  // Don't let an update that raced a click undo the switch the user just flipped.
  if (badgesToggle && !badgesPending) badgesToggle.checked = status.badges?.enabled !== false;

  for (const button of document.querySelectorAll('#modes button')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === status.mode));
  }
  const desktop = status.desktop ?? {visible: true, backdrop: 'device'};
  const desktopToggle = $('desktop-toggle');
  if (desktopToggle && !desktopPending) desktopToggle.checked = desktop.visible !== false;
  for (const button of document.querySelectorAll('#backdrops button')) {
    button.setAttribute('aria-checked', String(button.dataset.backdrop === desktop.backdrop));
    button.disabled = desktop.visible === false;
  }
  $('backdrop-hint').textContent = backdropHints[desktop.backdrop] ?? '';

  $('mode-hint').textContent = modeHints[status.mode] ?? '';
  // Wi-Fi credentials travel over USB, so the form needs an active USB connection.
  const usbReady = status.connected && status.transport === 'usb';
  $('wifi-form').querySelector('button[type="submit"]').disabled = !usbReady;
  $('wifi-scan').disabled = !usbReady || wifiScanning;
  // List nearby networks once each time the device connects over USB.
  if (usbReady && !wifiScanned) void scanWifi({quiet: true});
  if (!usbReady) wifiScanned = false;
  $('wifi-hint').textContent = usbReady
    ? 'Enter a 2.4 GHz network. The password goes straight to the device over USB and isn\'t stored on this computer.'
    : status.mode === 'wifi'
      ? 'Changing the Wi-Fi network uses USB. Set Connection to Auto with the cable plugged in first.'
      : 'Connect the device over USB to set up or change its Wi-Fi network.';

  const install = status.installing;
  $('install').hidden = !install;
  if (install) {
    $('install-title').textContent = `Installing ${install.name} Character`;
    $('install-percent').textContent = `${install.percent}%`;
    $('install-bar').style.width = `${install.percent}%`;
    $('install').querySelector('.bar').setAttribute('aria-valuenow', String(install.percent));
  }
}

function renderCharacters() {
  const list = $('characters');
  list.replaceChildren();
  const busy = !status?.connected || Boolean(status?.installing);
  for (const entry of characters) {
    const item = document.createElement('li');
    item.className = `character${entry.installed ? ' installed' : ''}`;

    const art = document.createElement('div');
    art.className = 'art';
    if (entry.thumbnail) {
      const image = document.createElement('img');
      image.alt = `${entry.name} character`;
      image.src = `/api/characters/${encodeURIComponent(entry.id)}/thumbnail?token=${token}`;
      art.append(image);
    } else {
      art.textContent = entry.name.slice(0, 1).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    const title = document.createElement('strong');
    title.textContent = entry.name;
    const badge = document.createElement('span');
    badge.className = `badge${entry.installed ? ' current' : ''}`;
    badge.textContent = entry.installed ? 'Installed' : entry.builtIn ? 'Built-in' : 'Added';
    name.append(title, badge);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const install = document.createElement('button');
    install.type = 'button';
    if (status && !status.connected && status.desktop?.visible) {
      // No device to install on, so choose what the desktop shows. The device
      // gets the same character when it next connects without one.
      const showing = status.desktop.character === entry.id;
      install.textContent = showing ? 'On desktop' : 'Show on desktop';
      install.className = showing ? 'secondary' : '';
      install.disabled = showing;
      install.addEventListener('click', () => void updateDesktop({character: entry.id},
        `${entry.name} is on the desktop.`).then(renderCharacters));
    } else {
      install.textContent = entry.installed ? 'Reinstall' : 'Install';
      install.className = entry.installed ? 'secondary' : '';
      install.disabled = busy;
      install.addEventListener('click', () => installCharacter(entry));
    }
    actions.append(install);
    if (!entry.builtIn) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Remove';
      remove.disabled = entry.installed || Boolean(status?.installing);
      remove.addEventListener('click', () => removeCharacter(entry));
      actions.append(remove);
    }
    body.append(name, actions);
    item.append(art, body);
    list.append(item);
  }
}

async function loadCharacters() {
  try {
    characters = await api('/api/characters');
    renderCharacters();
    renderStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function installCharacter(entry) {
  try {
    await api(`/api/characters/${encodeURIComponent(entry.id)}/install`, {method: 'POST'});
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeCharacter(entry) {
  if (!confirm(`Remove ${entry.name} from this computer?`)) return;
  try {
    await api(`/api/characters/${encodeURIComponent(entry.id)}`, {method: 'DELETE'});
    toast(`Removed ${entry.name}.`, 'success');
    await loadCharacters();
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('upload').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const entry = await api('/api/characters', {
      method: 'POST', body: await file.arrayBuffer(), type: 'application/octet-stream'});
    toast(`Added ${entry.name}. Select Install to put it on the device.`, 'success');
    await loadCharacters();
  } catch (error) {
    toast(error.message, 'error');
  }
});

function signalName(rssi) {
  return rssi >= -60 ? 'strong' : rssi >= -72 ? 'good' : 'weak';
}

// The device scans with its own 2.4 GHz radio, so 5 GHz-only networks never appear here.
async function scanWifi({quiet = false} = {}) {
  if (wifiScanning) return;
  wifiScanning = true;
  wifiScanned = true;
  const list = $('ssid-list');
  const button = $('wifi-scan');
  const previous = list.value || status?.network?.ssid || '';
  button.disabled = true;
  button.textContent = 'Scanning…';
  try {
    const networks = await api('/api/wifi/networks');
    const placeholder = new Option(networks.length ? 'Choose a network' : 'No 2.4 GHz networks found', '');
    // Network names can hold any character, so they only ever go in as text.
    const options = networks.map(network => new Option(
      `${network.ssid} (${signalName(network.rssi)} signal${network.secure ? '' : ', open'})`, network.ssid));
    list.replaceChildren(placeholder, ...options);
    if (!$('ssid').value && networks.some(network => network.ssid === previous)) list.value = previous;
  } catch (error) {
    list.replaceChildren(new Option('Scan unavailable. Type a network name.', ''));
    if (!quiet) toast(error.message, 'error');
  } finally {
    wifiScanning = false;
    button.textContent = 'Scan';
    button.disabled = !(status?.connected && status.transport === 'usb');
  }
}

$('wifi-scan').addEventListener('click', () => void scanWifi());
$('ssid-list').addEventListener('change', () => {
  if ($('ssid-list').value) $('ssid').value = '';
});
$('ssid').addEventListener('input', () => {
  if ($('ssid').value) $('ssid-list').value = '';
});

$('wifi-form').addEventListener('submit', async event => {
  event.preventDefault();
  const ssid = $('ssid').value || $('ssid-list').value;
  if (!ssid) {
    toast('Choose a nearby network or type a network name.', 'error');
    return;
  }
  const button = event.submitter ?? event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    await api('/api/wifi', {
      method: 'POST', type: 'application/json',
      body: JSON.stringify({ssid, password: $('password').value}),
    });
    $('password').value = '';
    toast(`The device is joining ${ssid}.`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Connect device';
  }
});

for (const button of document.querySelectorAll('#modes button')) {
  button.addEventListener('click', async () => {
    try {
      await api('/api/connection', {
        method: 'POST', type: 'application/json', body: JSON.stringify({mode: button.dataset.mode})});
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

const backdropHints = {
  device: 'The character on a small copy of the device, screen, bezel and buttons, so it looks and reads exactly as it does on your desk.',
  none: 'Just the character and its effects, straight on the desktop.',
};

let desktopPending = false;

async function updateDesktop(change, message) {
  desktopPending = true;
  try {
    const result = await api('/api/desktop', {
      method: 'POST', type: 'application/json', body: JSON.stringify(change)});
    if (status && result?.desktop) status.desktop = result.desktop;
    if (status) renderStatus();
    toast(message, 'success');
  } catch (error) {
    toast(error.message, 'error');
    if (status) renderStatus();
  } finally {
    desktopPending = false;
  }
}

$('desktop-toggle')?.addEventListener('change', event => {
  const visible = event.target.checked;
  void updateDesktop({visible},
    visible ? 'The desktop character is on.' : 'The desktop character is off.');
});

for (const button of document.querySelectorAll('#backdrops button')) {
  button.addEventListener('click', () => {
    void updateDesktop({backdrop: button.dataset.backdrop}, `Desktop look set to ${button.textContent}.`);
  });
}

let badgesPending = false;

$('badges-toggle')?.addEventListener('change', async event => {
  const enabled = event.target.checked;
  badgesPending = true;
  try {
    await api('/api/badges', {
      method: 'POST', type: 'application/json', body: JSON.stringify({enabled}),
    });
    if (status?.badges) status.badges.enabled = enabled;
    toast(enabled ? 'Agent badges are on.' : 'Agent badges are off.', 'success');
  } catch (error) {
    event.target.checked = !enabled;
    toast(error.message, 'error');
  } finally {
    badgesPending = false;
  }
});

let pendingActions = new Map();

// Lists the agents that still need a one-time step and announces each one as it finishes.
function renderSetup() {
  const agents = (status?.agents ?? []).filter(agent => agent.action);
  const current = new Map(agents.map(agent => [agent.id, agent]));
  for (const [id, agent] of pendingActions) {
    if (!current.has(id) && status?.agents?.some(item => item.id === id && item.enabled)) {
      toast(agent.action.kind === 'approve' ? `${agent.name} hooks approved.` : `${agent.name} is connected.`, 'success');
    }
  }
  pendingActions = current;
  document.title = agents.length ? `(${agents.length}) Agent Companion Settings` : 'Agent Companion Settings';
  $('setup').hidden = agents.length === 0;
  const list = $('setup-steps');
  list.replaceChildren();
  for (const agent of agents) {
    const item = document.createElement('li');
    item.className = `setup-item ${agent.action.kind}`;
    const title = document.createElement('strong');
    title.textContent = agent.action.title;
    const steps = document.createElement('ul');
    for (const step of agent.action.steps) {
      const line = document.createElement('li');
      line.textContent = step;
      steps.append(line);
    }
    item.append(title, steps);
    list.append(item);
  }
}

function onStatus(next) {
  const previous = status;
  status = next;
  const result = next.lastInstall;
  if (result && JSON.stringify(result) !== JSON.stringify(lastResult) && previous) {
    toast(result.ok
      ? `${result.name} installed over ${result.transport === 'wifi' ? 'Wi-Fi' : 'USB'}. The device is restarting.`
      : `Couldn't install ${result.name}: ${result.error}`, result.ok ? 'success' : 'error');
  }
  lastResult = result;
  const refresh = !previous || previous.character !== next.character
    || Boolean(previous.installing) !== Boolean(next.installing) || previous.connected !== next.connected;
  renderStatus();
  renderAgents();
  renderSetup();
  if (refresh) loadCharacters();
}

// Without a valid link, the rest of the page can't load anything, so show only the instructions.
function showLinkRequired(expired) {
  $('token-error-title').textContent = expired
    ? 'This settings link has expired.' : 'This page needs its private link.';
  $('token-error').hidden = false;
  for (const section of document.querySelectorAll('main > section')) section.hidden = true;
  sessionStorage.removeItem('companion-token');
}

if (!token) {
  showLinkRequired(false);
} else {
  const events = new EventSource(`/api/events?token=${token}`);
  events.addEventListener('status', event => onStatus(JSON.parse(event.data)));
  events.addEventListener('error', async () => {
    status = null;
    renderStatus();
    // EventSource hides the HTTP status, so ask directly whether the link was rejected.
    try {
      const response = await fetch('/api/status', {headers: {'X-Companion-Token': token}});
      if (response.status === 401) {
        events.close();
        showLinkRequired(true);
      }
    } catch {
      // The service is restarting or stopped; EventSource keeps retrying on its own.
    }
  });
}

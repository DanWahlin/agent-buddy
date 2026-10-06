const $ = id => document.getElementById(id);
const stateNames = {
  idle: 'Idle', surprise: 'Surprise', working: 'Working', complete: 'Complete', attention: 'Needs attention',
};
const statePhrases = {
  idle: 'is idle', surprise: 'is surprised', working: 'is working', complete: 'just finished',
  attention: 'needs your attention',
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
let orientationPending = false;
let orientationDragging = false;
// The status stream from the service.
let events = null;

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
    if (agent.locations?.length) body.append(agentLocations(agent.locations));
    if (agent.hookStatus === 'outdated') {
      const badge = document.createElement('span');
      badge.className = 'badge action approve';
      badge.textContent = 'Hook outdated';
      title.after(badge);
    }
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
    if (agent.warning) {
      const warning = document.createElement('p');
      warning.className = 'hint agent-warning';
      warning.setAttribute('role', 'alert');
      warning.textContent = agent.warning;
      body.append(warning);
    }

    const actions = document.createElement('div');
    actions.className = 'actions agent-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'secondary';
    sizedLabel(toggle, agent.enabled ? 'Disable' : 'Enable', 'Disable');
    toggle.addEventListener('click', () => agentAction(agent.id, agent.enabled ? 'disable' : 'enable'));
    const install = document.createElement('button');
    install.type = 'button';
    sizedLabel(install, agent.installed ? 'Reinstall' : 'Install hook', 'Install hook');
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

// Where the agent can run (Windows and each WSL distribution), with the hook status in each.
// Install and Remove act on all of them.
function agentLocations(locations) {
  const list = document.createElement('ul');
  list.className = 'agent-locations';
  for (const location of locations) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'agent-location-name';
    name.textContent = location.name;
    const detail = document.createElement('span');
    detail.className = `agent-location-status ${location.hookStatus}`;
    detail.textContent = [location.detected ? 'detected' : 'not detected', `hook ${location.hookStatus}`,
      ...(location.running ? [] : ['not running'])].join(' · ');
    row.append(name, detail);
    if (location.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = location.hint;
      row.append(hint);
    }
    list.append(row);
  }
  return list;
}

// The button keeps the width of its widest label, so the buttons next to it
// don't move when the label changes.
function sizedLabel(button, label, widest) {
  const text = document.createElement('span');
  text.textContent = label;
  button.classList.add('sized');
  button.dataset.widest = widest;
  button.replaceChildren(text);
}

async function agentAction(id, action) {
  try {
    const path = action === 'remove' ? `/api/agents/${encodeURIComponent(id)}`
      : `/api/agents/${encodeURIComponent(id)}/${action}`;
    status.agents = await api(path, {method: action === 'remove' ? 'DELETE' : 'POST'});
    renderAgents();
    const warning = status.agents.find(agent => agent.id === id)?.warning;
    if (warning) toast(warning, 'error');
    else toast('Agent settings updated.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderStatus() {
  if (!status) {
    $('fact-connection').textContent = 'Service offline';
    $('fact-versions').textContent = '—';
    $('summary').textContent = 'Waiting for the companion service…';
    renderDesktopApp();
    renderService();
    renderOrientation();
    renderUsage();
    renderFirmware();
    return;
  }
  const connected = status.connected;
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
  renderUsage();
  const state = $('fact-state');
  state.textContent = stateNames[status.state] ?? status.state;
  const active = (status.agents ?? []).filter(agent => agent.activeSessions > 0 || agent.driving);
  if (active.length) {
    const list = document.createElement('ul');
    list.className = 'fact-agents';
    for (const agent of active) {
      const item = document.createElement('li');
      item.textContent = agent.activeSessions ? `${agent.name} (${agent.activeSessions})` : agent.name;
      list.append(item);
    }
    state.append(list);
  }
  renderVersions();
  const badgesToggle = $('badges-toggle');
  // Don't let an update that raced a click undo the switch the user just flipped.
  if (badgesToggle && !badgesPending) badgesToggle.checked = status.badges?.enabled !== false;

  for (const button of document.querySelectorAll('#modes button')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === status.mode));
  }
  const desktop = status.desktop ?? {visible: true, backdrop: 'device'};
  const desktopToggle = $('desktop-toggle');
  if (desktopToggle && !desktopPending) desktopToggle.checked = desktop.visible !== false;
  const frameToggle = $('device-frame-toggle');
  if (frameToggle) {
    if (!desktopPending) frameToggle.checked = desktop.backdrop !== 'none';
    frameToggle.disabled = desktop.visible === false;
  }
  const soundsToggle = $('desktop-sounds-toggle');
  if (soundsToggle) {
    if (!desktopPending) soundsToggle.checked = desktop.sounds === true;
    soundsToggle.disabled = desktop.visible === false;
  }
  const volume = $('desktop-volume');
  if (volume) {
    if (!desktopPending && !volumeDragging) {
      volume.value = String(Number.isInteger(desktop.volume) ? desktop.volume : 30);
      showVolume();
    }
    volume.disabled = desktop.visible === false || desktop.sounds !== true;
  }
  renderDesktopApp();
  renderService();
  renderOrientation();

  for (const line of document.querySelectorAll('#mode-hint [data-mode]')) {
    line.classList.toggle('current', line.dataset.mode === status.mode);
  }
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
      ? 'Changing the Wi-Fi network uses USB. Set Device connection to Auto with the cable plugged in first.'
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

function showOrientationOffset() {
  const value = Number($('orientation-offset').value);
  $('orientation-offset-value').textContent = `${value > 0 ? '+' : ''}${value} deg`;
}

function renderOrientation() {
  const orientation = status?.orientation;
  const busy = Boolean(status?.installing || status?.firmware?.updating || status?.firmware?.usb?.installing);
  const disabled = !status?.connected || !orientation || busy || orientationPending;
  const input = $('orientation-offset');
  if (!orientationPending && !orientationDragging) {
    input.value = String(orientation?.offsetDegrees ?? 0);
    showOrientationOffset();
  }
  input.disabled = disabled;
  $('orientation-left').disabled = disabled || orientation.offsetDegrees <= -15;
  $('orientation-right').disabled = disabled || orientation.offsetDegrees >= 15;
  $('orientation-reset').disabled = disabled || orientation.offsetDegrees === 0;
  $('orientation-hint').textContent = !status?.connected ? 'Connect the device to adjust its screen alignment.'
    : !orientation ? 'Install updated device firmware to configure screen alignment.'
    : busy ? 'Wait for the current installation to finish.'
    : orientationPending ? 'Saving alignment on the device...'
    : 'Left rotates counterclockwise; Right rotates clockwise. Reset returns to zero trim.';
}

async function updateOrientationOffset(offsetDegrees) {
  if (orientationPending) return;
  orientationPending = true;
  renderOrientation();
  try {
    const result = await api('/api/orientation', {
      method: 'POST', type: 'application/json', body: JSON.stringify({offsetDegrees})});
    if (status) status.orientation = result.orientation;
    toast('Screen alignment saved on the device.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    orientationPending = false;
    orientationDragging = false;
    renderOrientation();
  }
}

$('orientation-offset').addEventListener('pointerdown', () => { orientationDragging = true; });
$('orientation-offset').addEventListener('input', showOrientationOffset);
$('orientation-offset').addEventListener('change', event => {
  orientationDragging = false;
  void updateOrientationOffset(Number(event.target.value));
});
$('orientation-offset').addEventListener('pointercancel', () => {
  orientationDragging = false;
  renderOrientation();
});
$('orientation-offset').addEventListener('blur', () => {
  orientationDragging = false;
  renderOrientation();
});
$('orientation-left').addEventListener('click', () => {
  void updateOrientationOffset(status.orientation.offsetDegrees - 0.5);
});
$('orientation-right').addEventListener('click', () => {
  void updateOrientationOffset(status.orientation.offsetDegrees + 0.5);
});
$('orientation-reset').addEventListener('click', () => { void updateOrientationOffset(0); });

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

// An in-page dialog, because the desktop app's Settings window has no window.confirm().
function confirmAction(message, action) {
  const dialog = $('confirm');
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = action;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), {once: true});
  });
}

async function removeCharacter(entry) {
  if (!await confirmAction(`Remove ${entry.name} from this computer?`, 'Remove')) return;
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

// Escape closes the connection help until the pointer or focus leaves it.
const modeHelp = $('mode-help');
modeHelp.addEventListener('keydown', event => {
  if (event.key === 'Escape') modeHelp.classList.add('dismissed');
});
modeHelp.addEventListener('mouseleave', () => modeHelp.classList.remove('dismissed'));
modeHelp.addEventListener('focusout', () => modeHelp.classList.remove('dismissed'));

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

$('device-frame-toggle')?.addEventListener('change', event => {
  const framed = event.target.checked;
  void updateDesktop({backdrop: framed ? 'device' : 'none'},
    framed ? 'The device is shown around the character.' : 'Only the character is shown.');
});

$('desktop-sounds-toggle')?.addEventListener('change', event => {
  const sounds = event.target.checked;
  void updateDesktop({sounds}, sounds ? 'Desktop sounds are on.' : 'Desktop sounds are muted.');
});

// Status updates arrive while the user drags; they must not move the slider.
let volumeDragging = false;

function showVolume() {
  const volume = $('desktop-volume');
  const label = $('desktop-volume-value');
  if (!volume) return;
  volume.style.setProperty('--fill', String(Number(volume.value) / 100));
  if (label) label.textContent = `${volume.value}%`;
}

$('desktop-volume')?.addEventListener('pointerdown', () => { volumeDragging = true; });
for (const end of ['pointerup', 'pointercancel']) {
  window.addEventListener(end, () => { volumeDragging = false; });
}
$('desktop-volume')?.addEventListener('input', showVolume);
$('desktop-volume')?.addEventListener('change', event => {
  const volume = Number(event.target.value);
  void updateDesktop({volume}, `Desktop sound volume is ${volume}%.`);
});

// The service and the desktop app each come from a release. Different versions mean that one of
// them was not updated, so say so.
function renderVersions() {
  const fact = $('fact-versions');
  const service = status?.service?.version;
  const app = status?.desktop?.app;
  const appText = !app || app.state !== 'running' ? 'not running'
    : app.version ? `v${app.version}` : 'version unknown';
  fact.textContent = '';
  for (const line of [`Service ${service ? `v${service}` : 'version unknown'}`, `Desktop app ${appText}`]) {
    const row = document.createElement('span');
    row.className = 'fact-line';
    row.textContent = line;
    fact.append(row);
  }
  if (service && app?.state === 'running' && app.version && app.version !== service) {
    const warning = document.createElement('span');
    warning.className = 'fact-detail';
    warning.textContent = 'The versions are different. Install the same release of both.';
    fact.append(warning);
  }
}

const desktopAppViews = {
  running: {pill: 'Running', kind: 'usb', hint: 'The desktop app is open. Stop closes it.'},
  starting: {pill: 'Starting…', kind: 'warning', hint: 'Opening the desktop app…'},
  stopping: {pill: 'Closing…', kind: 'warning', hint: 'Closing the desktop app…'},
  stopped: {pill: 'Not running', kind: 'offline', hint: 'The desktop app is closed. Start opens it.'},
};
let desktopAppPending = false;

function renderDesktopApp() {
  const pill = $('desktop-app-state');
  const hint = $('desktop-app-hint');
  const start = $('desktop-app-start');
  const stop = $('desktop-app-stop');
  const app = status?.desktop?.app;
  if (!app) {
    pill.textContent = status ? 'Unknown' : 'Checking…';
    pill.className = 'pill offline';
    // A service that started before this feature existed sends no app status.
    hint.textContent = status
      ? 'Restart the companion service (run npm run setup) to start and stop the desktop app here.'
      : 'Waiting for the companion service…';
    start.disabled = true;
    stop.disabled = true;
    return;
  }
  const view = desktopAppViews[app.state] ?? desktopAppViews.stopped;
  pill.textContent = view.pill;
  pill.className = `pill ${view.kind}`;
  start.disabled = desktopAppPending || app.state !== 'stopped' || !app.canStart;
  stop.disabled = desktopAppPending || app.state !== 'running';
  hint.textContent = app.state === 'stopped' && app.error ? app.error
    : app.state === 'stopped' && !app.canStart
      ? 'Download the desktop app from the Releases page, or run npm run desktop in the repository folder. '
        + 'Open it one time. After that, you can start and stop it here.'
      : view.hint;
}

async function desktopAppAction(action) {
  desktopAppPending = true;
  renderDesktopApp();
  try {
    const result = await api(`/api/desktop/${action}`, {method: 'POST'});
    if (status?.desktop && result?.desktop?.app) status.desktop.app = result.desktop.app;
    toast(action === 'stop' ? 'Closing the desktop app.' : 'Opening the desktop app.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    desktopAppPending = false;
    renderDesktopApp();
  }
}

$('desktop-app-start').addEventListener('click', () => desktopAppAction('start'));
$('desktop-app-stop').addEventListener('click', () => desktopAppAction('stop'));

let serviceStopPending = false;
let serviceRestartPending = false;

function renderService() {
  const pill = $('service-state');
  pill.textContent = serviceRestartPending ? 'Restarting…' : status ? 'Running' : 'Not answering';
  pill.className = `pill ${serviceRestartPending ? 'warning' : status ? 'usb' : 'offline'}`;
  const busy = !status || serviceStopPending || serviceRestartPending || Boolean(status.installing);
  $('service-restart').disabled = busy;
  $('service-stop').disabled = busy;
}

// This page reconnects on its own when the service is back, with the same link.
const serviceRestartMs = 8000;

$('service-restart').addEventListener('click', async () => {
  serviceRestartPending = true;
  renderService();
  try {
    await api('/api/service/restart', {method: 'POST'});
    toast('Restarting the companion service. This page reconnects in a few seconds.', 'success');
    setTimeout(() => {
      serviceRestartPending = false;
      renderService();
    }, serviceRestartMs);
  } catch (error) {
    toast(error.message, 'error');
    serviceRestartPending = false;
    renderService();
  }
});

$('service-stop').addEventListener('click', async () => {
  const message = 'Stop the companion service? The device and the desktop app stop showing agent activity, '
    + 'and the desktop app closes. Open the desktop app, or sign in to this computer again, to start it again.';
  if (!await confirmAction(message, 'Stop')) return;
  serviceStopPending = true;
  renderService();
  try {
    await api('/api/service/stop', {method: 'POST'});
    showServiceStopped();
  } catch (error) {
    toast(error.message, 'error');
    serviceStopPending = false;
    renderService();
  }
});

// The service stops in a moment, so stop listening and say how to start it again.
function showServiceStopped() {
  events?.close();
  for (const section of document.querySelectorAll('main > section, main > .tabs, main > .notice')) section.hidden = true;
  $('summary').textContent = 'The companion service is stopped.';
  $('service-stopped').hidden = false;
}

$('uninstall').addEventListener('click', async () => {
  const keepData = $('uninstall-keep-data').checked;
  const message = 'Uninstall Agent Companion? This removes the desktop app, the companion service and the '
    + (keepData ? 'agent hooks. Your settings stay.' : 'agent hooks, and deletes your settings, Wi-Fi pairing and added characters.');
  if (!await confirmAction(message, 'Uninstall')) return;
  const button = $('uninstall');
  button.disabled = true;
  try {
    showUninstalled(await api('/api/uninstall', {method: 'POST', body: JSON.stringify({keepData}), type: 'application/json'}));
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
});

// The service stops in a few seconds, so stop listening and show only what is left to do.
function showUninstalled(result) {
  events?.close();
  for (const section of document.querySelectorAll('main > section, main > .tabs, main > .notice')) section.hidden = true;
  $('summary').textContent = 'Uninstalled.';
  $('uninstalled-summary').textContent = result.keptData
    ? 'Your settings stay on this computer for when you install again. The desktop app closes in a few seconds.'
    : 'Your settings are deleted. The desktop app closes in a few seconds.';
  const steps = $('uninstalled-steps');
  steps.replaceChildren(...[...result.manual ?? [], 'Restart the agent sessions that are open, so they stop calling the hooks.',
    'You can close this window.'].map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('uninstalled').hidden = false;
  sessionStorage.removeItem('companion-token');
}

// A firmware update restarts the device; this long after the upload, it should run the new firmware.
const firmwareRestartMs = 120_000;
let firmwarePending = false;
let firmwareTimer;

function firmwareView(firmware) {
  if (!firmware) return status
    ? {pill: 'Unknown', kind: 'offline', hint: 'Restart the companion service (run npm run setup) to update firmware here.'}
    : {pill: 'Checking…', kind: 'offline', hint: 'Waiting for the companion service…'};
  if (firmware.updating?.button) return {pill: 'Press BOOT', kind: 'warning',
    hint: 'Press the BOOT button on the device to allow the update. The device shows the same request. '
      + 'The request stops after 60 seconds.'};
  if (firmware.updating) return {pill: `Updating ${firmware.updating.percent}%`, kind: 'warning',
    hint: 'Sending the firmware over Wi-Fi. Keep the device powered. It restarts when the update finishes.'};
  const last = firmware.last;
  if (last?.ok && firmware.device !== last.id) {
    return Date.now() - last.at < firmwareRestartMs
      ? {pill: 'Restarting…', kind: 'warning', hint: 'The device is restarting into the new firmware.'}
      : {pill: 'Went back', kind: 'warning', hint: 'The device went back to its old firmware, because the new '
        + 'firmware did not connect to Wi-Fi. Install the firmware over USB below.'};
  }
  if (!status.connected) return {pill: 'Not connected', kind: 'offline', hint: 'Connect the device to see its firmware.'};
  if (!firmware.device) return {pill: 'Old firmware', kind: 'warning', hint: 'This firmware is older and does not '
    + 'report its version, so it cannot update over Wi-Fi. A newer release installs over USB below.'};
  if (!firmware.built) return {pill: 'Installed', kind: 'usb', hint: `Firmware ${firmware.device}.`};
  if (firmware.built === firmware.device)
    return {pill: 'Current build installed', kind: 'usb',
      hint: `The device runs the source build from this computer (${firmware.device}). No update is needed.`};
  return {pill: 'Update available', kind: 'warning', hint: firmware.canUpdate
    ? `The device runs ${firmware.device}. Update sends the built firmware (${firmware.built}) over Wi-Fi. `
      + 'You press the BOOT button on the device to allow it. '
      + 'If the new firmware does not connect to Wi-Fi, the device goes back to the old firmware.'
    : `The built firmware (${firmware.built}) is different from the device's (${firmware.device}). `
      + 'Updates go over Wi-Fi: connect the device to Wi-Fi first.'};
}

function renderFirmware() {
  const firmware = status?.firmware;
  const view = firmwareView(firmware);
  const pill = $('firmware-state');
  pill.textContent = view.pill;
  pill.className = `pill ${view.kind}`;
  $('firmware-hint').textContent = view.hint;
  $('firmware-update').disabled = firmwarePending || !firmware?.canUpdate;
  // Wi-Fi updates send firmware you built yourself; the release firmware goes over USB.
  $('firmware-update').hidden = !firmware?.canUpdate && !firmwarePending;
  // Show "Went back" on time, even when no new status arrives.
  clearTimeout(firmwareTimer);
  if (view.pill === 'Restarting…')
    firmwareTimer = setTimeout(renderFirmware, firmware.last.at + firmwareRestartMs - Date.now() + 500);
  renderUsbFirmware();
}

let usbFirmwarePending = false;
let usbFirmwareTimer;
const usbStages = {downloading: 'Downloading', checking: 'Checking', connecting: 'Connecting', writing: 'Writing'};

function usbFirmwareView(usb) {
  if (!usb) return status
    ? {pill: 'Unknown', kind: 'offline', hint: 'Update the companion service to install firmware here.'}
    : {pill: 'Checking…', kind: 'offline', hint: 'Waiting for the companion service…'};
  const release = usb.release ? `v${usb.release}` : null;
  if (usb.installing) {
    const percent = usb.installing.percent;
    return {pill: `${usbStages[usb.installing.stage]}${percent === null ? '…' : ` ${percent}%`}`, kind: 'warning',
      percent: usb.installing.stage === 'writing' ? percent : null,
      hint: usb.installing.stage === 'downloading'
        ? `Downloading the ${release} firmware from GitHub.`
        : 'Writing the firmware over USB. Keep the USB cable connected until it finishes.'};
  }
  const last = usb.last;
  if (last?.ok && status.firmware?.device !== last.id && Date.now() - last.at < firmwareRestartMs)
    return {pill: 'Restarting…', kind: 'warning', hint: `Release v${last.version} is installed. The device is restarting.`};
  if (!release) return {pill: 'Unknown', kind: 'offline',
    hint: 'The companion service has no VERSION file, so it cannot choose a release.'};
  if (!usb.flasher) return {pill: 'Needs the desktop app', kind: 'offline',
    hint: `The desktop app writes the ${release} firmware from GitHub to the device over USB. Open the desktop app, `
      + 'then come back here.'};
  const about = `This downloads published release ${release} from GitHub and replaces the firmware over USB. `
    + 'Wi-Fi settings stay; the character goes back to Copilot.';
  if (last && !last.ok) return {pill: 'Failed', kind: 'warning', hint: `${last.error} ${about}`};
  if (usb.unanswered) return {pill: 'No companion firmware', kind: 'warning',
    hint: `An ESP32 on ${usb.port} does not answer as an Agent Companion. Install ${release} to set it up. ${about}`};
  const device = status.firmware?.device;
  if (usb.releaseId && device === usb.releaseId)
    return {pill: `${release} installed`, kind: 'usb', hint: `The device runs release ${release}. Install it again to repair it.`};
  if (!usb.port) return {pill: 'No USB device', kind: 'offline',
    hint: `Connect the device with a USB data cable to install ${release}. ${about}`};
  if (device && device === status.firmware?.built && device !== usb.releaseId)
    return {pill: 'Your own build', kind: 'warning',
      hint: `The current source build is installed. This is a release replacement, not an update to that build. ${about}`};
  if (usb.releaseId && device) return {pill: `Not ${release}`, kind: 'warning',
    hint: `The device runs other firmware (ID ${device}), not release ${release}. ${about}`};
  return {pill: `Release ${release}`, kind: 'offline', hint: about};
}

function renderUsbFirmware() {
  const usb = status?.firmware?.usb;
  const view = usbFirmwareView(usb);
  const pill = $('usb-firmware-state');
  pill.textContent = view.pill;
  pill.className = `pill ${view.kind}`;
  $('usb-firmware-hint').textContent = view.hint;
  const bar = $('usb-firmware-bar');
  bar.hidden = view.percent === null || view.percent === undefined;
  if (!bar.hidden) {
    bar.setAttribute('aria-valuenow', String(view.percent));
    bar.firstElementChild.style.width = `${view.percent}%`;
  }
  const button = $('usb-firmware-install');
  const action = !status?.connected || usb?.unanswered ? 'Install'
    : usb?.releaseId && status.firmware?.device === usb.releaseId ? 'Reinstall' : 'Replace with';
  button.textContent = usb?.release ? `${action} v${usb.release}` : 'Install';
  button.disabled = usbFirmwarePending || !usb?.flasher || !usb.release || Boolean(usb.installing)
    || Boolean(status?.installing) || Boolean(status?.firmware?.updating);
  if (usb?.installing || usb?.unanswered || (status?.connected && !status.firmware?.device))
    $('usb-firmware-recovery').open = true;
  clearTimeout(usbFirmwareTimer);
  if (view.pill === 'Restarting…')
    usbFirmwareTimer = setTimeout(renderUsbFirmware, usb.last.at + firmwareRestartMs - Date.now() + 500);
}

$('usb-firmware-install').addEventListener('click', async () => {
  if (status?.connected && status.firmware?.device) {
    const release = status.firmware.usb?.release;
    if (!await confirmAction(
        `Replace the current firmware with published release v${release}? `
          + 'Features in your source build may not be in this release. '
          + 'The character returns to Copilot; Wi-Fi settings stay.', 'Replace firmware')) return;
  }
  usbFirmwarePending = true;
  renderUsbFirmware();
  try {
    await api('/api/firmware/usb', {method: 'POST'});
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    usbFirmwarePending = false;
    renderUsbFirmware();
  }
});

$('firmware-update').addEventListener('click', async () => {
  firmwarePending = true;
  renderFirmware();
  try {
    await api('/api/firmware/update', {method: 'POST'});
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    firmwarePending = false;
    renderFirmware();
  }
});

// Tabs follow the ARIA tabs pattern: arrow keys, Home and End move between them.
const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(selected, focus = false) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) selected.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1],
    }[event.key];
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  });
}

// The theme follows the system until the user chooses one here; theme.js applies the saved choice early.
const darkScheme = matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  return document.documentElement.dataset.theme ?? (darkScheme.matches ? 'dark' : 'light');
}

function renderTheme() {
  $('theme-toggle').checked = currentTheme() === 'dark';
}

$('theme-toggle').addEventListener('change', event => {
  const theme = event.target.checked ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('companion-theme', theme);
  } catch {
    // The choice lasts for this page only.
  }
});
darkScheme.addEventListener('change', renderTheme);
renderTheme();

let badgesPending = false;
let usagePending = false;
const usageWindowNames = {today: 'Today', month: 'This month', active: 'Active sessions'};

function renderUsage() {
  const usage = status?.usage;
  const fact = $('fact-usage');
  // The status box shows both values; the device shows only the one for what is running.
  const summary = usage?.summary ?? usage?.lines ?? [];
  fact.textContent = !usage ? '—' : !usage.enabled ? 'Off' : summary.length ? '' : 'No usage yet';
  if (usage?.enabled) {
    for (const line of summary) {
      const row = document.createElement('span');
      row.className = 'fact-line';
      row.textContent = line;
      fact.append(row);
    }
    const period = document.createElement('span');
    period.className = 'fact-detail';
    period.textContent = usageWindowNames[usage.window] ?? usage.window;
    fact.append(period);
  }
  const preview = $('usage-preview');
  preview.classList.toggle('off', !usage?.enabled || !usage.lines.length);
  preview.textContent = !usage ? 'Not available'
    : !usage.enabled ? 'Hidden'
    : usage.lines.length ? usage.lines.join(' · ')
    : summary.length ? 'No agent running' : 'No usage yet';
  if (usagePending) return;
  const toggle = $('usage-toggle');
  const select = $('usage-window');
  toggle.disabled = !usage;
  select.disabled = !usage || !usage.enabled;
  if (!usage) return;
  toggle.checked = usage.enabled;
  select.value = usage.window;
}

async function updateUsage(change, message) {
  usagePending = true;
  try {
    const result = await api('/api/usage', {
      method: 'POST', type: 'application/json', body: JSON.stringify(change)});
    if (status && result?.usage) status.usage = result.usage;
    toast(message, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    usagePending = false;
    renderUsage();
  }
}

$('usage-toggle').addEventListener('change', event => {
  const enabled = event.target.checked;
  void updateUsage({enabled}, enabled ? 'Usage is shown.' : 'Usage is hidden.');
});

$('usage-window').addEventListener('change', event => {
  const window = event.target.value;
  void updateUsage({window}, `Usage now shows ${usageWindowNames[window].toLowerCase()}.`);
});

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
  const firmwareResult = next.firmware?.last;
  if (firmwareResult && previous && JSON.stringify(firmwareResult) !== JSON.stringify(previous.firmware?.last)) {
    toast(firmwareResult.ok ? 'Firmware sent. The device is restarting.'
      : `Couldn't update the firmware: ${firmwareResult.error}`, firmwareResult.ok ? 'success' : 'error');
  }
  const usbResult = next.firmware?.usb?.last;
  if (usbResult && previous && JSON.stringify(usbResult) !== JSON.stringify(previous.firmware?.usb?.last)) {
    toast(usbResult.ok ? `Firmware v${usbResult.version} installed. The device is restarting.`
      : `Couldn't install the firmware: ${usbResult.error}`, usbResult.ok ? 'success' : 'error');
  }
  const refresh = !previous || previous.character !== next.character
    || Boolean(previous.installing) !== Boolean(next.installing) || previous.connected !== next.connected;
  renderStatus();
  renderFirmware();
  renderAgents();
  renderSetup();
  if (refresh) loadCharacters();
}

// Without a valid link, the rest of the page can't load anything, so show only the instructions.
function showLinkRequired(expired) {
  $('token-error-title').textContent = expired
    ? 'This settings link has expired.' : 'This page needs its private link.';
  $('token-error').hidden = false;
  for (const section of document.querySelectorAll('main > section, main > .tabs')) section.hidden = true;
  sessionStorage.removeItem('companion-token');
}

if (!token) {
  showLinkRequired(false);
} else {
  events = new EventSource(`/api/events?token=${token}`);
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

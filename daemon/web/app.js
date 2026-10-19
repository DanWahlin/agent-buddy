import {Onboarding} from './onboarding.js';

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
let charactersLoading = null;
let charactersReload = false;
let charactersLoaded = false;
let charactersRetryAt = 0;
let lastResult = null;
let toastTimer;
let wifiScanning = false;
let wifiScanned = false;
let orientationPending = false;
let orientationDragging = false;
// The status stream from the service.
let events = null;

const onboarding = new Onboarding({
  api, confirm: confirmAction, drawAgentIcon,
  thumbnail: id => `/api/characters/${encodeURIComponent(id)}/thumbnail?token=${token}&revision=${status?.charactersRevision ?? 0}`,
  loadPreview: (id, signal) => api(`/api/characters/${encodeURIComponent(id)}/preview-pack`, {binary: true, signal}),
  refresh: refreshStatus, reloadCharacters: loadCharacters, notify: toast,
});

async function refreshStatus() {
  const next = await api('/api/status');
  onStatus(next);
  return next;
}

function toast(message, kind = 'info') {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, kind === 'error' ? 8000 : 4500);
}

async function api(path, {method = 'GET', body, type, binary = false, signal} = {}) {
  const headers = {'X-Companion-Token': token};
  if (type) headers['Content-Type'] = type;
  const response = await fetch(path, {method, headers, body, signal});
  if (response.ok && binary) return response.arrayBuffer();
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
function drawAgentIcon(canvas, icon, cssSize = 48) {
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
    if (action === 'install') {
      const agent = status.agents.find(entry => entry.id === id);
      if (!await confirmAction(`Install hooks for ${agent.name}? This updates the agent configuration and keeps backups. `
        + 'The hooks report activity to the local companion service. The agent may request its own approval.', 'Install hook')) return;
    }
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
    $('fact-connection').className = '';
    $('fact-state').textContent = 'Unavailable';
    $('fact-address').textContent = 'Service offline';
    $('fact-network').textContent = 'Service offline';
    $('fact-versions').textContent = '—';
    $('summary').textContent = 'Waiting for the companion service…';
    renderDesktopApp();
    renderService();
    renderOrientation();
    renderUsage();
    renderFirmware();
    renderDeviceConnection();
    return;
  }
  const connected = status.connected;
  $('summary').textContent = connected
    ? (status.character === 'none' ? 'No character is installed yet.'
      : `${characterName(status.character)} ${statePhrases[status.state] ?? status.state}.`)
    : status.deviceEnabled === false ? `${characterName(status.desktop?.character)} is on your desktop.`
    : 'Plug in the device, or turn it on if it\'s already on Wi-Fi.';
  const where = status.transport === 'wifi' ? String(status.port).replace(/^https?:\/\//, '').replace(/:80$/, '')
    : String(status.port).replace(/^\/dev\//, '');
  const connection = $('fact-connection');
  connection.textContent = connected
    ? `${status.transport === 'wifi' ? 'Wi-Fi' : 'USB'} connected`
    : status.deviceEnabled === false ? 'Desktop only' : 'Not connected';
  connection.className = connected ? 'connected' : '';
  $('fact-address').textContent = connected ? where : 'Not connected';
  // Network names can hold any character, so they only ever go in as text.
  $('fact-network').textContent = connected && status.network?.ssid
    ? `${status.network.ssid}${status.network.connected ? '' : ' (not connected)'}`
    : connected ? 'Not reported' : 'Not connected';
  renderUsage();
  renderDeviceConnection();
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
  const physicalToggle = $('physical-device-toggle');
  if (physicalToggle && !desktopPending) physicalToggle.checked = status.deviceEnabled !== false;
  if (physicalToggle) physicalToggle.disabled = Boolean(status.installing || status.firmware?.usb?.installing
    || status.firmware?.updating || status.onboarding?.busy);
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
      ? 'Changing the Wi-Fi network uses USB. Set Connection mode to Auto, then connect the USB cable.'
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

const closeIcon = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
  + '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

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
    body.append(name, actions);
    item.append(art, body);
    // The installed character stays until another one replaces it.
    if (!entry.builtIn && !entry.installed) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-character';
      remove.title = `Remove ${entry.name}`;
      remove.setAttribute('aria-label', `Remove ${entry.name}`);
      remove.innerHTML = closeIcon;
      remove.disabled = Boolean(status?.installing);
      remove.addEventListener('click', () => removeCharacter(entry));
      item.append(remove);
    }
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

function loadCharacters() {
  if (charactersLoading) {
    charactersReload = true;
    return charactersLoading;
  }
  charactersLoading = (async () => {
    do {
      charactersReload = false;
      try {
        characters = await api('/api/characters');
        charactersLoaded = true;
        charactersRetryAt = 0;
        if (status?.onboarding?.completed === false) onboarding.update(status, characters);
        else {
          renderCharacters();
          renderStatus();
        }
      } catch (error) {
        charactersRetryAt = Date.now() + 3000;
        toast(error.message, 'error');
        break;
      }
    } while (charactersReload);
  })().finally(() => { charactersLoading = null; });
  return charactersLoading;
}

async function installCharacter(entry) {
  try {
    await api(`/api/characters/${encodeURIComponent(entry.id)}/install`, {method: 'POST'});
  } catch (error) {
    toast(error.message, 'error');
  }
}

// An in-page dialog, because the desktop app's Settings window has no window.confirm().
function confirmAction(message, action, details, options = {}) {
  const dialog = $('confirm');
  if (dialog.open) {
    toast('Complete or cancel the open confirmation first.', 'error');
    return Promise.resolve(false);
  }
  $('confirm-title').textContent = options.title ?? action;
  $('confirm-context').textContent = options.context ?? 'Confirm change';
  $('confirm-message').textContent = message;
  $('confirm-note').textContent = options.note ?? '';
  $('confirm-note').hidden = !options.note;
  $('confirm-ok').textContent = action;
  const danger = options.danger ?? ['Remove', 'Uninstall'].includes(action);
  $('confirm-ok').className = danger ? 'danger confirm-destructive' : '';
  $('confirm-logo').hidden = Boolean(options.icon);
  $('confirm-agent-icon').hidden = !options.icon;
  if (options.icon) drawAgentIcon($('confirm-agent-icon'), options.icon, 48);
  $('confirm-details').hidden = !details;
  $('confirm-details').open = false;
  $('confirm-file-list').textContent = details ?? '';
  dialog.returnValue = '';
  dialog.showModal();
  $('confirm-cancel').focus({preventScroll: true});
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
    if (status && typeof result?.deviceEnabled === 'boolean') status.deviceEnabled = result.deviceEnabled;
    if (status) renderStatus();
    toast(message, 'success');
  } catch (error) {
    toast(error.message, 'error');
    if (status) renderStatus();
  } finally {
    desktopPending = false;
    if (status) renderStatus();
  }
}

// What the last Detect device found, until the connection changes.
let detection = null;
let detecting = false;

function connectionKey() {
  return status ? `${status.connected}|${status.transport}|${status.port}|${status.deviceEnabled}|${status.mode}` : '';
}

function renderDeviceConnection() {
  const pill = $('device-connection-state');
  const hint = $('device-connection-hint');
  const button = $('device-detect');
  if (!pill || !hint || !button) return;
  if (detection && detection.key !== connectionKey()) detection = null;
  const view = !status ? {pill: 'Unknown', kind: 'offline', hint: 'Waiting for the companion service…'}
    : detection ? detectionView(detection.found)
    : status.connected ? {pill: `${status.transport === 'wifi' ? 'Wi-Fi' : 'USB'} connected`, kind: 'usb',
      hint: status.transport === 'wifi' ? 'Connected over Wi-Fi.' : `Connected over USB on ${status.port}.`}
    : status.deviceEnabled === false ? {pill: 'Off', kind: 'offline',
      hint: 'Use a physical device is off, so Agent Buddy does not look for a device.'}
    : {pill: 'Not connected', kind: 'offline', hint: 'Agent Buddy looks for the device by itself. '
      + 'If it does not connect after you plug it in, select Detect device to find out why.'};
  pill.textContent = view.pill;
  pill.className = `pill ${view.kind}`;
  hint.textContent = view.hint;
  button.textContent = detecting ? 'Detecting…' : 'Detect device';
  button.disabled = detecting || !status || status.deviceEnabled === false || Boolean(status.installing
    || status.firmware?.usb?.installing || status.firmware?.updating || status.onboarding?.busy);
}

const cableSteps = 'Use a USB data cable (a charge-only cable powers the device but is not detected), '
  + 'try another USB port, and check that the device is on.';

function detectionView(found) {
  const ports = found.ports.join(', ');
  const wifi = found.wifiPaired && found.mode !== 'usb'
    ? ' Your paired Wi-Fi device did not answer either: keep it on and on the same network as this computer.' : '';
  switch (found.result) {
    case 'connected': return {pill: `${found.transport === 'wifi' ? 'Wi-Fi' : 'USB'} connected`, kind: 'usb',
      hint: found.transport === 'wifi' ? 'Found the device over Wi-Fi.' : `Found the device on ${found.port}.`};
    case 'disabled': return {pill: 'Off', kind: 'offline', hint: 'Turn on Use a physical device first.'};
    case 'busy': return {pill: 'Busy', kind: 'warning', hint: 'Wait for the current installation to finish, then try again.'};
    case 'wifi-mode': return {pill: 'USB not used', kind: 'warning', hint: `A USB device is connected (${ports}), `
      + 'but Connection mode is Wi-Fi, which does not use USB. Choose Auto or USB below.'};
    case 'usb-unavailable': return {pill: 'USB port in use', kind: 'warning', hint: `${ports} could not be opened`
      + `${found.error ? ` (${found.error})` : ''}. Close other programs that use the port, such as a serial monitor `
      + 'or the Arduino IDE, then select Detect device again. On Linux, your user also needs serial-port access '
      + '(the dialout or uucp group).'};
    case 'usb-not-answering': return {pill: 'Not answering', kind: 'warning', hint: `A device is on ${ports}, but it `
      + 'does not answer as Agent Buddy. Unplug the USB cable, connect it again, and select Detect device. '
      + 'If it still does not answer, it needs firmware: use USB release install or recovery below.'};
    default: return {pill: 'Not found', kind: 'offline', hint: `No device was found on USB. ${cableSteps}`
      + `${navigator.userAgent.includes('Windows') ? ' Connect USB to Windows, not to a WSL terminal.' : ''}${wifi}`};
  }
}

async function detectDevice() {
  detecting = true;
  detection = null;
  renderDeviceConnection();
  try {
    const found = await api('/api/devices/detect', {method: 'POST'});
    await refreshStatus();
    detection = {found, key: connectionKey()};
    if (found.result === 'usb-not-answering') {
      $('usb-firmware-recovery').open = true;
      void detectSettingsDevices().catch(() => undefined);
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    detecting = false;
    renderDeviceConnection();
  }
}

$('device-detect')?.addEventListener('click', () => void detectDevice());

$('physical-device-toggle')?.addEventListener('change', event => {
  const deviceEnabled = event.target.checked;
  void updateDesktop({deviceEnabled}, deviceEnabled ? 'Physical device connection is enabled.' : 'Device discovery is off.');
});

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
      ? {pill: 'Restarting…', kind: 'warning', until: last.at + firmwareRestartMs,
        hint: 'The device is restarting into the new firmware.'}
      : {pill: 'Went back', kind: 'warning', hint: 'The device went back to its old firmware, because the new '
        + 'firmware did not connect to Wi-Fi. Install the firmware over USB below.'};
  }
  // The button stays (disabled), so the row keeps its size while the progress shows in it.
  if (firmware.usb?.installing) return {...usbInstallView(firmware.usb), overUsb: true};
  if (usbRestarting(firmware.usb)) return {pill: 'Restarting…', kind: 'warning',
    until: firmware.usb.last.at + firmwareRestartMs, hint: 'The device is restarting into the new firmware.'};
  if (!status.connected) return {pill: 'Not connected', kind: 'offline', hint: 'Connect the device to see its firmware.'};
  if (otherBoard(firmware)) return {pill: 'Other board', kind: 'usb', hint: otherBoardHint(firmware)};
  if (!firmware.device) return {pill: 'Old firmware', kind: 'warning', update: true, overUsb: Boolean(firmware.usb?.release),
    hint: 'This firmware is older and does not report its version, so it cannot update over Wi-Fi. '
      + 'A newer release installs over USB.'};
  if (!firmware.built) return releaseFirmwareView(firmware);
  if (firmware.built === firmware.device)
    return {pill: 'Current build installed', kind: 'usb',
      hint: `The device runs the source build from this computer (${firmware.device}). No update is needed.`};
  return {pill: 'Update available', kind: 'warning', update: true, hint: firmware.canUpdate
    ? `The device runs ${firmware.device}. Update sends the built firmware (${firmware.built}) over Wi-Fi. `
      + 'You press the BOOT button on the device to allow it. '
      + 'If the new firmware does not connect to Wi-Fi, the device goes back to the old firmware.'
    : `The built firmware (${firmware.built}) is different from the device's (${firmware.device}). `
      + 'Updates go over Wi-Fi: connect the device to Wi-Fi first.'};
}

// The connected device's board, when releases have no firmware for it. Firmware for another board
// can stop such a device, so neither firmware row offers one.
function otherBoard(firmware) {
  const board = firmware?.board, boards = firmware?.usb?.boards;
  return status?.connected && board && boards && !boards.some(entry => entry.id === board) ? board : null;
}

function otherBoardHint(firmware) {
  return `This device is a ${firmware.board} board, and releases have no firmware for it, so the app does not `
    + `install one. Build and upload this board's firmware from source: BOARD=${firmware.board} bash tools/arduino.sh upload <port>.`;
}

function boardInfo(id) {
  return status?.firmware?.usb?.boards?.find(entry => entry.id === id) ?? null;
}

// The board that the device on the selected USB port reports. Only then does the device decide
// the board: over Wi-Fi, or on another port, the device to install can be a different one.
function reportedUsbBoard() {
  const selected = $('usb-firmware-port').value;
  const board = status?.connected && status.transport === 'usb' && (!selected || selected === status.port)
    ? status.firmware?.board : null;
  return boardInfo(board) ? board : null;
}

// The desktop app has no firmware build of its own: it compares the device with the release
// firmware for its version, which it installs over USB.
function releaseFirmwareView(firmware) {
  const {release, releaseId} = firmware.usb ?? {};
  if (!release || !releaseId) return {pill: 'Installed', kind: 'usb', hint: `Firmware ${firmware.device}.`};
  if (firmware.device === releaseId) return {pill: `v${release}`, kind: 'usb',
    hint: `The device runs release v${release}, the firmware for this app. No update is needed.`};
  return {pill: 'Update available', kind: 'warning', update: true, overUsb: true,
    hint: `Firmware v${release} for the ${boardInfo(firmware.board)?.name ?? 'device'} is available for this app. `
      + `The device runs other firmware (ID ${firmware.device}). `
      + 'Update installs it over USB: connect the device with a USB data cable. '
      + 'Wi-Fi settings stay, and the app then installs your character again.'};
}

function renderFirmware() {
  const firmware = status?.firmware;
  const view = firmwareView(firmware);
  const pill = $('firmware-state');
  pill.textContent = view.pill;
  pill.className = `pill ${view.kind}`;
  $('firmware-hint').textContent = view.hint;
  renderBar($('firmware-bar'), view.percent);
  $('device-update-badge').hidden = !view.update;
  // Wi-Fi updates send firmware you built yourself; the release firmware goes over USB.
  const button = $('firmware-update');
  const overUsb = Boolean(view.overUsb) && !firmware?.canUpdate;
  button.dataset.usb = String(overUsb);
  button.textContent = overUsb ? `Update to v${firmware.usb.release}` : 'Update';
  button.disabled = firmwarePending || (overUsb ? usbFirmwareBlocked(firmware.usb) : !firmware?.canUpdate);
  button.hidden = !firmware?.canUpdate && !firmwarePending && !overUsb;
  // Leave "Restarting…" on time, even when no new status arrives; the USB row follows this row.
  clearTimeout(firmwareTimer);
  if (view.until) firmwareTimer = setTimeout(renderFirmware, view.until - Date.now() + 500);
  renderUsbFirmware();
}

let usbFirmwarePending = false;
const usbStages = {downloading: 'Downloading', checking: 'Checking', connecting: 'Connecting', writing: 'Writing'};

// A USB install in progress, for both the Device firmware row and the recovery row.
function usbInstallView(usb) {
  const {stage, percent} = usb.installing;
  return {pill: `${usbStages[stage]}${percent === null ? '…' : ` ${percent}%`}`, kind: 'warning',
    percent: stage === 'writing' ? percent : null,
    hint: stage === 'downloading'
      ? `Downloading the v${usb.release} firmware from GitHub.`
      : 'Writing the firmware over USB. Keep the USB cable connected until it finishes.'};
}

function renderBar(bar, percent) {
  bar.hidden = percent === null || percent === undefined;
  if (bar.hidden) return;
  bar.setAttribute('aria-valuenow', String(percent));
  bar.firstElementChild.style.width = `${percent}%`;
}

function usbFirmwareView(usb) {
  if (!usb) return status
    ? {pill: 'Unknown', kind: 'offline', hint: 'Update the companion service to install firmware here.'}
    : {pill: 'Checking…', kind: 'offline', hint: 'Waiting for the companion service…'};
  const release = usb.release ? `v${usb.release}` : null;
  if (usb.installing) return usbInstallView(usb);
  const last = usb.last;
  if (usbRestarting(usb))
    return {pill: 'Restarting…', kind: 'warning', hint: `Release v${last.version} is installed. The device is restarting.`};
  if (!release) return {pill: 'Unknown', kind: 'offline',
    hint: 'The companion service has no VERSION file, so it cannot choose a release.'};
  if (otherBoard(status.firmware)) return {pill: 'Other board', kind: 'offline', hint: otherBoardHint(status.firmware)};
  if (!usb.flasher) return {pill: 'Needs the desktop app', kind: 'offline',
    hint: `The desktop app writes the ${release} firmware from GitHub to the device over USB. Open the desktop app, `
      + 'then come back here.'};
  const about = `This downloads published release ${release} from GitHub and replaces the firmware over USB. `
    + 'Wi-Fi settings stay, and the app then installs your character again.';
  if (last && !last.ok) return {pill: 'Failed', kind: 'warning', hint: `${last.error} ${about}`};
  // The device answers over Wi-Fi, so it has companion firmware; only its USB link is silent.
  if (usb.unanswered && status.connected) return {pill: 'USB not answering', kind: 'warning',
    hint: `The device answers over Wi-Fi but not over USB on ${usb.port}. Unplug the USB cable, `
      + 'connect it again, and wait a few seconds.'};
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
  renderBar($('usb-firmware-bar'), view.percent);
  const button = $('usb-firmware-install');
  const action = !status?.connected ? 'Install'
    : usb?.releaseId && status.firmware?.device === usb.releaseId ? 'Reinstall' : 'Replace with';
  button.textContent = usb?.release ? `${action} v${usb.release}` : 'Install';
  button.disabled = usbFirmwareBlocked(usb);
  renderBoardChoice(usb);
  // Recovery is for a device that does not answer at all; a device that answers updates with the row above.
  // Only for a device that does not answer; an install shows its progress in the row that started it.
  if (!status?.connected && usb?.unanswered && !usb.installing) $('usb-firmware-recovery').open = true;
}

let boardKey = '';

// A device that answers over USB names its board; for any other, the person chooses it here.
function renderBoardChoice(usb) {
  const select = $('usb-firmware-board');
  const boards = usb?.boards ?? [];
  const key = JSON.stringify(boards.map(board => board.id));
  if (key !== boardKey) {
    boardKey = key;
    const previous = select.value;
    select.replaceChildren(new Option('Select the board', ''));
    for (const board of boards) select.add(new Option(board.models, board.id));
    select.value = boards.some(board => board.id === previous) ? previous : '';
  }
  const reported = reportedUsbBoard();
  // A board that a device reported is not a choice for another device: the person chooses again.
  if (reported) select.value = reported;
  else if (select.dataset.reported) select.value = '';
  select.dataset.reported = reported ?? '';
  select.disabled = Boolean(reported) || usbFirmwareBlocked(usb);
  $('usb-board-message').textContent = reported
    ? `The device reports that it is a ${boardInfo(reported).name}.`
    : 'Each board has its own firmware. Firmware for a different board can stop the device.';
}

function usbRestarting(usb) {
  const last = usb?.last;
  return Boolean(last?.ok) && status.firmware?.device !== last.id && Date.now() - last.at < firmwareRestartMs;
}

function usbFirmwareBlocked(usb) {
  return usbFirmwarePending || !usb?.flasher || !usb.release || Boolean(usb.installing)
    || Boolean(status?.installing) || Boolean(status?.firmware?.updating) || Boolean(otherBoard(status?.firmware));
}

async function detectSettingsDevices() {
  const detection = await api('/api/devices');
  const select = $('usb-firmware-port');
  const previous = select.value;
  select.replaceChildren();
  if (detection.ports.length !== 1) select.add(new Option('Select your Waveshare device', ''));
  for (const port of detection.ports) select.add(new Option(port.path, port.path));
  select.value = detection.ports.some(port => port.path === previous) ? previous
    : detection.ports.some(port => port.path === detection.connected) ? detection.connected
    : detection.ports.length === 1 ? detection.ports[0].path : '';
  $('usb-device-message').textContent = detection.ports.length
    ? 'Check that the board below matches the device before installation.'
    : 'No device found. Use a USB data cable and check serial-port permissions.';
  return select.value;
}

$('usb-firmware-port').addEventListener('change', () => renderUsbFirmware());

$('usb-device-detect').addEventListener('click', () => {
  void detectSettingsDevices().catch(error => toast(error.message, 'error'));
});

async function installReleaseOverUsb() {
  usbFirmwarePending = true;
  renderFirmware();
  try {
    const port = $('usb-firmware-port').value || await detectSettingsDevices();
    if (!port) throw new Error('Select your Waveshare device before installing firmware.');
    const board = reportedUsbBoard() ?? $('usb-firmware-board').value;
    const info = boardInfo(board);
    if (!info) {
      $('usb-firmware-recovery').open = true;
      $('usb-firmware-board').focus();
      throw new Error('Select the board of the device, then install again.');
    }
    const release = status.firmware.usb?.release;
    if (!await confirmAction(`Confirm that ${port} is your ${info.models}.\n\n`
      + `Install published release v${release} for the ${info.name}? `
      + 'Firmware for a different board can stop the device. This replaces the current firmware and partition table. '
      + 'Back up other firmware first. Wi-Fi settings stay, and the app then installs your character again.',
      'Install firmware')) return;
    await api('/api/firmware/usb', {method: 'POST', type: 'application/json',
      body: JSON.stringify({port, board, confirmed: true})});
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    usbFirmwarePending = false;
    renderFirmware();
  }
}

$('usb-firmware-install').addEventListener('click', () => void installReleaseOverUsb());

$('firmware-update').addEventListener('click', async () => {
  if ($('firmware-update').dataset.usb === 'true') return installReleaseOverUsb();
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
  const setup = status?.onboarding;
  const deferred = setup?.completed && (setup.deviceDeferred
    || setup.agents.some(id => {
      const agent = status.agents.find(entry => entry.id === id);
      return !agent?.installed || !agent.enabled || Boolean(agent.action);
    }));
  const current = new Map(agents.map(agent => [agent.id, agent]));
  for (const [id, agent] of pendingActions) {
    if (!current.has(id) && status?.agents?.some(item => item.id === id && item.enabled)) {
      toast(agent.action.kind === 'approve' ? `${agent.name} hooks approved.` : `${agent.name} is connected.`, 'success');
    }
  }
  pendingActions = current;
  document.title = agents.length ? `(${agents.length}) Agent Buddy Settings` : 'Agent Buddy Settings';
  $('setup').hidden = agents.length === 0 && !deferred;
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
  if (deferred) {
    const item = document.createElement('li');
    item.textContent = setup.deviceDeferred ? 'Device setup was deferred. Open setup to continue.'
      : 'Some selected agents still need hooks or a connection. Open the setup guides to continue.';
    list.append(item);
  }
}

async function restartSetup(guides = false) {
  try {
    const previous = status?.onboarding;
    const setup = await api('/api/onboarding/restart', {method: 'POST'});
    if (guides) {
      const needsHooks = setup.agents.some(id => {
        const agent = status.agents.find(entry => entry.id === id);
        return !agent?.installed || !agent.enabled || agent.hookStatus === 'outdated';
      });
      await api('/api/onboarding', {method: 'POST', type: 'application/json', body: JSON.stringify({
        step: previous?.deviceDeferred && !needsHooks && !status.agents.some(agent => setup.agents.includes(agent.id) && agent.action)
          ? 'display' : 'agents',
        agentStage: needsHooks ? 'select' : 'connect',
      })});
    }
    await refreshStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('setup-restart').addEventListener('click', () => void restartSetup());
$('setup-guides').addEventListener('click', () => void restartSetup(true));

function onStatus(next) {
  const previous = status;
  status = next;
  const settingUp = next.onboarding?.completed === false;
  document.body.classList.toggle('setup-active', settingUp);
  $('onboarding').hidden = !settingUp;
  $('settings-content').hidden = settingUp;
  $('setup-restart').hidden = settingUp || !next.onboarding;
  onboarding.update(next, characters);
  const catalogChanged = !previous || previous.charactersRevision !== next.charactersRevision
    || previous.character !== next.character
    || Boolean(previous.installing) !== Boolean(next.installing)
    || previous.connected !== next.connected
    || (next.onboarding?.step === 'character' && previous.onboarding?.step !== 'character');
  if (catalogChanged || (!charactersLoaded && !charactersLoading && Date.now() >= charactersRetryAt))
    void loadCharacters();
  if (settingUp) {
    document.title = 'Agent Buddy Setup';
    $('summary').textContent = 'A few steps to make it yours.';
    return;
  }
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
  renderStatus();
  renderFirmware();
  renderAgents();
  renderSetup();
  if (previous?.onboarding?.completed === false) renderCharacters();
}

// Without a valid link, the rest of the page can't load anything, so show only the instructions.
function showLinkRequired(expired) {
  document.body.classList.remove('setup-active');
  $('onboarding').hidden = true;
  $('settings-content').hidden = false;
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
    if (!$('onboarding').hidden) onboarding.setOffline();
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

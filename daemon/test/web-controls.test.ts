import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

test('web alignment controls initialize once and send confirmed settings', async () => {
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  function makeElement() {
    return {
      value: '0', disabled: false, checked: false, hidden: false, open: false, className: '',
      style: {setProperty() {}}, dataset: {} as Record<string, string>,
      children: [] as string[],
      get textContent() { return this.text; },
      set textContent(value: string) { this.text = value; if (value === '') this.children = []; },
      text: '',
      append(...items: Array<{textContent: string; className: string}>) {
        for (const item of items) this.children.push(`${item.className}:${item.textContent}`);
      },
      classList: {toggle() {}, add() {}, remove() {}},
      listeners: new Map<string, number>(),
      addEventListener(type: string) {
        this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
      },
      querySelector() { return {disabled: false, setAttribute() {}}; },
      firstElementChild: {style: {}},
      setAttribute() {}, removeAttribute() {},
    };
  }
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id)!;
  }
  const calls: Array<{path: string; offsetDegrees: number}> = [];
  const context = createContext({
    Onboarding: class { update() {} },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      documentElement: {dataset: {theme: 'light'}},
      body: {classList: {toggle() {}, remove() {}}},
      createElement: () => ({textContent: '', className: ''}),
    },
    location: {hash: '', pathname: '/'},
    history: {replaceState() {}},
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    setTimeout: () => 0, clearTimeout() {},
    window: {addEventListener() {}},
    async fetch(path: string, options: RequestInit) {
      assert.equal(typeof options.body, 'string');
      const body = JSON.parse(String(options.body)) as {offsetDegrees: number};
      calls.push({path, offsetDegrees: body.offsetDegrees});
      return {ok: true, async text() {
        return JSON.stringify({ok: true, orientation: body});
      }};
    },
  });
  const text = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  runInContext(text.replace(/^import \{Onboarding\} from '\.\/onboarding\.js';\s*/, ''), context);
  assert.equal(runInContext('typeof renderOrientation', context), 'function');
  assert.equal(element('orientation-right').listeners.get('click'), 1);
  assert.equal(element('voice-mode').listeners.get('change'), 1);
  assert.equal(element('badges-toggle').listeners.get('change'), 1);
  runInContext('renderOrientation()', context);
  assert.equal(element('orientation-offset').disabled, true);
  runInContext('status = {connected: true, transport: "wifi", state: "idle", character: "copilot", '
    + 'port: "http://192.0.2.7:80", network: {ssid: "Home <Wi-Fi>", connected: true}, '
    + 'orientation: {offsetDegrees: 0}, firmware: {}}; renderStatus()', context);
  assert.equal(element('orientation-offset').disabled, false);
  assert.equal(element('fact-connection').textContent, 'Wi-Fi connected');
  assert.equal(element('fact-connection').className, 'connected');
  assert.equal(element('fact-address').textContent, '192.0.2.7');
  assert.equal(element('fact-network').textContent, 'Home <Wi-Fi>');
  assert.equal(element('fact-state').textContent, 'Idle');
  runInContext('status.network.connected = false; renderStatus()', context);
  assert.equal(element('fact-network').textContent, 'Home <Wi-Fi> (not connected)');
  runInContext('status.network = null; renderStatus()', context);
  assert.equal(element('fact-network').textContent, 'Not reported');
  runInContext('wifiScanned = true; status.transport = "usb"; status.port = "/dev/cu.usbmodem7"; renderStatus()', context);
  assert.equal(element('fact-connection').textContent, 'USB connected');
  assert.equal(element('fact-connection').className, 'connected');
  assert.equal(element('fact-address').textContent, 'cu.usbmodem7');
  await runInContext('updateOrientationOffset(1.5)', context);
  assert.deepEqual(calls, [{path: '/api/orientation', offsetDegrees: 1.5}]);
  assert.equal(element('orientation-offset').value, '1.5');
  assert.equal(element('orientation-offset-value').textContent, '+1.5 deg');
  runInContext('status.installing = {}; renderOrientation()', context);
  assert.equal(element('orientation-offset').disabled, true);
  runInContext('status.installing = null; status.firmware = {device: "abc", built: "abc", canUpdate: false, '
    + 'usb: {release: "0.9.0", flasher: true, port: "/dev/test"}}; renderFirmware()', context);
  assert.equal(element('firmware-update').hidden, true);
  assert.equal(element('firmware-state').textContent, 'Current build installed');
  assert.equal(element('usb-firmware-recovery').open, false);
  assert.equal(element('usb-firmware-install').textContent, 'Replace with v0.9.0');
  assert.match(element('usb-firmware-hint').textContent, /replacement, not an update/);
  // A device that answers over Wi-Fi has companion firmware; only its USB link is silent.
  runInContext('status.connected = true; status.firmware.usb.unanswered = true; renderUsbFirmware()', context);
  assert.equal(element('usb-firmware-recovery').open, false);
  assert.equal(element('usb-firmware-state').textContent, 'USB not answering');
  assert.match(element('usb-firmware-hint').textContent, /Unplug the USB cable/);
  assert.equal(element('usb-firmware-install').textContent, 'Replace with v0.9.0');
  runInContext('status.connected = false; status.firmware.usb.unanswered = true; renderUsbFirmware()', context);
  assert.equal(element('usb-firmware-recovery').open, true);
  assert.equal(element('usb-firmware-install').textContent, 'Install v0.9.0');
  // The desktop app has no build of its own; it offers its release firmware as an update over USB.
  runInContext('status.connected = true; status.firmware = {device: "aaaaaaaaaaaaaaaa", built: null, canUpdate: false, '
    + 'usb: {release: "0.9.0", releaseId: "bbbbbbbbbbbbbbbb", flasher: true, port: "/dev/test"}}; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Update available');
  assert.equal(element('device-update-badge').hidden, false);
  assert.equal(element('firmware-update').hidden, false);
  assert.equal(element('firmware-update').disabled, false);
  assert.equal(element('firmware-update').textContent, 'Update to v0.9.0');
  assert.equal(element('firmware-update').dataset.usb, 'true');
  runInContext('status.firmware.usb.installing = {stage: "writing", percent: 5}; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Installing…');
  assert.equal(element('firmware-update').hidden, true);
  runInContext('status.firmware.usb.installing = null; status.firmware.device = "bbbbbbbbbbbbbbbb"; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'v0.9.0');
  assert.equal(element('device-update-badge').hidden, true);
  assert.equal(element('firmware-update').hidden, true);
  runInContext('status.connected = false', context);

  const versions = () => element('fact-versions').children;
  runInContext('status.service = {version: "0.10.0"}; status.desktop = {app: {state: "running", version: "0.10.0"}}; '
    + 'renderVersions()', context);
  assert.deepEqual(versions(), ['fact-line:Service v0.10.0', 'fact-line:Desktop app v0.10.0']);
  runInContext('status.desktop.app.version = "0.7.0"; renderVersions()', context);
  assert.deepEqual(versions(), ['fact-line:Service v0.10.0', 'fact-line:Desktop app v0.7.0',
    'fact-detail:The versions are different. Install the same release of both.']);
  runInContext('status.desktop.app = {state: "stopped", version: null}; status.service = {version: null}; '
    + 'renderVersions()', context);
  assert.deepEqual(versions(), ['fact-line:Service version unknown', 'fact-line:Desktop app not running']);
  runInContext('status.desktop.app = {state: "running"}; renderVersions()', context);
  assert.equal(versions()[1], 'fact-line:Desktop app version unknown');
  runInContext('renderStatus()', context);
  assert.equal(element('fact-connection').textContent, 'Not connected');
  assert.equal(element('fact-connection').className, '');
  runInContext('status.deviceEnabled = false; status.connected = false; renderStatus()', context);
  assert.equal(element('fact-connection').textContent, 'Desktop only');
  assert.equal(element('fact-connection').className, '');
  assert.equal(element('fact-address').textContent, 'Not connected');
  runInContext('status = null; renderStatus()', context);
  assert.equal(element('fact-connection').textContent, 'Service offline');
  assert.equal(element('fact-state').textContent, 'Unavailable');
  assert.equal(element('fact-address').textContent, 'Service offline');
  assert.equal(element('fact-network').textContent, 'Service offline');
  assert.equal(element('fact-versions').textContent, '—');
  assert.equal(element('fact-usage').textContent, '—');
});

test('confirmation dialogs focus Cancel, separate details, and reset between actions', async () => {
  let focused = '';
  let close: () => void = () => assert.fail('The dialog close handler is missing.');
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  function makeElement(id: string) {
    return {
      textContent: '', hidden: false, open: false, className: '', returnValue: '',
      focus() { focused = id; },
      showModal() { this.open = true; },
      addEventListener(type: string, listener: () => void, options: {once: boolean}) {
        assert.equal(type, 'close');
        assert.equal(options.once, true);
        close = () => { this.open = false; listener(); };
      },
    };
  }
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id)!;
  }
  const draws: number[] = [];
  const context = createContext({
    $: element,
    toast() {},
    drawAgentIcon(_canvas: unknown, _icon: unknown, size: number) { draws.push(size); },
  });

  const source = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function confirmAction(');
  const end = source.indexOf('\nasync function removeCharacter(', start);
  assert.ok(start >= 0 && end > start);
  runInContext(source.slice(start, end), context);

  const cancelled: Promise<boolean> = runInContext(`confirmAction('Only Agent Buddy hooks are removed.',
    'Remove hooks', '/home/test/.codex/config.toml', {title: 'Disconnect Codex?',
      context: 'Agent connection', note: 'Restart open Codex sessions.', danger: true, icon: {id: 'codex'}})`, context);
  assert.equal(element('confirm-title').textContent, 'Disconnect Codex?');
  assert.equal(element('confirm-context').textContent, 'Agent connection');
  assert.equal(element('confirm-note').textContent, 'Restart open Codex sessions.');
  assert.equal(element('confirm-note').hidden, false);
  assert.equal(element('confirm-details').hidden, false);
  assert.equal(element('confirm-details').open, false);
  assert.equal(element('confirm-file-list').textContent, '/home/test/.codex/config.toml');
  assert.equal(element('confirm-ok').textContent, 'Remove hooks');
  assert.match(element('confirm-ok').className, /confirm-destructive/);
  assert.equal(element('confirm-logo').hidden, true);
  assert.equal(element('confirm-agent-icon').hidden, false);
  assert.deepEqual(draws, [48]);
  assert.equal(focused, 'confirm-cancel');
  assert.equal(await runInContext("confirmAction('Install firmware?', 'Install firmware')", context), false);
  assert.equal(element('confirm-title').textContent, 'Disconnect Codex?');
  assert.equal(element('confirm-ok').textContent, 'Remove hooks');
  close();
  assert.equal(await cancelled, false);

  element('confirm-details').open = true;
  const approved: Promise<boolean> = runInContext("confirmAction('Install the selected hooks?', 'Install')", context);
  assert.equal(element('confirm-title').textContent, 'Install');
  assert.equal(element('confirm-context').textContent, 'Confirm change');
  assert.equal(element('confirm-message').textContent, 'Install the selected hooks?');
  assert.equal(element('confirm-note').textContent, '');
  assert.equal(element('confirm-note').hidden, true);
  assert.equal(element('confirm-details').hidden, true);
  assert.equal(element('confirm-details').open, false);
  assert.equal(element('confirm-file-list').textContent, '');
  assert.equal(element('confirm-ok').className, '');
  assert.equal(element('confirm-logo').hidden, false);
  assert.equal(element('confirm-agent-icon').hidden, true);
  element('confirm').returnValue = 'ok';
  close();
  assert.equal(await approved, true);

  const uninstall: Promise<boolean> = runInContext("confirmAction('Uninstall the app?', 'Uninstall')", context);
  assert.match(element('confirm-ok').className, /confirm-destructive/);
  assert.equal(element('confirm').returnValue, '');
  close();
  assert.equal(await uninstall, false);
});

test('character catalog refreshes coalesce in-flight changes and retain a retry path after failure', async () => {
  let complete!: (value: unknown[]) => void;
  let entered!: () => void;
  const refreshing = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  let renders = 0;
  const messages: string[] = [];
  const context = createContext({
    api: () => {
      requests++;
      if (requests === 2) entered();
      return new Promise<unknown[]>(resolve => { complete = resolve; });
    },
    onboarding: {update() { renders++; }},
    toast: (message: string) => { messages.push(message); },
    renderCharacters() {}, renderStatus() {},
  });
  const source = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function loadCharacters()');
  const end = source.indexOf('\nasync function installCharacter(', start);
  runInContext(`let charactersLoading = null, charactersReload = false, charactersLoaded = false;
    let charactersRetryAt = 0, characters = [], status = {onboarding: {completed: false}};`, context);
  runInContext(source.slice(start, end), context);
  const first: Promise<void> = runInContext('loadCharacters()', context);
  const second: Promise<void> = runInContext('loadCharacters()', context);
  assert.equal(first, second);
  assert.equal(requests, 1);
  complete([{id: 'copilot'}]);
  await refreshing;
  assert.equal(requests, 2);
  complete([{id: 'copilot'}, {id: 'custom'}]);
  await first;
  assert.equal(renders, 2);
  assert.equal(runInContext('characters.length', context), 2);
  assert.equal(runInContext('charactersLoading', context), null);
  runInContext("api = async () => { throw new Error('Catalog offline.'); }", context);
  await runInContext('loadCharacters()', context);
  assert.deepEqual(messages, ['Catalog offline.']);
  assert.ok(runInContext('charactersRetryAt', context) > Date.now());
  assert.equal(runInContext('characters.length', context), 2);
  runInContext("api = async () => [{id: 'copilot'}]", context);
  await runInContext('loadCharacters()', context);
  assert.equal(runInContext('charactersRetryAt', context), 0);
  assert.equal(runInContext('characters.length', context), 1);
});

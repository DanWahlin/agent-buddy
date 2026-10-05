import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createContext, runInContext} from 'node:vm';

test('web alignment controls initialize once and send confirmed settings', async () => {
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  function makeElement() {
    return {
      value: '0', disabled: false, checked: false, hidden: false, open: false, textContent: '', className: '',
      style: {setProperty() {}}, dataset: {},
      classList: {toggle() {}, add() {}, remove() {}},
      listeners: new Map<string, number>(),
      addEventListener(type: string) {
        this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
      },
      querySelector() { return {disabled: false, setAttribute() {}}; },
      setAttribute() {}, removeAttribute() {},
    };
  }
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id)!;
  }
  const calls: Array<{path: string; offsetDegrees: number}> = [];
  const context = createContext({
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      documentElement: {dataset: {theme: 'light'}},
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
  runInContext(text, context);
  assert.equal(runInContext('typeof renderOrientation', context), 'function');
  assert.equal(element('orientation-right').listeners.get('click'), 1);
  runInContext('renderOrientation()', context);
  assert.equal(element('orientation-offset').disabled, true);
  runInContext('status = {connected: true, transport: "wifi", state: "idle", character: "copilot", '
    + 'orientation: {offsetDegrees: 0}, firmware: {}}; renderStatus()', context);
  assert.equal(element('orientation-offset').disabled, false);
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
  runInContext('status.connected = false; status.firmware.usb.unanswered = true; renderUsbFirmware()', context);
  assert.equal(element('usb-firmware-recovery').open, true);
  assert.equal(element('usb-firmware-install').textContent, 'Install v0.9.0');
});

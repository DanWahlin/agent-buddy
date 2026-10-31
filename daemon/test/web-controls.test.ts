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
      options: [] as Array<{text: string; value: string}>,
      replaceChildren(...items: Array<{text: string; value: string}>) { this.options = items; },
      add(item: {text: string; value: string}) { this.options.push(item); },
      focus() {},
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
      firstElementChild: {style: {} as Record<string, string>},
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
    Option: class { constructor(readonly text: string, readonly value: string) {} },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      documentElement: {dataset: {theme: 'light'}},
      body: {classList: {toggle() {}, remove() {}}},
      createElement: () => ({textContent: '', className: ''}),
    },
    location: {hash: '', pathname: '/'},
    navigator: {userAgent: 'Windows NT'},
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
  // Device connection says how the device is reached, and Detect device says why it is not.
  assert.equal(element('device-connection-state').textContent, 'USB connected');
  assert.equal(element('device-connection-hint').textContent, 'The device is connected over USB on /dev/cu.usbmodem7.');
  assert.equal(element('device-detect').disabled, false);
  // Settings shows the device: its board, connection, firmware, character, MAC address, and protocol.
  runInContext('status.firmware = {board: "waveshare-lcd-154", device: "cccccccccccccccc", built: null, usb: {release: "0.9.0", '
    + 'releaseId: "cccccccccccccccc", boards: [{id: "waveshare-lcd-154", name: "Waveshare ESP32-S3-Touch-LCD-1.54", '
    + 'models: "Waveshare ESP32-S3-Touch-LCD-1.54", releaseId: "cccccccccccccccc"}]}}; '
    + 'status.device = {variant: "standard", macAddress: "B8:1F:3F:D8:37:98", protocol: 12, choices: [], '
    + 'waiting: [], silentPorts: []}; renderStatus()', context);
  assert.equal(element('device-connection-hint').textContent,
               'Waveshare ESP32-S3-Touch-LCD-1.54 is connected over USB on /dev/cu.usbmodem7.');
  assert.equal(element('device-facts').hidden, false);
  assert.deepEqual(element('device-facts').children, [
    ':Board', ':Waveshare ESP32-S3-Touch-LCD-1.54 (waveshare-lcd-154, variant standard)',
    ':Connection', ':USB, /dev/cu.usbmodem7', ':Firmware', ':Release v0.9.0 (cccccccccccccccc)',
    ':Character', ':copilot', ':MAC address', ':B8:1F:3F:D8:37:98', ':Protocol', ':12']);
  assert.equal(element('device-choices').hidden, true);
  assert.equal(element('fact-board').textContent, 'Waveshare ESP32-S3-Touch-LCD-1.54 (waveshare-lcd-154, variant standard)');
  assert.equal(element('fact-firmware').textContent, 'Release v0.9.0 (cccccccccccccccc)');
  assert.equal(element('fact-mac').textContent, 'B8:1F:3F:D8:37:98');
  assert.ok(element('fact-connection').children.includes('fact-detail:Waveshare ESP32-S3-Touch-LCD-1.54'));
  // A device that does not report its board, or one that this app version doesn't know, says so.
  runInContext('status.firmware.board = null; renderStatus()', context);
  assert.match(element('fact-board').textContent, /^Not reported\. The device runs older firmware/);
  runInContext('status.firmware.board = "waveshare-future"; status.device.variant = null; renderStatus()', context);
  assert.equal(element('fact-board').textContent,
               'waveshare-future. This version of the app has no firmware for this board.');
  // Several devices that answer on USB: none is used, and the person chooses one.
  runInContext('status.connected = false; status.device.choices = [{path: "/dev/cu.usbmodem1", pid: 4097, '
    + 'serialNumber: "AA:BB:CC:DD:EE:01", board: "waveshare-lcd-154", variant: "standard", character: "copilot", '
    + 'firmware: "cccccccccccccccc"}, {path: "/dev/cu.usbmodem2", pid: 4097, serialNumber: "AA:BB:CC:DD:EE:02", '
    + 'board: null, variant: null, character: null, firmware: null}]; renderStatus()', context);
  assert.equal(element('device-connection-state').textContent, 'Choose a device');
  assert.match(element('device-connection-hint').textContent, /uses none of them until you choose one/);
  assert.equal(element('device-facts').hidden, true);
  assert.equal(element('device-choices').hidden, false);
  runInContext('status.firmware.usb.flasher = true; renderUsbFirmware()', context);
  assert.equal(element('usb-firmware-state').textContent, 'Choose a device');
  assert.match(element('usb-firmware-hint').textContent, /uses no device until you choose one under Device connection/);
  assert.deepEqual(element('device-choices').children, [
    'device-choice:Waveshare ESP32-S3-Touch-LCD-1.54 · on /dev/cu.usbmodem1 · USB serial number AA:BB:CC:DD:EE:01 · copilot',
    'secondary:Use this device',
    'device-choice:Board not reported · on /dev/cu.usbmodem2 · USB serial number AA:BB:CC:DD:EE:02',
    'secondary:Use this device']);
  // A device that answers on the selected port reports its board, also while the person chooses.
  runInContext('$("usb-firmware-port").value = "/dev/cu.usbmodem1"', context);
  assert.equal(runInContext('reportedUsbBoard()', context), 'waveshare-lcd-154');
  runInContext('$("usb-firmware-port").value = "/dev/cu.usbmodem2"', context);
  assert.equal(runInContext('reportedUsbBoard()', context), null);
  runInContext('$("usb-firmware-port").value = ""', context);
  // One device answers, and another that answered before is silent now: the person still chooses.
  runInContext('status.device.choices = status.device.choices.slice(0, 1); status.device.waiting = '
    + '[{path: "/dev/cu.usbmodem3", pid: 4097, serialNumber: "AA:BB:CC:DD:EE:03"}]; renderStatus()', context);
  assert.equal(element('device-connection-state').textContent, 'Choose a device');
  assert.match(element('device-connection-hint').textContent,
               /^The Agent Buddy device on \/dev\/cu\.usbmodem3 \(USB serial number AA:BB:CC:DD:EE:03\) does not answer now\./);
  assert.equal(element('device-choices').children.length, 2);
  // Without choices, a silent device and other ESP32 devices are named.
  runInContext('status.device.choices = []; status.device.silentPorts = ["/dev/cu.usbmodem4"]; renderStatus()', context);
  assert.equal(element('device-connection-state').textContent, 'Not connected');
  assert.match(element('device-connection-hint').textContent,
               /usbmodem3.*does not answer now.*ESP32 device on \/dev\/cu\.usbmodem4 does not answer as Agent Buddy/);
  runInContext('status.device.waiting = []; status.device.silentPorts = []; status.device.choices = ['
    + '{path: "/dev/cu.usbmodem1", pid: 4097, serialNumber: "AA:BB:CC:DD:EE:01", board: "waveshare-lcd-154", '
    + 'variant: "standard", character: "copilot", firmware: "cccccccccccccccc"}, {path: "/dev/cu.usbmodem2", pid: 4097, '
    + 'serialNumber: "AA:BB:CC:DD:EE:02", board: null, variant: null, character: null, firmware: null}]; renderStatus()',
  context);
  const chosen: unknown[] = [];
  context.chosen = chosen;
  context.apiBefore = runInContext('api', context);
  runInContext('api = async (path, options) => { chosen.push({path, body: JSON.parse(options.body)}); return {}; }; '
    + 'refreshStatus = async () => undefined; toastBefore = toast; toast = () => undefined', context);
  await runInContext('chooseDevice("/dev/cu.usbmodem2")', context);
  assert.deepEqual(JSON.parse(JSON.stringify(chosen)), [{path: '/api/devices/choose', body: {path: '/dev/cu.usbmodem2'}}]);
  runInContext('api = apiBefore; toast = toastBefore; status.device.choices = []; status.connected = true; '
    + 'status.firmware = {}; renderStatus()', context);
  const views = JSON.parse(runInContext(`JSON.stringify(['no-device', 'wifi-mode', 'usb-unavailable', 'usb-not-answering',
    'several-devices']
    .map(result => detectionView({result, ports: ['COM3'], mode: 'auto', wifiPaired: true, error: 'Access denied'})))`,
  context)) as Array<{pill: string; hint: string}>;
  assert.equal(views[0]!.pill, 'Not found');
  assert.match(views[0]!.hint, /charge-only cable.*not to a WSL terminal.*paired Wi-Fi device did not answer/);
  assert.match(views[1]!.hint, /\(COM3\).*Connection mode is Wi-Fi/);
  assert.equal(views[2]!.pill, 'USB port in use');
  assert.match(views[2]!.hint, /COM3 could not be opened \(Access denied\)\. Close other programs/);
  assert.match(views[3]!.hint, /COM3.*does not answer as Agent Buddy.*USB release install or recovery/);
  assert.equal(views[4]!.pill, 'Choose a device');
  assert.match(views[4]!.hint, /Several Agent Buddy devices answer on USB \(COM3\).*remembers your choice/);
  runInContext('detection = {found: {result: "usb-not-answering", ports: ["COM3"]}, key: connectionKey()}; '
    + 'renderDeviceConnection()', context);
  assert.equal(element('device-connection-state').textContent, 'Not answering');
  // A change in the connection replaces what Detect device found.
  runInContext('status.connected = false; renderDeviceConnection()', context);
  assert.equal(element('device-connection-state').textContent, 'Not connected');
  assert.match(element('device-connection-hint').textContent, /select Detect device to find out why/);
  runInContext('status.deviceEnabled = false; renderDeviceConnection()', context);
  assert.equal(element('device-connection-state').textContent, 'Off');
  assert.equal(element('device-detect').disabled, true);
  runInContext('status.connected = true; status.deviceEnabled = true; renderDeviceConnection()', context);
  await runInContext('updateOrientationOffset(1.5)', context);
  assert.deepEqual(calls, [{path: '/api/orientation', offsetDegrees: 1.5}]);
  assert.equal(element('orientation-offset').value, '1.5');
  assert.equal(element('orientation-offset-value').textContent, '+1.5 deg');
  runInContext('status.installing = {}; renderOrientation()', context);
  assert.equal(element('orientation-offset').disabled, true);
  runInContext('status.installing = null; status.firmware = {device: "abc", built: "abc", canUpdate: false, '
    + 'board: "waveshare-amoled-175", usb: {release: "0.9.0", releaseBoard: "waveshare-amoled-175", flasher: true, '
    + 'port: "/dev/test"}}; renderFirmware()', context);
  assert.equal(element('firmware-update').hidden, true);
  assert.equal(element('firmware-state').textContent, 'Current build installed');
  // The build from this computer is the default board's: a device of another board is not offered it.
  runInContext('status.firmware.board = "waveshare-amoled-206"; status.firmware.device = "def"; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Installed');
  assert.doesNotMatch(element('firmware-hint').textContent, /built firmware/);
  runInContext('status.firmware.board = "waveshare-amoled-175"; status.firmware.device = "abc"; renderFirmware()', context);
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
    + 'board: "waveshare-amoled-175", usb: {release: "0.9.0", releaseId: "bbbbbbbbbbbbbbbb", flasher: true, '
    + 'port: "/dev/test"}}; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Update available');
  assert.equal(element('device-update-badge').hidden, false);
  assert.equal(element('firmware-update').hidden, false);
  assert.equal(element('firmware-update').disabled, false);
  assert.equal(element('firmware-update').textContent, 'Update to v0.9.0');
  assert.equal(element('firmware-update').dataset.usb, 'true');
  // Each board has its own release firmware; a device that answers over USB decides the board.
  runInContext('status.port = "/dev/test"; $("usb-firmware-port").value = "/dev/test"; '
    + 'status.firmware.board = "waveshare-lcd-154"; status.firmware.usb.boards = ['
    + '{id: "waveshare-amoled-175", name: "Waveshare ESP32-S3-Touch-AMOLED-1.75", '
    + 'models: "Waveshare ESP32-S3-Touch-AMOLED-1.75-B or -C", releaseId: "bbbbbbbbbbbbbbbb"}, '
    + '{id: "waveshare-lcd-154", name: "Waveshare ESP32-S3-Touch-LCD-1.54", '
    + 'models: "Waveshare ESP32-S3-Touch-LCD-1.54", releaseId: "cccccccccccccccc"}]; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Update available');
  assert.match(element('firmware-hint').textContent, /for the Waveshare ESP32-S3-Touch-LCD-1.54 is available/);
  assert.deepEqual(element('usb-firmware-board').options.map(option => option.value),
                   ['', 'waveshare-amoled-175', 'waveshare-lcd-154']);
  assert.equal(element('usb-firmware-board').value, 'waveshare-lcd-154');
  assert.equal(element('usb-firmware-board').disabled, true);
  assert.match(element('usb-board-message').textContent, /reports that it is a Waveshare ESP32-S3-Touch-LCD-1.54/);
  assert.equal(element('usb-firmware-install').disabled, false);
  const installs: unknown[] = [];
  const prompts: string[] = [];
  context.installs = installs;
  context.prompts = prompts;
  runInContext('confirmAction = async message => { prompts.push(message); return true; }; '
    + 'api = async (path, options) => { installs.push({path, body: JSON.parse(options.body)}); return {}; }; '
    + 'toast = message => prompts.push(`toast: ${message}`)', context);
  await runInContext('installReleaseOverUsb()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(installs)), [{path: '/api/firmware/usb', body: {port: '/dev/test', board: 'waveshare-lcd-154', confirmed: true}}]);
  // The board that a device on another port reports is not used for the selected port.
  runInContext('$("usb-firmware-port").value = "/dev/other"; renderFirmware()', context);
  assert.equal(element('usb-firmware-board').value, '');
  assert.equal(element('usb-firmware-board').disabled, false);
  await runInContext('installReleaseOverUsb()', context);
  assert.equal(installs.length, 1);
  assert.equal(prompts.at(-1), 'toast: Select the board of the device, then install again.');
  runInContext('$("usb-firmware-port").value = "/dev/test"; renderFirmware()', context);
  assert.equal(element('usb-firmware-board').value, 'waveshare-lcd-154');
  assert.match(prompts[0]!, /^Confirm that \/dev\/test is your Waveshare ESP32-S3-Touch-LCD-1.54\.\n\nInstall published release v0.9.0 for the Waveshare ESP32-S3-Touch-LCD-1.54\?/);
  // A device that does not answer cannot say: the person must choose a board first.
  runInContext('status.connected = false; $("usb-firmware-board").value = ""; renderFirmware()', context);
  assert.equal(element('usb-firmware-board').disabled, false);
  assert.equal(element('usb-firmware-board').value, '');
  await runInContext('installReleaseOverUsb()', context);
  assert.equal(installs.length, 1);
  assert.equal(prompts.at(-1), 'toast: Select the board of the device, then install again.');
  assert.equal(element('usb-firmware-recovery').open, true);
  runInContext('$("usb-firmware-board").value = "waveshare-amoled-175"', context);
  await runInContext('installReleaseOverUsb()', context);
  assert.deepEqual(JSON.parse(JSON.stringify((installs[1] as {body: unknown}).body)), {port: '/dev/test', board: 'waveshare-amoled-175', confirmed: true});
  assert.match(prompts.at(-1)!, /Waveshare ESP32-S3-Touch-AMOLED-1.75-B or -C/);
  runInContext('status.connected = true; renderFirmware()', context);
  // A board that releases have no firmware for keeps its own firmware: neither row offers one.
  runInContext('status.firmware.board = "custom-board"; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Other board');
  assert.match(element('firmware-hint').textContent, /reports that it is a custom-board board, and releases of this version of the app have no firmware.*BOARD=custom-board/);
  assert.equal(element('device-update-badge').hidden, true);
  assert.equal(element('firmware-update').hidden, true);
  assert.equal(element('usb-firmware-state').textContent, 'Other board');
  assert.equal(element('usb-firmware-install').disabled, true);
  runInContext('status.firmware.board = "waveshare-amoled-175"; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Update available');
  assert.equal(element('usb-firmware-install').disabled, false);
  // A device that does not report its board is not compared with any board's release firmware.
  runInContext('status.firmware.board = null; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Board not reported');
  assert.match(element('firmware-hint').textContent, /does not say which board it is.*select the board/);
  assert.equal(element('firmware-update').textContent, 'Update to v0.9.0');
  assert.equal(element('usb-firmware-state').textContent, 'Board not reported');
  runInContext('status.firmware.board = "waveshare-amoled-175"; '
    + 'status.firmware.usb.installing = {stage: "writing", percent: 5}; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Writing 5%');
  assert.match(element('firmware-hint').textContent, /Keep the USB cable connected/);
  assert.equal(element('firmware-bar').hidden, false);
  assert.equal(element('firmware-bar').firstElementChild.style.width, '5%');
  // The button stays, disabled, so the row keeps its size.
  assert.equal(element('firmware-update').hidden, false);
  assert.equal(element('firmware-update').disabled, true);
  // The device does not answer while it is written, but the recovery section stays as it was.
  element('usb-firmware-recovery').open = false;
  runInContext('status.connected = false; status.firmware.usb.unanswered = true; renderFirmware()', context);
  assert.equal(element('usb-firmware-recovery').open, false);
  runInContext('status.connected = true; status.firmware.usb.unanswered = false; '
    + 'status.firmware.usb.installing = {stage: "downloading", percent: null}; renderFirmware()', context);
  assert.equal(element('firmware-state').textContent, 'Downloading…');
  assert.match(element('firmware-hint').textContent, /Downloading the v0\.9\.0 firmware/);
  assert.equal(element('firmware-bar').hidden, true);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {SerialPortMock} from 'serialport';
import {macFromDeviceId, macFromUsbSerial} from '../src/device-transport.js';
import {boardVariant, candidatePorts, deviceSummary, espressifPorts, pickPort, UsbTransport} from '../src/usb-transport.js';

const MockBinding = SerialPortMock.binding;
type MockPortBinding = Awaited<ReturnType<typeof MockBinding.open>>;
const openPort = MockBinding.open.bind(MockBinding);
const portPath = (index: number) => process.platform === 'win32' ? `COM${10 + index}`
  : process.platform === 'darwin' ? `/dev/cu.usbmodem10${index}` : `/dev/ttyACM${index}`;

interface FakeDevice {
  answers: boolean;
  board: string | null;
  character: string;
  // INFO requests the device got, answered or not.
  asked: number;
  // Runs on a Wi-Fi scan request, with the function that sends the device's reply lines.
  wifiScan?: (reply: (line: string) => void) => void;
}

// Espressif ports, each with a device that answers as an Agent Buddy or stays silent. The mock gives
// each port a serial number: "1", "2", and so on, in the order they are plugged in.
const byPath = new Map<string, FakeDevice>();

function plugIn(index: number, device: Partial<FakeDevice>): FakeDevice {
  const path = portPath(index);
  MockBinding.createPort(path, {echo: false, record: false, vendorId: '303a', productId: '1001'});
  const fake = {answers: true, board: 'waveshare-amoled-206', character: 'copilot', asked: 0, ...device};
  byPath.set(path, fake);
  return fake;
}

function fakeDevices(devices: Array<Partial<FakeDevice>>): Map<string, FakeDevice> {
  MockBinding.reset();
  byPath.clear();
  devices.forEach((device, index) => plugIn(index + 1, device));
  MockBinding.open = async openOptions => {
    const binding: MockPortBinding = await openPort(openOptions);
    const device = byPath.get(openOptions.path)!;
    const write = binding.write.bind(binding);
    const reply = (line: string): void => { setImmediate(() => binding.isOpen && binding.emitData(`${line}\n`)); };
    binding.write = async (buffer: Buffer) => {
      await write(buffer);
      const text = buffer.toString('latin1');
      if (text === 'i') device.asked++;
      if (!device.answers) return;
      if (text === 'i') {
        return reply(`INFO protocol=12 firmware=0123456789abcdef character=${device.character}`
          + (device.board ? `\nBOARD id=${device.board} variant=standard` : ''));
      }
      if (text === 'o') return reply('ORIENTATION_SETTINGS offset_tenths=0');
      if (text === 'w') return device.wifiScan?.(reply);
      const command = /^!(\w+)\n$/.exec(text);
      if (command) reply(`COMMAND accepted=${command[1]}`);
    };
    return binding;
  };
  return byPath;
}

async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the test condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('of several ESP32 devices on USB, the only one that answers as Agent Buddy is used', async () => {
  const devices = fakeDevices([{answers: false}, {board: 'waveshare-lcd-154', character: 'ghost'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(2));
    assert.equal(usb.board, 'waveshare-lcd-154');
    assert.equal(usb.variant, 'standard');
    assert.equal(usb.serialNumber, '2');
    assert.equal(usb.character, 'ghost');
    assert.deepEqual(usb.choices, []);
    assert.equal(usb.unanswered, null);
    // Both devices were asked; the one that answered was asked again when it was opened.
    assert.ok(devices.get(portPath(1))!.asked >= 1);
    assert.ok(devices.get(portPath(2))!.asked >= 2);
  } finally {
    await usb.stop();
  }
});

test('when several devices answer, none is used until the person chooses one, and the choice is kept', async () => {
  fakeDevices([{board: 'waveshare-amoled-175'}, {board: 'waveshare-amoled-206', character: 'ghost'}]);
  const changes: string[] = [];
  const usb = new UsbTransport(() => changes.push('change'), undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.choices.length === 2);
    assert.equal(usb.connected, false);
    assert.deepEqual(usb.choices.map(({path, serialNumber, board, variant, character, firmware}) =>
      ({path, serialNumber, board, variant, character, firmware})), [
      {path: portPath(1), serialNumber: '1', board: 'waveshare-amoled-175', variant: 'standard', character: 'copilot',
       firmware: '0123456789abcdef'},
      {path: portPath(2), serialNumber: '2', board: 'waveshare-amoled-206', variant: 'standard', character: 'ghost',
       firmware: '0123456789abcdef'},
    ]);
    assert.ok(changes.length > 0);
    // Another scan finds the same devices, and still uses none of them.
    await usb.scanNow();
    assert.equal(usb.connected, false);
    assert.equal(usb.unanswered, null);
    await usb.chooseDevice({serialNumber: '2', path: portPath(2)});
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(2));
    assert.equal(usb.board, 'waveshare-amoled-206');
    assert.deepEqual(usb.choices, []);
    assert.deepEqual(usb.waiting, []);
  } finally {
    await usb.stop();
  }
});

test('a saved choice picks its device among several that answer, matched by serial number', async () => {
  fakeDevices([{board: 'waveshare-amoled-175'}, {board: 'waveshare-amoled-206'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  // The port changed since the choice; the serial number still finds the device.
  usb.setChosenDevice({serialNumber: '1', path: portPath(9)});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(1));
    assert.equal(usb.board, 'waveshare-amoled-175');
  } finally {
    await usb.stop();
  }
});

test('another device is not used while the chosen device is plugged in but silent', async () => {
  const devices = fakeDevices([{answers: false}, {board: 'waveshare-lcd-154'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  usb.setChosenDevice({serialNumber: '1', path: portPath(1)});
  try {
    usb.start();
    await until(() => usb.choices.length === 1);
    assert.equal(usb.connected, false);
    assert.equal(usb.choices[0]!.path, portPath(2));
    assert.deepEqual(usb.waiting.map(port => port.path), [portPath(1)]);
    assert.deepEqual(usb.silentPorts, []);
    // When the chosen device answers again, it is used.
    devices.get(portPath(1))!.answers = true;
    await usb.scanNow();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(1));
  } finally {
    await usb.stop();
  }
});

test('a device that answered before still counts while it is busy, so the other is not picked', async () => {
  const devices = fakeDevices([{board: 'waveshare-amoled-175'}, {board: 'waveshare-amoled-206'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.choices.length === 2);
    // The first device installs a character over Wi-Fi and does not read USB for a while.
    devices.get(portPath(1))!.answers = false;
    await usb.scanNow();
    assert.equal(usb.connected, false);
    assert.deepEqual(usb.choices.map(choice => choice.path), [portPath(2)]);
    assert.deepEqual(usb.waiting.map(port => port.path), [portPath(1)]);
    assert.deepEqual(usb.unanswered, null);
  } finally {
    await usb.stop();
  }
});

test('a connection to another device switches to the chosen device when it answers', async () => {
  fakeDevices([{board: 'waveshare-lcd-154'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50, chosenCheckMs: 0});
  usb.setChosenDevice({serialNumber: '2', path: portPath(2)});
  try {
    usb.start();
    // The chosen device is not plugged in, and only one device is there: it is used.
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(1));
    plugIn(2, {board: 'waveshare-amoled-206'});
    await until(() => usb.connected && usb.path === portPath(2), 8000);
    assert.equal(usb.board, 'waveshare-amoled-206');
  } finally {
    await usb.stop();
  }
});

test('a switch to the chosen device waits for the command that runs on the connected device', async () => {
  const devices = fakeDevices([{board: 'waveshare-lcd-154'}]);
  let endScan: (() => void) | undefined;
  devices.get(portPath(1))!.wifiScan = reply => { endScan = () => reply('WIFI_SCAN_END count=0'); };
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50, chosenCheckMs: 0});
  usb.setChosenDevice({serialNumber: '2', path: portPath(2)});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(1));
    // The connected device scans for Wi-Fi networks when the chosen device is plugged in and answers.
    const scan = usb.scanWifi();
    await until(() => endScan !== undefined);
    const chosen = plugIn(2, {board: 'waveshare-amoled-206'});
    await until(() => chosen.asked > 0, 8000);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(usb.connected, true);
    assert.equal(usb.path, portPath(1));
    // The scan ends normally, and then the service switches to the chosen device.
    endScan!();
    assert.deepEqual(await scan, []);
    await until(() => usb.connected && usb.path === portPath(2), 8000);
  } finally {
    await usb.stop();
  }
});

test('a port that setup selected stays in use when another device is the chosen one', async () => {
  const devices = fakeDevices([{board: 'waveshare-amoled-175'}, {board: 'waveshare-amoled-206'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50, chosenCheckMs: 0});
  usb.setChosenDevice({serialNumber: '1', path: portPath(1)});
  try {
    await usb.selectPort(portPath(2));
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(2));
    // The scans while it is connected do not switch to the chosen device, and do not ask it.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(usb.connected, true);
    assert.equal(usb.path, portPath(2));
    assert.equal(devices.get(portPath(1))!.asked, 0);
  } finally {
    await usb.stop();
  }
});

test('a stop during a check of several ports connects nothing', async () => {
  fakeDevices([{answers: false}, {board: 'waveshare-lcd-154'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 200});
  try {
    usb.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    await usb.stop();
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(usb.connected, false);
    assert.equal(usb.path, null);
  } finally {
    await usb.stop();
  }
});

test('AGENT_COMPANION_PORT names the only port that is used', async () => {
  const devices = fakeDevices([{board: 'waveshare-amoled-175'}, {board: 'waveshare-amoled-206'}]);
  const previous = process.env.AGENT_COMPANION_PORT;
  process.env.AGENT_COMPANION_PORT = portPath(2);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50, chosenCheckMs: 0});
  // A chosen device does not replace the port that it names.
  usb.setChosenDevice({serialNumber: '1', path: portPath(1)});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.path, portPath(2));
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(usb.connected, true);
    assert.equal(usb.path, portPath(2));
    assert.equal(devices.get(portPath(1))!.asked, 0);
  } finally {
    await usb.stop();
    if (previous === undefined) delete process.env.AGENT_COMPANION_PORT;
    else process.env.AGENT_COMPANION_PORT = previous;
  }
  // A port that it names but that is not there connects nothing else.
  process.env.AGENT_COMPANION_PORT = portPath(9);
  const missing = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    missing.start();
    await missing.scanNow();
    assert.equal(missing.connected, false);
  } finally {
    await missing.stop();
    if (previous === undefined) delete process.env.AGENT_COMPANION_PORT;
    else process.env.AGENT_COMPANION_PORT = previous;
  }
});

test('several ESP32 devices that do not answer are reported, and nothing connects', async () => {
  fakeDevices([{answers: false}, {answers: false}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.silentPorts.length === 2);
    await usb.scanNow();
    assert.equal(usb.connected, false);
    assert.deepEqual(usb.unanswered, {path: portPath(1), pid: 0x1001, serialNumber: '1'});
    assert.deepEqual(usb.silentPorts.map(port => port.path), [portPath(1), portPath(2)]);
    assert.deepEqual(usb.choices, []);
  } finally {
    await usb.stop();
  }
});

test('a device without the BOARD line is a choice whose board is not reported', async () => {
  fakeDevices([{board: null}, {board: 'waveshare-amoled-206'}]);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 1000});
  try {
    usb.start();
    await until(() => usb.choices.length === 2);
    assert.equal(usb.choices[0]!.board, null);
    assert.equal(usb.choices[0]!.variant, null);
    assert.equal(usb.choices[1]!.board, 'waveshare-amoled-206');
  } finally {
    await usb.stop();
  }
});

test('reads device details from the INFO reply and the BOARD line', () => {
  assert.deepEqual(deviceSummary('INFO protocol=12 firmware=0123456789abcdef character=copilot', 'BOARD id=waveshare-amoled-175 variant=c'),
    {board: 'waveshare-amoled-175', variant: 'c', character: 'copilot', firmware: '0123456789abcdef'});
  assert.deepEqual(deviceSummary('INFO protocol=8 character=none', null),
    {board: null, variant: null, character: 'none', firmware: null});
  assert.equal(boardVariant('BOARD id=waveshare-amoled-206 variant=standard'), 'standard');
  assert.equal(boardVariant('BOARD id=waveshare-amoled-206 variant=standard extra=1'), 'standard');
  assert.equal(boardVariant('BOARD id=waveshare-amoled-206'), null);
  assert.deepEqual(espressifPorts([
    {path: '/dev/tty.usbmodem1', vendorId: '303A', productId: '1001', serialNumber: 'X'},
    {path: '/dev/tty.usbmodem2', vendorId: '2E8A'},
    {path: '/dev/tty.usbserial-3', vendorId: '303a'},
  ] as never, 'darwin'), [{path: '/dev/cu.usbmodem1', pid: 0x1001, serialNumber: 'X'}]);
  // macOS lists /dev/tty.* ports; a port named either way is the same one.
  const mac = [{path: '/dev/tty.usbmodem101', vendorId: '303a', productId: '1001'},
               {path: '/dev/tty.usbmodem102', vendorId: '303a', productId: '1001'}];
  assert.equal(pickPort(mac as never, '/dev/cu.usbmodem102', 'darwin')!.path, '/dev/cu.usbmodem102');
  assert.equal(pickPort(mac as never, '/dev/tty.usbmodem102', 'darwin')!.path, '/dev/cu.usbmodem102');
  assert.deepEqual(candidatePorts([{path: '/dev/tty.custom'}] as never, '/dev/cu.custom', 'darwin').map(port => port.path),
                   ['/dev/cu.custom']);
});

test('the MAC address comes from the USB serial number or from the Wi-Fi device ID', () => {
  assert.equal(macFromUsbSerial('B8:1F:3F:D8:37:98'), 'B8:1F:3F:D8:37:98');
  assert.equal(macFromUsbSerial('b81f3fd83798'), 'B8:1F:3F:D8:37:98');
  assert.equal(macFromUsbSerial('B8_1F_3F_D8_37_98'), 'B8:1F:3F:D8:37:98');
  assert.equal(macFromUsbSerial('test-board'), null);
  assert.equal(macFromUsbSerial(null), null);
  // NetworkManager::ensureIdentity prints ESP.getEfuseMac(), whose low byte is the MAC's first byte.
  assert.equal(macFromDeviceId('00009837d83f1fb8'), 'B8:1F:3F:D8:37:98');
  assert.equal(macFromDeviceId('12349837d83f1fb8'), null);
  assert.equal(macFromDeviceId(null), null);
});

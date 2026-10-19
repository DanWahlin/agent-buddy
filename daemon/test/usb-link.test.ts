import assert from 'node:assert/strict';
import test from 'node:test';
import {SerialPortMock} from 'serialport';
import {UsbTransport} from '../src/usb-transport.js';

const MockBinding = SerialPortMock.binding;
type MockPortBinding = Awaited<ReturnType<typeof MockBinding.open>>;
const path = process.platform === 'win32' ? 'COM9' : '/dev/cu.usbmodem9001';
// The preferred port passes the platform's port-name filter on every CI runner.
process.env.AGENT_COMPANION_PORT = path;
const openPort = MockBinding.open.bind(MockBinding);

// A device on the mock port that answers INFO, orientation, state, and upload requests. After
// an upload it restarts, and `silentAfterRestart` makes it stop answering, as a wedged USB link does.
function fakeDevice(options: {silentAfterRestart: boolean; silent?: boolean; stuckDrain?: boolean;
                             board?: string | null}) {
  MockBinding.reset();
  MockBinding.createPort(path, {echo: false, record: false, vendorId: '303a', productId: '1001'});
  const state = {character: 'copilot', silent: options.silent ?? false, received: 0, uploading: false,
                 board: options.board ?? null};
  MockBinding.open = async openOptions => {
    const binding: MockPortBinding = await openPort(openOptions);
    const write = binding.write.bind(binding);
    // Like tcdrain on macOS when the device stops reading its USB port: it never returns.
    const drain = binding.drain.bind(binding);
    binding.drain = () => state.silent && options.stuckDrain ? new Promise<void>(() => undefined) : drain();
    const reply = (line: string): void => { setImmediate(() => binding.isOpen && binding.emitData(`${line}\n`)); };
    binding.write = async (buffer: Buffer) => {
      await write(buffer);
      if (state.silent) return;
      const text = buffer.toString('latin1');
      if (state.uploading) {
        state.received += buffer.length;
        if (state.received < 8) return reply(`UPLOAD_ACK received=${state.received}`);
        state.uploading = false;
        state.character = 'bunny';
        reply('UPLOAD_OK character=bunny stalls=0 resyncs=0 rebooting');
        if (options.silentAfterRestart) state.silent = true;
        else setTimeout(() => reply('READY: character=bunny'), 5);
        return;
      }
      // The BOARD line comes in the same chunk as INFO, as the firmware sends them together.
      if (text === 'i') return reply(`INFO protocol=12 firmware=0123456789abcdef character=${state.character}`
        + (state.board ? `\nBOARD id=${state.board} variant=standard` : ''));
      if (text === 'o') return reply('ORIENTATION_SETTINGS offset_tenths=0');
      if (text === 'u') {
        state.uploading = true;
        state.received = 0;
        return reply('UPLOAD_READY max_bytes=4096 chunk=256');
      }
      const command = /^!(\w+)\n$/.exec(text);
      if (command) reply(`COMMAND accepted=${command[1]}`);
    };
    return binding;
  };
  return state;
}

async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the test condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('after a character upload, the transport reports the new character before the device answers again', async () => {
  fakeDevice({silentAfterRestart: true});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.character, 'copilot');
    assert.equal(await usb.installCharacter(Buffer.alloc(8)), 'bunny');
    assert.equal(usb.character, 'bunny');
  } finally {
    await usb.stop();
  }
});

test('a USB port that stops answering is closed after three timeouts in a row', async () => {
  fakeDevice({silentAfterRestart: true});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    usb.setState('working');
    usb.setState('idle');
    assert.equal(usb.connected, true);
    usb.setState('working');
    await until(() => !usb.connected);
  } finally {
    await usb.stop();
  }
});

test('a device that restarts normally keeps its USB link', async () => {
  fakeDevice({silentAfterRestart: false});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    for (const state of ['working', 'idle', 'working', 'idle'] as const) usb.setState(state);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(usb.connected, true);
    assert.equal(usb.character, 'bunny');
  } finally {
    await usb.stop();
  }
});

test('an open USB port does not count as connected until the device answers', async () => {
  fakeDevice({silentAfterRestart: false, silent: true});
  let changes = 0;
  const usb = new UsbTransport(() => { changes++; }, undefined, {serial: SerialPortMock, requestTimeoutMs: 100});
  try {
    usb.start();
    const end = Date.now() + 400;
    while (Date.now() < end) {
      assert.equal(usb.connected, false);
      assert.equal(usb.character, null);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Only the unanswered-port notice changes; a silent port never reports a connect or disconnect.
    assert.ok(changes <= 1);
  } finally {
    await usb.stop();
  }
});

test('a request to a device that stops reading fails at its timeout and does not crash the service', {timeout: 10_000}, async () => {
  fakeDevice({silentAfterRestart: true, stuckDrain: true});
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    for (const state of ['working', 'idle', 'working'] as const) usb.setState(state);
    await until(() => !usb.connected);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
    await usb.stop();
  }
});

test('the USB link reports the board that the device names, and no board for firmware without the line', async () => {
  const device = fakeDevice({silentAfterRestart: false, board: 'waveshare-lcd-154'});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    assert.equal(usb.board, null);
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.board, 'waveshare-lcd-154');
    // A restart into firmware without a BOARD line, which can't say its board.
    device.board = null;
    await usb.installCharacter(Buffer.alloc(8));
    // The restart clears the board, and the INFO reply after it names none.
    await until(() => usb.character === 'bunny' && usb.board === null);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(usb.board, null);
    assert.equal(usb.connected, true);
  } finally {
    await usb.stop();
  }
  assert.equal(usb.board, null);

  fakeDevice({silentAfterRestart: false});
  const old = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    old.start();
    await until(() => old.connected);
    assert.equal(old.connected, true);
    assert.equal(old.board, null);
  } finally {
    await old.stop();
  }
});

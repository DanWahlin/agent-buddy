import {spawn} from 'node:child_process';
import type {UsbPort} from './usb-transport.js';

export type UsbFlashStage = 'checking' | 'connecting' | 'writing';

export interface UsbFlashEvents {
  stage(stage: UsbFlashStage): void;
  progress(percent: number): void;
}

export type UsbFlasher = (program: string, dir: string, port: UsbPort, events: UsbFlashEvents) => Promise<void>;

// Writing 11 MB takes about a minute over the ESP32-S3's own USB port; a UART bridge is slower.
const flashTimeoutMs = 15 * 60_000;
const stages = new Set<string>(['checking', 'connecting', 'writing']);

export function usbFlashArguments(dir: string, port: UsbPort): string[] {
  return ['--flash-firmware', dir, '--port', port.path,
    ...(port.pid === null ? [] : ['--pid', port.pid.toString(16).padStart(4, '0')])];
}

// Runs the desktop app's `--flash-firmware` mode and follows the lines it prints (see flasher.rs).
export const runUsbFlasher: UsbFlasher = (program, dir, port, events) => new Promise((resolve, reject) => {
  const child = spawn(program, usbFlashArguments(dir, port), {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  let output = '';
  let errors = '';
  let result: {ok: true} | {ok: false; error: string} | null = null;
  const timer = setTimeout(() => {
    result = {ok: false, error: 'Installing the firmware took too long.'};
    child.kill();
  }, flashTimeoutMs);
  const line = (text: string) => {
    const [word, ...rest] = text.trim().split(' ');
    const value = rest.join(' ');
    if (word === 'stage' && stages.has(value)) events.stage(value as UsbFlashStage);
    else if (word === 'progress' && /^\d{1,3}$/.test(value)) events.progress(Math.min(100, Number(value)));
    else if (word === 'done') result ??= {ok: true};
    else if (word === 'error') result ??= {ok: false, error: value || 'The firmware install failed.'};
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    const lines = output.split('\n');
    output = lines.pop()!;
    lines.forEach(line);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    errors = (errors + chunk).slice(-2000);
  });
  child.on('error', error => {
    clearTimeout(timer);
    reject(new Error(`Couldn't start the desktop app to install firmware: ${error.message}`));
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (output) line(output);
    if (result?.ok) resolve();
    else if (result) reject(new Error(result.error));
    else reject(new Error(code === 0
      ? 'This desktop app cannot install firmware. Update the desktop app, open it, and try again.'
      : `The firmware install stopped (exit code ${code})${errors.trim() ? `: ${errors.trim().split('\n').pop()}` : ''}.`));
  });
});

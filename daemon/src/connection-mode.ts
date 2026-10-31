import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {connectionPreferencePath} from './paths.js';
import type {UsbDeviceChoice} from './usb-transport.js';

// auto prefers USB and falls back to Wi-Fi; wifi leaves a connected cable for power only.
export const connectionModes = ['auto', 'usb', 'wifi'] as const;
export type ConnectionMode = typeof connectionModes[number];

export function isConnectionMode(value: unknown): value is ConnectionMode {
  return typeof value === 'string' && (connectionModes as readonly string[]).includes(value);
}

// The device the person chose when several Agent Buddy devices answered on USB.
export function isUsbDeviceChoice(value: unknown): value is UsbDeviceChoice {
  if (typeof value !== 'object' || value === null) return false;
  const {serialNumber, path} = value as Record<string, unknown>;
  return (serialNumber === null || (typeof serialNumber === 'string' && serialNumber.length > 0 && serialNumber.length <= 128))
    && typeof path === 'string' && path.length > 0 && path.length <= 256;
}

// connection.json keeps the mode and the chosen USB device; each save keeps the other value.
async function readPreference(): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(connectionPreferencePath(), 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    // A missing or unreadable preference keeps the defaults.
    return {};
  }
}

async function savePreference(change: Record<string, unknown>): Promise<void> {
  const path = connectionPreferencePath();
  const value = {...await readPreference(), ...change};
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, path);
}

export async function loadConnectionMode(): Promise<ConnectionMode> {
  const {mode} = await readPreference();
  return isConnectionMode(mode) ? mode : 'auto';
}

export async function saveConnectionMode(mode: ConnectionMode): Promise<void> {
  await savePreference({mode});
}

export async function loadUsbDeviceChoice(): Promise<UsbDeviceChoice | null> {
  const {usbDevice} = await readPreference();
  return isUsbDeviceChoice(usbDevice) ? {serialNumber: usbDevice.serialNumber, path: usbDevice.path} : null;
}

export async function saveUsbDeviceChoice(choice: UsbDeviceChoice): Promise<void> {
  await savePreference({usbDevice: choice});
}

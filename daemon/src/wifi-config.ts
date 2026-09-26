import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {dirname} from 'node:path';
import {createSocket} from 'node:dgram';
import {wifiConfigPath} from './paths.js';

const discoveryPort = 4666;
const discoveryRequest = Buffer.from('ESP32_AGENT_COMPANION_DISCOVER_V1');

export interface WifiDevice {
  deviceId: string;
  hostname: string;
  address: string;
  port: number;
  boot: number;
}

export interface WifiConfig {
  deviceId: string;
  token: string;
  address?: string;
  port?: number;
}

export function validateWifiCredentials(ssid: string, password: string): void {
  const ssidLength = Buffer.byteLength(ssid, 'utf8');
  const passwordLength = Buffer.byteLength(password, 'utf8');
  if (ssidLength < 1 || ssidLength > 32)
    throw new Error('Wi-Fi network name must contain 1 to 32 bytes.');
  if (passwordLength > 63 || (passwordLength > 0 && passwordLength < 8))
    throw new Error('Wi-Fi password must be empty or contain 8 to 63 bytes.');
  if (ssid.includes('\0') || password.includes('\0'))
    throw new Error('Wi-Fi credentials cannot contain null characters.');
}

export function wifiProvisioningPacket(ssid: string, password: string): string {
  validateWifiCredentials(ssid, password);
  return `@${Buffer.from(ssid).toString('base64')}:${Buffer.from(password).toString('base64')}\n`;
}

export function parseWifiProvisioningResponse(line: string): WifiConfig {
  const match = /^WIFI configured device_id=([0-9a-f]{16}) token=([0-9a-f]{32})$/i.exec(line);
  if (!match) throw new Error('Device returned invalid Wi-Fi pairing data.');
  return {deviceId: match[1]!, token: match[2]!};
}

export async function loadWifiConfig(): Promise<WifiConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(wifiConfigPath(), 'utf8')) as Partial<WifiConfig>;
    if (!isHex(parsed.deviceId, 16) || !isHex(parsed.token, 32))
      throw new Error('Stored Wi-Fi pairing data is invalid.');
    return {
      deviceId: parsed.deviceId,
      token: parsed.token,
      address: isHost(parsed.address) ? parsed.address : undefined,
      port: validPort(parsed.port) ? parsed.port : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveWifiConfig(config: WifiConfig): Promise<void> {
  if (!isHex(config.deviceId, 16) || !isHex(config.token, 32))
    throw new Error('Device returned invalid Wi-Fi pairing data.');
  const path = wifiConfigPath();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
  await chmod(path, 0o600);
}

export function parseDiscovery(data: Buffer, address: string): WifiDevice | null {
  try {
    const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    if (value.service !== 'esp32-agent-companion' || value.protocol !== 1
        || !isHex(value.deviceId, 16) || typeof value.hostname !== 'string'
        || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
        || !Number.isInteger(value.boot) || Number(value.boot) < 0)
      return null;
    return {
      deviceId: value.deviceId,
      hostname: value.hostname,
      address,
      port: Number(value.port),
      boot: Number(value.boot),
    };
  } catch {
    return null;
  }
}

export function broadcastAddresses(
    interfaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>
      = networkInterfaces()): string[] {
  const addresses = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = ipv4(entry.address);
      const mask = ipv4(entry.netmask);
      if (ip === null || mask === null) continue;
      addresses.add(fromIpv4((ip | (~mask >>> 0)) >>> 0));
    }
  }
  return [...addresses];
}

export async function discoverWifiDevices(timeoutMs = 1200): Promise<WifiDevice[]> {
  const socket = createSocket({type: 'udp4', reuseAddr: true});
  const devices = new Map<string, WifiDevice>();
  socket.on('message', (data, remote) => {
    const device = parseDiscovery(data, remote.address);
    if (device) devices.set(device.deviceId, device);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      resolve();
    });
  });
  try {
    await Promise.all(broadcastAddresses().map(address =>
      new Promise<void>(resolve =>
        socket.send(discoveryRequest, discoveryPort, address, () => resolve()))));
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return [...devices.values()];
  } finally {
    socket.close();
  }
}

export async function pairWifi(code: string, preferredHost?: string): Promise<WifiConfig> {
  if (!/^\d{8}$/.test(code)) throw new Error('Pairing code must contain exactly eight digits.');
  if (preferredHost && !isHost(preferredHost))
    throw new Error('Wi-Fi host must be an IPv4 address or hostname.');
  let device: WifiDevice;
  if (preferredHost) {
    device = {deviceId: '', hostname: preferredHost, address: preferredHost, port: 80, boot: 0};
  } else {
    const devices = await discoverWifiDevices();
    if (!devices.length)
      throw new Error('No Agent Companion found. Confirm it is connected to the same Wi-Fi network.');
    if (devices.length > 1)
      throw new Error('Multiple Agent Companions found. Pass --host ADDRESS to choose one.');
    device = devices[0]!;
  }
  const response = await fetch(`http://${device.address}:${device.port}/pair`, {
    method: 'POST',
    body: code,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Wi-Fi pairing failed: ${await response.text()}`);
  const result = await response.json() as Partial<WifiConfig>;
  if (!isHex(result.deviceId, 16) || !isHex(result.token, 32))
    throw new Error('Device returned invalid Wi-Fi pairing data.');
  const config = {
    deviceId: result.deviceId,
    token: result.token,
    address: device.address,
    port: device.port,
  };
  await saveWifiConfig(config);
  return config;
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);
}

function isHost(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 253
      && /^[a-z0-9.-]+$/i.test(value);
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function ipv4(value: string): number | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  return parts.reduce((result, part) => (result * 256 + part) >>> 0, 0);
}

function fromIpv4(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

import {randomBytes, timingSafeEqual} from 'node:crypto';
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCharacterName, maxPackBytes, readCharacterThumbnail} from './character-pack.js';
import type {CompanionService} from './companion-service.js';
import {isConnectionMode} from './connection-mode.js';
import {desktopBackdrops, isDesktopBackdrop, isDesktopVolume} from './display-settings.js';
import {settingsInfoPath} from './paths.js';
import {isAgentId} from './agents/types.js';
import {isUsageWindow, usageWindows} from './usage-tracker.js';
import {isOrientationOffset} from './orientation-settings.js';
import {isVoiceNotificationMode} from './voice-notifications.js';

export const defaultSettingsPort = 4667;
const maxJsonBytes = 64 * 1024;
const eventIntervalMs = 1000;
const staticFiles: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; "
    + "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface SettingsServerOptions {
  service: Pick<CompanionService, 'status' | 'installBusy' | 'characters' | 'installCharacter' | 'addCharacter'
    | 'removeCharacter' | 'configureWifi' | 'scanWifi' | 'setConnection' | 'agentStatuses' | 'setAgentEnabled'
    | 'installAgentHook' | 'uninstallAgentHook' | 'setAgentBadgesEnabled' | 'setDesktop' | 'startDesktop'
    | 'stopDesktop' | 'setUsage' | 'setOrientationOffset' | 'updateFirmware' | 'installFirmwareOverUsb'
    | 'setVoiceNotifications' | 'uninstall' | 'stopService' | 'restartService' | 'on' | 'off'>;
  port: number;
  token: string;
  webDirectory?: string;
  thumbnail?: (id: string) => Promise<Buffer | null>;
}

export function webDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Serves the settings page. It listens on loopback only, and every API call must carry
// the per-session token and come from the page's own origin, so other websites can't use it.
export function createSettingsServer(options: SettingsServerOptions): Server {
  const {service, port, token} = options;
  const directory = options.webDirectory ?? webDirectory();
  const thumbnail = options.thumbnail ?? readCharacterThumbnail;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const expected = Buffer.from(token);

  const authorized = (request: IncomingMessage, url: URL, allowQuery: boolean) => {
    const header = request.headers['x-companion-token'];
    const supplied = typeof header === 'string' ? header : allowQuery ? url.searchParams.get('token') : null;
    if (!supplied) return false;
    const actual = Buffer.from(supplied);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? '';
    if (!hosts.has(host)) throw new HttpError(421, 'Unknown host.');
    const origin = request.headers.origin;
    if (origin && !hosts.has(origin.replace(/^http:\/\//, ''))) throw new HttpError(403, 'Forbidden origin.');
    const url = new URL(request.url ?? '/', `http://${host}`);
    const method = request.method ?? 'GET';

    const file = staticFiles[url.pathname];
    if (method === 'GET' && file) {
      const body = await readFile(join(directory, file[0]));
      response.writeHead(200, {...securityHeaders, 'Content-Type': file[1]});
      response.end(body);
      return;
    }
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

    const segments = url.pathname.split('/').filter(Boolean).slice(1);
    const readable = method === 'GET'
        && (segments[0] === 'events' || (segments[0] === 'characters' && segments[2] === 'thumbnail'));
    if (!authorized(request, url, readable)) throw new HttpError(401, 'Missing or invalid session token.');

    if (method === 'GET' && segments.length === 1 && segments[0] === 'status') {
      return json(response, 200, service.status());
    }
    if (segments[0] === 'agents') {
      if (method === 'GET' && segments.length === 1) return json(response, 200, service.agentStatuses());
      const id = segments[1];
      if (!isAgentId(id)) throw new HttpError(404, 'Unknown agent.');
      if (method === 'POST' && segments.length === 3 && segments[2] === 'enable') {
        return json(response, 200, await service.setAgentEnabled(id, true));
      }
      if (method === 'POST' && segments.length === 3 && segments[2] === 'disable') {
        return json(response, 200, await service.setAgentEnabled(id, false));
      }
      if (method === 'POST' && segments.length === 3 && segments[2] === 'install') {
        return json(response, 200, await service.installAgentHook(id));
      }
      if (method === 'DELETE' && segments.length === 2) {
        return json(response, 200, await service.uninstallAgentHook(id));
      }
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'events') {
      return streamEvents(request, response, service);
    }
    if (segments[0] === 'characters') {
      const id = segments[1];
      if (method === 'GET' && segments.length === 1) return json(response, 200, await service.characters());
      if (method === 'POST' && segments.length === 1) {
        requireType(request, 'application/octet-stream');
        const entry = await service.addCharacter(await readBody(request, maxPackBytes));
        return json(response, 201, entry);
      }
      if (!id || !isCharacterName(id)) throw new HttpError(404, 'Unknown character.');
      if (method === 'GET' && segments[2] === 'thumbnail' && segments.length === 3) {
        const image = await thumbnail(id);
        if (!image) throw new HttpError(404, 'No thumbnail.');
        response.writeHead(200, {...securityHeaders, 'Content-Type': 'image/png'});
        response.end(image);
        return;
      }
      if (method === 'POST' && segments[2] === 'install' && segments.length === 3) {
        const status = service.status();
        if (status.installing || service.installBusy)
          throw new HttpError(409, 'A character installation is already in progress.');
        if (!status.connected) throw new HttpError(409, 'Connect the Agent Companion over USB or Wi-Fi first.');
        if (!(await service.characters()).some(entry => entry.id === id))
          throw new HttpError(404, 'Unknown character.');
        // Progress and the result arrive through /api/events.
        service.installCharacter(id).catch(error => console.error(`[settings] install failed: ${
          error instanceof Error ? error.message : String(error)}`));
        return json(response, 202, {ok: true});
      }
      if (method === 'DELETE' && segments.length === 2) {
        await service.removeCharacter(id);
        return json(response, 200, {ok: true});
      }
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'firmware' && segments[1] === 'update') {
      const status = service.status();
      if (status.installing || status.firmware.updating || service.installBusy)
        throw new HttpError(409, 'Wait for the current installation to finish.');
      if (!status.firmware.canUpdate)
        throw new HttpError(409, status.firmware.built === null ? 'No firmware is built.'
          : status.firmware.built === status.firmware.device ? 'The device already runs this firmware.'
          : 'The device must be on Wi-Fi with firmware protocol 9 or later.');
      // Progress and the result arrive through /api/events.
      service.updateFirmware().catch(error => console.error(`[settings] firmware update failed: ${
        error instanceof Error ? error.message : String(error)}`));
      return json(response, 202, {ok: true});
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'firmware' && segments[1] === 'usb') {
      const status = service.status();
      if (status.installing || status.firmware.updating || status.firmware.usb.installing || service.installBusy)
        throw new HttpError(409, 'Wait for the current installation to finish.');
      if (!status.firmware.usb.flasher)
        throw new HttpError(409, 'Installing firmware over USB needs the desktop app. Open the desktop app, then try again.');
      if (!status.firmware.usb.release)
        throw new HttpError(409, 'The companion service has no VERSION file, so it cannot choose a release.');
      // Download and write progress, and the result, arrive through /api/events.
      service.installFirmwareOverUsb().catch(() => undefined);
      return json(response, 202, {ok: true});
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'wifi' && segments[1] === 'networks') {
      return json(response, 200, await service.scanWifi());
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'wifi') {
      const body = await readJson(request) as {ssid?: unknown; password?: unknown};
      if (typeof body.ssid !== 'string' || typeof body.password !== 'string')
        throw new HttpError(400, 'Enter a network name and password.');
      const deviceId = await service.configureWifi(body.ssid, body.password);
      return json(response, 200, {ok: true, deviceId});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'connection') {
      const body = await readJson(request) as {mode?: unknown};
      if (!isConnectionMode(body.mode)) throw new HttpError(400, 'Connection mode must be auto, usb, or wifi.');
      await service.setConnection(body.mode);
      return json(response, 200, {ok: true, mode: body.mode});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'orientation') {
      const body = await readJson(request) as {offsetDegrees?: unknown};
      if (!isOrientationOffset(body.offsetDegrees))
        throw new HttpError(400, 'Orientation offset must be from -15 to 15 degrees in half-degree steps.');
      try {
        const orientation = await service.setOrientationOffset(body.offsetDegrees);
        return json(response, 200, {ok: true, orientation});
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'badges') {
      const body = await readJson(request) as {enabled?: unknown};
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Badge setting must be true or false.');
      await service.setAgentBadgesEnabled(body.enabled);
      return json(response, 200, {ok: true, enabled: body.enabled});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'voice') {
      const body = await readJson(request) as {mode?: unknown};
      if (!isVoiceNotificationMode(body.mode))
        throw new HttpError(400, 'Voice notifications must be off, milestones, or chatty.');
      await service.setVoiceNotifications(body.mode);
      return json(response, 200, {ok: true, mode: body.mode});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'desktop') {
      const body = await readJson(request) as {visible?: unknown; backdrop?: unknown; sounds?: unknown; volume?: unknown;
        character?: unknown};
      if (body.visible !== undefined && typeof body.visible !== 'boolean')
        throw new HttpError(400, 'Desktop visibility must be true or false.');
      if (body.sounds !== undefined && typeof body.sounds !== 'boolean')
        throw new HttpError(400, 'Desktop sounds must be on (true) or off (false).');
      if (body.volume !== undefined && !isDesktopVolume(body.volume))
        throw new HttpError(400, 'Desktop volume must be a whole number from 0 to 100.');
      if (body.backdrop !== undefined && !isDesktopBackdrop(body.backdrop))
        throw new HttpError(400, `Desktop backdrop must be one of: ${desktopBackdrops.join(', ')}.`);
      if (body.character !== undefined && (typeof body.character !== 'string' || !isCharacterName(body.character)))
        throw new HttpError(400, 'Desktop character must be a character id.');
      if (body.visible === undefined && body.backdrop === undefined && body.sounds === undefined
        && body.volume === undefined && body.character === undefined)
        throw new HttpError(400, 'Nothing to change.');
      try {
        await service.setDesktop({visible: body.visible, backdrop: body.backdrop, sounds: body.sounds,
                                  volume: body.volume, character: body.character});
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
      return json(response, 200, {ok: true, desktop: service.status().desktop});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'usage') {
      const body = await readJson(request) as {enabled?: unknown; window?: unknown};
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        throw new HttpError(400, 'Usage setting must be true or false.');
      if (body.window !== undefined && !isUsageWindow(body.window))
        throw new HttpError(400, `Usage window must be one of: ${usageWindows.join(', ')}.`);
      if (body.enabled === undefined && body.window === undefined) throw new HttpError(400, 'Nothing to change.');
      await service.setUsage({enabled: body.enabled, window: body.window});
      return json(response, 200, {ok: true, usage: service.status().usage});
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'desktop'
        && (segments[1] === 'start' || segments[1] === 'stop')) {
      try {
        if (segments[1] === 'start') await service.startDesktop();
        else service.stopDesktop();
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
      return json(response, 200, {ok: true, desktop: service.status().desktop});
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'service'
        && (segments[1] === 'stop' || segments[1] === 'restart')) {
      try {
        if (segments[1] === 'stop') await service.stopService();
        else service.restartService();
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
      return json(response, 200, {ok: true});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'uninstall') {
      const body = await readJson(request) as {keepData?: unknown};
      if (typeof body.keepData !== 'boolean') throw new HttpError(400, 'keepData must be true or false.');
      try {
        return json(response, 200, {ok: true, ...await service.uninstall(body.keepData)});
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
    }
    throw new HttpError(404, 'Not found.');
  };

  return createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 400;
      // An error can leave an unread request body behind, so don't reuse the connection.
      response.setHeader('Connection', 'close');
      response.on('finish', () => request.socket.destroy());
      json(response, status, {error: error instanceof Error ? error.message : String(error)});
    });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {...securityHeaders, 'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
}

function requireType(request: IncomingMessage, type: string): void {
  if ((request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== type)
    throw new HttpError(415, `Expected ${type}.`);
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit)
    return Promise.reject(new HttpError(413, 'Request body is too large.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  requireType(request, 'application/json');
  try {
    return JSON.parse((await readBody(request, maxJsonBytes)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function streamEvents(request: IncomingMessage, response: ServerResponse,
                      service: SettingsServerOptions['service']): void {
  response.writeHead(200, {...securityHeaders, 'Content-Type': 'text/event-stream', Connection: 'keep-alive'});
  let previous = '';
  const send = () => {
    const status = JSON.stringify(service.status());
    if (status === previous) return;
    previous = status;
    response.write(`event: status\ndata: ${status}\n\n`);
  };
  send();
  // Transport changes don't all emit events, so poll as well; unchanged status isn't resent.
  const timer = setInterval(send, eventIntervalMs);
  service.on('change', send);
  request.on('close', () => {
    clearInterval(timer);
    service.off('change', send);
  });
}

async function savedSettingsToken(): Promise<string | null> {
  try {
    const saved = JSON.parse(await readFile(settingsInfoPath(), 'utf8')) as {url?: unknown};
    const match = typeof saved.url === 'string' ? /#token=([0-9a-f]{48})$/.exec(saved.url) : null;
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function startSettingsServer(service: SettingsServerOptions['service']): Promise<string | null> {
  const port = Number(process.env.AGENT_COMPANION_SETTINGS_PORT ?? defaultSettingsPort);
  // Reusing the private token keeps open settings tabs and saved links working across daemon restarts.
  const token = await savedSettingsToken() ?? randomBytes(24).toString('hex');
  const server = createSettingsServer({service, port, token});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    console.error(`[settings] page unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  const path = settingsInfoPath();
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(`${path}.tmp`, `${JSON.stringify({url, port}, null, 2)}\n`, {mode: 0o600});
  await rename(`${path}.tmp`, path);
  await chmod(path, 0o600);
  console.log(`[settings] listening http://127.0.0.1:${port}`);
  return url;
}

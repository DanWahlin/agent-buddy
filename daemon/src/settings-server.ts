import {randomBytes, timingSafeEqual} from 'node:crypto';
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCharacterName, maxPackBytes, readCharacterPack, readCharacterThumbnail} from './character-pack.js';
import type {CompanionService} from './companion-service.js';
import {isConnectionMode} from './connection-mode.js';
import {desktopBackdrops, isDesktopBackdrop, isDesktopVolume} from './display-settings.js';
import {settingsInfoPath} from './paths.js';
import {isAgentId} from './agents/types.js';
import {isUsageWindow, usageWindows} from './usage-tracker.js';
import {isOrientationOffset} from './orientation-settings.js';
import {isVoiceNotificationMode} from './voice-notifications.js';
import {isOnboardingChange, isOnboardingStep, SetupError} from './onboarding.js';

export const defaultSettingsPort = 4667;
const maxJsonBytes = 64 * 1024;
const eventIntervalMs = 1000;
const staticFiles: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/onboarding.js': ['onboarding.js', 'text/javascript; charset=utf-8'],
  '/onboarding.css': ['onboarding.css', 'text/css; charset=utf-8'],
  '/welcome-device.webp': ['welcome-device.webp', 'image/webp'],
  '/welcome-idle.mp4': ['welcome-idle.mp4', 'video/mp4'],
  '/device-shell.webp': ['device-shell.webp', 'image/webp'],
  '/character-preview.js': ['character-preview.js', 'text/javascript; charset=utf-8'],
  '/character-engine.js': ['../../desktop/engine/prebuilt/engine.js', 'text/javascript; charset=utf-8'],
};
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; "
    + "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface SettingsServerOptions {
  service: Pick<CompanionService, 'status' | 'installBusy' | 'characters' | 'installCharacter' | 'addCharacter'
    | 'removeCharacter' | 'configureWifi' | 'scanWifi' | 'setConnection' | 'agentStatuses' | 'setAgentEnabled'
    | 'installAgentHook' | 'uninstallAgentHook' | 'setAgentBadgesEnabled' | 'setDesktop' | 'startDesktop'
    | 'stopDesktop' | 'setUsage' | 'setOrientationOffset' | 'updateFirmware' | 'installFirmwareOverUsb'
    | 'setVoiceNotifications' | 'uninstall' | 'stopService' | 'restartService' | 'onboardingStatus' | 'updateOnboarding'
    | 'restartOnboarding' | 'navigateOnboarding' | 'installOnboardingAgents' | 'detectUsbDevices' | 'applyOnboardingDisplay'
    | 'setupOnboardingDevice' | 'finishOnboarding' | 'removeOnboardingAgent' | 'rescanAgents' | 'on' | 'off'>;
  port: number;
  token: string;
  webDirectory?: string;
  thumbnail?: (id: string) => Promise<Buffer | null>;
  previewPack?: (id: string) => Promise<Buffer>;
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
  const previewPack = options.previewPack ?? (async id => (await readCharacterPack(id)).data);
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
    if ((method === 'GET' || method === 'HEAD') && file) {
      const body = await readFile(join(directory, file[0]));
      const headers = {...securityHeaders, 'Content-Type': file[1], 'Content-Length': body.length};
      if (file[1].startsWith('video/')) {
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, body.length - Number(match[2])) : NaN;
          const end = match?.[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end
            || start >= body.length || (match?.[1] === '' && Number(match[2]) === 0)) {
            response.writeHead(416, {...securityHeaders, 'Content-Range': `bytes */${body.length}`});
            response.end();
            return;
          }
          response.writeHead(206, {...headers, 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1});
          response.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1));
          return;
        }
        response.setHeader('Accept-Ranges', 'bytes');
      }
      response.writeHead(200, headers);
      response.end(method === 'HEAD' ? undefined : body);
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
    if (segments[0] === 'onboarding') {
      if (method === 'GET' && segments.length === 1) return json(response, 200, service.onboardingStatus());
      if (method === 'POST' && segments.length === 1) {
        const change = await readJson(request);
        if (!isOnboardingChange(change)) throw new HttpError(400, 'Invalid setup choices.');
        return json(response, 200, await service.updateOnboarding(change));
      }
      if (method === 'POST' && segments.length === 2) {
        if (segments[1] === 'restart') return json(response, 200, await service.restartOnboarding());
        if (segments[1] === 'rescan') return json(response, 200, await service.rescanAgents());
        if (segments[1] === 'navigate') {
          const body = await readJson(request) as {step?: unknown} | null;
          if (!body || !isOnboardingStep(body.step)) throw new HttpError(400, 'Select a valid setup step.');
          return json(response, 200, await service.navigateOnboarding(body.step));
        }
        if (segments[1] === 'remove-agent') {
          const body = await readJson(request) as {confirmed?: unknown; agent?: unknown; agents?: unknown} | null;
          if (body?.confirmed !== true || !isAgentId(body.agent))
            throw new HttpError(400, 'Approve the selected agent hook removal first.');
          const approvedAgents = body.agents;
          if (!Array.isArray(approvedAgents) || !approvedAgents.every(isAgentId))
            throw new HttpError(400, 'Include the current selection with the removal approval.');
          const current = service.onboardingStatus().agents;
          if (current.length !== approvedAgents.length || current.some(id => !approvedAgents.includes(id)))
            throw new HttpError(409, 'Agent selection changed. Review and approve the removal again.');
          return json(response, 200, await service.removeOnboardingAgent(body.agent));
        }
        if (segments[1] === 'hooks') {
          const body = await readJson(request) as {confirmed?: unknown; agents?: unknown; installAgents?: unknown} | null;
          if (typeof body?.confirmed !== 'boolean') throw new HttpError(400, 'Include the hook installation approval.');
          const approvedAgents = body.agents;
          if (!Array.isArray(approvedAgents) || !approvedAgents.every(isAgentId) || new Set(approvedAgents).size !== approvedAgents.length)
            throw new HttpError(400, 'Include the selected agents with the approval.');
          const current = service.onboardingStatus().agents;
          if (current.length !== approvedAgents.length || current.some(id => !approvedAgents.includes(id)))
            throw new HttpError(409, 'Agent selection changed. Review and approve the current selection again.');
          const installAgents = body.installAgents === undefined ? (body.confirmed ? approvedAgents : []) : body.installAgents;
          if (!Array.isArray(installAgents) || !installAgents.every(isAgentId)
            || new Set(installAgents).size !== installAgents.length || installAgents.some(id => !approvedAgents.includes(id)))
            throw new HttpError(400, 'Include only selected agents that need hook installation.');
          if (!body.confirmed && installAgents.length)
            throw new HttpError(400, 'Approve the required hook installation first.');
          return json(response, 200, {results: await service.installOnboardingAgents(installAgents)});
        }
        if (segments[1] === 'display') {
          await service.applyOnboardingDisplay();
          return json(response, 200, {ok: true});
        }
        if (segments[1] === 'device') {
          const body = await readJson(request) as {flash?: unknown; confirmed?: unknown; port?: unknown;
            character?: unknown; display?: unknown} | null;
          if (typeof body?.flash !== 'boolean' || body.confirmed !== true)
            throw new HttpError(400, 'Confirm the device setup first.');
          if (service.onboardingStatus().busy || service.installBusy)
            throw new HttpError(409, 'Wait for the current installation to finish.');
          const setup = service.onboardingStatus();
          if (setup.completed || setup.display === 'desktop' || setup.deviceDeferred || (body.flash && !setup.port))
            throw new HttpError(409, 'Select and detect the device in setup first.');
          if (body.port !== setup.port || body.character !== setup.character || body.display !== setup.display)
            throw new HttpError(409, 'Device choices changed. Review and approve the current device setup again.');
          service.setupOnboardingDevice(body.flash).catch(error =>
            console.error(`[onboarding] device setup failed: ${error instanceof Error ? error.message : String(error)}`));
          return json(response, 202, {ok: true});
        }
        if (segments[1] === 'finish') return json(response, 200, await service.finishOnboarding());
      }
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'devices')
      return json(response, 200, await service.detectUsbDevices());
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
      if (method === 'GET' && segments[2] === 'preview-pack' && segments.length === 3) {
        if (!(await service.characters()).some(entry => entry.id === id))
          throw new HttpError(404, 'Unknown character.');
        const pack = await previewPack(id);
        response.writeHead(200, {...securityHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': pack.length});
        response.end(pack);
        return;
      }
      if (method === 'POST' && segments[2] === 'install' && segments.length === 3) {
        const status = service.status();
        if (status.installing || service.installBusy || status.onboarding?.busy)
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
      if (status.installing || status.firmware.updating || service.installBusy || status.onboarding?.busy)
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
      const body = await readJson(request) as {port?: unknown; confirmed?: unknown} | null;
      if (body?.confirmed !== true) throw new HttpError(400, 'Confirm the supported device and firmware replacement first.');
      if (body.port !== undefined && body.port !== null && typeof body.port !== 'string')
        throw new HttpError(400, 'USB port must be a device path.');
      const status = service.status();
      if (status.installing || status.firmware.updating || status.firmware.usb.installing || service.installBusy || status.onboarding?.busy)
        throw new HttpError(409, 'Wait for the current installation to finish.');
      if (!status.firmware.usb.flasher)
        throw new HttpError(409, 'Installing firmware over USB needs the desktop app. Open the desktop app, then try again.');
      if (!status.firmware.usb.release)
        throw new HttpError(409, 'The companion service has no VERSION file, so it cannot choose a release.');
      // Download and write progress, and the result, arrive through /api/events.
      service.installFirmwareOverUsb(typeof body.port === 'string' ? body.port : undefined).catch(error =>
        console.error(`[settings] USB firmware install failed: ${error instanceof Error ? error.message : String(error)}`));
      return json(response, 202, {ok: true});
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'wifi' && segments[1] === 'networks') {
      return json(response, 200, await service.scanWifi());
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'wifi') {
      const body = await readJson(request) as {ssid?: unknown; password?: unknown} | null;
      if (typeof body?.ssid !== 'string' || typeof body?.password !== 'string')
        throw new HttpError(400, 'Enter a network name and password.');
      const deviceId = await service.configureWifi(body.ssid, body.password);
      return json(response, 200, {ok: true, deviceId});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'connection') {
      const body = await readJson(request) as {mode?: unknown} | null;
      if (!isConnectionMode(body?.mode)) throw new HttpError(400, 'Connection mode must be auto, usb, or wifi.');
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
        throw new HttpError(400, 'Voice notifications must be off, milestones, chatty, or contextual.');
      await service.setVoiceNotifications(body.mode);
      return json(response, 200, {ok: true, mode: body.mode});
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'desktop') {
      const body = await readJson(request) as {visible?: unknown; backdrop?: unknown; sounds?: unknown; volume?: unknown;
        character?: unknown; deviceEnabled?: unknown};
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
      if (body.deviceEnabled !== undefined && typeof body.deviceEnabled !== 'boolean')
        throw new HttpError(400, 'Device use must be on (true) or off (false).');
      if (body.deviceEnabled !== undefined && service.onboardingStatus().busy)
        throw new HttpError(409, 'Wait for device setup to finish.');
      if (body.visible === undefined && body.backdrop === undefined && body.sounds === undefined
        && body.volume === undefined && body.character === undefined && body.deviceEnabled === undefined)
        throw new HttpError(400, 'Nothing to change.');
      try {
        await service.setDesktop({visible: body.visible, backdrop: body.backdrop, sounds: body.sounds,
                                  volume: body.volume, character: body.character,
                                  ...(body.deviceEnabled === undefined ? {} : {deviceEnabled: body.deviceEnabled})});
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
      return json(response, 200, {ok: true, desktop: service.status().desktop, deviceEnabled: service.status().deviceEnabled});
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
      const status = error instanceof HttpError || error instanceof SetupError ? error.status : 400;
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
    const value: unknown = JSON.parse((await readBody(request, maxJsonBytes)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'Request body must be a JSON object.');
    return value;
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

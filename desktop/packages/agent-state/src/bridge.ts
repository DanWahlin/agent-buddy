/**
 * The bridge between agent hooks and whatever is showing the character.
 *
 * Upstream runs one daemon per machine talking to one USB device. VS Code has
 * no daemon and any number of windows, so the first window to bind the endpoint
 * becomes the leader and runs the coordinator; the rest connect as subscribers
 * and are pushed the state. When a leader goes away its subscribers race to
 * take over, so closing the window that happened to start first does not stop
 * the others reacting.
 *
 * Framing is newline-delimited JSON in both directions. Upstream parses a whole
 * request on end-of-stream, which cannot express a server that pushes; a
 * subscriber holds its socket open for the life of the window.
 */

import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { characterStates, hookEvents, type CharacterState } from './vendor/protocol.js';
import { StateCoordinator } from './vendor/state-coordinator.js';
import { StateStore } from './vendor/state-store.js';
import { endpointIsFile, endpointPath, statePath } from './paths.js';

export type BridgeRole = 'leader' | 'subscriber' | 'stopped';

export interface BridgeOptions {
  endpoint?: string;
  statePath?: string;
  /** Called whenever the character state changes, in any role. */
  onState: (state: CharacterState) => void;
  onLog?: (message: string) => void;
  /** How long to wait before retrying after losing both roles. */
  retryMs?: number;
}

/** A request a hook or another window can send. */
type Request =
  | { type: 'hook'; event: string; payload?: Record<string, unknown> }
  | { type: 'send'; state: string }
  | { type: 'status' }
  | { type: 'subscribe' };

const MAX_LINE = 64 * 1024;

export class StateBridge {
  readonly #endpoint: string;
  readonly #statePath: string;
  readonly #onState: (state: CharacterState) => void;
  readonly #log: (message: string) => void;
  readonly #retryMs: number;

  #role: BridgeRole = 'stopped';
  #state: CharacterState = 'idle';
  #server: Server | null = null;
  #coordinator: StateCoordinator | null = null;
  #store: StateStore | null = null;
  #client: Socket | null = null;
  /**
   * Every accepted connection, whether or not it has said what it wants yet.
   *
   * Tracking only the subscribers was not enough: a window that has connected
   * but whose `subscribe` line has not been read is invisible to that set, so
   * shutting down left it open, `server.close()` waited on it forever, and the
   * other window was never told to take over.
   */
  #connections = new Set<Socket>();
  #subscribers = new Set<Socket>();
  #retry: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(options: BridgeOptions) {
    this.#endpoint = options.endpoint ?? endpointPath();
    this.#statePath = options.statePath ?? statePath();
    this.#onState = options.onState;
    this.#log = options.onLog ?? (() => {});
    this.#retryMs = options.retryMs ?? 5000;
  }

  get role(): BridgeRole { return this.#role; }
  get state(): CharacterState { return this.#state; }
  get endpoint(): string { return this.#endpoint; }
  get sessionCount(): number { return this.#coordinator?.sessionCount ?? 0; }
  /** Windows currently following this one. */
  get subscriberCount(): number { return this.#subscribers.size; }

  /** Take whichever role is available. Never throws; failures are logged and retried. */
  async start(): Promise<void> {
    this.#stopping = false;
    try {
      await this.#becomeLeader();
      return;
    } catch (error) {
      if (!isAddressInUse(error)) {
        this.#log('Could not listen on ' + this.#endpoint + ': ' + message(error));
        this.#scheduleRetry();
        return;
      }
    }

    // Something is already there. Join it, or clear it away if it is a corpse.
    try {
      await this.#becomeSubscriber();
      return;
    } catch (error) {
      this.#log('Could not join the existing companion: ' + message(error));
    }

    if (endpointIsFile()) {
      // A socket file outlives the process that made it; a failed connect to an
      // existing path means the owner is gone.
      await unlink(this.#endpoint).catch(() => undefined);
      try {
        await this.#becomeLeader();
        return;
      } catch (error) {
        this.#log('Could not take over ' + this.#endpoint + ': ' + message(error));
      }
    }
    this.#scheduleRetry();
  }

  /** Drive the state by hand. Reaches every window when sent by the leader. */
  setState(state: CharacterState): void {
    this.#publish(state);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }

    this.#client?.destroy();
    this.#client = null;

    if (this.#server) {
      const server = this.#server;
      this.#server = null;

      // Order matters. Dropping connections first wakes the other windows
      // immediately, and one reconnecting before the server stops accepting
      // would keep close() pending forever. So stop accepting, then drop them.
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      this.#dropConnections();

      // Shutting a window down must not be able to hang on a stuck socket.
      await Promise.race([closed, sleep(2000)]);
      if (endpointIsFile()) await unlink(this.#endpoint).catch(() => undefined);
    } else {
      this.#dropConnections();
    }

    this.#coordinator?.close();
    if (this.#store && this.#coordinator) {
      await this.#store.flush(this.#coordinator.snapshot()).catch(() => undefined);
    }
    this.#coordinator = null;
    this.#store = null;
    this.#role = 'stopped';
  }

  async #becomeLeader(): Promise<void> {
    if (endpointIsFile()) {
      await mkdir(dirname(this.#endpoint), { recursive: true, mode: 0o700 });
    }

    // Claim the endpoint before building anything. The coordinator owns a sweep
    // interval, so creating it first and then failing to listen - which is the
    // normal outcome when another window got there first - would leave a live
    // timer behind on every attempt.
    // allowHalfOpen: on platforms that have it, a client may write one request
    // and close its writing end while still waiting to read the reply.
    const server = createServer({ allowHalfOpen: true }, socket => this.#serve(socket));
    server.on('error', error => this.#log('Bridge error: ' + message(error)));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#endpoint);
    });

    const store = new StateStore(this.#statePath);
    const restored = await store.load().catch(() => undefined);
    const coordinator = new StateCoordinator(state => this.#publish(state), {
      restored,
      onMutation: state => store.schedule(state),
    });

    this.#server = server;
    this.#store = store;
    this.#coordinator = coordinator;
    this.#role = 'leader';
    this.#log('Listening on ' + this.#endpoint);
    this.#publish(coordinator.state);
  }

  async #becomeSubscriber(): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = createConnection(this.#endpoint);
      attempt.setTimeout(2000, () => {
        attempt.destroy();
        reject(new Error('timed out connecting to ' + this.#endpoint));
      });
      attempt.once('connect', () => { attempt.setTimeout(0); resolve(attempt); });
      attempt.once('error', reject);
    });

    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    readLines(socket, line => {
      const message = parse(line);
      if (message && typeof message === 'object' && 'state' in message) {
        const state = (message as { state: unknown }).state;
        if (isCharacterState(state)) this.#apply(state);
      }
    });
    socket.on('close', () => {
      if (this.#stopping || this.#client !== socket) return;
      this.#client = null;
      this.#role = 'stopped';
      this.#log('The leading window went away; taking over.');
      void this.start();
    });

    socket.write(JSON.stringify({ type: 'subscribe' }) + '\n');
    this.#client = socket;
    this.#role = 'subscriber';
    this.#log('Following another window on ' + this.#endpoint);
  }

  /** Handle one inbound connection: a hook firing, or a window subscribing. */
  #serve(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    this.#connections.add(socket);
    socket.on('close', () => {
      this.#connections.delete(socket);
      this.#subscribers.delete(socket);
    });
    // A hook is a single line and gone; a subscriber stays. Only the former
    // should be timed out, so the timer is cleared once one subscribes.
    socket.setTimeout(10_000, () => { if (!this.#subscribers.has(socket)) socket.destroy(); });

    readLines(socket, line => {
      const request = parse(line) as Request | null;
      if (!request || typeof request !== 'object') {
        reply(socket, { ok: false, error: 'malformed request' });
        return;
      }

      switch (request.type) {
        case 'hook': {
          if (!hookEvents.includes(request.event as never)) {
            reply(socket, { ok: false, error: 'unknown event ' + request.event });
            return;
          }
          this.#coordinator?.handle(request.event as never, request.payload ?? {});
          reply(socket, { ok: true, state: this.#state });
          return;
        }
        case 'send': {
          if (!isCharacterState(request.state)) {
            reply(socket, { ok: false, error: 'unknown state ' + request.state });
            return;
          }
          this.#publish(request.state);
          reply(socket, { ok: true, state: this.#state });
          return;
        }
        case 'status':
          reply(socket, {
            ok: true,
            state: this.#state,
            role: this.#role,
            sessions: this.sessionCount,
            subscribers: this.subscriberCount,
          });
          return;
        case 'subscribe':
          this.#subscribers.add(socket);
          socket.setTimeout(0);
          write(socket, { type: 'state', state: this.#state });
          return;
        default:
          reply(socket, { ok: false, error: 'unknown request' });
      }
    }, {
      onOverflow: () => socket.destroy(),
      // The client has stopped writing; once the reply is out, so are we.
      onEnd: () => { if (!this.#subscribers.has(socket)) socket.end(); },
    });
  }

  /** Adopt a state and tell every subscriber. */
  #publish(state: CharacterState): void {
    this.#apply(state);
    for (const socket of this.#subscribers) write(socket, { type: 'state', state });
  }

  #apply(state: CharacterState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState(state);
  }

  /** Close every accepted connection, so `server.close()` can complete. */
  #dropConnections(): void {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    this.#subscribers.clear();
  }

  #scheduleRetry(): void {
    if (this.#stopping || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.start();
    }, this.#retryMs);
    // Never hold the process open just to retry.
    this.#retry.unref?.();
  }
}

function isCharacterState(value: unknown): value is CharacterState {
  return typeof value === 'string' && (characterStates as readonly string[]).includes(value);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function write(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  socket.write(JSON.stringify(value) + '\n');
}

function reply(socket: Socket, value: unknown): void {
  write(socket, value);
}

/** Split an incoming stream into JSON lines, refusing anything oversized. */
function readLines(
  socket: Socket,
  onLine: (line: string) => void,
  options: { onOverflow?: () => void; onEnd?: () => void } = {},
): void {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      buffer = '';
      options.onOverflow?.();
      return;
    }
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  socket.on('end', () => {
    // Tolerate a client that writes one JSON object and closes without a
    // newline, which is how the upstream daemon's clients behave.
    const line = buffer.trim();
    buffer = '';
    if (line) onLine(line);
    options.onEnd?.();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
}

function isAddressInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

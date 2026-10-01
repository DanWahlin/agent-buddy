/**
 * Where the bridge listens, and where it keeps its state.
 *
 * Written fresh rather than adapted from upstream, which has no Windows branch
 * at all - its README tells Windows users to run the daemon inside WSL 2. A
 * VS Code extension cannot ask that, so Windows gets a named pipe and the other
 * platforms get a Unix socket, which `net.createServer().listen(path)` treats
 * identically.
 *
 * The endpoint is deliberately not the ESP32 daemon's. Both can run at once,
 * and a hook can fan out to both; sharing one socket would mean whichever
 * started first owned the other's traffic.
 */

import { homedir, tmpdir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Join using the separator of the platform being asked about, not the one this
 * process happens to run on. Without this the platform argument would be a
 * half-truth: correct in production, where they always agree, and wrong
 * everywhere else - including in its own tests.
 */
function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join;
}

const NAME = 'agent-companion-vscode';

/** The socket or named pipe the bridge listens on. */
export function endpointPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.AGENT_COMPANION_VSCODE_SOCKET;
  if (override) return override;

  if (platform === 'win32') {
    // Named pipes live in a kernel namespace, not the filesystem: nothing to
    // create beforehand and nothing to clean up afterwards.
    return '\\\\.\\pipe\\' + NAME;
  }

  if (platform === 'darwin') {
    return joinFor(platform)(dataDirectory(platform, environment), 'bridge.sock');
  }

  // A Unix socket path is capped near 104 bytes, so prefer the short runtime
  // directory and fall back to the temp directory rather than the home one.
  const join = joinFor(platform);
  const runtime = environment.XDG_RUNTIME_DIR;
  const base = runtime ? join(runtime, NAME) : join(tmpdir(), NAME + '-' + uid());
  return join(base, 'bridge.sock');
}

/** Where the coordinator's session snapshot is written. */
export function statePath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.AGENT_COMPANION_VSCODE_STATE
    ?? joinFor(platform)(dataDirectory(platform, environment), 'state.json');
}

/**
 * Where the hook shim lives, once installed.
 *
 * Deliberately not inside whichever host installed it. Hooks name the shim by
 * path, and a path inside a versioned extension directory stops resolving the
 * moment that extension updates - at which point Copilot CLI, whose
 * `preToolUse` is fail-closed, refuses every tool call until somebody works out
 * why. A home of its own outlives any host, and lets two hosts share one.
 */
export function shimPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  return environment.AGENT_COMPANION_VSCODE_SHIM
    ?? joinFor(platform)(dataDirectory(platform, environment, home ?? homedir()), 'hook.js');
}

/** True when the endpoint is a filesystem path needing a directory and cleanup. */
export function endpointIsFile(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function dataDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const join = joinFor(platform);
  if (platform === 'win32') {
    const appData = environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(appData, 'AgentCompanion');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Agent Companion');
  }
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), NAME);
}

function uid(): number {
  try {
    return process.getuid?.() ?? userInfo().uid;
  } catch {
    return 0;
  }
}

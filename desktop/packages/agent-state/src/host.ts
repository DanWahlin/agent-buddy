#!/usr/bin/env node
/**
 * The bridge as a process, for a host that is not Node.
 *
 * A VS Code extension runs `StateBridge` in its own extension host. A Tauri
 * app cannot: its shell is Rust. So the bridge runs here instead, and the two
 * talk newline-delimited JSON over stdio - the same framing the endpoint uses,
 * for the same reason, and cheap enough that the shell need not care what is
 * on the other end.
 *
 * That is deliberately swappable. Nothing here is visible to the shell beyond
 * the lines below, so a Rust bridge can replace this later without the app
 * knowing, exactly as a Rust shim could replace the one the agents run.
 *
 * **Shutting down matters more than it looks.** The leader holds the endpoint,
 * and the other windows only take over promptly because it closes its
 * connections on the way out. A host that kills this process instead of asking
 * it to stop would leave them waiting, so every way out leads to `stop()`:
 * a `stop` line, stdin closing because the parent went away, or a signal.
 */

import { createInterface } from 'node:readline';
import { StateBridge } from './bridge.js';
import { characterStates, type CharacterState } from './vendor/protocol.js';

/** What the shell may say to us. */
type Command =
  | { type: 'send'; state: string }
  | { type: 'folders'; folders: string[] }
  | { type: 'stop' };

function emit(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function isCharacterState(value: unknown): value is CharacterState {
  return typeof value === 'string' && (characterStates as readonly string[]).includes(value);
}

/** Folders may be given up front, so the first state is already the right one. */
function initialFolders(): string[] {
  const flag = process.argv.indexOf('--folders');
  if (flag < 0) return [];
  return (process.argv[flag + 1] ?? '')
    .split(',')
    .map(folder => folder.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const bridge = new StateBridge({
    folders: initialFolders(),
    onState: state => emit({ type: 'state', state }),
    onLog: message => emit({ type: 'log', message }),
  });

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    emit({ type: 'stopping', why });
    await bridge.stop();
    process.exit(0);
  };

  await bridge.start();
  emit({ type: 'ready', role: bridge.role, endpoint: bridge.endpoint, state: bridge.state });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    if (!line.trim()) return;
    let command: Command;
    try {
      command = JSON.parse(line) as Command;
    } catch {
      emit({ type: 'log', message: 'ignored a line that was not JSON' });
      return;
    }

    switch (command?.type) {
      case 'send':
        // Simulate State, which overrides every project on purpose.
        if (isCharacterState(command.state)) bridge.setState(command.state);
        return;
      case 'folders':
        if (Array.isArray(command.folders)) {
          bridge.setFolders(command.folders.filter(f => typeof f === 'string'));
        }
        return;
      case 'stop':
        void stop('asked to');
        return;
      default:
        emit({ type: 'log', message: 'ignored an unknown command' });
    }
  });

  // The parent going away closes this, which is the ordinary way a child
  // learns its host has quit - including when the host was killed and never
  // got to ask nicely.
  lines.on('close', () => void stop('the host went away'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch(error => {
  emit({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

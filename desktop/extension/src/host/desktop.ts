/**
 * Desktop entry point: shared activation, plus the socket bridge and the hook
 * installer. Both need Node, so neither is in the web build.
 */

import * as vscode from 'vscode';
import { StateBridge, endpointPath, type CharacterState } from '@agent-companion/agent-state';
import { activate as activateShared, type AgentSource } from './extension.js';
import { registerHookCommands, shimPath } from './hooks-command.js';

class BridgeSource implements AgentSource {
  #bridge: StateBridge | null = null;

  async start(handlers: {
    onState: (state: CharacterState) => void;
    onLog: (message: string) => void;
  }): Promise<void> {
    this.#bridge = new StateBridge({
      onState: handlers.onState,
      onLog: handlers.onLog,
      // What this window has open, so it reacts to agents working here and not
      // to one busy in somebody else's project.
      folders: workspaceFolders(),
    });
    await this.#bridge.start();
  }

  /** A folder added or removed changes what this window should react to. */
  foldersChanged(): void {
    this.#bridge?.setFolders(workspaceFolders());
  }

  async stop(): Promise<void> {
    await this.#bridge?.stop();
    this.#bridge = null;
  }

  setState(state: CharacterState): void {
    this.#bridge?.setState(state);
  }

  describe(): string {
    if (!this.#bridge) return 'Agent Companion is not connected.';
    const role = this.#bridge.role === 'leader'
      ? 'leading, ' + this.#bridge.sessionCount + ' agent session(s) across '
        + this.#bridge.routeCount + ' project(s)'
      : this.#bridge.role === 'subscriber'
        ? 'following another window'
        : 'not connected';
    const folders = workspaceFolders();
    return 'Agent Companion: ' + this.#bridge.state + ' - ' + role
      + '. Reacting to ' + (folders.length ? folders.join(', ') : 'any project')
      + '. Listening on ' + endpointPath() + '.';
  }
}

/** The folders this window has open, as plain paths the bridge can match. */
function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext): void {
  const source = new BridgeSource();
  activateShared(context, source);
  registerHookCommands(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => source.foldersChanged()),
  );
}

export function deactivate(): void {
  // Disposed through the subscriptions registered above.
}

export { shimPath };

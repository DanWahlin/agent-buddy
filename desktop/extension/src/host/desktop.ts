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
    });
    await this.#bridge.start();
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
      ? 'leading, ' + this.#bridge.sessionCount + ' agent session(s)'
      : this.#bridge.role === 'subscriber'
        ? 'following another window'
        : 'not connected';
    return 'Agent Companion: ' + this.#bridge.state + ' - ' + role
      + '. Listening on ' + endpointPath() + '.';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  activateShared(context, new BridgeSource());
  registerHookCommands(context);
}

export function deactivate(): void {
  // Disposed through the subscriptions registered above.
}

export { shimPath };

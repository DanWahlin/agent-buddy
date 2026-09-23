/**
 * Web entry point. The hook bridge needs sockets, so a browser build gets the
 * view and the commands but no agent connection.
 */
import * as vscode from 'vscode';
import { activate as activateShared } from './extension.js';

export function activate(context: vscode.ExtensionContext): void {
  activateShared(context);
}

export function deactivate(): void {
  // Disposed through the subscriptions registered in the shared activation.
}

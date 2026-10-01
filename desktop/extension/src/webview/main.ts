/**
 * The page inside the view, as VS Code hosts it.
 *
 * Everything the page does lives in `startView`, shared with any other host.
 * All that is left here is the one thing a webview does differently: messages
 * go out through `acquireVsCodeApi` and come in on the window.
 */

import { startView, type HostMessage } from '@agent-companion/companion-core';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

startView({
  post: message => vscode.postMessage(message),
  receive: handler => window.addEventListener(
    'message', (event: MessageEvent<HostMessage>) => handler(event.data)),
}, {
  canvas: document.getElementById('stage') as HTMLCanvasElement,
  message: document.getElementById('message') as HTMLParagraphElement,
});

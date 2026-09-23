/**
 * The webview view that shows the companion.
 *
 * One provider serves all three placements - activity bar, panel and explorer -
 * because only one of them is ever contributed at a time, chosen by the
 * `agentCompanion.position` setting's `when` clauses.
 */

import * as vscode from 'vscode';
import type { CharacterState } from '@agent-companion/pack-format';
import type { Direction } from '@agent-companion/renderer';
import type { HostMessage, ViewMessage, ViewSettings } from '../protocol.js';
import { choosePack, discoverPacks, type DiscoveredPack } from './pack-discovery.js';

export const VIEW_IDS = [
  'agentCompanion.sidebarView',
  'agentCompanion.panelView',
  'agentCompanion.explorerView',
] as const;

export class CompanionViewProvider implements vscode.WebviewViewProvider {
  readonly #extensionUri: vscode.Uri;
  readonly #views = new Set<vscode.WebviewView>();
  readonly #output: vscode.LogOutputChannel;

  #packs: DiscoveredPack[] = [];
  #current: DiscoveredPack | null = null;
  #state: CharacterState = 'idle';
  #sleeping = false;

  constructor(extensionUri: vscode.Uri, output: vscode.LogOutputChannel) {
    this.#extensionUri = extensionUri;
    this.#output = output;
  }

  get packs(): DiscoveredPack[] { return this.#packs; }
  get current(): DiscoveredPack | null { return this.#current; }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.#views.add(view);
    view.onDidDispose(() => this.#views.delete(view));

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: this.#resourceRoots(),
    };
    view.webview.onDidReceiveMessage((message: ViewMessage) => this.#onMessage(view, message));

    if (this.#packs.length === 0) await this.refresh();
    view.webview.html = this.#html(view.webview);
  }

  /** Re-read packs from disk and show whichever the settings ask for. */
  async refresh(): Promise<void> {
    const { packs, problems } = await discoverPacks(this.#extensionUri);
    this.#packs = packs;

    for (const problem of problems) {
      this.#output.warn(problem.folder.fsPath + ': ' + problem.reason);
    }

    const wanted = vscode.workspace.getConfiguration('agentCompanion').get<string>('pack');
    this.#current = choosePack(packs, wanted);

    if (!this.#current) {
      this.#post({ type: 'error', message: 'No character packs were found.' });
      this.#output.error('No character packs were found.');
      return;
    }
    if (wanted && this.#current.pack.id !== wanted) {
      this.#output.warn('Pack "' + wanted + '" was not found; showing "'
        + this.#current.pack.id + '" instead.');
    }
    this.#output.info('Showing pack "' + this.#current.pack.id + '" from '
      + this.#current.folder.fsPath);

    // The resource roots depend on which pack is current.
    for (const view of this.#views) {
      view.webview.options = { enableScripts: true, localResourceRoots: this.#resourceRoots() };
      this.#show(view);
    }
  }

  setState(state: CharacterState): void {
    this.#state = state;
    this.#post({ type: 'state', state });
  }

  /** Steer the gaze. Fire and forget: the player ignores it mid-expression. */
  look(direction: Direction): void {
    this.#post({ type: 'look', direction });
  }

  setSleeping(sleeping: boolean): void {
    this.#sleeping = sleeping;
    this.#post({ type: 'sleep', sleeping });
  }

  /** Push changed settings without reloading the pack. */
  applySettings(): void {
    this.#post({ type: 'settings', settings: settings() });
  }

  #onMessage(view: vscode.WebviewView, message: ViewMessage): void {
    if (message.type === 'ready') {
      this.#show(view);
      return;
    }
    if (message.type === 'failed') {
      this.#output.error('Webview: ' + message.message);
      void vscode.window.showErrorMessage('Agent Companion: ' + message.message);
    }
  }

  /** Send the current pack, with every image resolved to a webview URI. */
  #show(view: vscode.WebviewView): void {
    const current = this.#current;
    if (!current) {
      void view.webview.postMessage({
        type: 'error', message: 'No character packs were found.',
      } satisfies HostMessage);
      return;
    }

    const images: Record<string, string> = {};
    for (const track of Object.values(current.pack.tracks)) {
      if (!track) continue;
      for (const name of [track.base, track.blinks]) {
        if (!name || images[name]) continue;
        images[name] = view.webview
          .asWebviewUri(vscode.Uri.joinPath(current.folder, name))
          .toString();
      }
    }

    void view.webview.postMessage({
      type: 'show', pack: current.pack, images, settings: settings(),
    } satisfies HostMessage);

    // A view that was hidden and restored should come back in the state the
    // rest of the session is in, not at idle.
    if (this.#state !== 'idle') void view.webview.postMessage({ type: 'state', state: this.#state });
    if (this.#sleeping) void view.webview.postMessage({ type: 'sleep', sleeping: true });
  }

  #post(message: HostMessage): void {
    for (const view of this.#views) void view.webview.postMessage(message);
  }

  #resourceRoots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.#extensionUri, 'dist')];
    // Only the pack being shown needs to be readable, not every pack found.
    if (this.#current) roots.push(this.#current.folder);
    return roots;
  }

  #html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview.js'));

    // Nothing loads by default. Images come from the pack folder and the
    // script from dist, both under cspSource; there is no connect-src because
    // the page never fetches - the host hands it everything.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Companion</title>
<style nonce="${nonce}">
  html, body {
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  body { display: grid; place-items: center; padding: 8px; box-sizing: border-box; }
  canvas {
    display: block;
    max-width: 100%;
    max-height: 100%;
    cursor: pointer;
    touch-action: none;
  }
  #message {
    display: none;
    padding: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }
  #message.visible { display: block; }
  canvas.hidden { display: none; }
</style>
</head>
<body>
  <canvas id="stage" class="hidden"></canvas>
  <p id="message" role="status">Loading the companion…</p>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function settings(): ViewSettings {
  const configuration = vscode.workspace.getConfiguration('agentCompanion');
  return {
    crossfade: configuration.get<boolean>('crossfade') ?? true,
    maxScale: configuration.get<number>('maxScale') ?? 3,
    autoSleep: configuration.get<boolean>('autoSleep') ?? true,
  };
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Shared activation.
 *
 * Nothing here touches Node, so it serves both the desktop and the web build.
 * The hook bridge needs sockets, so the desktop entry point passes one in and
 * the web entry point does not; everything else is identical.
 */

import * as vscode from 'vscode';
import { CHARACTER_STATES, type CharacterState } from '@agent-companion/pack-format';
import { CompanionViewProvider, VIEW_IDS } from './companion-view.js';
import { gazeDirection } from '@agent-companion/companion-core';

/** What the desktop build adds. The web build passes nothing. */
export interface AgentSource {
  start(handlers: {
    onState: (state: CharacterState) => void;
    onLog: (message: string) => void;
  }): Promise<void>;
  stop(): Promise<void>;
  /** Drive a state by hand, reaching other windows too where possible. */
  setState(state: CharacterState): void;
  /** A short description for the status command. */
  describe(): string;
}

export function activate(context: vscode.ExtensionContext, source?: AgentSource): void {
  const output = vscode.window.createOutputChannel('Agent Companion', { log: true });
  const provider = new CompanionViewProvider(context.extensionUri, output);
  context.subscriptions.push(output);

  for (const id of VIEW_IDS) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(id, provider, {
      // The character keeps animating while the view is hidden. Rebuilding it on
      // every tab switch would mean reloading the pack and a visible restart.
      webviewOptions: { retainContextWhenHidden: true },
    }));
  }

  if (source) {
    void source.start({
      onState: state => provider.setState(state),
      onLog: line => output.info(line),
    });
    context.subscriptions.push({ dispose: () => void source.stop() });
    context.subscriptions.push(
      vscode.commands.registerCommand('agentCompanion.showStatus', () => {
        void vscode.window.showInformationMessage(source.describe());
      }),
    );
  }

  watchTheEditor(context, provider);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentCompanion.reload', () => provider.refresh()),
    vscode.commands.registerCommand('agentCompanion.selectPack', () => selectPack(provider)),
    vscode.commands.registerCommand('agentCompanion.simulateState', () => simulateState(provider, source)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('agentCompanion.pack')
        || event.affectsConfiguration('agentCompanion.packPaths')) {
        void provider.refresh();
        return;
      }
      if (event.affectsConfiguration('agentCompanion.crossfade')
        || event.affectsConfiguration('agentCompanion.maxScale')
        || event.affectsConfiguration('agentCompanion.autoSleep')) {
        provider.applySettings();
      }
    }),
  );
}

export function deactivate(): void {
  // Views and commands are disposed through the subscriptions above.
}

/**
 * Point the gaze at whatever the developer is doing.
 *
 * The caret's place in the *visible* range is what matters, not its place in
 * the file, so scrolling moves the gaze as much as typing does. Selection
 * changes arrive per keystroke, so this is debounced rather than sent raw.
 */
function watchTheEditor(
  context: vscode.ExtensionContext, provider: CompanionViewProvider,
): void {
  let pending: NodeJS.Timeout | undefined;

  const following = () =>
    vscode.workspace.getConfiguration('agentCompanion').get<boolean>('followCaret') ?? true;

  const look = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || !following()) return;
    const visible = editor.visibleRanges[0];
    if (!visible) return;

    const direction = gazeDirection({
      line: editor.selection.active.line,
      column: editor.selection.active.character,
      firstVisibleLine: visible.start.line,
      lastVisibleLine: visible.end.line,
    });
    if (direction) provider.look(direction);
  };

  const schedule = (editor: vscode.TextEditor | undefined): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = undefined; look(editor); }, 150);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => schedule(event.textEditor)),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => schedule(event.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => schedule(editor)),
    // Nothing to watch, and nobody watching: let him rest while the window is
    // in the background, and wake him when it comes back.
    vscode.window.onDidChangeWindowState(state => provider.setSleeping(!state.focused)),
    { dispose: () => { if (pending) clearTimeout(pending); } },
  );
}

async function selectPack(provider: CompanionViewProvider): Promise<void> {
  await provider.refresh();
  const packs = provider.packs;
  if (packs.length === 0) {
    const open = 'Open Settings';
    const choice = await vscode.window.showWarningMessage(
      'No character packs were found. Add a folder to "agentCompanion.packPaths".', open);
    if (choice === open) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'agentCompanion.packPaths');
    }
    return;
  }

  const current = provider.current?.pack.id;
  const picked = await vscode.window.showQuickPick(
    packs.map(candidate => ({
      label: candidate.pack.name,
      description: candidate.pack.id === current ? '$(check) current' : undefined,
      detail: [candidate.pack.description, candidate.pack.author && 'by ' + candidate.pack.author,
        candidate.origin === 'bundled' ? 'bundled' : candidate.folder.fsPath]
        .filter(Boolean).join(' · '),
      id: candidate.pack.id,
    })),
    { title: 'Agent Companion: Select Character Pack', matchOnDetail: true });

  if (!picked) return;
  await vscode.workspace.getConfiguration('agentCompanion')
    .update('pack', picked.id, vscode.ConfigurationTarget.Global);
}

/**
 * Drive a state by hand. Until the hook bridge lands this is the only way to
 * see the expressions, and afterwards it stays the way to check a pack.
 */
async function simulateState(
  provider: CompanionViewProvider, source?: AgentSource,
): Promise<void> {
  const sleep = 'sleep';
  const picked = await vscode.window.showQuickPick(
    [...CHARACTER_STATES, sleep].map(state => ({
      label: state,
      description: describe(state),
    })),
    { title: 'Agent Companion: Simulate State' });
  if (!picked) return;

  if (picked.label === sleep) {
    provider.setSleeping(true);
    return;
  }
  provider.setSleeping(false);
  // Through the bridge when there is one, so other windows follow along.
  if (source) source.setState(picked.label as CharacterState);
  else provider.setState(picked.label as CharacterState);
}

function describe(state: string): string {
  switch (state) {
    case 'idle': return 'looking around';
    case 'working': return 'the agent is running tools';
    case 'complete': return 'the agent finished';
    case 'attention': return 'waiting on you';
    case 'surprise': return 'a reaction';
    case 'sleep': return 'eyes closed';
    default: return '';
  }
}

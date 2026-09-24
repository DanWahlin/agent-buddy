/**
 * Installing and removing the agent hooks.
 *
 * This edits files the user owns, outside the workspace, so it asks first,
 * shows exactly which paths it will touch, and can undo itself. Copilot CLI's
 * hook file is ours alone and is written whole; Claude Code's settings.json
 * belongs to the user, so it is merged and re-serialised with only our entries
 * changed.
 */

import * as vscode from 'vscode';
import {
  copilotCliHooks, installShim, mergeClaudeCodeHooks, removeClaudeCodeHooks, removeShim,
  shimPath as installedShimPath, type HookTarget,
} from '@agent-companion/agent-state';

type Agent = 'claude-code' | 'copilot-cli';

const LABELS: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'Copilot CLI',
};

/** The copy that ships inside this extension, which is the one to install. */
export function bundledShim(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'hook.js').fsPath;
}

/** Where the installed shim lives: its own place, not this extension's. */
export const shimPath = installedShimPath;

function target(): HookTarget {
  // process.execPath in the extension host is the Electron binary, which runs
  // Node when ELECTRON_RUN_AS_NODE is set - but a hook invoked by an agent will
  // not have that. Prefer a real node on PATH and let the user correct it.
  //
  // The shim is named at its own path rather than this extension's. An
  // extension directory carries its version, so it stops existing on the next
  // update, and Copilot CLI's preToolUse is fail-closed: hooks naming a shim
  // that cannot be run do not go unheard, they deny the tool call.
  return { node: 'node', shim: installedShimPath() };
}

function settingsUri(agent: Agent): vscode.Uri {
  const home = homeUri();
  return agent === 'claude-code'
    ? vscode.Uri.joinPath(home, '.claude', 'settings.json')
    : vscode.Uri.joinPath(home, '.copilot', 'hooks', 'agent-companion-vscode.json');
}

function homeUri(): vscode.Uri {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return vscode.Uri.file(home);
}

export function registerHookCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentCompanion.installHooks',
      () => installHooks(context.extensionUri)),
    vscode.commands.registerCommand('agentCompanion.uninstallHooks',
      () => uninstallHooks()),
  );
}

async function pickAgents(title: string): Promise<Agent[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    (Object.keys(LABELS) as Agent[]).map(agent => ({
      label: LABELS[agent],
      description: settingsUri(agent).fsPath,
      agent,
      picked: true,
    })),
    { title, canPickMany: true });
  return picked?.map(item => item.agent);
}

/**
 * Can an agent actually run the shim?
 *
 * The hooks invoke `node` from PATH, because `process.execPath` here is the
 * Electron binary and only behaves as Node with an environment variable an
 * agent will not set. If PATH has no node, the hooks would fail silently and
 * the character would simply never react - worth saying up front.
 */
async function nodeVersion(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile('node', ['--version'], { timeout: 5000, shell: process.platform === 'win32' },
      (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

async function installHooks(extensionUri: vscode.Uri): Promise<void> {
  const agents = await pickAgents('Agent Companion: Install Hooks For');
  if (!agents?.length) return;

  const version = await nodeVersion();
  if (!version) {
    const anyway = 'Install Anyway';
    const choice = await vscode.window.showWarningMessage(
      'Node could not be found on PATH.',
      {
        modal: true,
        detail: 'The hooks run "node" to reach this extension. Without it on PATH '
          + 'they will do nothing, and the character will not react to agent activity.',
      },
      anyway);
    if (choice !== anyway) return;
  }

  const paths = agents.map(agent => settingsUri(agent).fsPath).join('\n  ');
  const proceed = await vscode.window.showWarningMessage(
    'Agent Companion will edit these files:',
    { modal: true, detail: '  ' + paths + '\n\nExisting hooks are kept.' },
    'Install');
  if (proceed !== 'Install') return;

  try {
    // Before anything names it, so no hook ever points at a shim that is not
    // there yet - which on Copilot CLI would block the agent, not just the art.
    await installShim(bundledShim(extensionUri));
  } catch (error) {
    void vscode.window.showErrorMessage(
      'Could not put the hook shim in place: ' + message(error));
    return;
  }

  const done: string[] = [];
  for (const agent of agents) {
    try {
      await (agent === 'claude-code' ? installClaudeCode() : installCopilotCli());
      done.push(LABELS[agent]);
    } catch (error) {
      void vscode.window.showErrorMessage(
        'Could not install hooks for ' + LABELS[agent] + ': ' + message(error));
    }
  }

  if (!done.length) return;
  const show = 'Show File';
  const choice = await vscode.window.showInformationMessage(
    'Hooks installed for ' + done.join(' and ')
    + '. Restart any running agent session to pick them up.', show);
  if (choice === show) {
    await vscode.window.showTextDocument(settingsUri(agents[0]));
  }
}

async function installClaudeCode(): Promise<void> {
  const uri = settingsUri('claude-code');
  const existing = await readJson(uri);
  const merged = mergeClaudeCodeHooks(existing, target());
  await writeJson(uri, merged);
}

async function installCopilotCli(): Promise<void> {
  // This file is ours alone, so it is replaced rather than merged.
  await writeJson(settingsUri('copilot-cli'), copilotCliHooks(target()));
}

async function uninstallHooks(): Promise<void> {
  const agents = await pickAgents('Agent Companion: Remove Hooks From');
  if (!agents?.length) return;

  const removed: Agent[] = [];
  for (const agent of agents) {
    try {
      const uri = settingsUri(agent);
      if (agent === 'copilot-cli') {
        await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
        removed.push(agent);
        continue;
      }
      const existing = await readJson(uri);
      await writeJson(uri, removeClaudeCodeHooks(existing, shimPath()));
      removed.push(agent);
    } catch (error) {
      void vscode.window.showErrorMessage(
        'Could not remove hooks for ' + LABELS[agent] + ': ' + message(error));
    }
  }

  // Only once nothing names it any more. Taking the shim away while an agent
  // still has hooks pointing at it is the exact failure this all exists to
  // avoid - and on Copilot CLI it would deny every tool call.
  const everyAgent = (Object.keys(LABELS) as Agent[]).every(agent => removed.includes(agent));
  if (everyAgent) await removeShim();

  void vscode.window.showInformationMessage(
    everyAgent
      ? 'Agent Companion hooks removed.'
      : 'Agent Companion hooks removed. The shim stays, because the other agent still uses it.');
}

async function readJson(uri: vscode.Uri): Promise<Record<string, unknown>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes).trim();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    // A missing file is the normal first-run case. Anything else - unreadable,
    // or JSON we would destroy by overwriting - must stop the install.
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return {};
    if (error instanceof SyntaxError) {
      throw new Error(uri.fsPath + ' is not valid JSON, so it was left alone.');
    }
    throw error;
  }
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, body);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

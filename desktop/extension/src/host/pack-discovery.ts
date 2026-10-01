/**
 * Finding character packs, the VS Code way.
 *
 * The rules live in `@agent-companion/companion-core`; this supplies the two
 * things that are VS Code's business. Everything goes through
 * `vscode.workspace.fs` rather than `node:fs`, so the same code works in a
 * desktop window and in vscode.dev, and the roots come from the extension's
 * own folder plus whatever the settings add.
 */

import * as vscode from 'vscode';
import {
  choosePack, discoverPacks as discover,
  type DiscoveredPack as CoreDiscoveredPack,
  type DiscoveryResult as CoreDiscoveryResult,
  type PackFileSystem,
} from '@agent-companion/companion-core';

export type DiscoveredPack = CoreDiscoveredPack<vscode.Uri>;
export type DiscoveryResult = CoreDiscoveryResult<vscode.Uri>;
export { choosePack };

const filesystem: PackFileSystem<vscode.Uri> = {
  join: (folder, name) => vscode.Uri.joinPath(folder, name),

  async exists(target) {
    try {
      await vscode.workspace.fs.stat(target);
      return true;
    } catch {
      return false;
    }
  },

  async readFile(target) {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
  },

  async readDirectories(folder) {
    const entries = await vscode.workspace.fs.readDirectory(folder);
    return entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => name);
  },
};

/**
 * Discover packs bundled with the extension plus any in `agentCompanion.packPaths`.
 * Later sources win on id, so a user can shadow the bundled pack with their own.
 */
export function discoverPacks(extensionUri: vscode.Uri): Promise<DiscoveryResult> {
  return discover(filesystem, [
    { folder: vscode.Uri.joinPath(extensionUri, 'packs'), origin: 'bundled' },
    ...packPathSetting().map(configured => ({
      folder: toUri(configured), origin: 'configured' as const,
    })),
  ]);
}

/** The configured extra pack locations, trimmed and de-duplicated. */
function packPathSetting(): string[] {
  const raw = vscode.workspace.getConfiguration('agentCompanion').get<string[]>('packPaths') ?? [];
  return [...new Set(raw.map(value => value.trim()).filter(Boolean))];
}

function toUri(value: string): vscode.Uri {
  // A bare path is far more likely than a URI, and Uri.parse would silently
  // read a Windows drive letter as a scheme.
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(value) ? vscode.Uri.parse(value) : vscode.Uri.file(value);
}

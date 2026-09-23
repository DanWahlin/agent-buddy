/**
 * Finding character packs.
 *
 * Everything goes through `vscode.workspace.fs` rather than `node:fs`, so the
 * same code works in a desktop window and in vscode.dev.
 *
 * A configured path may point either at a pack folder - one holding a
 * `pack.json` - or at a folder of them, because both are natural things for
 * someone to type after running the packer a few times.
 */

import * as vscode from 'vscode';
import { validatePack, type Pack } from '@agent-companion/pack-format';

export interface DiscoveredPack {
  pack: Pack;
  /** The folder holding `pack.json`, used as a webview resource root. */
  folder: vscode.Uri;
  /** Where it came from, for the picker and for error messages. */
  origin: 'bundled' | 'configured';
}

export interface DiscoveryResult {
  packs: DiscoveredPack[];
  /** Folders that looked like packs but could not be used, with the reason. */
  problems: Array<{ folder: vscode.Uri; reason: string }>;
}

const MANIFEST = 'pack.json';

/**
 * Discover packs bundled with the extension plus any in `agentCompanion.packPaths`.
 * Later sources win on id, so a user can shadow the bundled pack with their own.
 */
export async function discoverPacks(extensionUri: vscode.Uri): Promise<DiscoveryResult> {
  const problems: DiscoveryResult['problems'] = [];
  const byId = new Map<string, DiscoveredPack>();

  const roots: Array<{ uri: vscode.Uri; origin: DiscoveredPack['origin'] }> = [
    { uri: vscode.Uri.joinPath(extensionUri, 'packs'), origin: 'bundled' },
  ];
  for (const configured of packPathSetting()) {
    roots.push({ uri: toUri(configured), origin: 'configured' });
  }

  for (const { uri, origin } of roots) {
    for (const folder of await packFolders(uri, problems)) {
      const loaded = await readPack(folder, origin, problems);
      if (loaded) byId.set(loaded.pack.id, loaded);
    }
  }

  return { packs: [...byId.values()], problems };
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

/**
 * Resolve a root to the pack folders under it: the root itself when it holds a
 * manifest, otherwise its immediate subdirectories that do.
 */
async function packFolders(
  root: vscode.Uri, problems: DiscoveryResult['problems'],
): Promise<vscode.Uri[]> {
  if (await exists(vscode.Uri.joinPath(root, MANIFEST))) return [root];

  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    // A missing bundled folder is a build problem; a missing configured one is
    // the user's typo. Either way it is worth surfacing, but not throwing over.
    problems.push({ folder: root, reason: 'could not be read' });
    return [];
  }

  const found: vscode.Uri[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const folder = vscode.Uri.joinPath(root, name);
    if (await exists(vscode.Uri.joinPath(folder, MANIFEST))) found.push(folder);
  }
  if (found.length === 0) {
    problems.push({ folder: root, reason: 'contains no pack.json, and no folder that has one' });
  }
  return found;
}

async function readPack(
  folder: vscode.Uri, origin: DiscoveredPack['origin'], problems: DiscoveryResult['problems'],
): Promise<DiscoveredPack | null> {
  const manifest = vscode.Uri.joinPath(folder, MANIFEST);
  let pack: unknown;
  try {
    const bytes = await vscode.workspace.fs.readFile(manifest);
    pack = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    problems.push({ folder, reason: 'pack.json could not be read: ' + message(error) });
    return null;
  }

  // Structural validation only. Checking image dimensions would mean decoding
  // every strip in every pack on startup, which is not worth it here - the
  // renderer reports a missing or malformed image when it loads one.
  const errors = validatePack(pack);
  if (errors.length) {
    problems.push({ folder, reason: 'pack.json is not valid: ' + errors[0] });
    return null;
  }

  return { pack: pack as Pack, folder, origin };
}

/** Choose the pack named in settings, falling back to whatever is available. */
export function choosePack(packs: DiscoveredPack[], wanted: string | undefined): DiscoveredPack | null {
  if (packs.length === 0) return null;
  return packs.find(candidate => candidate.pack.id === wanted) ?? packs[0];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

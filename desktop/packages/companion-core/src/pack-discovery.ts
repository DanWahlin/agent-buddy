/**
 * Finding character packs, without knowing what a folder is.
 *
 * The rules are the same wherever the companion runs, but the way to read a
 * directory is not: a VS Code window goes through `workspace.fs`, so that the
 * same code works in vscode.dev, while a desktop app goes straight to
 * `node:fs`. So the folder is an opaque handle the caller supplies operations
 * for, rather than a path - a `Uri` survives the round trip that way, and
 * remote packs keep working.
 *
 * A configured root may point either at a pack folder - one holding a
 * `pack.json` - or at a folder of them, because both are natural things for
 * someone to type after running the packer a few times.
 */

import { validatePack, type Pack } from '@agent-companion/pack-format';

const MANIFEST = 'pack.json';

export type PackOrigin = 'bundled' | 'configured';

/** Somewhere to look, and what to call it when reporting a problem. */
export interface PackRoot<Folder> {
  folder: Folder;
  origin: PackOrigin;
}

/** The little of a filesystem that discovery needs. */
export interface PackFileSystem<Folder> {
  /** The child of `folder` called `name`. */
  join(folder: Folder, name: string): Folder;
  exists(target: Folder): Promise<boolean>;
  /** The contents of `target` as text. */
  readFile(target: Folder): Promise<string>;
  /** The names of the immediate subdirectories of `folder`. */
  readDirectories(folder: Folder): Promise<string[]>;
}

export interface DiscoveredPack<Folder> {
  pack: Pack;
  /** The folder holding `pack.json`. A webview also uses it as a resource root. */
  folder: Folder;
  /** Where it came from, for the picker and for error messages. */
  origin: PackOrigin;
}

export interface DiscoveryResult<Folder> {
  packs: Array<DiscoveredPack<Folder>>;
  /** Folders that looked like packs but could not be used, with the reason. */
  problems: Array<{ folder: Folder; reason: string }>;
}

/**
 * Discover the packs under each root, in order.
 *
 * Later roots win on id, so a caller that puts its bundled packs first lets a
 * user shadow one with their own.
 */
export async function discoverPacks<Folder>(
  filesystem: PackFileSystem<Folder>,
  roots: ReadonlyArray<PackRoot<Folder>>,
): Promise<DiscoveryResult<Folder>> {
  const problems: DiscoveryResult<Folder>['problems'] = [];
  const byId = new Map<string, DiscoveredPack<Folder>>();

  for (const { folder, origin } of roots) {
    for (const found of await packFolders(filesystem, folder, problems)) {
      const loaded = await readPack(filesystem, found, origin, problems);
      if (loaded) byId.set(loaded.pack.id, loaded);
    }
  }

  return { packs: [...byId.values()], problems };
}

/**
 * Resolve a root to the pack folders under it: the root itself when it holds a
 * manifest, otherwise its immediate subdirectories that do.
 */
async function packFolders<Folder>(
  filesystem: PackFileSystem<Folder>,
  root: Folder,
  problems: DiscoveryResult<Folder>['problems'],
): Promise<Folder[]> {
  if (await filesystem.exists(filesystem.join(root, MANIFEST))) return [root];

  let names: string[];
  try {
    names = await filesystem.readDirectories(root);
  } catch {
    // A missing bundled folder is a build problem; a missing configured one is
    // the user's typo. Either way it is worth surfacing, but not throwing over.
    problems.push({ folder: root, reason: 'could not be read' });
    return [];
  }

  const found: Folder[] = [];
  for (const name of names) {
    const folder = filesystem.join(root, name);
    if (await filesystem.exists(filesystem.join(folder, MANIFEST))) found.push(folder);
  }
  if (found.length === 0) {
    problems.push({ folder: root, reason: 'contains no pack.json, and no folder that has one' });
  }
  return found;
}

async function readPack<Folder>(
  filesystem: PackFileSystem<Folder>,
  folder: Folder,
  origin: PackOrigin,
  problems: DiscoveryResult<Folder>['problems'],
): Promise<DiscoveredPack<Folder> | null> {
  let pack: unknown;
  try {
    pack = JSON.parse(await filesystem.readFile(filesystem.join(folder, MANIFEST)));
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
export function choosePack<Folder>(
  packs: Array<DiscoveredPack<Folder>>, wanted: string | undefined,
): DiscoveredPack<Folder> | null {
  if (packs.length === 0) return null;
  return packs.find(candidate => candidate.pack.id === wanted) ?? packs[0];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

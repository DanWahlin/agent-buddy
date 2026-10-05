import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readdir, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {builtInCharacterDirectory} from './character-pack.js';
import {findExecutable} from './agents/commands.js';

const execFileAsync = promisify(execFile);

export interface CharacterBuildOptions {
  // The source checkout that holds characters/ and tools/character_pack.py.
  root?: string;
  python?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

// Rebuilds the built-in packs when characters/ changes, so a character added or updated by
// `git pull` shows up on the settings page without another setup step.
export class CharacterPackBuilder {
  readonly #root: string | undefined;
  readonly #python: string;
  readonly #pythonOptions: string[];
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;
  #built: string | undefined;
  #running: Promise<void> | undefined;

  constructor(options: CharacterBuildOptions = {}) {
    this.#root = 'root' in options ? options.root : defaultRoot();
    [this.#python, this.#pythonOptions] = options.python ? [options.python, []] : defaultPython();
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#log = options.log ?? (message => console.error(message));
  }

  // Never throws: when a rebuild isn't possible, the packs that are already built are used.
  refresh(): Promise<void> {
    this.#running ??= this.#refresh().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #refresh(): Promise<void> {
    const root = this.#root;
    const script = root && join(root, 'tools', 'character_pack.py');
    if (!root || !script || !existsSync(script) || !existsSync(join(root, 'characters'))) return;
    try {
      if (await packFingerprint(root) === this.#built) return;
      await execFileAsync(this.#python, [...this.#pythonOptions, script, 'build'],
                          {cwd: root, timeout: this.#timeoutMs, windowsHide: true});
      this.#built = await packFingerprint(root);
      console.log('[character] rebuilt character packs');
    } catch (error) {
      const detail = error && typeof error === 'object' && 'stderr' in error && String(error.stderr).trim();
      this.#log(`[character] couldn't rebuild character packs, using the existing ones: ${
        detail || (error instanceof Error ? error.message : String(error))}`);
    }
  }
}

// Windows has the "py" launcher or python.exe; "python3" there is often a Microsoft Store shortcut.
export function defaultPython(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
                              exists?: (path: string) => boolean): [string, string[]] {
  if (platform !== 'win32') return ['python3', []];
  const py = findExecutable('py', env, platform, exists);
  if (py) return [py, ['-3']];
  return [findExecutable('python', env, platform, exists) ?? 'python', []];
}

// A custom pack directory isn't tied to a checkout, so there is nothing to rebuild.
function defaultRoot(): string | undefined {
  if (process.env.AGENT_COMPANION_CHARACTERS) return undefined;
  return resolve(builtInCharacterDirectory(), '..', '..');
}

// Packs are built from each character's top-level files (character.json, frames.bin,
// frames.json). Their sizes and times, plus the built packs', tell whether a rebuild
// could change anything.
export async function packFingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  const add = async (path: string) => {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) parts.push(`${path}:${info.size}:${info.mtimeMs}`);
  };
  const files = async (folder: string) => (await readdir(folder).catch(() => [])).sort();
  await add(join(root, 'tools', 'character_pack.py'));
  for (const name of await files(join(root, 'characters'))) {
    const folder = join(root, 'characters', name);
    if (!existsSync(join(folder, 'character.json'))) continue;
    for (const file of await files(folder)) await add(join(folder, file));
  }
  const output = join(root, 'build', 'characters');
  for (const file of await files(output)) if (file.endsWith('.acpk')) await add(join(output, file));
  return parts.join('\n');
}

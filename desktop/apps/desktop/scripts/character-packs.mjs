import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

export function builtInPackFiles(root) {
  const characters = join(root, 'characters');
  const ids = JSON.parse(readFileSync(join(characters, 'built-in.json'), 'utf8'));
  if (!Array.isArray(ids) || ids.length === 0
      || ids.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,15}$/.test(id))
      || new Set(ids).size !== ids.length) {
    throw new Error('characters/built-in.json must list unique valid character ids.');
  }
  const folders = readdirSync(characters, {withFileTypes: true})
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const sortedIds = [...ids].sort();
  if (JSON.stringify(folders) !== JSON.stringify(sortedIds)) {
    throw new Error('Built-in character sources must match characters/built-in.json. '
      + 'Keep add-on character sources in a separate repository.');
  }
  return sortedIds.map(id => {
    const manifest = JSON.parse(readFileSync(join(characters, id, 'character.json'), 'utf8'));
    if (manifest?.id !== id) throw new Error(`Character manifest id does not match its folder: ${id}.`);
    const file = `${id}.acpk`;
    const path = join(root, 'build', 'characters', file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Missing built-in character pack ${file}. Run "python3 tools/character_pack.py build" first.`);
    }
    return file;
  });
}

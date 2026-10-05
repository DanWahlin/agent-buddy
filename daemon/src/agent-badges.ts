import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {agentIds, type AgentId} from './agents/types.js';
import {customIconDirectory} from './display-settings.js';
import {pngToMask24} from './png-mask.js';

export type AgentBadgeRole = 'w' | 'a' | 'c';
export type AgentBadgeRoleName = 'working' | 'attention' | 'complete';

export interface AgentBadgeIconDefinition {
  id: AgentId;
  name: string;
  color: string;
  mask: Buffer;
}

export interface AgentBadgeActive {
  id: AgentId;
  role: AgentBadgeRole;
}

export interface AgentBadgeStatusIcon {
  id: AgentId;
  name: string;
  color: string;
  mask: string;
}

const names: Record<AgentId, string> = {
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  grok: 'Grok Build',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
};

// 24x24 pixel-art glyphs hand-drawn for this project; some are simplified takes on each agent's
// logo or mascot. Users can override them with <daemon data>/icons/<id>.png (see docs/development.md).
const defaultIcons: Record<AgentId, {color: string; art: readonly string[]}> = {
  copilot: {color: '#8F9BFF', art: [
    '........................',
    '........................',
    '........................',
    '.......##########.......',
    '.....##############.....',
    '....##............##....',
    '....#.#####..#####.##...',
    '...##.#...##.#...#..#...',
    '..##..#...####...##.##..',
    '####..#...####...##.####',
    '#####.##..##.#..##..####',
    '#####..####..#####.#####',
    '######............######',
    '########################',
    '########################',
    '#########.####.#########',
    '.########..###..#######.',
    '...######..###..#####...',
    '....#####.####.#####....',
    '.....##############.....',
    '......############......',
    '........########........',
    '........................',
    '........................',
  ]},
  claude: {color: '#E5896A', art: [
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '...##################...',
    '...##################...',
    '...##################...',
    '...###..########..###...',
    '...###..########..###...',
    '...###..########..###...',
    '########################',
    '########################',
    '########################',
    '...##################...',
    '...##################...',
    '...##################...',
    '....##.##......##.##....',
    '....##.##......##.##....',
    '....##.##......##.##....',
    '........................',
    '........................',
    '........................',
    '........................',
  ]},
  codex: {color: '#5EE0A0', art: [
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '....##..................',
    '...####.................',
    '....#####...............',
    '.....#####..............',
    '......#####.............',
    '.......#####............',
    '........#####...........',
    '.........####...........',
    '........####............',
    '......#####.............',
    '.....#####..............',
    '....#####....#.....#....',
    '...#####....#########...',
    '....##......#########...',
    '.............#######....',
    '........................',
    '........................',
    '........................',
    '........................',
  ]},
  grok: {color: '#E8EAED', art: [
    '........................',
    '........................',
    '........................',
    '.........######.....#...',
    '.......########....#....',
    '......#########...#.....',
    '.....#########..##......',
    '....#####......###......',
    '....####......###.......',
    '...####......###..###...',
    '...####.....###..####...',
    '...####....###...####...',
    '...####...###....####...',
    '...####..###.....####...',
    '...###..###......####...',
    '.......###......####....',
    '......###......#####....',
    '......##..#########.....',
    '.....#...#########......',
    '....#....########.......',
    '...#.....######.........',
    '........................',
    '........................',
    '........................',
  ]},
  hermes: {color: '#F0C050', art: [
    '........................',
    '........................',
    '..........####..........',
    '..........####..........',
    '.........######.........',
    '..........####..........',
    '...##.##...###..##.##...',
    '.########..###.########.',
    '.########..############.',
    '...###################..',
    '......#############.....',
    '.........#######........',
    '..........####..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '...........###..........',
    '..........####..........',
    '...........##...........',
    '........................',
  ]},
  openclaw: {color: '#FF6B6B', art: [
    '........................',
    '........................',
    '..###..............###..',
    '....##............##....',
    '......##.######.##......',
    '......############......',
    '.....##############.....',
    '....####..####..####....',
    '...#####..####..#####...',
    '...##################...',
    '.##.################.##.',
    '###.################.###',
    '###.################.###',
    '.##.################.##.',
    '....################....',
    '.....##############.....',
    '......############......',
    '.......##########.......',
    '........########........',
    '.........##..##.........',
    '.........##..##.........',
    '........................',
    '........................',
    '........................',
  ]},
};

export function asciiMask(lines: readonly string[]): Buffer {
  if (lines.length !== 24 || lines.some(line => line.length !== 24))
    throw new Error('Agent badge ASCII art must be 24 by 24.');
  const mask = Buffer.alloc(72);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const char = lines[y]?.[x];
      if (char && char !== '.') {
        const index = y * 3 + Math.floor(x / 8);
        mask[index] = (mask[index] ?? 0) | (0x80 >> (x % 8));
      }
    }
  }
  return mask;
}

export async function loadAgentBadgeIcons(dataDir: string): Promise<AgentBadgeIconDefinition[]> {
  const directory = customIconDirectory(dataDir);
  const icons: AgentBadgeIconDefinition[] = [];
  for (const id of agentIds) {
    const defaults = defaultIcons[id];
    let color = defaults.color;
    let mask = asciiMask(defaults.art);
    try {
      mask = pngToMask24(await readFile(join(directory, `${id}.png`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error(`[badges] ${id}.png ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const parsed = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as {color?: unknown};
      if (typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.color)) color = parsed.color.toUpperCase();
      else console.error(`[badges] ${id}.json ignored: color must be #RRGGBB`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error(`[badges] ${id}.json ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
    icons.push({id, name: names[id], color: normalizeColor(color), mask});
  }
  return icons;
}

export function iconPacket(icon: AgentBadgeIconDefinition): string {
  return `%${icon.id}:${normalizeColor(icon.color).slice(1)}:${icon.mask.toString('base64')}\n`;
}

export function activePacket(active: readonly AgentBadgeActive[]): string {
  return active.length ? `&${active.map(item => `${item.id}=${item.role}`).join(',')}\n` : '&\n';
}

export function shouldSendBadges(protocol: number): boolean {
  return Number.isInteger(protocol) && protocol >= 6;
}

export function statusIcons(icons: readonly AgentBadgeIconDefinition[]): AgentBadgeStatusIcon[] {
  return icons.map(icon => ({id: icon.id, name: icon.name, color: icon.color, mask: icon.mask.toString('base64')}));
}

export function roleName(role: AgentBadgeRole): AgentBadgeRoleName {
  return role === 'w' ? 'working' : role === 'a' ? 'attention' : 'complete';
}

function normalizeColor(color: string): string {
  return color.startsWith('#') ? color.toUpperCase() : `#${color.toUpperCase()}`;
}

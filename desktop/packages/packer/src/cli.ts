#!/usr/bin/env node
/**
 * `agent-pack` - turn a rendered character rig into an Agent Companion pack.
 *
 *   agent-pack build <rig-dir...> --out <dir> --id marvin --name Marvin
 *   agent-pack validate <pack-dir>
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { validatePack } from '@agent-companion/pack-format';
import { buildPack } from './build.js';
import { cutoutPack } from './cutout.js';
import { readRig } from './rig.js';
import { probeIn } from './webp.js';

interface Flags {
  positional: string[];
  out?: string;
  id?: string;
  name?: string;
  author?: string;
  license?: string;
  description?: string;
  steps?: number;
  scale?: number;
  quality?: number;
  eyeMargin?: number;
  background?: string | null;
  anchor?: string;
  quiet: boolean;
  dryRun?: boolean;
}

const USAGE = [
  'Usage:',
  '  agent-pack build <rig-dir...> --out <dir> --id <id> --name <name> [options]',
  '  agent-pack validate <pack-dir>',
  '  agent-pack cutout <pack-dir> [--dry-run]   make an existing pack transparent',
  '',
  'Build options:',
  '  --out <dir>          where to write the pack            (required)',
  '  --id <id>            pack identifier                    (required)',
  '  --name <name>        display name                       (defaults to --id)',
  '  --author <who>       pack author',
  '  --license <spdx>     pack licence',
  '  --description <text> one-line description',
  '  --steps <n>          poses to keep per track            (default: half the rig)',
  '  --scale <f>          frame scale, 0 < f <= 1            (default: 0.5)',
  '  --quality <n>        WebP quality 1-100                 (default: 82)',
  '  --eye-margin <px>    bloom allowance around eye boxes   (default: 6)',
  '  --background <hex>   draw on an opaque card instead of cutting out',
  '  --alpha              cut the backdrop away                (default)',
  '  --anchor <png>       canonical centre pose for frame 0',
  '  --quiet              only print the summary',
].join('\n');

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error('Missing value for ' + arg);
      return value;
    };
    switch (arg) {
      case '--out': flags.out = next(); break;
      case '--id': flags.id = next(); break;
      case '--name': flags.name = next(); break;
      case '--author': flags.author = next(); break;
      case '--license': flags.license = next(); break;
      case '--description': flags.description = next(); break;
      case '--steps': flags.steps = Number(next()); break;
      case '--scale': flags.scale = Number(next()); break;
      case '--quality': flags.quality = Number(next()); break;
      case '--eye-margin': flags.eyeMargin = Number(next()); break;
      case '--background': flags.background = next(); break;
      case '--alpha': flags.background = null; break;
      case '--anchor': flags.anchor = next(); break;
      case '--quiet': flags.quiet = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default:
        if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
        flags.positional.push(arg);
    }
  }
  return flags;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function commandBuild(flags: Flags): Promise<number> {
  if (flags.positional.length === 0) throw new Error('No rig directory given.');
  if (!flags.out) throw new Error('--out is required.');
  if (!flags.id) throw new Error('--id is required.');

  const directories = flags.positional.map(directory => resolve(directory));
  const outDir = resolve(flags.out);
  const log = flags.quiet ? () => {} : (message: string) => console.log('  ' + message);

  const rig = readRig(directories);
  if (!flags.quiet) {
    console.log('Rig: ' + rig.tracks.size + ' tracks, ' + rig.count + ' poses, '
      + rig.width + 'x' + rig.height + ', ' + rig.blinkLevels.length + ' blink levels');
  }

  const result = await buildPack({
    rig,
    outDir,
    id: flags.id,
    name: flags.name ?? flags.id,
    author: flags.author,
    license: flags.license,
    description: flags.description,
    steps: flags.steps,
    scale: flags.scale,
    quality: flags.quality,
    eyeMargin: flags.eyeMargin,
    background: flags.background ?? null,
    anchor: flags.anchor ? resolve(flags.anchor) : undefined,
    onProgress: log,
  });

  const errors = validatePack(result.pack, probeIn(outDir));
  if (errors.length) {
    console.error('Pack failed validation:');
    for (const error of errors) console.error('  - ' + error);
    return 1;
  }

  const { pack } = result;
  console.log('');
  console.log('Wrote ' + basename(outDir) + ': ' + Object.keys(pack.tracks).length + ' tracks, '
    + pack.steps + ' steps, ' + pack.frame.width + 'x' + pack.frame.height
    + ', ' + formatBytes(result.bytes));
  if (result.realigned.length) {
    console.log('Realigned frame 0 on ' + result.realigned.length + ' track(s) that drifted '
      + 'from the centre pose: ' + result.realigned.join(', '));
  }
  if (result.neverBlink.length) {
    console.log('No blink strip needed for: ' + result.neverBlink.join(', '));
  }
  return 0;
}

async function commandValidate(flags: Flags): Promise<number> {
  const directory = resolve(flags.positional[0] ?? '.');
  const packPath = join(directory, 'pack.json');
  if (!existsSync(packPath)) {
    console.error('No pack.json in ' + directory);
    return 1;
  }
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const errors = validatePack(pack, probeIn(directory));
  if (errors.length) {
    console.error(directory + ' is not a valid pack:');
    for (const error of errors) console.error('  - ' + error);
    return 1;
  }
  console.log(directory + ' is a valid pack (' + Object.keys(pack.tracks).length + ' tracks).');
  return 0;
}

async function commandCutout(flags: Flags): Promise<number> {
  const directory = resolve(flags.positional[0] ?? '.');
  const results = await cutoutPack(directory, { dryRun: flags.dryRun });

  for (const { name, background } of results) {
    console.log('  ' + name.padEnd(28) + (background * 100).toFixed(1) + '% backdrop removed');
  }
  // A strip that comes out almost all or almost none of either is a sign the
  // threshold does not suit this art, and is worth saying rather than shipping.
  const odd = results.filter(r => r.background < 0.15 || r.background > 0.9);
  if (odd.length) {
    console.warn('\nCheck these by eye; the proportion removed looks wrong: '
      + odd.map(r => r.name).join(', '));
  }
  console.log(flags.dryRun
    ? '\nDry run; nothing written.'
    : '\nRewrote ' + results.length + ' base strips and dropped the pack background.');
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  const flags = parseArgs(rest);
  let code = 1;
  switch (command) {
    case 'build': code = await commandBuild(flags); break;
    case 'validate': code = await commandValidate(flags); break;
    case 'cutout': code = await commandCutout(flags); break;
    default:
      console.error('Unknown command: ' + command);
      console.error(USAGE);
  }
  process.exit(code);
}

// Keep sharp from holding threads open longer than the CLI needs them.
sharp.cache(false);

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

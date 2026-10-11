import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {agentsConfigPath} from '../paths.js';
import {recordOf, uniqueTemporaryPath} from './file-utils.js';
import type {AgentId} from './types.js';

export interface AgentsConfig {
  enabled: Partial<Record<AgentId, boolean>>;
  // When each agent's hooks first reached the daemon; proves the hooks are loaded.
  seen?: Partial<Record<AgentId, number>>;
  // Agents whose hooks the user removed. Setup and app updates don't add these hooks back.
  removed?: Partial<Record<AgentId, boolean>>;
  // An empty record means no hooks have been approved. Missing means a legacy installation.
  approved?: Partial<Record<AgentId, boolean>>;
  problem?: string;
}

const reportedProblems = new Set<string>();

function unreadableConfig(error: unknown, path: string): AgentsConfig {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {enabled: {}};
  const problem = 'Saved agent choices could not be read. Run setup again to repair them. Hooks are disabled until choices can be saved.';
  if (!reportedProblems.has(path)) {
    console.error(`[agents] ${problem} File: ${path}`);
    reportedProblems.add(path);
  }
  return {enabled: {}, approved: {}, problem};
}

export async function loadAgentsConfig(path = agentsConfigPath()): Promise<AgentsConfig> {
  try {
    const config = fromJson(JSON.parse(await readFile(path, 'utf8')));
    reportedProblems.delete(path);
    return config;
  } catch (error) {
    return unreadableConfig(error, path);
  }
}

export function loadAgentsConfigSync(path = agentsConfigPath()): AgentsConfig {
  try {
    const config = fromJson(JSON.parse(readFileSync(path, 'utf8')));
    reportedProblems.delete(path);
    return config;
  } catch (error) {
    return unreadableConfig(error, path);
  }
}

export async function saveAgentsConfig(config: AgentsConfig, path = agentsConfigPath()): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = uniqueTemporaryPath(path);
  const {problem: _problem, ...saved} = config;
  await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

let pendingUpdate: Promise<unknown> = Promise.resolve();

// Serializes read-modify-write updates so concurrent hooks and settings changes don't drop each other.
export function updateAgentsConfig(
    update: (config: AgentsConfig) => boolean | void, path = agentsConfigPath()): Promise<void> {
  const next = pendingUpdate.then(async () => {
    const config = await loadAgentsConfig(path);
    if (update(config) !== false) await saveAgentsConfig(config, path);
  });
  pendingUpdate = next.catch(() => undefined);
  return next;
}

export function isAgentEnabledSync(id: AgentId, detected = true, path = agentsConfigPath()): boolean {
  if (!existsSync(path)) return detected;
  return configuredAgentEnabled(loadAgentsConfigSync(path), id, detected);
}

export function configuredAgentEnabled(config: AgentsConfig, id: AgentId, detected = true): boolean {
  return config.enabled[id] ?? (config.approved === undefined ? detected : config.approved[id] === true && detected);
}

function fromJson(input: unknown): AgentsConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent choices.');
  const value = recordOf(input);
  for (const key of ['enabled', 'removed', 'approved', 'seen']) {
    const field = value[key];
    if (field === undefined) continue;
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || Object.values(field).some(item => key === 'seen'
        ? typeof item !== 'number' || !Number.isFinite(item) || item < 0 : typeof item !== 'boolean'))
      throw new Error('Invalid agent choices.');
  }
  return {enabled: recordOf(value.enabled) as Partial<Record<AgentId, boolean>>,
          seen: recordOf(value.seen) as Partial<Record<AgentId, number>>,
          removed: recordOf(value.removed) as Partial<Record<AgentId, boolean>>,
          ...(value.approved === undefined ? {} : {approved: recordOf(value.approved) as Partial<Record<AgentId, boolean>>})};
}

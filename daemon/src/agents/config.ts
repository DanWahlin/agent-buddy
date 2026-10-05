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
}

export async function loadAgentsConfig(path = agentsConfigPath()): Promise<AgentsConfig> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<AgentsConfig>;
    return fromJson(value);
  } catch {
    return {enabled: {}};
  }
}

export function loadAgentsConfigSync(path = agentsConfigPath()): AgentsConfig {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentsConfig>;
    return fromJson(value);
  } catch {
    return {enabled: {}};
  }
}

export async function saveAgentsConfig(config: AgentsConfig, path = agentsConfigPath()): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = uniqueTemporaryPath(path);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
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
  const configured = loadAgentsConfigSync(path).enabled[id];
  return configured ?? detected;
}

function fromJson(value: Partial<AgentsConfig>): AgentsConfig {
  return {enabled: recordOf(value.enabled) as Partial<Record<AgentId, boolean>>,
          seen: recordOf(value.seen) as Partial<Record<AgentId, number>>,
          removed: recordOf(value.removed) as Partial<Record<AgentId, boolean>>};
}

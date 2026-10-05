import {isAbsolute, join} from 'node:path';

// Each agent keeps its settings in a folder in the home folder, unless the user moves it
// with the agent's own variable. The service gets these variables from the user's shell
// (see serviceEnvironment), so it edits the same files the agents read.
export const agentHomeVariables = [
  'COPILOT_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'OPENCLAW_HOME',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

function agentHome(variable: typeof agentHomeVariables[number], fallback: string,
                   home: string, env: Environment): string {
  const value = env[variable]?.trim();
  if (!value) return join(home, fallback);
  if (value === '~' || value.startsWith('~/')) return join(home, value.slice(1));
  // A relative value means nothing to a service; the agent resolves it from its own folder.
  return isAbsolute(value) ? value : join(home, fallback);
}

export const copilotHome = (home: string, env: Environment = {}) => agentHome('COPILOT_HOME', '.copilot', home, env);
export const claudeHome = (home: string, env: Environment = {}) => agentHome('CLAUDE_CONFIG_DIR', '.claude', home, env);
export const codexHome = (home: string, env: Environment = {}) => agentHome('CODEX_HOME', '.codex', home, env);
export const grokHome = (home: string, env: Environment = {}) => agentHome('GROK_HOME', '.grok', home, env);
// Hermes keeps its home in %LOCALAPPDATA%\hermes on native Windows and in ~/.hermes elsewhere
// (hermes_constants.py). HERMES_DATA_DIR_SUFFIX is added to either default.
export function hermesHome(home: string, env: Environment = {}, platform: NodeJS.Platform = process.platform): string {
  if (env.HERMES_HOME?.trim()) return agentHome('HERMES_HOME', '.hermes', home, env);
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? '';
  if (platform !== 'win32') return join(home, `.hermes${suffix}`);
  return join(env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), `hermes${suffix}`);
}

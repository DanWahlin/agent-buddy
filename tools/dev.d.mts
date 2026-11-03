export function developmentEnvironment(
  repository: string, environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
): NodeJS.ProcessEnv & {AGENT_COMPANION_DATA_DIR: string; AGENT_COMPANION_SOCKET: string};
export function prepareDevelopmentState(env: NodeJS.ProcessEnv): Promise<string>;
export function run(command: string, args: string[], options?: {
  env?: NodeJS.ProcessEnv; cwd?: string;
}): Promise<void>;
export function main(args?: string[]): Promise<void>;

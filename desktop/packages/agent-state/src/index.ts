export { StateBridge, type BridgeOptions, type BridgeRole } from './bridge.js';
export { endpointPath, statePath, endpointIsFile, dataDirectory } from './paths.js';
export {
  CLAUDE_CODE_EVENTS, COPILOT_CLI_EVENTS,
  claudeCodeHooks, copilotCliHooks, mergeClaudeCodeHooks, removeClaudeCodeHooks,
  type AgentKind, type HookTarget,
} from './hooks.js';
export {
  characterStates, hookEvents,
  type CharacterState, type HookEvent, type HookPayload,
} from './vendor/protocol.js';
export { StateCoordinator } from './vendor/state-coordinator.js';

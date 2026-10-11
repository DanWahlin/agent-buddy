import {readFileSync} from 'node:fs';
import {copyFile, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {isAgentId, type AgentId} from './agents/types.js';
import {uniqueTemporaryPath} from './agents/file-utils.js';
import {isCharacterName} from './character-pack.js';
import {onboardingPath} from './paths.js';

export const onboardingSteps = ['welcome', 'agents', 'character', 'display', 'firmware', 'complete'] as const;
export const companionDisplays = ['desktop', 'device', 'both'] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export type CompanionDisplay = typeof companionDisplays[number];

export interface OnboardingState {
  version: 1;
  completed: boolean;
  step: OnboardingStep;
  visitedSteps: OnboardingStep[];
  agents: AgentId[];
  agentStage: 'select' | 'connect';
  character: string;
  display: CompanionDisplay;
  agentsDeferred: boolean;
  deferredAgents: AgentId[];
  deviceDeferred: boolean;
  port: string | null;
}

export type OnboardingChange = Partial<Omit<OnboardingState, 'version' | 'completed' | 'visitedSteps'>>;

export class SetupError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) {
    super(message);
  }
}

export function initialOnboarding(completed = false): OnboardingState {
  return {version: 1, completed, step: 'welcome', agents: [], agentStage: 'select', character: 'copilot', display: 'desktop',
          visitedSteps: ['welcome'], agentsDeferred: false, deferredAgents: [], deviceDeferred: false, port: null};
}

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return onboardingSteps.some(step => step === value);
}

export function isOnboardingChange(value: unknown): value is OnboardingChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  const keys = ['step', 'agents', 'agentStage', 'character', 'display', 'agentsDeferred', 'deferredAgents', 'deviceDeferred', 'port'];
  return Object.keys(change).every(key => keys.includes(key))
    && (change.step === undefined || isOnboardingStep(change.step))
    && (change.agents === undefined || agentList(change.agents))
    && (change.agentStage === undefined || change.agentStage === 'select' || change.agentStage === 'connect')
    && (change.deferredAgents === undefined || agentList(change.deferredAgents))
    && (change.character === undefined || (typeof change.character === 'string' && isCharacterName(change.character)))
    && (change.display === undefined || companionDisplays.some(display => display === change.display))
    && (change.agentsDeferred === undefined || typeof change.agentsDeferred === 'boolean')
    && (change.deviceDeferred === undefined || typeof change.deviceDeferred === 'boolean')
    && (change.port === undefined || change.port === null
      || (typeof change.port === 'string' && change.port.length > 0 && change.port.length <= 256));
}

function agentList(value: unknown): value is AgentId[] {
  return Array.isArray(value) && value.every(isAgentId) && new Set(value).size === value.length;
}

export function readOnboarding(path = onboardingPath()): OnboardingState | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidOnboardingError('The saved setup record is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidOnboardingError('The saved setup record is invalid.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.completed !== 'boolean')
    throw new InvalidOnboardingError('The saved setup record is invalid.');
  const {version: _version, completed, visitedSteps, ...change} = record;
  if (!isOnboardingChange(change) || Object.keys(change).length !== 9)
    throw new InvalidOnboardingError('The saved setup record is invalid.');
  const saved = {...initialOnboarding(), ...change, completed};
  if (saved.completed && saved.step !== 'complete')
    throw new InvalidOnboardingError('The saved setup record is invalid.');
  if (visitedSteps === undefined) {
    saved.visitedSteps = onboardingSteps.filter((step, index) =>
      index <= onboardingSteps.indexOf(saved.step)
      && (step !== 'firmware' || saved.step === 'firmware' || (saved.display !== 'desktop' && !saved.deviceDeferred)));
  } else {
    if (!Array.isArray(visitedSteps) || !visitedSteps.every(isOnboardingStep)
      || new Set(visitedSteps).size !== visitedSteps.length
      || !visitedSteps.includes('welcome') || !visitedSteps.includes(saved.step))
      throw new InvalidOnboardingError('The saved setup progress is invalid.');
    saved.visitedSteps = visitedSteps;
  }
  return saved;
}

class InvalidOnboardingError extends Error {}

export class OnboardingStore {
  readonly #path: string;
  #state: OnboardingState;
  #pending: Promise<unknown> = Promise.resolve();
  #problem: string | null = null;
  #backup: string | null = null;

  constructor(path = onboardingPath()) {
    this.#path = path;
    // An older installation or command-line setup has no setup record.
    try {
      this.#state = readOnboarding(path) ?? initialOnboarding(true);
    } catch (error) {
      if (!(error instanceof InvalidOnboardingError)) throw error;
      this.#state = initialOnboarding();
      this.#backup = `${uniqueTemporaryPath(path)}.invalid`;
      this.#problem = 'Saved setup progress could not be read. Setup must restart. '
        + 'The damaged file will be kept beside onboarding.json. Existing hooks and device settings are unchanged.';
      console.error(`[onboarding] ${this.#problem} Backup: ${this.#backup}`);
    }
  }

  get state(): OnboardingState {
    return structuredClone(this.#state);
  }

  get problem(): string | null {
    return this.#problem;
  }

  update(change: OnboardingChange): Promise<OnboardingState> {
    if (!isOnboardingChange(change)) return Promise.reject(new SetupError('Invalid setup choices.', 400));
    return this.#save(state => ({...state, ...change}));
  }

  reset(change: OnboardingChange = {}, preserveVisits = false): Promise<OnboardingState> {
    if (!isOnboardingChange(change)) return Promise.reject(new SetupError('Invalid setup choices.', 400));
    return this.#save(state => ({...initialOnboarding(), ...change,
      ...(preserveVisits ? {visitedSteps: state.visitedSteps} : {})}));
  }

  finish(): Promise<OnboardingState> {
    return this.#save(state => ({...state, completed: true, step: 'complete'}));
  }

  #save(update: (state: OnboardingState) => OnboardingState): Promise<OnboardingState> {
    const work = this.#pending.then(async () => {
      const next = update(this.state);
      if (!next.visitedSteps.includes(next.step)) next.visitedSteps.push(next.step);
      const temporary = uniqueTemporaryPath(this.#path);
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
        if (this.#backup) {
          await copyFile(this.#path, this.#backup);
          this.#backup = null;
        }
        await rename(temporary, this.#path);
      } catch (error) {
        await rm(temporary, {force: true});
        throw error;
      }
      this.#state = next;
      this.#problem = null;
      return this.state;
    });
    this.#pending = work.catch(() => undefined);
    return work;
  }
}

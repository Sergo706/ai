import { vi } from "vitest";

import type { LoggerSpies } from "./logger";
import type {
  EvaluatorAdapter,
  EvaluatorInput,
  EvaluatorVerdict,
  ExternalDiscoveryAdapter,
  LocalKnowledgeAdapter,
  TargetExecutorAdapter,
  WorkflowBudgets,
  WorkflowExecutionContext,
} from "../../src/agentic-loop/types";
import { WorkflowState } from "../../src/agentic-loop/WorkflowState";

/**
 * Fixtures shared by every `agentic-loop` test.
 *
 * The loop was built around adapters, so the honest way to test it is to supply
 * plain objects that stand in for the domain-specific implementations and let
 * the real phase classes drive them. Nothing here mocks a phase, a state
 * method or an evaluator decision: those are the logic under test.
 */

/** A small budget set that makes every guard reachable in a few iterations. */
export const testBudgets: WorkflowBudgets = {
  maxLocalRounds: 5,
  maxExternalRounds: 4,
  localBatchSize: 3,
  maxIntentsPerRound: 3,
  maxTargetsPerIntent: 2,
  maxEvaluatorItems: 3,
  maxConsecutiveInsufficientLocalBatches: 2,
  maxSkippedExternalRounds: 2,
  maxRepeatedIntentRounds: 2,
  maxDiscoveryFailuresPerIntent: 3,
};

export function makeState<TLocalItem = string, TExternalArtifact = string>(
  overrides: Partial<WorkflowBudgets> = {},
  query = "the query",
): WorkflowState<TLocalItem, TExternalArtifact> {
  return new WorkflowState<TLocalItem, TExternalArtifact>(query, {
    ...testBudgets,
    ...overrides,
  });
}

/**
 * A logger whose calls can be asserted.
 *
 * Typed as `never` so it drops into a `Logger`-typed parameter without a cast
 * at each call site.
 */
export function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as never;
}

/** Logger variant that also exposes the spies for assertions. */
export function makeSpyLogger(): { logger: never; spies: LoggerSpies } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger: logger as never, spies: logger };
}

export function ctx(signal?: AbortSignal): WorkflowExecutionContext {
  return { signal, emit: vi.fn() };
}

/** An execution context that records every progress event it is given. */
export function ctxWithEvents(signal?: AbortSignal) {
  const events: unknown[] = [];
  const context: WorkflowExecutionContext = {
    signal,
    emit: (update) => {
      events.push(update);
    },
  };
  return { context, events };
}

/**
 * An evaluator whose verdicts are scripted.
 *
 * An empty script means "never sufficient, no new intents" rather than running
 * off the end and throwing, which would look like an adapter failure and
 * pollute `state.errors`.
 */
export function scriptedEvaluator(
  verdicts: EvaluatorVerdict[],
  options: {
    transformIntent?: (intent: string) => string;
    fingerprint?: (intent: string) => string;
  } = {},
) {
  const inputs: EvaluatorInput[] = [];
  let index = 0;

  const adapter: EvaluatorAdapter = {
    evaluate: vi.fn(async (input: EvaluatorInput) => {
      inputs.push(input);
      const verdict =
        verdicts.length === 0
          ? { isSufficient: false, nextIntents: [] }
          : verdicts[Math.min(index, verdicts.length - 1)];
      index++;
      return verdict;
    }),
    ...(options.transformIntent
      ? { transformIntent: options.transformIntent }
      : {}),
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };

  return {
    adapter,
    inputs,
    get calls() {
      return index;
    },
  };
}

export interface LocalItem {
  id: string;
  text: string;
}

export function localItem(id: string, text = `text ${id}`): LocalItem {
  return { id, text };
}

export function localPage(...ids: string[]): LocalItem[] {
  return ids.map((id) => localItem(id));
}

/**
 * A local-knowledge adapter that serves pre-scripted pages.
 *
 * Pages are indexed by `offset / limit`, which is how the phase pages, so a
 * test can describe "what the database returns" without restating the loop.
 */
export function localAdapter(pages: LocalItem[][]) {
  const calls: { offset: number; limit: number }[] = [];

  const adapter: LocalKnowledgeAdapter<LocalItem> = {
    fetchBatch: vi.fn(async (offset: number, limit: number) => {
      calls.push({ offset, limit });
      return pages[Math.floor(offset / limit)] ?? [];
    }),
    getId: (item) => item.id,
    getScore: (item) => Number(item.id) || 0,
    formatEvidence: (item) => (item.text ? `[${item.id}] ${item.text}` : null),
  };

  return { adapter, calls };
}

export interface DiscoveredPayload {
  targets: string[];
  passive?: string[];
}

/**
 * A discovery adapter plus a target executor that appends evidence for whatever
 * it is handed, so a test can observe what the loop chose to execute.
 */
export function discoveryHarness(
  options: {
    discover?: (intent: string) => Promise<DiscoveredPayload>;
    extractCandidates?: (
      intent: string,
      payload: DiscoveredPayload,
    ) => string[];
    extractPassiveEvidence?: (
      intent: string,
      payload: DiscoveredPayload,
    ) => string[];
    getKey?: (target: string) => string;
    isBlocked?: (target: string) => { blocked: boolean; reason?: string };
    executeBatch?: (
      targets: string[],
      state: WorkflowState<string, string>,
      context: WorkflowExecutionContext,
    ) => Promise<boolean>;
  } = {},
) {
  const discover = vi.fn(
    options.discover ??
      (async (_intent: string) => ({ targets: [] as string[] })),
  );

  const discovery: ExternalDiscoveryAdapter<DiscoveredPayload, string> = {
    discover,
    extractCandidates:
      options.extractCandidates ?? ((_intent, payload) => payload.targets),
    ...(options.extractPassiveEvidence
      ? { extractPassiveEvidence: options.extractPassiveEvidence }
      : {}),
  };

  const executeBatch = vi.fn(
    options.executeBatch ??
      (async (targets: string[], state: WorkflowState<unknown, string>) => {
        for (const target of targets) {
          state.appendEvidence(`evidence ${target}`);
        }
        return targets.length > 0;
      }),
  );

  const executor: TargetExecutorAdapter<string, string> = {
    getKey: options.getKey ?? ((target) => target),
    ...(options.isBlocked ? { isBlocked: options.isBlocked } : {}),
    executeBatch,
  };

  return { discovery, executor, discover, executeBatch };
}

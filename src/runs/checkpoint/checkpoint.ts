import type { Checkpoint } from "../../types/Checkpoint";
import { DEFAULT_CHECKPOINT_VERSION } from "./shared";

/**
 * Wrap a workflow's progress in a checkpoint envelope.
 *
 * Cheap enough to call every round; stringification happens once, where the row
 * is written.
 *
 * @param args - The phase, the workflow's own state, and an optional version.
 * @returns The envelope to hand to `saveCheckpoint`.
 * @example
 * ```ts
 * saveCheckpoint(checkpoint({ phase: "external", state, roundsDone: round }));
 * ```
 */
export function checkpoint<TState, TPhase extends string>(args: {
  /** The phase the run had reached. */
  phase: TPhase;
  /** Workflow-defined progress. */
  state: TState;
  /**
   * Envelope version. Raise it when `state` changes shape.
   *
   * @default DEFAULT_CHECKPOINT_VERSION
   */
  version?: number;
  /** How many rounds or items `phase` had completed, when meaningful. */
  roundsDone?: number;
}): Checkpoint<TState, TPhase> {
  return {
    version: args.version ?? DEFAULT_CHECKPOINT_VERSION,
    phase: args.phase,
    roundsDone: args.roundsDone,
    state: args.state,
  };
}

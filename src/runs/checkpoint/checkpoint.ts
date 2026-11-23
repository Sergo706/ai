import type { Checkpoint } from "../../types/Checkpoint";
import { DEFAULT_CHECKPOINT_VERSION } from "./shared";

/**
 * Wraps a workflow's progress in a checkpoint envelope.
 *
 * Cheap enough to call every round: it copies the reference and nothing else.
 * Stringification happens once, when the caller writes the row.
 */
export function checkpoint<TState, TPhase extends string>(args: {
  phase: TPhase;
  state: TState;
  /** Defaults to `DEFAULT_CHECKPOINT_VERSION`. Up it when `state` changes. */
  version?: number;
  /** How many rounds or items `phase` had completed, when that is meaningful. */
  roundsDone?: number;
}): Checkpoint<TState, TPhase> {
  return {
    version: args.version ?? DEFAULT_CHECKPOINT_VERSION,
    phase: args.phase,
    roundsDone: args.roundsDone,
    state: args.state,
  };
}

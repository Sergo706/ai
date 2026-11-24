import type { Checkpoint } from "../../types/Checkpoint";

/**
 * Copy a checkpoint's progress into a workflow's live state object.
 *
 * The caller builds the state first, so configuration (budgets, thresholds) comes
 * from the current deployment while only the progress is restored.
 *
 * @param target - The freshly built state to write into.
 * @param from - The checkpoint to restore.
 * @param restoreState - Applies `from.state` to `target`; reviving `Map`s and
 * `Set`s is the workflow's business.
 * @returns `target`, for convenience.
 */
export function restore<TState, TPhase extends string>(
  target: TState,
  from: Checkpoint<TState, TPhase>,
  restoreState: (target: TState, state: TState) => void,
): TState {
  restoreState(target, from.state);
  return target;
}

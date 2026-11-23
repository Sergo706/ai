import type { Checkpoint } from "../../types/Checkpoint";

/**
 * Copies a checkpoint's progress into a workflow's live state object.
 *
 * The caller constructs the state first, so config-driven fields (batch sizes,
 * budgets, thresholds) come from the current deployment rather than the one that
 * crashed. Only the progress is restored. That split is the point: a tunable
 * changed between the crash and the resume takes effect instead of being frozen
 * at its old value.
 *
 * `restore` writes into `target` in place and returns it, so the caller's own
 * state object is the one that lives on. How a field is revived — a `Map` from
 * its entries, a `Set` from its values, a plain value as-is — is the workflow's
 * business, which is why it supplies the function.
 */
export function restore<TState, TPhase extends string>(
  target: TState,
  from: Checkpoint<TState, TPhase>,
  restoreState: (target: TState, state: TState) => void,
): TState {
  restoreState(target, from.state);
  return target;
}

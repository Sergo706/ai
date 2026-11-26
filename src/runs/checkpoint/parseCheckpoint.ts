import type { Checkpoint, CheckpointSpec } from "../../types/Checkpoint";

/**
 * Narrow an unknown value from `runs.checkpoint` to a usable checkpoint.
 *
 * Only the envelope is checked: `version` must match and `phase` must still
 * exist in this build. `state` is only checked to be an object, because its
 * shape belongs to the workflow.
 *
 * @param value - The raw stored value.
 * @param spec - The version and phases this build understands.
 * @returns The checkpoint, or `null` when it was written by another build or
 * workflow, in which case the run starts from the beginning.
 * @example
 * ```ts
 * const ckpt = parseCheckpoint(raw, { version: 1, phases: ["seeds", "local"] });
 * ```
 */
export function parseCheckpoint<TState, TPhase extends string>(
  value: unknown,
  spec: CheckpointSpec<TPhase>,
): Checkpoint<TState, TPhase> | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Partial<Checkpoint<TState, TPhase>>;

  if (candidate.version !== spec.version) return null;
  if (typeof candidate.phase !== "string") return null;
  if (!spec.phases.includes(candidate.phase)) return null;
  if (typeof candidate.state !== "object" || candidate.state === null) {
    return null;
  }

  return {
    version: candidate.version,
    phase: candidate.phase,
    roundsDone:
      typeof candidate.roundsDone === "number"
        ? candidate.roundsDone
        : undefined,
    state: candidate.state,
  };
}

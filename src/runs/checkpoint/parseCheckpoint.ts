import type { Checkpoint, CheckpointSpec } from "../../types/Checkpoint";

/**
 * Narrows an unknown value from `runs.checkpoint` to a checkpoint this build can
 * use.
 *
 * Returns `null` rather than throwing. A row written by an older build, by
 * another workflow, or by a partially failed write is not a reason to fail a
 * run — it is the normal case for a run that never reached a durable boundary,
 * and the caller resumes from the beginning.
 *
 * Only the envelope is checked: `version` matches and `phase` is one this build
 * still lists. `state` is validated as "an object" and nothing more, because its
 * shape belongs to the workflow and guessing at it here would couple this module
 * to one workflow's internals.
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
      typeof candidate.roundsDone === "number" ? candidate.roundsDone : undefined,
    state: candidate.state,
  };
}

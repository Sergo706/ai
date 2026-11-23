/**
 * A resumable position in any run.
 *
 * `state` and `phase` are supplied by the workflow, because only it knows what
 * progress looks like for its own work — a research loop tracks issued search
 * terms, a crawl tracks fetched URLs, a pipeline tracks completed stages. The lib
 * stores and validates the envelope, never the payload.
 */
export interface Checkpoint<TState = unknown, TPhase extends string = string> {
  /**
   * Bumped when the envelope or the workflow's payload shape changes.
   *
   * A snapshot written by an older build is discarded rather than guessed at,
   * which is why this is on the envelope and not inside `state`.
   */
  version: number;
  /** Where the run had reached. Resume enters the next stage after this one. */
  phase: TPhase;
  /**
   * Progress inside `phase`, when the stage itself is repeated.
   *
   * Optional because most workflows have a single pass per phase and have
   * nothing to count. A loop that runs several rounds per phase uses it so a
   * resume does not get a fresh budget.
   */
  roundsDone?: number;
  /** Workflow-defined progress. Opaque to the lib. */
  state: TState;
}

/** How to recognise a checkpoint written by a particular workflow build. */
export interface CheckpointSpec<TPhase extends string = string> {
  /** The envelope version this build writes and is willing to read. */
  version: number;
  /**
   * The phases this build still understands.
   *
   * A snapshot naming a phase that no longer exists is rejected: resuming into a
   * stage that was removed would either skip work that is now required or run
   * work the checkpoint said was already done.
   */
  phases: readonly TPhase[];
}

/** A checkpoint that passed `parseCheckpoint`, carrying the caller's own types. */
export type ParsedCheckpoint<
  TState,
  TPhase extends string,
> = Checkpoint<TState, TPhase>;

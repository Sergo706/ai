# AgenticWorkflowLoop: Adapters, Budgets, State & Checkpoints

## Complete `AgenticWorkflowConfig` Wiring

`AgenticWorkflowLoop` is parameterized over five domain types:
`<TLocalItem, TDiscoveryPayload, TTarget, TExternalArtifact, TReport = undefined>`.

Only `targetExecutor` and `evaluator` are required; `localKnowledge`, `externalDiscovery`, `critic`, and `finalAnswer` are optional.

```ts
import {
  AgenticWorkflowLoop,
  checkpoint,
  parseCheckpoint,
  type AgenticWorkflowConfig,
  type WorkflowBudgets,
  type WorkflowCheckpoint,
  type WorkflowStage,
} from "@riavzon/ai";

const STAGES: readonly WorkflowStage[] = [
  "seeds",
  "local",
  "external",
  "critic",
  "final",
];

const budgets: WorkflowBudgets = {
  maxLocalRounds: 4,
  localBatchSize: 10,
  maxExternalRounds: 3,
  maxIntentsPerRound: 3,
  maxTargetsPerIntent: 4,
  maxEvaluatorItems: 24,
  maxConsecutiveInsufficientLocalBatches: 2,
  maxSkippedExternalRounds: 2,
  maxRepeatedIntentRounds: 1,
  maxDiscoveryFailuresPerIntent: 2,
};

const restored = parseCheckpoint<WorkflowCheckpoint, WorkflowStage>(
  await ctx.loadCheckpoint(),
  { version: 1, phases: STAGES },
);

const config: AgenticWorkflowConfig<
  RelevantChunk,
  SearchPayload,
  FetchTarget,
  ExtractedArtifact,
  FinalReport
> = {
  name: "market-research",
  query: "Compare enterprise pricing for Acme and Globex.",
  budgets,
  seedTargets: initialTargets,
  localKnowledge: localKnowledgeAdapter, // optional — defined in section 1 below
  externalDiscovery: externalDiscoveryAdapter, // optional — defined in section 2 below
  targetExecutor: targetExecutorAdapter, // required — defined in section 3 below
  evaluator: evaluatorAdapter, // required — defined in section 4 below
  critic: criticAdapter, // optional — defined in section 5 below
  finalAnswer: finalAnswerAdapter, // optional — defined in section 6 below
  signal: ctx.leaseSignal,
  onProgress: (ev) => ctx.emitProgress(ev),
  onCheckpoint: (snapshot) =>
    ctx.saveCheckpoint(
      checkpoint({
        phase: snapshot.completedStages.at(-1) ?? "seeds",
        state: snapshot,
        roundsDone: snapshot.externalRounds,
      }),
    ),
  resumeFrom: restored?.state,
};

const loop = new AgenticWorkflowLoop(config);
const result = await loop.run();
```

## The Six Adapter Contracts

### 1. `LocalKnowledgeAdapter<TLocalItem>` (optional)

Pages already-indexed data before hitting external sources. Omit or set `skipLocal: true` for external-only workflows.

```ts
import {
  fetchRelevantChunks,
  type LocalKnowledgeAdapter,
  type RelevantChunk,
} from "@riavzon/ai";

const localKnowledge: LocalKnowledgeAdapter<RelevantChunk> = {
  fetchBatch: (offset, limit, _state, _ctx) =>
    fetchRelevantChunks(queryVector, limit, offset, 0.3, userId),
  getId: (chunk) => chunk.id,
  getScore: (chunk) => chunk.similarity,
  formatEvidence: (chunk) =>
    `[doc:${String(chunk.documentId)}] ${chunk.chunkText}`,
};
```

### 2. `ExternalDiscoveryAdapter<TDiscoveryPayload, TTarget>` (optional)

Converts evaluator `nextIntents` into candidate targets. Executed in parallel across all intents in a round.

```ts
const externalDiscovery: ExternalDiscoveryAdapter<SearchPayload, FetchTarget> =
  {
    discover: async (intent, ctx) => {
      ctx.emit({ label: `Searching: ${intent}`, intent, addedEvidence: false });
      return searchWeb(intent, ctx.signal);
    },
    extractPassiveEvidence: (_intent, payload) => payload.snippets,
    extractCandidates: (_intent, payload) =>
      payload.urls.map((url) => ({ url })),
  };
```

### 3. `TargetExecutorAdapter<TTarget, TExternalArtifact>` (required)

Executes deduplicated targets and appends accepted evidence to `state.evidenceSet` and raw outputs to `state.externalArtifacts`.

```ts
const targetExecutor: TargetExecutorAdapter<FetchTarget, ExtractedArtifact> = {
  getKey: (target) => target.url,
  isBlocked: (target) =>
    target.url.endsWith(".zip")
      ? { blocked: true, reason: "binary archive" }
      : { blocked: false },
  executeBatch: async (targets, state, ctx) => {
    let addedAny = false;
    for (const target of targets) {
      if (ctx.signal?.aborted) break;
      const artifact = await extractAndFilter(target.url, ctx.signal);
      if (artifact.evidence) {
        state.evidenceSet.push(artifact.evidence);
        state.externalArtifacts.push(artifact);
        addedAny = true;
      }
      ctx.emit({
        label: target.url,
        addedEvidence: Boolean(artifact.evidence),
      });
    }
    return addedAny;
  },
};
```

### 4. `EvaluatorAdapter` (required)

Judges accumulated evidence between rounds and emits new search intents when incomplete.

```ts
const VerdictSchema = z.object({
  isSufficient: z.boolean(),
  nextIntents: z.array(z.string()),
});

const evaluator: EvaluatorAdapter = {
  evaluate: async ({ query, evidenceText, issuedOrExhaustedIntents }, ctx) => {
    const messages = buildEvaluatorMessages(
      query,
      evidenceText,
      issuedOrExhaustedIntents,
    );
    const completion = await client.chat.completions.create(
      { model: "gpt-4.1-mini", messages },
      { signal: ctx.signal },
    );
    return llmSchemaParser(VerdictSchema, completion, {
      agent: "evaluator",
      messages,
      retry: (request) =>
        client.chat.completions.create(
          { model: "gpt-4.1-mini", ...request },
          { signal: ctx.signal },
        ),
    });
  },
  transformIntent: (intent) => intent.trim(),
};
```

### 5. `CriticAdapter<TLocalItem, TExternalArtifact>` (optional)

Reviews gathered evidence before synthesis. Returning `{ approved: false, followUpIntents: [...] }` triggers bounded follow-up rounds.

```ts
const critic: CriticAdapter<RelevantChunk, ExtractedArtifact> = {
  review: async (state, ctx) => {
    const verdict = await reviewEvidence(state.evidenceSet, ctx.signal);
    return {
      approved: verdict.ok,
      notes: verdict.notes,
      followUpIntents: verdict.gaps,
    };
  },
};
```

### 6. `FinalAnswerAdapter<TLocalItem, TExternalArtifact, TReport>` (optional)

Synthesizes the final structured or Markdown `report` placed on `WorkflowRunResult.report`.

```ts
const finalAnswer: FinalAnswerAdapter<
  RelevantChunk,
  ExtractedArtifact,
  FinalReport
> = {
  synthesize: async (runResult, ctx) => {
    return synthesizeReport(
      runResult.context,
      runResult.externalArtifacts,
      ctx.signal,
    );
  },
};
```

## Checkpoints & Resuming After Crash

The loop invokes `onCheckpoint(checkpoint: WorkflowCheckpoint)` at durable stage boundaries. `WorkflowCheckpoint` records:

```ts
interface WorkflowCheckpoint {
  completedStages: WorkflowStage[]; // "seeds" | "local" | "external" | "critic" | "final"
  localSearches: number;
  externalRounds: number;
  state: unknown; // opaque workflow-defined snapshot
}
```

When resuming via `runWorkflow({ ..., resumeRunId: row.id })`:

1. Call `const raw = await ctx.loadCheckpoint();` and validate the envelope with `parseCheckpoint<WorkflowCheckpoint, WorkflowStage>(raw, { version: 1, phases: ["seeds", "local", "external", "critic", "final"] })`.
2. Pass `resumeFrom: parsed?.state` into `AgenticWorkflowConfig`.
3. In `onCheckpoint`, wrap the `WorkflowCheckpoint` in `checkpoint({ phase: snapshot.completedStages.at(-1) ?? "seeds", state: snapshot, roundsDone: snapshot.externalRounds })` before calling `ctx.saveCheckpoint(...)`.
4. Return `{ data, stopReason, source, isSufficient, missingIntents, meta }` from `runWorkflow`'s `execute` callback.

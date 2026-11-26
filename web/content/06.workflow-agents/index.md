---
title: Workflow Agents
description: Build bounded, resumable multi-stage research and investigation pipelines with AgenticWorkflowLoop, typed adapters, strict budgets, and progress streaming.
navigation:
  icon: i-lucide-git-branch
seo:
  title: Workflow Agents & Agentic Loops — Riavzon AI
  description: Orchestrate multi-stage AI workflows across local knowledge, discovery, execution, evaluation, critique, and synthesis with AgenticWorkflowLoop in @riavzon/ai.
---

Standard single-prompt tool loops are great for interactive chat, but deep research, competitive analysis, or multi-source audits require explicit stages, deduplicated intent tracking, hard termination guarantees, and durable mid-run checkpoints. `AgenticWorkflowLoop` is a typed, budget-enforced state machine built specifically for those workflows.

## Lifecycle stages

Every `AgenticWorkflowLoop` run progresses through six deterministic steps, stopping early as soon as the `evaluator` declares evidence sufficient, a budget hits its ceiling, no new sources remain, or `signal` aborts:

```text [Execution Flow]
1. seeds      ─► Execute optional pre-seeded targets (seedTargets) → evaluate → early exit if sufficient
2. local      ─► Page through localKnowledge batches (skipped if skipLocal: true) → evaluate → early exit if sufficient
3. cold start ─► Only if evidenceSet is empty and maxExternalRounds > 0: evaluate(..., coldStart = true) to generate initial intents (falls back to [transformIntent(query) ?? query])
4. external   ─► Discover intents via externalDiscovery → executeBatch() → evaluate each round
5. critic     ─► Skipped if evidenceSet is empty; can request at most ONE refinement pass (resets contextIsSufficient = false first)
6. final      ─► Skipped automatically when context, localItems, and externalArtifacts are all empty (leaving report undefined)
```

Each stage records progress into `WorkflowState`, emits structured `WorkflowProgressEvent` updates via `onProgress`, and snapshots resumable `WorkflowCheckpoint` payloads via `onCheckpoint`.

## Quick example

Define typed domain objects and pass your adapters + budgets to `new AgenticWorkflowLoop(config)`:

```ts [src/research-workflow.ts]
import {
  AgenticWorkflowLoop,
  fetchRelevantChunks,
  generateEmbedding,
  type AgenticWorkflowConfig,
  type RelevantChunk,
  type WorkflowBudgets,
} from "@riavzon/ai";

interface SearchTarget {
  url: string;
  title: string;
}

interface ScrapedPage {
  url: string;
  markdown: string;
}

interface ResearchReport {
  summary: string;
  sources: string[];
}

const budgets: WorkflowBudgets = {
  maxLocalRounds: 3,
  maxExternalRounds: 4,
  localBatchSize: 8,
  maxIntentsPerRound: 3,
  maxTargetsPerIntent: 5,
  maxEvaluatorItems: 20,
  maxConsecutiveInsufficientLocalBatches: 2,
  maxSkippedExternalRounds: 2,
  maxRepeatedIntentRounds: 2,
  maxDiscoveryFailuresPerIntent: 2,
};

export async function runResearch(query: string, signal?: AbortSignal) {
  const queryVec = await generateEmbedding(query);

  const config: AgenticWorkflowConfig<
    RelevantChunk,
    SearchTarget[],
    SearchTarget,
    ScrapedPage,
    ResearchReport
  > = {
    name: "research",
    query,
    budgets,
    signal,
    localKnowledge: {
      fetchBatch: (offset, limit) =>
        fetchRelevantChunks(queryVec, limit, offset, 0.4),
      getId: (chunk) => chunk.id,
      getScore: (chunk) => chunk.similarity,
      formatEvidence: (chunk) => `[${chunk.title ?? "Doc"}] ${chunk.chunkText}`,
    },
    externalDiscovery: {
      discover: async (intent, ctx) => searchWebTargets(intent, ctx.signal),
      extractCandidates: (_intent, payload) => payload,
    },
    targetExecutor: {
      getKey: (target) => target.url,
      executeBatch: async (targets, state, ctx) => {
        let added = false;
        for (const target of targets) {
          const markdown = await fetchAndExtract(target.url, ctx.signal);
          if (markdown) {
            state.appendEvidence(`Source (${target.url}):\n${markdown}`);
            state.externalArtifacts.push({ url: target.url, markdown });
            added = true;
          }
          ctx.emit({ label: target.title, addedEvidence: Boolean(markdown) });
        }
        return added;
      },
    },
    evaluator: {
      evaluate: async ({ query, evidenceText, issuedOrExhaustedIntents }) =>
        judgeEvidenceWithLlm(query, evidenceText, issuedOrExhaustedIntents),
    },
    finalAnswer: {
      synthesize: async (result) => ({
        summary: await summarizeEvidence(query, result.context),
        sources: result.externalArtifacts.map((a) => a.url),
      }),
    },
  };

  const loop = new AgenticWorkflowLoop(config);
  return loop.run();
}
```

## Run result (`WorkflowRunResult`)

`loop.run()` always resolves to a structured `WorkflowRunResult<TLocalItem, TExternalArtifact, TReport>` — including when aborted (`stopReason: "aborted"`). Internally, the loop and adapters abort via `context.signal?.throwIfAborted()` or `WorkflowAbortedError`, which `loop.run()` catches to mark state aborted and return cleanly with all evidence collected so far:

| Field               | Type                                                                  | Description                                                      |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `isSufficient`      | `boolean`                                                             | `true` when `evaluator` judged gathered evidence sufficient.     |
| `source`            | `"local" \| "external" \| "mixed" \| "none"`                          | Origin of accepted evidence.                                     |
| `stopReason`        | `"sufficient" \| "budget_exhausted" \| "no_new_sources" \| "aborted"` | Exact reason the loop terminated.                                |
| `context`           | `string`                                                              | Concatenated accepted evidence blocks passed to final synthesis. |
| `localItems`        | `TLocalItem[]`                                                        | Accepted items returned by `localKnowledge`.                     |
| `externalArtifacts` | `TExternalArtifact[]`                                                 | Raw artifacts pushed by `targetExecutor`.                        |
| `missingIntents`    | `string[]`                                                            | Remaining unanswered intents when `isSufficient` is `false`.     |
| `localSearches`     | `number`                                                              | Number of local batches actually executed.                       |
| `externalRounds`    | `number`                                                              | Number of external discovery rounds executed.                    |
| `criticNotes`       | `string \| undefined`                                                 | Review notes from `critic`, if configured.                       |
| `errors`            | `string[]`                                                            | Recoverable errors collected during discovery or execution.      |
| `report`            | `TReport \| undefined`                                                | Output returned by `finalAnswer.synthesize()`, if configured.    |

## Stream workflow progress over SSE

Connect `onProgress` directly to `runProgressFrames()` inside `workflowStream()` (or `workflowStreamWithRegistry()` for resumable runs) so frontend clients see every stage and target live:

```ts [src/stream-workflow.ts]
import {
  AgenticWorkflowLoop,
  runProgressFrames,
  setSseHeaders,
  workflowStream,
} from "@riavzon/ai";

export function streamResearch(query: string): Response {
  const stream = workflowStream({
    execute: async (emit) => {
      const progress = runProgressFrames(emit, { query, workflow: "research" });
      progress.onRunStarted(crypto.randomUUID());

      const loop = new AgenticWorkflowLoop({
        ...workflowConfig,
        query,
        onProgress: progress.onProgress,
      });

      const result = await loop.run();
      return { type: "research_result", result };
    },
  });

  return new Response(stream, { headers: setSseHeaders() });
}
```

## Explore workflow agents

::card-group
:::card
---

icon: i-lucide-sliders
title: Adapters & Budgets
to: /workflow-agents/adapters-and-budgets
---

Detailed reference for all 6 typed adapters, intent fingerprinting, and all 10 termination budget caps.
:::

:::card
---

icon: i-lucide-rotate-ccw
title: Checkpoints & Resume
to: /workflow-agents/checkpoints-and-resume
---

Persist `WorkflowCheckpoint` snapshots via `onCheckpoint`, restore with `resumeFrom`, and handle `WorkflowAbortedError`.
:::

:::card
---

icon: i-lucide-flask-conical
title: Complete Research Workflow
to: /workflow-agents/complete-research-workflow
---

A complete runnable `AgenticWorkflowLoop` wiring local vector search, live extraction, adaptive filtering, LLM schema validation, critic review, and SSE streaming.
:::
::

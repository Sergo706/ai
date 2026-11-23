import type { RunKind, RunResumer } from "./types.js";

interface ResumerKey {
  kind: RunKind;
  name?: string;
}

function keyOf(resumer: ResumerKey): string {
  return `${resumer.kind}::${resumer.name ?? ""}`;
}

function describeKey(resumer: ResumerKey): string {
  return resumer.name === undefined || resumer.name === ""
    ? `kind "${resumer.kind}"`
    : `kind "${resumer.kind}" name "${resumer.name}"`;
}

const resumers = new Map<string, RunResumer>();

/**
 * Teaches the sweep how to resume one kind, or one named runner inside a kind.
 *
 * Call this once at module load of the file that owns the runner — in practice
 * from `server/lib/runs/resumers/`, wired in `server/plugins/runsBoot.ts`.
 *
 * Registering the same kind+name twice is a programming error, not a runtime
 * condition, so this throws rather than silently replacing the first one.
 */
export function registerRunResumer(resumer: RunResumer): void {
  const key = keyOf(resumer);
  if (resumers.has(key)) {
    throw new Error(
      `A run resumer for ${describeKey(resumer)} is already registered`,
    );
  }
  resumers.set(key, resumer);
}

/**
 * Every registered resumer, in registration order.
 *
 * The sweep iterates this rather than a hard-coded list, which is the whole
 * reason a new workflow does not need to touch the sweep at all.
 */
export function listRunResumers(): RunResumer[] {
  return [...resumers.values()];
}

/**
 * The resumer for one `runs` row, or `undefined` when nothing claims it.
 *
 * A named resumer wins over an unnamed one for the same kind, so `workflow` can
 * have a specific runner for `input.name === "price-watch"` without also
 * needing a catch-all.
 */
export function findRunResumer(
  kind: RunKind,
  name: string | undefined,
): RunResumer | undefined {
  if (name !== undefined) {
    const exact = resumers.get(keyOf({ kind, name }));
    if (exact) return exact;
  }
  return resumers.get(keyOf({ kind }));
}

/** Test-only hook: forget everything that was registered. */
export function resetRunResumers(): void {
  resumers.clear();
}

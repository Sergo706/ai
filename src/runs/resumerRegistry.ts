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
 * Teach the recovery sweep how to resume one kind, or one named runner in a kind.
 *
 * Call once at module load of the file that owns the runner, before `startRuns`.
 *
 * @param resumer - The kind (and optional name) plus its `adopt` function.
 * @throws If the same kind and name are already registered.
 * @example
 * ```ts
 * registerRunResumer({ kind: "workflow", name: "research", adopt });
 * ```
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
 * @returns The resumers, as registered.
 */
export function listRunResumers(): RunResumer[] {
  return [...resumers.values()];
}

/**
 * The resumer that owns one `runs` row.
 *
 * @param kind - The row's kind.
 * @param name - The row's `input.name`, when it has one.
 * @returns The matching resumer; a named one wins over the unnamed one for the
 * same kind. `undefined` when nothing is registered.
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

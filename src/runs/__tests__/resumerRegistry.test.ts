import { beforeEach, describe, expect, it } from "vitest";
import {
  findRunResumer,
  listRunResumers,
  registerRunResumer,
  resetRunResumers,
} from "../resumerRegistry.js";
import type { RunResumer } from "../types.js";

/**
 * The recovery sweep asks this registry how to continue a row. A wrong answer
 * means a stale row is adopted by the wrong workflow, which rebuilds it from
 * another workflow's `input` and fails.
 */

function resumer(
  kind: RunResumer["kind"],
  name?: string,
  marker = "marker",
): RunResumer {
  return {
    kind,
    ...(name === undefined ? {} : { name }),
    adopt: () => Promise.resolve(marker),
  } as unknown as RunResumer;
}

beforeEach(() => {
  resetRunResumers();
});

describe("findRunResumer", () => {
  it("finds an unnamed resumer for a kind", () => {
    const only = resumer("chat");
    registerRunResumer(only);
    expect(findRunResumer("chat", undefined)).toBe(only);
  });

  it("prefers the named resumer over the catch-all for the same kind", () => {
    const catchAll = resumer("workflow");
    const named = resumer("workflow", "research-product");
    registerRunResumer(catchAll);
    registerRunResumer(named);
    expect(findRunResumer("workflow", "research-product")).toBe(named);
  });

  it("falls back to the catch-all for an unregistered name", () => {
    const catchAll = resumer("workflow");
    registerRunResumer(catchAll);
    registerRunResumer(resumer("workflow", "research-product"));
    expect(findRunResumer("workflow", "something-else")).toBe(catchAll);
  });

  it("returns undefined when nothing covers the kind", () => {
    registerRunResumer(resumer("chat"));
    expect(findRunResumer("workflow", "x")).toBeUndefined();
  });

  it("does not match a named resumer when no name is given", () => {
    // A row without `runs.input.name` cannot be assumed to belong to a named
    // workflow; adopting it with one would rebuild it from missing input.
    registerRunResumer(resumer("workflow", "research-product"));
    expect(findRunResumer("workflow", undefined)).toBeUndefined();
  });

  it("keeps kinds separate", () => {
    const research = resumer("chat");
    const workflow = resumer("workflow");
    registerRunResumer(research);
    registerRunResumer(workflow);
    expect(findRunResumer("chat", undefined)).toBe(research);
    expect(findRunResumer("workflow", undefined)).toBe(workflow);
  });

  it("treats an empty name as no name, because both spell the same jsonb value", () => {
    // `runs.input.name` is `jsonb`; a workflow that stored `""` is the same
    // workflow as one that stored nothing, so an empty name must not shadow the
    // catch-all with a second registry entry.
    const catchAll = resumer("workflow");
    registerRunResumer(catchAll);
    expect(findRunResumer("workflow", "")).toBe(catchAll);
    expect(() => {
      registerRunResumer(resumer("workflow", ""));
    }).toThrow(/already registered/);
  });
});

describe("registerRunResumer", () => {
  it("throws when the same kind and name is registered twice", () => {
    registerRunResumer(resumer("workflow", "video"));
    expect(() => {
      registerRunResumer(resumer("workflow", "video"));
    }).toThrow(/already registered/);
  });

  it("throws for a duplicate unnamed resumer too", () => {
    registerRunResumer(resumer("chat"));
    expect(() => {
      registerRunResumer(resumer("chat"));
    }).toThrow(/already registered/);
  });

  it("names the kind in the error, so the duplicate is identifiable", () => {
    registerRunResumer(resumer("chat"));
    expect(() => {
      registerRunResumer(resumer("chat"));
    }).toThrow(/research/);
  });

  it("names both kind and name for a named duplicate", () => {
    registerRunResumer(resumer("workflow", "agentic-team"));
    expect(() => {
      registerRunResumer(resumer("workflow", "agentic-team"));
    }).toThrow(/agentic-team/);
  });

  it("allows the same name under different kinds", () => {
    registerRunResumer(resumer("workflow", "shared"));
    expect(() => {
      registerRunResumer(resumer("chat", "shared"));
    }).not.toThrow();
  });
});

describe("listRunResumers", () => {
  it("lists everything registered", () => {
    const a = resumer("chat");
    const b = resumer("workflow", "video");
    registerRunResumer(a);
    registerRunResumer(b);
    expect(listRunResumers()).toEqual([a, b]);
  });

  it("is empty after a reset", () => {
    registerRunResumer(resumer("chat"));
    resetRunResumers();
    expect(listRunResumers()).toEqual([]);
  });
});

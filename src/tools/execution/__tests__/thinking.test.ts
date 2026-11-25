import { describe, expect, it } from "vitest";

import { thinkingParams } from "../thinking.js";

describe("thinkingParams", () => {
  it("sends nothing when no effort was requested", () => {
    expect(thinkingParams(undefined)).toEqual({});
  });

  it("forwards reasoning_effort without provider-specific fields", () => {
    const params = thinkingParams("high");
    expect(params).toEqual({ reasoning_effort: "high" });
    expect("thinking" in params).toBe(false);
  });

  it("keeps low, medium, high and max distinct", () => {
    const efforts = ["low", "medium", "high", "max"] as const;
    const sent = efforts.map(
      (effort) => thinkingParams(effort).reasoning_effort,
    );
    expect(sent).toEqual(["low", "medium", "high", "max"]);
  });
});

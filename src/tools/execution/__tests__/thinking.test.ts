import { describe, expect, it } from "vitest";
import { thinkingParams } from "../thinking.js";

describe("thinkingParams", () => {
  it("sends nothing when no effort was requested", () => {
    expect(thinkingParams(undefined)).toEqual({});
  });

  it("forwards the effort verbatim alongside the DeepSeek thinking flag", () => {
    expect(thinkingParams("high")).toEqual({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
  });

  it("keeps low, medium, high and max distinct", () => {
    const efforts = ["low", "medium", "high", "max"] as const;
    const sent = efforts.map(
      (effort) => thinkingParams(effort).reasoning_effort,
    );
    expect(sent).toEqual(["low", "medium", "high", "max"]);
  });

  it("always enables thinking when an effort is present", () => {
    for (const effort of ["low", "max"] as const) {
      expect(thinkingParams(effort).thinking).toEqual({ type: "enabled" });
    }
  });
});

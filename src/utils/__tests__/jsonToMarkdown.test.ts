import { describe, expect, it } from "vitest";
import { jsonToMarkdown } from "~/utils/jsonToMarkdown.js";

/** The marker the renderer uses for a value that has no printable form. */
const NONE = "_(none)_";

describe("scalars at the top level", () => {
  it("renders a string verbatim", () => {
    expect(jsonToMarkdown("hello")).toBe("hello");
  });

  it("collapses runs of whitespace inside a string", () => {
    // A provider that returns a multi-line blurb must not break the bullet list.
    expect(jsonToMarkdown("a\n\n\tb   c")).toBe("a b c");
  });

  it("trims a string before measuring it", () => {
    expect(jsonToMarkdown("   padded   ")).toBe("padded");
  });

  it("renders the empty marker for a blank string", () => {
    expect(jsonToMarkdown("   ")).toBe(NONE);
  });

  it("renders numbers, including zero and negatives", () => {
    expect(jsonToMarkdown(0)).toBe("0");
    expect(jsonToMarkdown(-12.5)).toBe("-12.5");
  });

  it("falls back to the empty marker for a non-finite number", () => {
    expect(jsonToMarkdown(Number.NaN)).toBe(NONE);
    expect(jsonToMarkdown(Number.POSITIVE_INFINITY)).toBe(NONE);
  });

  it("renders booleans as lowercase literals", () => {
    expect(jsonToMarkdown(true)).toBe("true");
    expect(jsonToMarkdown(false)).toBe("false");
  });

  it("renders a bigint as its decimal string", () => {
    expect(jsonToMarkdown(BigInt("9007199254740993"))).toBe("9007199254740993");
  });

  it("renders a valid Date as an ISO string", () => {
    expect(jsonToMarkdown(new Date("2024-03-05T06:07:08.000Z"))).toBe(
      "2024-03-05T06:07:08.000Z",
    );
  });

  it("renders an invalid Date as the empty marker", () => {
    expect(jsonToMarkdown(new Date("nope"))).toBe(NONE);
  });

  it("renders null and undefined as the empty marker", () => {
    expect(jsonToMarkdown(null)).toBe(NONE);
    expect(jsonToMarkdown(undefined)).toBe(NONE);
  });

  it("stringifies a value that is neither object-like nor scalar", () => {
    // A symbol is the one input that is not a scalar, not an array and not a
    // plain object, so it lands on the String() fallback.
    expect(jsonToMarkdown(Symbol("tag"))).toBe("Symbol(tag)");
    expect(jsonToMarkdown(() => 1)).toBe(String(() => 1));
  });
});

describe("maxStringLength", () => {
  it("leaves a string at exactly the limit untouched", () => {
    expect(jsonToMarkdown("abcdef", { maxStringLength: 6 })).toBe("abcdef");
  });

  it("cuts an over-long string and appends an ellipsis", () => {
    // The ellipsis replaces the last kept character, so the result is exactly
    // `maxStringLength` characters wide rather than one over.
    const out = jsonToMarkdown("abcdefgh", { maxStringLength: 5 });
    expect(out).toBe("abcd…");
    expect(out).toHaveLength(5);
  });
});

describe("object rendering", () => {
  it("renders scalar fields as a bullet list", () => {
    expect(jsonToMarkdown({ a: 1, b: "two", c: false })).toBe(
      ["- **a**: 1", "- **b**: two", "- **c**: false"].join("\n"),
    );
  });

  it("renders a null field as the empty marker", () => {
    expect(jsonToMarkdown({ a: null })).toBe(`- **a**: ${NONE}`);
  });

  it("renders a nested object under a heading", () => {
    expect(jsonToMarkdown({ outer: { inner: "v" } })).toBe(
      ["## outer", "", "- **inner**: v"].join("\n"),
    );
  });

  it("deepens the heading for each level of nesting", () => {
    expect(jsonToMarkdown({ a: { b: { c: "x" } } })).toBe(
      ["## a", "", "### b", "", "- **c**: x"].join("\n"),
    );
  });

  it("clamps the heading level to the markdown maximum of six", () => {
    expect(jsonToMarkdown({ a: { b: { c: "x" } } }, { headingLevel: 6 })).toBe(
      ["###### a", "", "###### b", "", "- **c**: x"].join("\n"),
    );
  });

  it("clamps a heading level below one up to one", () => {
    expect(jsonToMarkdown({ outer: { inner: 1 } }, { headingLevel: 0 })).toBe(
      ["# outer", "", "- **inner**: 1"].join("\n"),
    );
  });

  it("honours a custom starting heading level", () => {
    expect(jsonToMarkdown({ outer: { inner: 1 } }, { headingLevel: 4 })).toBe(
      ["#### outer", "", "- **inner**: 1"].join("\n"),
    );
  });

  it("renders an empty object as the empty marker", () => {
    expect(jsonToMarkdown({})).toBe(NONE);
  });

  it("still emits a heading for a nested object with no fields", () => {
    expect(jsonToMarkdown({ outer: {} })).toBe("## outer");
  });

  it("renders empty containers as bullets when omitEmpty is off", () => {
    expect(jsonToMarkdown({ a: "", b: [], c: {} })).toBe(
      [`- **a**: ${NONE}`, `- **b**: ${NONE}`, "", "## c"].join("\n"),
    );
  });
});

describe("omitEmpty", () => {
  it("drops blank strings, empty arrays and empty objects", () => {
    expect(
      jsonToMarkdown({ a: "", b: [], c: {}, keep: "yes" }, { omitEmpty: true }),
    ).toBe("- **keep**: yes");
  });

  it("drops null and undefined", () => {
    expect(
      jsonToMarkdown({ a: null, b: undefined, keep: 1 }, { omitEmpty: true }),
    ).toBe("- **keep**: 1");
  });

  it("keeps falsy values that are not empty", () => {
    // Zero and false are answers, not absences: dropping them would change the
    // meaning of the payload.
    expect(jsonToMarkdown({ n: 0, f: false }, { omitEmpty: true })).toBe(
      ["- **n**: 0", "- **f**: false"].join("\n"),
    );
  });

  it("keeps a Date, which is not an empty container", () => {
    expect(
      jsonToMarkdown(
        { d: new Date("2020-01-01T00:00:00.000Z") },
        { omitEmpty: true },
      ),
    ).toBe("- **d**: 2020-01-01T00:00:00.000Z");
  });
});

describe("arrays", () => {
  it("renders a scalar array on one line", () => {
    expect(jsonToMarkdown({ tags: ["a", "b"] })).toBe("- **tags**: a, b");
  });

  it("skips unrenderable entries inside a scalar array", () => {
    expect(jsonToMarkdown({ tags: ["a", null, "b"] })).toBe("- **tags**: a, b");
  });

  it("renders the empty marker when every entry is unrenderable", () => {
    expect(jsonToMarkdown({ tags: [null, ""] })).toBe(`- **tags**: ${NONE}`);
  });

  it("renders a top-level array under the items key", () => {
    expect(jsonToMarkdown([1, 2])).toBe("- **items**: 1, 2");
  });

  it("renders a top-level empty array as the empty marker", () => {
    expect(jsonToMarkdown([])).toBe(`- **items**: ${NONE}`);
  });

  it("caps a scalar array and says how many were dropped", () => {
    expect(
      jsonToMarkdown({ list: [1, 2, 3, 4, 5] }, { maxArrayItems: 2 }),
    ).toBe(
      ["- **list**: 1, 2", "- **list**: _… 3 more item(s) omitted_"].join("\n"),
    );
  });

  it("renders objects as titled subsections", () => {
    expect(jsonToMarkdown({ rows: [{ label: "first" }] })).toBe(
      ["## rows", "", "### 1. first", "", "- **label**: first"].join("\n"),
    );
  });

  it("falls back to a bare index when no title key is present", () => {
    expect(jsonToMarkdown({ rows: [{ count: 1 }] })).toBe(
      ["## rows", "", "### 1.", "", "- **count**: 1"].join("\n"),
    );
  });

  it("skips a blank title key and uses the next one", () => {
    expect(jsonToMarkdown({ rows: [{ title: "   ", name: "Second" }] })).toBe(
      [
        "## rows",
        "",
        "### 1. Second",
        "",
        `- **title**: ${NONE}`,
        "- **name**: Second",
      ].join("\n"),
    );
  });

  it("uses a numeric title key", () => {
    expect(jsonToMarkdown({ rows: [{ id: 42 }] })).toBe(
      ["## rows", "", "### 1. 42", "", "- **id**: 42"].join("\n"),
    );
  });

  it("collapses whitespace in a title", () => {
    expect(jsonToMarkdown({ rows: [{ name: "a\n\tb" }] })).toBe(
      ["## rows", "", "### 1. a b", "", "- **name**: a b"].join("\n"),
    );
  });

  it("truncates a long title to ninety characters", () => {
    const out = jsonToMarkdown({ rows: [{ name: "x".repeat(120) }] });
    const titleLine = out.split("\n").find((line) => line.startsWith("### "));
    // "### 1. " is seven characters, so the title portion is exactly 90 wide.
    expect(titleLine).toBe(`### 1. ${"x".repeat(89)}…`);
  });

  it("honours a caller-supplied title key list", () => {
    expect(
      jsonToMarkdown(
        { rows: [{ symbol: "BTC", name: "ignored" }] },
        { titleKeys: ["symbol"] },
      ),
    ).toBe(
      [
        "## rows",
        "",
        "### 1. BTC",
        "",
        "- **symbol**: BTC",
        "- **name**: ignored",
      ].join("\n"),
    );
  });

  it("renders a nested array of scalars as one bullet", () => {
    expect(jsonToMarkdown({ rows: [[1, 2], [3]] })).toBe(
      ["## rows", "", "- 1, 2", "- 3"].join("\n"),
    );
  });

  it("omits a nested array that has no printable entries", () => {
    expect(jsonToMarkdown({ rows: [[null], "x"] })).toBe(
      ["## rows", "", "- x"].join("\n"),
    );
  });

  it("caps an object array and reports the remainder at the end", () => {
    expect(
      jsonToMarkdown(
        { rows: [{ count: 1 }, { count: 2 }, { count: 3 }] },
        { maxArrayItems: 2 },
      ),
    ).toBe(
      [
        "## rows",
        "",
        "### 1.",
        "",
        "- **count**: 1",
        "### 2.",
        "",
        "- **count**: 2",
        "",
        "_… 1 more item(s) omitted_",
      ].join("\n"),
    );
  });
});

describe("cycles and depth", () => {
  it("marks a circular reference instead of recursing forever", () => {
    const node: Record<string, unknown> = { label: "root" };
    node.self = node;

    expect(jsonToMarkdown(node)).toBe(
      ["- **label**: root", "", "## self", "", "- _(circular reference)_"].join(
        "\n",
      ),
    );
  });

  it("marks a cycle reached through an array", () => {
    const node: Record<string, unknown> = { label: "root" };
    node.children = [node];

    expect(jsonToMarkdown(node)).toBe(
      [
        "- **label**: root",
        "",
        "## children",
        "",
        "### 1. root",
        "",
        "- _(circular reference)_",
      ].join("\n"),
    );
  });

  it("renders a shared, non-circular reference twice", () => {
    // The guard tracks the current stack, not everything ever visited, so a
    // diamond must not be mislabelled as a cycle.
    const shared = { v: 1 };
    expect(jsonToMarkdown({ a: shared, b: shared })).toBe(
      ["## a", "", "- **v**: 1", "", "## b", "", "- **v**: 1"].join("\n"),
    );
  });

  it("flattens a subtree that passes maxDepth", () => {
    expect(jsonToMarkdown({ a: { b: 1 } }, { maxDepth: 0 })).toBe(
      ["## a", "", '- {"b":1}'].join("\n"),
    );
  });

  it("marks a circular subtree that hits the depth cutoff", () => {
    // JSON.stringify cannot serialise this, so the flattening fallback has to
    // degrade to a placeholder rather than throw out of the renderer.
    const inner: Record<string, unknown> = {};
    inner.self = inner;

    expect(jsonToMarkdown({ a: inner }, { maxDepth: 0 })).toBe(
      ["## a", "", "- _(unrenderable value)_"].join("\n"),
    );
  });
});

describe("total length", () => {
  it("truncates the document and reports how much was dropped", () => {
    const out = jsonToMarkdown({ a: "abcdefghij" }, { maxTotalLength: 8 });
    const [kept, note] = out.split("\n\n");
    // "- **a**: abcdefghij" is 19 characters; keeping the first eight and
    // trimming the dangling space leaves exactly 11 unaccounted for.
    expect(kept).toBe("- **a**:");
    expect(note).toBe("_… truncated, 11 character(s) dropped_");
  });

  it("leaves a document at exactly the limit alone", () => {
    const exact = "- **a**: 1";
    expect(jsonToMarkdown({ a: 1 }, { maxTotalLength: exact.length })).toBe(
      exact,
    );
  });
});

describe("failure handling", () => {
  it("falls back to a flat rendering when a property getter throws", () => {
    let reads = 0;
    const value = {
      get a(): string {
        reads += 1;
        if (reads === 1) throw new Error("boom");
        return "ok";
      },
    };

    // The first walk throws; the fallback stringifies, which reads the getter a
    // second time and succeeds.
    expect(jsonToMarkdown(value)).toBe('{"a":"ok"}');
    expect(reads).toBe(2);
  });

  it("emits the empty marker when toJSON hides the value", () => {
    const value = {
      get a(): never {
        throw new Error("boom");
      },
      toJSON: () => undefined,
    };

    expect(jsonToMarkdown(value)).toBe(NONE);
  });

  it("emits the unrenderable placeholder when the fallback cannot serialise", () => {
    const value = {
      get a(): never {
        throw new Error("boom");
      },
    };

    // The top-level catch has no key to prefix, so the placeholder stands alone.
    expect(jsonToMarkdown(value)).toBe("_(unrenderable value)_");
  });
});

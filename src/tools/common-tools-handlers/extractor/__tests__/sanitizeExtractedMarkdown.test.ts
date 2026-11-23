import { describe, expect, it } from "vitest";
import { sanitizeExtractedMarkdown } from "../sanitizeExtractedMarkdown.js";

/**
 * What comes back from the crawler goes straight into the model's context, so
 * this is the last place an image blob or a deep link can be stopped. A base64
 * screenshot left in the text is enough to blow the context window on its own.
 */

describe("sanitizeExtractedMarkdown", () => {
  it("removes a markdown image", () => {
    expect(
      sanitizeExtractedMarkdown("before ![alt](https://a/b.png) after"),
    ).toBe("before  after");
  });

  it("removes an image whose alt text contains brackets or parentheses", () => {
    const input = "x ![a (b) [c]](https://a/b.png) y";
    expect(sanitizeExtractedMarkdown(input)).not.toContain("![");
    expect(sanitizeExtractedMarkdown(input)).not.toContain("b.png");
  });

  it("keeps the text of a markdown link and drops the target", () => {
    expect(sanitizeExtractedMarkdown("[the docs](https://example.com/x)")).toBe(
      "the docs",
    );
  });

  it("keeps link text and removes several links in one pass", () => {
    const input = "[a](https://1) and [b](https://2)";
    expect(sanitizeExtractedMarkdown(input)).toBe("a and b");
  });

  it("removes a base64 image payload", () => {
    const input = `text data:image/png;base64,${"A".repeat(200)} more`;
    const output = sanitizeExtractedMarkdown(input);
    expect(output).not.toContain("base64");
    expect(output).toContain("text");
    expect(output).toContain("more");
  });

  it("removes a bare http or https url", () => {
    expect(sanitizeExtractedMarkdown("see https://example.com/a now")).toBe(
      "see  now",
    );
    expect(
      sanitizeExtractedMarkdown("see http://example.com now"),
    ).not.toContain("http");
  });

  it("does not leave a fragment of the scheme behind", () => {
    const output = sanitizeExtractedMarkdown("pre https://a/b post");
    expect(output).not.toMatch(/https?:/);
    expect(output).toContain("pre");
    expect(output).toContain("post");
  });

  it("collapses three or more spaces into a paragraph break", () => {
    // Runs of spaces in a PDF conversion are layout, not meaning, and leaving
    // them costs tokens for nothing.
    expect(sanitizeExtractedMarkdown("a     b")).toBe("a\n\nb");
    expect(sanitizeExtractedMarkdown("a   b")).toBe("a\n\nb");
  });

  it("leaves two spaces alone, because a double space is legal prose", () => {
    expect(sanitizeExtractedMarkdown("a  b")).toBe("a  b");
  });

  it("leaves ordinary markdown structure untouched", () => {
    const input = [
      "# Heading",
      "",
      "- item one",
      "- item two",
      "",
      "> quoted",
      "",
      "**bold** and *italic*",
    ].join("\n");
    expect(sanitizeExtractedMarkdown(input)).toBe(input);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeExtractedMarkdown("")).toBe("");
  });

  it("is idempotent: sanitizing twice changes nothing further", () => {
    const once = sanitizeExtractedMarkdown(
      "a ![i](https://x/y.png) [t](https://z) https://w/q     end",
    );
    expect(sanitizeExtractedMarkdown(once)).toBe(once);
  });

  it("does not eat a bracketed aside that is not a link", () => {
    expect(sanitizeExtractedMarkdown("[not a link] stays")).toBe(
      "[not a link] stays",
    );
  });

  it("keeps a footnote marker intact", () => {
    expect(sanitizeExtractedMarkdown("claim[1] and claim[2]")).toBe(
      "claim[1] and claim[2]",
    );
  });
});

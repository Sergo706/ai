import { beforeEach, describe, expect, it } from "vitest";

import { generateHash } from "../../../../utils/hash";
import { cacheSet, getStorage } from "../../../../config/config";
import { clearConfiguredCache } from "~~/test/test-utils/cache";
import {
  extractorCacheKey,
  readExtractorCache,
  writeExtractorCache,
} from "../extractorCache";

/**
 * The extractor cache is what keeps a repeated crawl from paying twice, so the
 * properties that matter are the key it writes under, the shape it stores, and
 * how it degrades on a bad entry.
 *
 * These run against the real configured store (the `MiniCache` the unit setup
 * installs) rather than a mocked `get`/`mget`. That makes the round trip — write
 * then read — the thing under test instead of a restatement of the call.
 */

const LIMITED = "ext:lim:" as const;
const FULL = "ext:full:" as const;

beforeEach(() => {
  clearConfiguredCache(getStorage());
});

describe("extractorCacheKey", () => {
  it("hashes the url rather than embedding it in the key", () => {
    const key = extractorCacheKey("https://a.com", LIMITED);

    expect(key).toBe(`${LIMITED}${generateHash("https://a.com")}`);
    expect(key).not.toContain("https://a.com");
  });

  it("trims the url, so a stray space shares the entry", () => {
    expect(extractorCacheKey("  https://a.com  ", LIMITED)).toBe(
      extractorCacheKey("https://a.com", LIMITED),
    );
  });

  it("prefixes the hash so the limited and full variants never collide", () => {
    // The two variants store different markdown for the same url; sharing a key
    // would hand a caller a truncated body where it asked for the full one.
    expect(extractorCacheKey("https://a.com", LIMITED)).not.toBe(
      extractorCacheKey("https://a.com", FULL),
    );
  });

  it("distinguishes urls that differ only after normalisation", () => {
    expect(extractorCacheKey("https://a.com/x", LIMITED)).not.toBe(
      extractorCacheKey("https://a.com/y", LIMITED),
    );
  });
});

describe("readExtractorCache", () => {
  it("returns hits and the urls that still need crawling", async () => {
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "# A" }],
      LIMITED,
      60,
    );

    const result = await readExtractorCache(
      ["https://a.com", "https://b.com"],
      LIMITED,
    );

    expect(result.resultsByUrl.get("https://a.com")).toEqual({
      url: "https://a.com",
      markdown: "# A",
    });
    expect(result.urlsToCrawl).toEqual(["https://b.com"]);
  });

  it("returns every url to crawl when nothing is cached", async () => {
    const result = await readExtractorCache(
      ["https://a.com", "https://b.com"],
      LIMITED,
    );

    expect(result.resultsByUrl.size).toBe(0);
    expect(result.urlsToCrawl).toEqual(["https://a.com", "https://b.com"]);
  });

  it("returns an empty result for an empty batch", async () => {
    const result = await readExtractorCache([], LIMITED);

    expect(result.resultsByUrl.size).toBe(0);
    expect(result.urlsToCrawl).toEqual([]);
  });

  it("does not read an entry written under the other prefix", async () => {
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "full body" }],
      FULL,
      60,
    );

    const result = await readExtractorCache(["https://a.com"], LIMITED);

    expect(result.resultsByUrl.size).toBe(0);
    expect(result.urlsToCrawl).toEqual(["https://a.com"]);
  });

  it("keeps the entry keyed by the requested url, not the stored one", async () => {
    // The stored entry carries its own `url`; the map must be keyed on what the
    // caller asked for, or a trimmed variant would be unreachable by its input.
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "# A" }],
      LIMITED,
      60,
    );

    const result = await readExtractorCache(["  https://a.com  "], LIMITED);

    expect([...result.resultsByUrl.keys()]).toEqual(["  https://a.com  "]);
    expect(result.resultsByUrl.get("  https://a.com  ")?.markdown).toBe("# A");
  });

  it("discards an unparseable entry instead of failing the call", async () => {
    // A corrupt value must cost a re-crawl, not the whole batch.
    await cacheSet(
      extractorCacheKey("https://bad.com", LIMITED),
      "{not json",
      60_000,
    );

    const result = await readExtractorCache(
      ["https://bad.com", "https://ok.com"],
      LIMITED,
    );

    expect(result.resultsByUrl.size).toBe(0);
    expect(result.urlsToCrawl).toEqual(["https://bad.com", "https://ok.com"]);
  });

  it("re-crawls an entry that carries no markdown", async () => {
    await cacheSet(
      extractorCacheKey("https://empty.com", LIMITED),
      JSON.stringify({ url: "https://empty.com", markdown: "" }),
      60_000,
    );

    const result = await readExtractorCache(["https://empty.com"], LIMITED);

    expect(result.resultsByUrl.size).toBe(0);
    expect(result.urlsToCrawl).toEqual(["https://empty.com"]);
  });

  it("handles a mixed hit and miss set without reordering", async () => {
    await writeExtractorCache(
      [
        { url: "https://b.com", markdown: "# B" },
        { url: "https://d.com", markdown: "# D" },
      ],
      LIMITED,
      60,
    );

    const result = await readExtractorCache(
      ["https://a.com", "https://b.com", "https://c.com", "https://d.com"],
      LIMITED,
    );

    expect([...result.resultsByUrl.keys()]).toEqual([
      "https://b.com",
      "https://d.com",
    ]);
    expect(result.urlsToCrawl).toEqual(["https://a.com", "https://c.com"]);
  });
});

describe("writeExtractorCache", () => {
  it("stores the url and markdown so a later read can reconstruct them", async () => {
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "# A" }],
      LIMITED,
      60,
    );

    const store = getStorage();
    const raw = await (async () => {
      if (!("get" in store)) throw new Error("Expected the in-memory store");
      return store.get(extractorCacheKey("https://a.com", LIMITED));
    })();

    expect(raw).toBe(JSON.stringify({ url: "https://a.com", markdown: "# A" }));
  });

  it("writes every entry, not just the first", async () => {
    await writeExtractorCache(
      [
        { url: "https://a.com", markdown: "# A" },
        { url: "https://b.com", markdown: "# B" },
        { url: "https://c.com", markdown: "# C" },
      ],
      LIMITED,
      60,
    );

    const result = await readExtractorCache(
      ["https://a.com", "https://b.com", "https://c.com"],
      LIMITED,
    );

    expect(result.urlsToCrawl).toEqual([]);
    expect(result.resultsByUrl.size).toBe(3);
  });

  it("reads with the same prefix it wrote with", async () => {
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "limited body" }],
      LIMITED,
      60,
    );
    await writeExtractorCache(
      [{ url: "https://a.com", markdown: "full body" }],
      FULL,
      60,
    );

    expect(
      (await readExtractorCache(["https://a.com"], LIMITED)).resultsByUrl.get(
        "https://a.com",
      )?.markdown,
    ).toBe("limited body");
    expect(
      (await readExtractorCache(["https://a.com"], FULL)).resultsByUrl.get(
        "https://a.com",
      )?.markdown,
    ).toBe("full body");
  });

  it("writes nothing for an empty batch", async () => {
    await expect(writeExtractorCache([], LIMITED, 60)).resolves.toBeUndefined();
  });
});

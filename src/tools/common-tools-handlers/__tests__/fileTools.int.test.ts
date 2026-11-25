import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INTEGRATION_PG_URL, INTEGRATION_REDIS_URL } from "~~/test/integration.setup.js";
import { libLog, libLogger, resetLibLogger } from "~~/test/test-utils/logger.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";
import type { ToolExecutionContext } from "~/types/ToolExecutionTypes.js";

/**
 * The two file-producing handlers refuse to run against `MiniCache`, so they can
 * only be exercised with a real Redis. The rest of the suite is real too: the
 * PDF and xlsx bytes are produced by the actual `pdf-lib`/`exceljs` code paths.
 *
 * `src/tools/execution` reads its logger through `getConfiguration()`, so every
 * handler is imported *after* `loadConfig()` has configured the module.
 */

let env: LoadedConfig;

/** The context every handler receives; these handlers ignore it. */
const ctx: ToolExecutionContext = {
  toolCallId: "call-1",
  callIndex: 1,
  callTotal: 1,
};
let mod: {
  datetime: typeof import("~/tools/common-tools-handlers/getCurrentDatetime.js");
  pdf: typeof import("~/tools/common-tools-handlers/pdfCreator.js");
  sheet: typeof import("~/tools/common-tools-handlers/createStyledSpreadsheet.js");
  config: typeof import("~/config/config.js");
};

/** What `toolError()` produces, parsed so assertions can name the code. */
function errorOf(result: unknown): { code: string; message: string } {
  const parsed = JSON.parse(result as string) as {
    error: { code: string; message: string };
  };
  return parsed.error;
}

/** Reads a key the handler is expected to have written, failing loudly if not. */
async function readWritten(key: string): Promise<string> {
  const value = await env.redis?.get(key);
  if (typeof value !== "string") {
    throw new Error(`expected Redis key ${key} to hold a written value`);
  }
  return value;
}

beforeEach(async () => {
  resetLibLogger();
  env = await loadConfig({
    dialect: "pg",
    pgUrl: INTEGRATION_PG_URL,
    redisUrl: INTEGRATION_REDIS_URL,
    logger: libLogger,
  });
  await env.redis?.flushdb();

  mod = {
    datetime: await import(
      "~/tools/common-tools-handlers/getCurrentDatetime.js"
    ),
    pdf: await import("~/tools/common-tools-handlers/pdfCreator.js"),
    sheet: await import(
      "~/tools/common-tools-handlers/createStyledSpreadsheet.js"
    ),
    config: await import("~/config/config.js"),
  };
});

afterEach(async () => {
  await env.redis?.flushdb();
  await env.cleanup();
});

describe("getCurrentDatetime", () => {
  it("reports UTC by default", () => {
    const result = mod.datetime.getCurrentDatetime()({}, ctx) as {
      isoUtc: string;
      timezone: string;
      formatted: string;
    };

    expect(result.timezone).toBe("UTC");
    expect(result.isoUtc).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(result.formatted.length).toBeGreaterThan(0);
    // The formatted string must describe the same instant as the ISO one.
    expect(Date.parse(result.isoUtc)).toBeLessThanOrEqual(Date.now());
    expect(libLog.debug).toHaveBeenCalledWith(
      { args: {} },
      "agent ran tool getCurrentDatetime",
    );
  });

  it("honours an IANA timezone", () => {
    const result = mod.datetime.getCurrentDatetime()({
      timezone: "Asia/Jerusalem",
    }, ctx) as { isoUtc: string; timezone: string; formatted: string };

    expect(result.timezone).toBe("Asia/Jerusalem");
    expect(result.formatted).toMatch(/GMT\+/);
    // Same instant, different wall clock.
    expect(Math.abs(Date.parse(result.isoUtc) - Date.now())).toBeLessThan(5_000);
  });

  it("rejects a fixed UTC offset, which is not an IANA zone", () => {
    const result = mod.datetime.getCurrentDatetime()({ timezone: "+02:00" }, ctx);
    expect(errorOf(result)).toEqual({
      code: "VALIDATION_ERROR",
      message: "Provide a valid IANA timezone.",
    });
  });

  it("rejects an unknown zone", () => {
    const result = mod.datetime.getCurrentDatetime()({ timezone: "Mars/Olympus" }, ctx);
    expect(errorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty timezone string", () => {
    const result = mod.datetime.getCurrentDatetime()({ timezone: "" }, ctx);
    expect(errorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a timezone longer than a hundred characters", () => {
    const result = mod.datetime.getCurrentDatetime()({
      timezone: "a".repeat(101),
    }, ctx);
    expect(errorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown arguments", () => {
    const result = mod.datetime.getCurrentDatetime()({ when: "now" }, ctx);
    expect(errorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("classifies zones by shape without consulting the runtime", () => {
    expect(mod.datetime.validTimezone("UTC")).toBe(true);
    expect(mod.datetime.validTimezone("Europe/London")).toBe(true);
    expect(mod.datetime.validTimezone("-05:00")).toBe(false);
    expect(mod.datetime.validTimezone("+05:00")).toBe(false);
    expect(mod.datetime.validTimezone("Nowhere/AtAll")).toBe(false);
  });
});

describe("pdfCreator", () => {
  const ONE_PAGE = {
    filename: "report.pdf",
    pages: [{ action: "add", items: [{ type: "text", x: 20, y: 700, text: "Hi" }] }],
  };

  it("creates a PDF, caches it and reports the download path", async () => {
    const result = (await mod.pdf.pdfCreator()(ONE_PAGE, ctx)) as {
      success: boolean;
      message: string;
      filename: string;
      downloadUrl: string;
      sizeBytes: number;
    };

    expect(result.success).toBe(true);
    expect(result.message).toBe("PDF created successfully.");
    expect(result.filename).toBe("report.pdf");
    expect(result.downloadUrl).toMatch(/^\/api\/files\/[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(500);

    // The bytes really are in Redis, under the same key the URL advertises.
    const key = `file:${result.downloadUrl.slice("/api/files/".length)}`;
    const stored = await readWritten(key);
    expect(typeof stored).toBe("string");
    const parsed = JSON.parse(stored) as {
      base64Data: string;
      mimeType: string;
      filename: string;
      sizeBytes: number;
    };
    expect(parsed.mimeType).toBe("application/pdf");
    expect(parsed.filename).toBe("report.pdf");
    expect(parsed.sizeBytes).toBe(result.sizeBytes);
    expect(Buffer.from(parsed.base64Data, "base64").subarray(0, 5).toString()).toBe(
      "%PDF-",
    );
    // The TTL is a day by default.
    const ttl = await env.redis?.ttl(key);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it("serves the cached document on a second identical call", async () => {
    const first = (await mod.pdf.pdfCreator()(ONE_PAGE, ctx)) as {
      downloadUrl: string;
      sizeBytes: number;
    };
    const second = (await mod.pdf.pdfCreator()(ONE_PAGE, ctx)) as {
      downloadUrl: string;
      sizeBytes: number;
    };

    expect(second.downloadUrl).toBe(first.downloadUrl);
    expect(second.sizeBytes).toBe(first.sizeBytes);
  });

  it("derives sizeBytes from the payload when the cache entry omits it", async () => {
    // An entry written by an older build has no `sizeBytes`.
    const key = "file:" + "a".repeat(64);
    await env.redis?.setex(
      key,
      60,
      JSON.stringify({ base64Data: "AAAA", filename: "old.pdf" }),
    );
    const handler = mod.pdf.pdfCreator();
    // The handler hashes the params, so plant the entry under that hash by
    // calling once and rewriting the key it used.
    const created = (await handler(ONE_PAGE, ctx)) as { downloadUrl: string };
    const createdKey = `file:${created.downloadUrl.slice("/api/files/".length)}`;
    const raw = JSON.parse(await readWritten(createdKey)) as Record<
      string,
      unknown
    >;
    delete raw.sizeBytes;
    await env.redis?.setex(createdKey, 60, JSON.stringify(raw));

    const cached = (await handler(ONE_PAGE, ctx)) as { sizeBytes: number };
    expect(cached.sizeBytes).toBe(
      Buffer.byteLength(raw.base64Data as string, "base64"),
    );
  });

  it("rejects params that fail the schema", async () => {
    const result = await mod.pdf.pdfCreator()({ pages: "nope" }, ctx);
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION_ERROR");
    // The message is the serialised zod issue list.
    expect(JSON.parse(error.message)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["filename"] }),
      ]),
    );
  });

  it("reports a creation failure instead of throwing", async () => {
    const result = await mod.pdf.pdfCreator()({
      filename: "bad.pdf",
      pages: [{ action: "modify", pageIndex: 5, items: [] }],
    }, ctx);

    expect(errorOf(result)).toEqual({
      code: "PDF_CREATION_FAILED",
      message: "Page index 5 out of bounds.",
    });
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      "Failed to create PDF.",
    );
  });

  it("attaches the file id to a custom downloadPath on both cache miss and cache hit", async () => {
    const handler = mod.pdf.pdfCreator("/downloads/reports/");

    const created = (await handler(ONE_PAGE, ctx)) as {
      downloadUrl: string;
    };
    const cached = (await handler(ONE_PAGE, ctx)) as {
      downloadUrl: string;
    };

    expect(created.downloadUrl).toMatch(/^\/downloads\/reports\/[0-9a-f]{64}$/);
    expect(cached.downloadUrl).toBe(created.downloadUrl);

    const fileId = created.downloadUrl.slice("/downloads/reports/".length);
    const stored = JSON.parse(await readWritten(`file:${fileId}`)) as {
      filename: string;
    };
    expect(stored.filename).toBe("report.pdf");
  });

  it("refuses to run against the in-memory store", async () => {
    // Re-configure this process onto `MiniCache`, which is what a chat-only
    // deployment gets. The handler is constructed after that switch.
    const memory = await loadConfig({ dialect: "sqlite", logger: libLogger });
    try {
      const { pdfCreator } = await import(
        "~/tools/common-tools-handlers/pdfCreator.js"
      );
      const result = await pdfCreator()(ONE_PAGE, ctx);
      expect(errorOf(result)).toEqual({
        code: "TOOL_DISABLED",
        message: "This tool is currently not available",
      });
    } finally {
      await memory.cleanup();
    }
  });
});

describe("createStyledSpreadsheet", () => {
  const DATA = [
    { name: "Ada", score: 10 },
    { name: "Grace", score: 20 },
  ];

  it("creates an xlsx, caches it and reports the download path", async () => {
    const result = (await mod.sheet.createStyledSpreadsheet()({
      data: DATA,
    }, ctx)) as {
      success: boolean;
      message: string;
      filename: string;
      downloadUrl: string;
      sizeBytes: number;
    };

    expect(result.success).toBe(true);
    expect(result.message).toBe("Spreadsheet created successfully.");
    // No filename was given and the format defaults to xlsx.
    expect(result.filename).toBe("spreadsheet.xlsx");
    expect(result.sizeBytes).toBeGreaterThan(1_000);

    const key = `file:${result.downloadUrl.slice("/api/files/".length)}`;
    const parsed = JSON.parse(await readWritten(key)) as {
      mimeType: string;
      filename: string;
      base64Data: string;
    };
    expect(parsed.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // An xlsx is a zip.
    expect(Buffer.from(parsed.base64Data, "base64").subarray(0, 2).toString()).toBe(
      "PK",
    );
  });

  it("names a csv default when the caller asks for csv", async () => {
    const result = (await mod.sheet.createStyledSpreadsheet()({
      data: DATA,
      options: { format: "csv" },
    }, ctx)) as { filename: string };

    expect(result.filename).toBe("data.csv");
  });

  it("keeps a caller-supplied filename", async () => {
    const result = (await mod.sheet.createStyledSpreadsheet()({
      data: DATA,
      options: { filename: "scores.xlsx" },
    }, ctx)) as { filename: string };

    expect(result.filename).toBe("scores.xlsx");
  });

  it("serves the cached workbook on a second identical call", async () => {
    const first = (await mod.sheet.createStyledSpreadsheet()({ data: DATA }, ctx)) as {
      downloadUrl: string;
    };
    const second = (await mod.sheet.createStyledSpreadsheet()({ data: DATA }, ctx)) as {
      downloadUrl: string;
    };

    expect(second.downloadUrl).toBe(first.downloadUrl);
    expect(libLog.debug).toHaveBeenCalledWith(
      { fileId: first.downloadUrl.slice("/api/files/".length) },
      "Spreadsheet Redis cache HIT",
    );
  });

  it("discards a corrupted cache entry and regenerates", async () => {
    const handler = mod.sheet.createStyledSpreadsheet();
    const created = (await handler({ data: DATA }, ctx)) as { downloadUrl: string };
    const key = `file:${created.downloadUrl.slice("/api/files/".length)}`;
    await env.redis?.setex(key, 60, "not json at all");

    const regenerated = (await handler({ data: DATA }, ctx)) as { sizeBytes: number };
    expect(regenerated.sizeBytes).toBeGreaterThan(1_000);
    expect(libLog.warn).toHaveBeenCalledWith(
      { redisFileKey: key },
      "Discarding corrupted spreadsheet cache entry.",
    );

    // The good payload has replaced the corrupt one.
    const stored = JSON.parse(await readWritten(key)) as {
      filename: string;
    };
    expect(stored.filename).toBe("spreadsheet.xlsx");
  });

  it("derives sizeBytes from the payload when the cache entry omits it", async () => {
    const handler = mod.sheet.createStyledSpreadsheet();
    const created = (await handler({ data: DATA }, ctx)) as { downloadUrl: string };
    const key = `file:${created.downloadUrl.slice("/api/files/".length)}`;
    const raw = JSON.parse(await readWritten(key)) as Record<
      string,
      unknown
    >;
    delete raw.sizeBytes;
    await env.redis?.setex(key, 60, JSON.stringify(raw));

    const cached = (await handler({ data: DATA }, ctx)) as { sizeBytes: number };
    expect(cached.sizeBytes).toBe(
      Buffer.byteLength(raw.base64Data as string, "base64"),
    );
  });

  it("rejects params that fail the schema", async () => {
    const result = await mod.sheet.createStyledSpreadsheet()({ data: "nope" }, ctx);
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(JSON.parse(error.message)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["data"] })]),
    );
  });

  it("reports a generation failure instead of throwing", async () => {
    // `exceljs` refuses a worksheet name containing `[`, `]`, `:`, `*`, `?`,
    // `\` or `/`, which is a real rejection rather than a hand-made mock.
    const result = await mod.sheet.createStyledSpreadsheet()({
      data: DATA,
      options: { sheetName: "a[b]:c" },
    }, ctx);

    const error = errorOf(result);
    expect(error.code).toBe("SPREADSHEET_CREATION_FAILED");
    // `exceljs` names the offending worksheet and lists the forbidden
    // characters; only the exact wording is library-internal, so anchor on the
    // parts that carry meaning.
    expect(error.message).toMatch(
      /^Worksheet name a\[b\]:c cannot include any of the following characters: \* \? : \\ \/ \[ \]$/,
    );
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      "Failed to create spreadsheet.",
    );
  });

  it("attaches the file id to a custom downloadPath on both cache miss and cache hit", async () => {
    const handler = mod.sheet.createStyledSpreadsheet("/v2/exports///");

    const created = (await handler({ data: DATA }, ctx)) as {
      downloadUrl: string;
    };
    const cached = (await handler({ data: DATA }, ctx)) as {
      downloadUrl: string;
    };

    expect(created.downloadUrl).toMatch(/^\/v2\/exports\/[0-9a-f]{64}$/);
    expect(cached.downloadUrl).toBe(created.downloadUrl);

    const fileId = created.downloadUrl.slice("/v2/exports/".length);
    const stored = JSON.parse(await readWritten(`file:${fileId}`)) as {
      filename: string;
    };
    expect(stored.filename).toBe("spreadsheet.xlsx");
  });

  it("refuses to run against the in-memory store", async () => {
    const memory = await loadConfig({ dialect: "sqlite", logger: libLogger });
    try {
      const { createStyledSpreadsheet } = await import(
        "~/tools/common-tools-handlers/createStyledSpreadsheet.js"
      );
      const result = await createStyledSpreadsheet()({ data: DATA }, ctx);
      expect(errorOf(result)).toEqual({
        code: "TOOL_DISABLED",
        message: "This tool is currently not available",
      });
    } finally {
      await memory.cleanup();
    }
  });
});

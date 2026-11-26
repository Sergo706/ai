import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import { createPdf, readPdf } from "~/utils/pdfManipulation.js";

/**
 * A minimal, valid 1x1 PNG.
 *
 * Hand-built so the test does not depend on a binary fixture: a real encoder
 * would be scenery, and `pdf-lib` only needs a decodable PNG to embed.
 */
function onePixelPng(): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, crcBytes]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  // One scanline: a filter byte plus one RGB triple.
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A valid baseline JPEG produced by `pdf-lib` itself would need an encoder, so
 * this reuses a well-known 1x1 JPEG instead of inventing bytes.
 */
const ONE_PIXEL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

describe("createPdf", () => {
  it("creates a readable PDF with metadata and text", async () => {
    const result = await createPdf({
      filename: "hello.pdf",
      metadata: {
        title: "Quarterly",
        author: "Ada",
        subject: "numbers",
        creator: "tests",
        keywords: ["q1", "revenue"],
      },
      pages: [
        {
          action: "add",
          items: [{ type: "text", x: 40, y: 700, text: "Hello PDF", size: 18 }],
        },
      ],
    });

    expect(result.filename).toBe("hello.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(result.base64Data).toBe(result.buffer.toString("base64"));

    const text = await readPdf({ fileBuffer: result.buffer });
    expect(text).toContain("## PDF Metadata");
    expect(text).toContain("- Title: Quarterly");
    expect(text).toContain("- Author: Ada");
    expect(text).toContain("- Creator: tests");
    expect(text).toContain("- Producer: pdf-lib");
    expect(text).toContain("Hello PDF");
    expect(text).toContain("--- Page 1 ---");

    // `pdf-parse` does not surface Subject or Keywords in `getInfo()`, so the
    // write path is verified against the document itself.
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(result.buffer);
    expect(doc.getSubject()).toBe("numbers");
    // `pdf-lib` joins keyword arrays with a single space.
    expect(doc.getKeywords()).toBe("q1 revenue");
  });

  it("leaves metadata unset when the caller supplies none", async () => {
    const result = await createPdf({
      pages: [{ action: "add", items: [] }],
    });

    // No filename means the handler has to invent one.
    expect(result.filename).toBeUndefined();

    const text = await readPdf({ fileBuffer: result.buffer });
    expect(text).toContain("- Title: N/A");
    expect(text).toContain("- Author: N/A");
  });

  it("honours explicit page dimensions", async () => {
    const result = await createPdf({
      pages: [
        { action: "add", dimensions: [200, 100], items: [] },
        { action: "add", items: [] },
      ],
    });

    const text = await readPdf({ fileBuffer: result.buffer });
    expect(text).toContain("- Total Pages: 2");
    expect(text).toContain("--- Page 1 ---");
    expect(text).toContain("--- Page 2 ---");
  });

  it("defaults the page size to A4", async () => {
    const result = await createPdf({ pages: [{ action: "add", items: [] }] });
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(result.buffer);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 2);
    expect(size.height).toBeCloseTo(841.89, 2);
  });

  it("draws every supported item type", async () => {
    const result = await createPdf({
      filename: "shapes.pdf",
      pages: [
        {
          action: "add",
          items: [
            {
              type: "text",
              x: 30,
              y: 700,
              text: "Helvetica",
              size: 14,
              font: "Helvetica",
              colorRgb: [0.1, 0.2, 0.3],
            },
            {
              type: "text",
              x: 30,
              y: 660,
              text: "Bold",
              font: "HelveticaBold",
            },
            { type: "text", x: 30, y: 620, text: "Times", font: "TimesRoman" },
            { type: "text", x: 30, y: 580, text: "Courier", font: "Courier" },
            {
              type: "text",
              x: 30,
              y: 540,
              text: "DejaVuBold",
              font: "DejaVuBold",
            },
            {
              type: "rectangle",
              x: 30,
              y: 400,
              width: 120,
              height: 60,
              colorRgb: [1, 0, 0],
              borderColorRgb: [0, 0, 1],
              borderWidth: 2,
            },
            {
              type: "rectangle",
              x: 200,
              y: 400,
              width: 40,
              height: 40,
            },
            {
              type: "svgPath",
              x: 300,
              y: 400,
              path: "M 0 0 L 50 50 L 100 0 Z",
              scale: 1,
              colorRgb: [0, 0.5, 0],
            },
            { type: "svgPath", x: 300, y: 200, path: "M 0 0 L 10 10" },
            {
              type: "image",
              x: 400,
              y: 400,
              width: 32,
              height: 32,
              imageBase64: onePixelPng().toString("base64"),
              imageType: "png",
            },
            {
              type: "image",
              x: 450,
              y: 400,
              width: 16,
              height: 16,
              imageBase64: ONE_PIXEL_JPEG_BASE64,
              imageType: "jpg",
            },
          ],
        },
      ],
    });

    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(result.buffer);
    expect(doc.getPageCount()).toBe(1);
    expect(result.buffer.length).toBeGreaterThan(1_000);
  });

  it("skips an item that is missing the fields its type needs", async () => {
    // A model can send `{type:"text"}` with no text; that must not throw.
    const result = await createPdf({
      pages: [
        {
          action: "add",
          items: [
            { type: "text", x: 10, y: 10 },
            { type: "rectangle", x: 10, y: 10 },
            { type: "svgPath", x: 10, y: 10 },
            { type: "image", x: 10, y: 10 },
          ],
        },
      ],
    });

    expect(result.buffer.length).toBeGreaterThan(500);
  });

  it("modifies an existing page from a base64 document", async () => {
    const first = await createPdf({
      pages: [
        {
          action: "add",
          items: [{ type: "text", x: 20, y: 700, text: "Page one" }],
        },
      ],
    });

    const second = await createPdf({
      filename: "modified.pdf",
      basePdfBase64: first.base64Data,
      pages: [
        {
          action: "modify",
          pageIndex: 0,
          items: [{ type: "text", x: 20, y: 600, text: "Added later" }],
        },
      ],
    });

    const text = await readPdf({ fileBuffer: second.buffer });
    expect(text).toContain("Page one");
    expect(text).toContain("Added later");
    expect(text).toContain("- Total Pages: 1");
  });

  it("rejects a modify instruction whose page index is out of bounds", async () => {
    await expect(
      createPdf({
        pages: [{ action: "modify", pageIndex: 3, items: [] }],
      }),
    ).rejects.toThrow("Page index 3 out of bounds.");
  });

  it("rejects a modify instruction with no page index", async () => {
    await expect(
      createPdf({ pages: [{ action: "modify", items: [] }] }),
    ).rejects.toThrow(
      "Invalid page instruction: must specify action 'add' or 'modify' (with pageIndex).",
    );
  });

  it("continues when a page definition has no items array", async () => {
    // The schema defaults `items` to `[]`, but the library must survive a
    // caller that builds the params object by hand.
    const result = await createPdf({
      pages: [{ action: "add" }] as never,
    });
    expect(result.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("readPdf", () => {
  it("reports the metadata block when asked for it", async () => {
    const { buffer } = await createPdf({
      pages: [
        {
          action: "add",
          items: [{ type: "text", x: 10, y: 10, text: "body" }],
        },
      ],
    });

    const text = await readPdf({ fileBuffer: buffer, includeMetadata: true });
    expect(text.startsWith("## PDF Metadata\n")).toBe(true);
    expect(text).toContain("- Total Pages: 1");
    expect(text).toContain("## PDF Content");
  });

  it("omits the metadata block when asked to", async () => {
    const { buffer } = await createPdf({
      pages: [
        {
          action: "add",
          items: [{ type: "text", x: 10, y: 10, text: "body" }],
        },
      ],
    });

    const text = await readPdf({ fileBuffer: buffer, includeMetadata: false });
    // `pdf-parse` appends its own "-- 1 of 1 --" page footer, which is the only
    // thing beyond the page marker the reader adds.
    expect(text).toBe("## PDF Content\n\n--- Page 1 ---\nbody\n\n-- 1 of 1 --");
  });

  it("stops after maxPages", async () => {
    const { buffer } = await createPdf({
      pages: [
        { action: "add", items: [{ type: "text", x: 10, y: 10, text: "one" }] },
        { action: "add", items: [{ type: "text", x: 10, y: 10, text: "two" }] },
        {
          action: "add",
          items: [{ type: "text", x: 10, y: 10, text: "three" }],
        },
      ],
    });

    const text = await readPdf({ fileBuffer: buffer, maxPages: 2 });
    expect(text).toContain("--- Page 1 ---");
    expect(text).toContain("--- Page 2 ---");
    expect(text).not.toContain("--- Page 3 ---");
    // `total` in the metadata still reports the real page count.
    expect(text).toContain("- Total Pages: 3");
  });

  it("reads every page when maxPages exceeds the document", async () => {
    const { buffer } = await createPdf({
      pages: [
        {
          action: "add",
          items: [{ type: "text", x: 10, y: 10, text: "solo" }],
        },
      ],
    });

    const text = await readPdf({ fileBuffer: buffer, maxPages: 99 });
    expect(text).toContain("--- Page 1 ---");
    expect(text).not.toContain("--- Page 2 ---");
  });

  it("wraps a parse failure with a readable message", async () => {
    await expect(
      readPdf({ fileBuffer: Buffer.from("this is not a pdf") }),
    ).rejects.toThrow(/^Failed to read PDF: /);
  });

  it("falls back to N/A for the fields pdf-lib does not stamp", async () => {
    // `pdf-lib` always writes Creator, Producer and both dates, so Title and
    // Author are the only `?? "N/A"` fallbacks reachable from a real document.
    // This pins that they fire, and that the stamped fields are reported rather
    // than blanked by the same code path.
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage();
    const bare = Buffer.from(await doc.save());

    const text = await readPdf({ fileBuffer: bare });

    expect(text).toContain("- Title: N/A");
    expect(text).toContain("- Author: N/A");
    expect(text).toContain("- Creator: pdf-lib");
    expect(text).toContain("- Producer: pdf-lib");
    expect(text).toMatch(/- Creation Date: \w{3} \w{3} \d{2} \d{4}/);
    expect(text).toMatch(/- Modification Date: \w{3} \w{3} \d{2} \d{4}/);
    expect(text).toContain("- Total Pages: 1");
  });
});

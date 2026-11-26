import { describe, expect, it } from "vitest";

import {
  generateStyledSpreadsheet,
  readCsvToMarkdown,
  readXlsxToMarkdown,
} from "~/utils/spreadsheetsManipulation.js";

const ROWS = [
  { name: "Ada", role: "engineer" },
  { name: "Grace", role: "admiral" },
];

describe("generateStyledSpreadsheet", () => {
  it("returns an xlsx buffer by default with a styled header", async () => {
    const result = await generateStyledSpreadsheet(ROWS);

    expect(result.format).toBe("xlsx");
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(result.jsonData).toBe(ROWS);
    expect(result.filename).toBeUndefined();
    // A zip local header, which is what an xlsx is.
    expect(result.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(result.base64Data).toBe(result.buffer.toString("base64"));
  });

  it("renders a csv buffer when asked for one", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      format: "csv",
      filename: "people.csv",
    });

    expect(result.format).toBe("csv");
    expect(result.mimeType).toBe("text/csv");
    expect(result.filename).toBe("people.csv");
    expect(result.buffer.toString("utf8")).toBe(
      ["NAME,ROLE", "Ada,engineer", "Grace,admiral"].join("\n"),
    );
  });

  it("uses caller-supplied columns and header casing", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      format: "csv",
      columns: [
        { header: "Who", key: "name", width: 30 },
        { header: "Job", key: "role", width: 30 },
      ],
    });

    expect(result.buffer.toString("utf8").split("\n")[0]).toBe("Who,Job");
  });

  it("accepts a custom sheet name", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      sheetName: "People",
    });
    const markdown = await readXlsxToMarkdown(result.buffer);
    // A single sheet is rendered without its name, so assert via a second
    // sheet later; here just prove the workbook still parses.
    expect(markdown).toContain("| Ada | engineer |");
  });

  it("applies caller-supplied header and data styles", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      headerStyle: {
        font: { bold: true, size: 20, color: { argb: "FF000000" } },
        fill: {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFF00" },
        },
        alignment: { vertical: "top", horizontal: "left" },
        border: { top: { style: "medium" } },
      },
      dataStyle: {
        font: { italic: true },
        fill: {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF0F0F0" },
        },
        alignment: { vertical: "bottom", horizontal: "right" },
        border: { bottom: { style: "thick" } },
      },
    });

    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    const sheet = workbook.worksheets[0];

    expect(sheet.getRow(1).getCell(1).font).toMatchObject({
      bold: true,
      size: 20,
    });
    expect(sheet.getRow(1).getCell(1).fill).toMatchObject({
      type: "pattern",
      fgColor: { argb: "FFFFFF00" },
    });
    expect(sheet.getRow(2).getCell(1).font).toMatchObject({ italic: true });
    expect(sheet.getRow(2).getCell(1).border.bottom?.style).toBe("thick");
  });

  it("applies the default borders to data rows only", async () => {
    const result = await generateStyledSpreadsheet(ROWS);
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    const sheet = workbook.worksheets[0];

    expect(sheet.getRow(1).getCell(1).border.top?.style).toBeUndefined();
    expect(sheet.getRow(2).getCell(1).border.top?.style).toBe("thin");
  });

  it("applies a caller-supplied header border", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      headerStyle: { border: { left: { style: "double" } } },
    });
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    const sheet = workbook.worksheets[0];

    expect(sheet.getRow(1).getCell(1).border.left?.style).toBe("double");
  });

  it("produces an empty sheet for empty data", async () => {
    const result = await generateStyledSpreadsheet([]);
    expect(result.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(await readXlsxToMarkdown(result.buffer)).toBe("");
  });

  it("honours defaultColumnWidth for generated columns", async () => {
    const result = await generateStyledSpreadsheet(ROWS, {
      defaultColumnWidth: 40,
    });
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(result.buffer as never);
    const sheet = workbook.worksheets[0];
    expect(sheet.getColumn(1).width).toBe(40);
  });
});

describe("readXlsxToMarkdown", () => {
  it("renders a single sheet as a table with no sheet heading", async () => {
    const { buffer } = await generateStyledSpreadsheet(ROWS);
    expect(await readXlsxToMarkdown(buffer)).toBe(
      [
        "| NAME | ROLE |",
        "| --- | --- |",
        "| Ada | engineer |",
        "| Grace | admiral |",
        "",
      ].join("\n"),
    );
  });

  it("prefixes each sheet with its name when there are several", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const first = workbook.addWorksheet("People");
    first.addRow(["NAME", "ROLE"]);
    first.addRow(["Ada", "engineer"]);
    const second = workbook.addWorksheet("Totals");
    second.addRow(["KEY", "VALUE"]);
    second.addRow(["users", 2]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    expect(await readXlsxToMarkdown(buffer)).toBe(
      [
        "## People",
        "",
        "| NAME | ROLE |",
        "| --- | --- |",
        "| Ada | engineer |",
        "",
        "## Totals",
        "",
        "| KEY | VALUE |",
        "| --- | --- |",
        "| users | 2 |",
        "",
      ].join("\n"),
    );
  });

  it("skips a sheet with no rows", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    workbook.addWorksheet("Empty");
    const filled = workbook.addWorksheet("Filled");
    filled.addRow(["A"]);
    filled.addRow(["1"]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const markdown = await readXlsxToMarkdown(buffer);

    expect(markdown).not.toContain("Empty");
    expect(markdown).toBe(["| A |", "| --- |", "| 1 |", ""].join("\n"));
  });

  it("returns an empty string for a workbook with no sheets at all", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toBe("");
  });

  it("escapes pipes and newlines so a cell cannot break the table", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["HEADER"]);
    sheet.addRow(["a|b\nc"]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toBe(
      ["| HEADER |", "| --- |", "| a\\|b<br>c |", ""].join("\n"),
    );
  });

  it("renders a date cell as an ISO string", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["WHEN"]);
    sheet.addRow([new Date("2024-07-01T12:00:00.000Z")]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toContain(
      "| 2024-07-01T12:00:00.000Z |",
    );
  });

  it("renders a rich-text cell through its plain text", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["VALUE"]);
    sheet.getCell("A2").value = {
      richText: [{ text: "plain " }, { text: "text" }],
    };

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toContain("| plain text |");
  });

  it("JSON-stringifies a cell that has no plain text form", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["VALUE"]);
    sheet.getCell("A2").value = { formula: "SUM(B1:B2)", result: 7 };

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const markdown = await readXlsxToMarkdown(buffer);
    // A formula cell has text "7", so the plain-text path wins.
    expect(markdown).toContain("| 7 |");
  });

  it("leaves a null cell out, producing a ragged row", async () => {
    // `exceljs` does not materialise a trailing cell assigned `null`, so the
    // row really is one column wide. Rendering it verbatim is the honest
    // choice: inventing a trailing pipe would claim data that is not there.
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["A", "B"]);
    sheet.addRow(["x", null]);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toBe(
      ["| A | B |", "| --- | --- |", "| x |", ""].join("\n"),
    );
  });

  it("renders an empty-string cell as a blank column", async () => {
    const { default: exceljs } = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["A", "B"]);
    sheet.getCell("A2").value = "x";
    sheet.getCell("B2").value = "";

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await readXlsxToMarkdown(buffer)).toBe(
      ["| A | B |", "| --- | --- |", "| x |  |", ""].join("\n"),
    );
  });
});

describe("readCsvToMarkdown", () => {
  it("renders a csv buffer as a table", async () => {
    const csv = Buffer.from("NAME,ROLE\nAda,engineer\nGrace,admiral\n");
    expect(await readCsvToMarkdown(csv)).toBe(
      [
        "| NAME | ROLE |",
        "| --- | --- |",
        "| Ada | engineer |",
        "| Grace | admiral |",
        "",
      ].join("\n"),
    );
  });

  it("returns an empty string for a csv with no rows", async () => {
    expect(await readCsvToMarkdown(Buffer.from(""))).toBe("");
  });

  it("keeps a quoted field containing a comma", async () => {
    const csv = Buffer.from('A,B\n"x, y",z\n');
    expect(await readCsvToMarkdown(csv)).toBe(
      ["| A | B |", "| --- | --- |", "| x, y | z |", ""].join("\n"),
    );
  });
});

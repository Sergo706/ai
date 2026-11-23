import exceljs, {
  type Cell,
  type Worksheet,
  type Style,
} from "exceljs";
import { Readable } from "stream";
import { SpreadsheetOptions } from "./types/SpreadsheetsManipulation";

const { Workbook } = exceljs;

function cellToText(cell: Cell): string {
  const value = cell.value;

  if (value instanceof Date) return value.toISOString();

  const text = cell.text.trim();
  if (text) return text;

  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toTableCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function worksheetToMarkdown(worksheet: Worksheet): string {
  const rows: string[][] = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(toTableCell(cellToText(cell)));
    });
    if (cells.length > 0) rows.push(cells);
  });

  if (rows.length === 0) return "";

  const [header, ...body] = rows;
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ];

  return `${lines.join("\n")}\n`;
}

export async function readXlsxToMarkdown(buffer: Buffer): Promise<string> {
  const workbook = new Workbook();
  // @ts-expect-error Convert the buffer to the lib old typescript definition
  await workbook.xlsx.load(buffer);

  const sheets = workbook.worksheets
    .map((worksheet) => ({
      name: worksheet.name,
      markdown: worksheetToMarkdown(worksheet),
    }))
    .filter((sheet) => sheet.markdown.length > 0);

  if (sheets.length === 0) return "";
  if (sheets.length === 1) return sheets[0].markdown;

  return sheets
    .map((sheet) => `## ${sheet.name}\n\n${sheet.markdown}`)
    .join("\n");
}

export async function readCsvToMarkdown(buffer: Buffer): Promise<string> {
  const workbook = new Workbook();

  const stream = Readable.from(buffer);
  await workbook.csv.read(stream);

  const worksheet = workbook.worksheets[0];
  return worksheetToMarkdown(worksheet);
}


export async function createStyledSpreadsheet<
  T extends Record<string, unknown>,
>(
  data: T[],
  options: SpreadsheetOptions = {},
): Promise<{
  buffer: Buffer;
  format: "xlsx" | "csv";
  jsonData: T[];
  filename?: string;
  mimeType: string;
  base64Data: string;
}> {
  const {
    sheetName = "Sheet1",
    defaultColumnWidth = 25,
    headerStyle,
    dataStyle,
  } = options;

  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet(sheetName);

  if (options.columns && options.columns.length > 0) {
    worksheet.columns = options.columns;
  } else if (data.length > 0) {
    worksheet.columns = Object.keys(data[0]).map((key) => ({
      header: key.toUpperCase(),
      key: key,
      width: defaultColumnWidth,
    }));
  }

  if (data.length > 0) {
    worksheet.addRows(data);
    const headerRow = worksheet.getRow(1);
    headerRow.font = headerStyle?.font ?? {
      bold: true,
      color: { argb: "FFFFFFFF" },
      size: 12,
    };
    headerRow.fill = headerStyle?.fill ?? {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4F81BD" },
    };

    headerRow.alignment = headerStyle?.alignment ?? {
      vertical: "middle",
      horizontal: "center",
    };
    if (headerStyle?.border) headerRow.border = headerStyle.border;

    const defaultBorder: Partial<Style>["border"] = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;

      row.eachCell((cell) => {
        cell.border = dataStyle?.border ?? defaultBorder;
        if (dataStyle?.font) cell.font = dataStyle.font;
        if (dataStyle?.fill) cell.fill = dataStyle.fill;
        if (dataStyle?.alignment) cell.alignment = dataStyle.alignment;
      });
    });
  }

  const format = options.format ?? "xlsx";
  const buffer =
    format === "csv"
      ? ((await workbook.csv.writeBuffer()) as unknown as Buffer)
      : ((await workbook.xlsx.writeBuffer()) as unknown as Buffer);

  const mimeType =
    format === "csv"
      ? "text/csv"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  return {
    buffer,
    format,
    jsonData: data,
    filename: options.filename,
    mimeType,
    base64Data: buffer.toString("base64"),
  };
}

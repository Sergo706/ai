import z from 'zod'

const colorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

const pdfItemSchema = z.object({
  type: z.enum(["text", "image", "rectangle", "svgPath"]),
  x: z.number(),
  y: z.number(),
  text: z.string().optional(),
  size: z.number().default(12),
  font: z
    .enum([
      "DejaVu",
      "DejaVuBold",
      "Helvetica",
      "TimesRoman",
      "Courier",
      "HelveticaBold",
    ])
    .default("DejaVu"),
  imageBase64: z.string().optional(),
  imageType: z.enum(["png", "jpg"]).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  path: z.string().optional(),
  scale: z.number().optional(),
  colorRgb: colorSchema.optional(),
  borderColorRgb: colorSchema.optional(),
  borderWidth: z.number().optional(),
});


const pageSchema = z.object({
  action: z.enum(["add", "modify"]).default("add"),
  pageIndex: z.number().optional(),
  dimensions: z.tuple([z.number(), z.number()]).optional(),
  items: z.array(pdfItemSchema).default([]),
});

/** Arguments accepted by the `pdf_creator` tool. */
export const pdfCreatorParams = z.object({
  filename: z
    .string()
    .describe("The name of the file to save, e.g., 'report.pdf'"),
  basePdfBase64: z
    .string()
    .optional()
    .describe(
      "Base64 encoded existing PDF to modify. Leave empty to create a new PDF.",
    ),
  pages: z.array(pageSchema).describe("Pages to add or modify in the PDF"),
  metadata: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      subject: z.string().optional(),
      creator: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Arguments accepted by the `currencies_convertor` tool. */
export const currencyParams = z.object({
  amount: z.number().positive(),
  from: z.string().length(3).toUpperCase(),
  to: z.string().length(3).toUpperCase(),
});

/**
 * One document read.
 *
 * Chunk indexes are inclusive and both-or-neither: sending only `chunkStart`
 * would request an unbounded tail. The 10-chunk span is enforced by the handler
 * so the error can name the limit.
 */
export const documentParams = z.object({
  documentId: z.number().int().positive().describe("The document to read."),
  chunkStart: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "First chunk index (inclusive). Omit to get the whole document instead.",
    ),
  chunkEnd: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Last chunk index (inclusive). Required when chunkStart is set; at most 10 chunks per read.",
    ),
});

const styleSchema = z.object({
  font: z
    .object({
      bold: z.boolean().optional(),
      size: z.number().optional(),
      color: z.object({ argb: z.string() }).optional(),
    })
    .optional(),
  fill: z
    .object({
      type: z.literal("pattern").optional(),
      pattern: z.literal("solid").optional(),
      fgColor: z.object({ argb: z.string() }).optional(),
    })
    .optional(),
  alignment: z
    .object({
      vertical: z.enum(["top", "middle", "bottom"]).optional(),
      horizontal: z.enum(["left", "center", "right"]).optional(),
    })
    .optional(),
});

/** Arguments accepted by the `create_styled_spreadsheet` tool. */
export const spreadsheetCreatorParams = z.object({
  data: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      "Array of JSON objects representing the rows of the spreadsheet.",
    ),
  options: z
    .object({
      filename: z
        .string()
        .optional()
        .describe(
          "The name of the file to save, e.g., 'report.xlsx' or 'data.csv'",
        ),
      sheetName: z
        .string()
        .optional()
        .describe("Name of the worksheet (default: 'Sheet1')"),
      format: z
        .enum(["xlsx", "csv"])
        .optional()
        .describe("Output format (default: 'xlsx')"),
      defaultColumnWidth: z
        .number()
        .optional()
        .describe("Default width for columns (default: 25)"),
      columns: z
        .array(
          z.object({
            header: z.string().optional(),
            key: z.string().optional(),
            width: z.number().optional(),
          }),
        )
        .optional()
        .describe(
          "Explicit column definitions. If omitted, columns are auto-generated from the first data row.",
        ),
      headerStyle: styleSchema
        .optional()
        .describe("Styling for the header row (XLSX only)."),
      dataStyle: styleSchema
        .optional()
        .describe("Styling for the data rows (XLSX only)."),
    })
    .optional()
    .describe("Configuration options for the spreadsheet."),
});

import type { Column, Style } from "exceljs";

/** Options for {@link generateStyledSpreadsheet}. */
export interface SpreadsheetOptions {
  /**
   * Name of the worksheet.
   *
   * @default "Sheet1"
   */
  sheetName?: string;
  /**
   * Output format.
   *
   * @default "xlsx"
   */
  format?: "xlsx" | "csv";
  /** Filename to report back with the buffer. */
  filename?: string;
  /**
   * Column definitions. When omitted, columns are derived from the keys of the
   * first row.
   */
  columns?: Partial<Column>[];
  /** Header row styling, merged over the default blue bold header. */
  headerStyle?: Partial<Style>;
  /** Body cell styling; only applied when the matching option is given. */
  dataStyle?: Partial<Style>;
  /**
   * Width of the generated columns.
   *
   * @default 25
   */
  defaultColumnWidth?: number;
}
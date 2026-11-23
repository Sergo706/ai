import { Column, Style } from "exceljs";

export interface SpreadsheetOptions {
  sheetName?: string;
  format?: "xlsx" | "csv";
  filename?: string;
  columns?: Partial<Column>[];
  headerStyle?: Partial<Style>;
  dataStyle?: Partial<Style>;
  defaultColumnWidth?: number;
}
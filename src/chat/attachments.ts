import { readPdf } from "../utils/pdfManipulation";
import {
  readCsvToMarkdown,
  readXlsxToMarkdown,
} from "../utils/spreadsheetsManipulation";

/** A turn's message with any attached files folded into its text. */
export interface Attachments {
  /** `true` when at least one file was read and appended. */
  hasFiles: boolean;
  /** The message to send: file contents followed by the original message. */
  message: string;
}

/** Limits applied to one turn's attached files. */
export interface ParseFileLimits {
  /**
   * Maximum files per turn.
   *
   * @default 3
   */
  maxFiles?: number;
  /**
   * Maximum size of one file, in bytes.
   *
   * @default 10485760 (10 MB)
   */
  maxBytes?: number;
  /**
   * Accepted mime types, on top of any `text/*` type.
   *
   * @default PDF, CSV and XLSX
   */
  mimeTypes?: readonly string[];
  /**
   * Pages read from a PDF before the text is truncated.
   *
   * @default 5
   */
  maxPdfPages?: number;
}

const DEFAULT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * Read attached files and append them to the message as markdown.
 *
 * PDFs, CSVs and XLSX are converted to text and any `text/*` file is read as-is;
 * other types are rejected. Only the extracted text is kept, never the file.
 *
 * @param files - Files from the request, or `undefined` for none.
 * @param currentMessage - The caller's message, returned unchanged with no files.
 * @param limits - Size, count and type limits.
 * @returns The combined message and whether any file was read.
 * @throws If a file exceeds the count, size or mime-type limit.
 * @example
 * ```ts
 * const { message, hasFiles } = await parseFiles(files, "summarise this");
 * ```
 */
export async function parseFiles(
  files: File[] | undefined,
  currentMessage: string,
  limits: ParseFileLimits = {},
): Promise<Attachments> {
  if (!files || files.length === 0) {
    return { hasFiles: false, message: currentMessage };
  }

  const maxFiles = limits.maxFiles ?? 3;
  if (files.length > maxFiles) {
    throw new Error(`At most ${String(maxFiles)} files can be attached`);
  }

  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024;
  const mimeTypes = limits.mimeTypes ?? DEFAULT_MIME_TYPES;
  const maxPdfPages = limits.maxPdfPages ?? 5;

  const parsedFilesContent = [];
  for (const file of files) {
    if (file.size > maxBytes) {
      throw new Error(
        `"${file.name}" is larger than ${String(maxBytes)} bytes`,
      );
    }
    const accepted =
      file.type.startsWith("text/") ||
      mimeTypes.some((mime) => file.type === mime || file.type.includes(mime));
    if (!accepted) {
      throw new Error(`"${file.name}" has an unsupported type: ${file.type}`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let extractedText = "";

    if (file.type === "application/pdf") {
      extractedText = await readPdf({
        maxPages: maxPdfPages,
        fileBuffer: buffer,
        includeMetadata: true,
      });
    } else if (file.type === "text/csv") {
      extractedText = await readCsvToMarkdown(buffer);
    } else if (file.type.includes("spreadsheetml")) {
      extractedText = await readXlsxToMarkdown(buffer);
    } else {
      extractedText = await file.text();
    }

    parsedFilesContent.push({
      fileName: file.name,
      fileType: file.type,
      fileContent: extractedText,
    });
  }

  const filesContext = parsedFilesContent
    .map(
      (f) =>
        `--- START FILE: ${f.fileName} ---\n${f.fileContent}\n--- END FILE ---`,
    )
    .join("\n\n");

  return {
    hasFiles: true,
    message: `[USER UPLOADED FILES FOR CONTEXT]\n${filesContext}\n\n[USER MESSAGE]\n${currentMessage}`,
  };
}

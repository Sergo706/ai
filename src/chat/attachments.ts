import { readPdf } from "../utils/pdfManipulation";
import {
  readCsvToMarkdown,
  readXlsxToMarkdown,
} from "../utils/spreadsheetsManipulation";

export interface Attachments {
  hasFiles: boolean;
  message: string;
}

/** Limits applied to one turn's files. */
export interface ParseFileLimits {
  /** Maximum files per turn. Defaults to 3. */
  maxFiles?: number;
  /** Maximum bytes per file. Defaults to 10 MB. */
  maxBytes?: number;
  /** Accepted mime types. Defaults to the formats `parseFiles` can read. */
  mimeTypes?: readonly string[];
  /** Pages read from a PDF before truncating. Defaults to 5. */
  maxPdfPages?: number;
}

const DEFAULT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

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

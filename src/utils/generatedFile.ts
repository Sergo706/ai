import { cacheGet, getConfiguration } from "../config/config";

/** The key the tool handlers write generated files under. */
export function fileKey(id: string): string {
  return `file:${id}`;
}

export interface DownloadedFile {
  /** The decoded bytes. `Content-Length` is this, never the base64 length. */
  buffer: Buffer;
  filename: string;
  mimeType: string;
  headers: {
    "Content-Type": string;
    "Content-Disposition": string;
    "Content-Length": string;
  };
}

export type ReadFileFailure = "not_found" | "corrupt";

export type ReadFileOutcome =
  | { ok: true; file: DownloadedFile }
  | { ok: false; reason: ReadFileFailure; message: string };

/**
 * Reads a file an agent tool stored under `file:<id>`.
 *
 */
export async function readGeneratedFile(id: string): Promise<ReadFileOutcome> {
  const log = getConfiguration().logger;
  const raw = await cacheGet<string>(fileKey(id));

  if (!raw) {
    log.info({ fileId: id }, "[files] File not found or expired");
    return {
      ok: false,
      reason: "not_found",
      message: "File not found or expired",
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      base64Data: string;
      mimeType?: string;
      filename?: string;
    };

    const buffer = Buffer.from(parsed.base64Data, "base64");
    const mimeType = parsed.mimeType ?? "application/octet-stream";
    const filename = parsed.filename ?? "download";

    return {
      ok: true,
      file: {
        buffer,
        filename,
        mimeType,
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length.toString(),
        },
      },
    };
  } catch (err) {
    log.error({ err, fileId: id }, "[files] Failed to process file data");
    return {
      ok: false,
      reason: "corrupt",
      message: "Failed to process file data",
    };
  }
}

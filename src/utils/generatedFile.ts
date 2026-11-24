import { cacheGet, getConfiguration } from "../config/config";

/**
 * The cache key a generated file is stored under.
 *
 * @param id - The file id returned to the model.
 * @returns The key, `file:<id>`.
 */
export function fileKey(id: string): string {
  return `file:${id}`;
}

/** A generated file, ready to send as a download. */
export interface DownloadedFile {
  /** The decoded bytes; `Content-Length` is this, not the base64 length. */
  buffer: Buffer;
  /** Name to offer the browser. */
  filename: string;
  /** Mime type of the stored file. */
  mimeType: string;
  /** Response headers for a download. */
  headers: {
    "Content-Type": string;
    "Content-Disposition": string;
    "Content-Length": string;
  };
}

/** Why a generated file could not be read. */
export type ReadFileFailure = "not_found" | "corrupt";

/** The result of {@link readGeneratedFile}. */
export type ReadFileOutcome =
  | { ok: true; file: DownloadedFile }
  | {
      ok: false;
      /** `not_found` when it expired, `corrupt` when it could not be parsed. */
      reason: ReadFileFailure;
      /** Human-readable explanation, safe to surface. */
      message: string;
    };

/**
 * Read a file an agent tool stored under `file:<id>`.
 *
 * Files expire with the cache, so a `not_found` result is normal for an old
 * link.
 *
 * @param id - The file id returned by the tool.
 * @returns The decoded file and its response headers, or a reason it failed.
 * @example
 * ```ts
 * const result = await readGeneratedFile(id);
 * if (!result.ok) return new Response(result.message, { status: 404 });
 * return new Response(result.file.buffer, { headers: result.file.headers });
 * ```
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

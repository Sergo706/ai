import { MiniCache } from "@riavzon/utils";
import { getConfiguration, getStorage } from "../../config/config";
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { pdfCreatorParams } from "./schemas";
import { generateHash } from "../../utils/hash";
import { createPdf } from "../../utils/pdfManipulation";
import { envInt } from "@riavzon/utils/server";


const AGENT_GENERATED_FILE_TTL = envInt("AGENT_GENERATED_FILE_TTL", 86_400, {
  min: 0,
});

/**
 * Render markdown into a downloadable PDF.
 *
 * The file is cached in the configured store, keyed by its params hash, so a
 * repeated call returns the same link.
 *
 * @returns A handler that takes the PDF options and returns a URL to the file.
 * Requires a Redis store; returns `TOOL_DISABLED` with the memory store.
 */
export function pdfCreator(downloadPath = "/api/files"): ToolHandler {
  const config = getConfiguration();
  const log = config.logger;
  const store = getStorage();
  const isMemoryStore = store instanceof MiniCache;
  const basePath = downloadPath.replace(/\/+$/, "");

  return async (args) => {
    log.debug({ args }, "agent ran tool pdfCreator");
    
    if (isMemoryStore) {
      return toolError("TOOL_DISABLED", "This tool is currently not available")
    }

    const parse = pdfCreatorParams.safeParse(args);
    if (!parse.success) {
      return toolError("VALIDATION_ERROR", JSON.stringify(parse.error.issues));
    }

    const redis = store;
    try {
      const fileId = generateHash(JSON.stringify(parse.data));
      const redisFileKey = `file:${fileId}`;

      const existingRaw = await redis.get(redisFileKey);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as {
          base64Data: string;
          filename: string;
          sizeBytes?: number;
        };

        return {
          success: true,
          message: "PDF created successfully.",
          filename: existing.filename,
          downloadUrl: `${basePath}/${fileId}`,
          sizeBytes:
            existing.sizeBytes ??
            Buffer.byteLength(existing.base64Data, "base64"),
        };
      }

      const result = await createPdf(parse.data);
      const filename = result.filename ?? "document.pdf";

      await redis.setex(
        redisFileKey,
        AGENT_GENERATED_FILE_TTL,
        JSON.stringify({
          base64Data: result.base64Data,
          mimeType: result.mimeType,
          filename: filename,
          sizeBytes: result.buffer.length,
        }),
      );

      return {
        success: true,
        message: "PDF created successfully.",
        filename,
        downloadUrl: `${basePath}/${fileId}`,
        sizeBytes: result.buffer.length,
      };
    } catch (err) {
      log.error({ err }, "Failed to create PDF.");
      return toolError(
        "PDF_CREATION_FAILED",
        err instanceof Error ? err.message : "Unable to create PDF document.",
      );
    }
  };
}

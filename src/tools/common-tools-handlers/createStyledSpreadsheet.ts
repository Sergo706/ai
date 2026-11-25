import { envInt } from "@riavzon/utils/server";
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { spreadsheetCreatorParams } from "./schemas";
import { toolError } from "../execution";
import { MiniCache } from "@riavzon/utils";
import { getConfiguration, getStorage } from "../../config/config";
import { generateHash } from "../../utils/hash";
import { SpreadsheetOptions } from "../../utils/types/SpreadsheetsManipulation";
import { generateStyledSpreadsheet as generateSpreadsheet } from "../../utils/spreadsheetsManipulation";




/** Redis lifetime for a generated spreadsheet, keyed by its params hash. */
const AGENT_GENERATED_FILE_TTL = envInt("AGENT_GENERATED_FILE_TTL", 86_400, {
  min: 0,
});

/**
 * Render a styled spreadsheet (CSV or XLSX) and cache the result.
 *
 * The file is cached in the configured store, keyed by its params hash, so a
 * repeated call returns the same link.
 *
 * @returns A handler that takes the sheet options and returns a URL to the file.
 * Requires a Redis store; returns `TOOL_DISABLED` with the memory store.
 */
export function createStyledSpreadsheet(
  downloadPath = "/api/files",
): ToolHandler {
  const config = getConfiguration();
  const log = config.logger;
  const store = getStorage();
  const isMemoryStore = store instanceof MiniCache;
  const basePath = downloadPath.replace(/\/+$/, "");
  
  return async (args) => {
    log.debug({ args }, "agent ran tool createStyledSpreadsheet");

    if (isMemoryStore) {
      return toolError("TOOL_DISABLED", "This tool is currently not available")
    }
    
    const parse = spreadsheetCreatorParams.safeParse(args);
    if (!parse.success) {
      return toolError("VALIDATION_ERROR", JSON.stringify(parse.error.issues));
    }


    try {
      const fileId = generateHash(
        `spreadsheet:${JSON.stringify(parse.data)}`,
      );
      const redisFileKey = `file:${fileId}`;
      const redis = store;
      const existingRaw = await redis.get(redisFileKey);
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw) as {
            base64Data: string;
            filename: string;
            sizeBytes?: number;
          };
          log.debug({ fileId }, "Spreadsheet Redis cache HIT");
          return {
            success: true,
            message: "Spreadsheet created successfully.",
            filename: existing.filename,
            downloadUrl: `${basePath}/${fileId}`,
            sizeBytes:
              existing.sizeBytes ??
              Buffer.byteLength(existing.base64Data, "base64"),
          };
        } catch {
          log.warn(
            { redisFileKey },
            "Discarding corrupted spreadsheet cache entry.",
          );
        }
      }

      const { data, options } = parse.data;
      const result = await generateSpreadsheet(
        data,
        options as SpreadsheetOptions,
      );

      const filename =
        result.filename ??
        (result.format === "csv" ? "data.csv" : "spreadsheet.xlsx");

      await redis.setex(
        redisFileKey,
        AGENT_GENERATED_FILE_TTL,
        JSON.stringify({
          base64Data: result.base64Data,
          mimeType: result.mimeType,
          filename,
          sizeBytes: result.buffer.length,
        }),
      );

      return {
        success: true,
        message: "Spreadsheet created successfully.",
        filename,
        downloadUrl: `${basePath}/${fileId}`,
        sizeBytes: result.buffer.length,
      };
    } catch (err) {
      log.error({ err }, "Failed to create spreadsheet.");
      return toolError(
        "SPREADSHEET_CREATION_FAILED",
        err instanceof Error ? err.message : "Unable to create spreadsheet.",
      );
    }
  };
}

import { chunkProcess } from "@riavzon/utils";
import { getConfiguration, getDb } from "../config/config";
import { toVec } from "../db/utils";
import { prepareScrape, type PrepareScrapeOptions } from "../rag/prepareScrape";
import { generateHash } from "../utils/hash";

/** What an upload run did. */
export interface Results {
  /** Filenames stored successfully. */
  ingested: string[];
  /** Filenames skipped because an identical document already existed. */
  skippedDuplicates: string[];
  /** Filenames that failed; the reason is in the log. */
  errors: string[];
}

/** One file to ingest: a browser `File`, or raw text/bytes with a name. */
export type UploadSource =
  | File
  | {
      name: string;
      data: string | Uint8Array | Buffer;
    };

/** A form submission, or an explicit list of sources. */
export type UploadSources = FormData | readonly UploadSource[];

async function readSource(
  source: UploadSource,
): Promise<{ filename: string; text: string } | null> {
  if (!("data" in source)) {
    return {
      filename: source.name,
      text: Buffer.from(await source.arrayBuffer()).toString("utf-8"),
    };
  }
  const { name, data } = source;
  if (typeof data === "string") return { filename: name, text: data };

  return { 
    filename: name,
    text: Buffer.from(data).toString("utf-8") 
  };
}

function listSources(files: UploadSources): readonly UploadSource[] {
  if (!(files instanceof FormData)) return files;
  const out: UploadSource[] = [];
  for (const value of files.values()) {
    if (typeof value !== "string") out.push(value);
  }
  return out;
}

/** Tuning for {@link saveUploadedScrappedFile}. */
export interface SaveUploadedScrappedFileOptions<T> {
  /** Payload handed to a `prepare.formatter`. Defaults to `{}`. */
  jsonData?: T;
  /**
   * Chunking and embedding options forwarded to `prepareScrape`.
   */
  prepare?: Omit<PrepareScrapeOptions<T, never>, "chunkMeta">;
  /** Chunks per insert statement. Defaults to 100. */
  batchSize?: number;
  /** Accepted file extensions. Defaults to `.md` and `.txt`. */
  extensions?: readonly string[];
}

/**
 * Ingests markdown/text uploads as documents plus embedded chunks.
 *
 * Accepts a `FormData` upload or prepared sources, so a route can hand over the
 * parsed form while a script or an ingestion job hands over buffers.
 *
 * Duplicates are recognised by content hash, so re-uploading the same text
 * under a different filename is skipped rather than embedded twice. Each file
 * is its own transaction: one failure leaves the others ingested.
 */
/**
 * Read uploaded files, chunk and embed them, and store them as documents.
 *
 * Identical content is detected by hash and skipped, so re-uploading a file is
 * safe.
 *
 * @param files - A form submission or a list of sources.
 * @param userId - Owner to attribute the documents to.
 * @param options - Chunking, batching and accepted extensions.
 * @returns Which files were ingested, skipped, or failed.
 * @example
 * ```ts
 * const { ingested } = await saveUploadedScrappedFile(formData, userId);
 * ```
 */
export async function saveUploadedScrappedFile<T>(
  files: UploadSources,
  userId?: string,
  options: SaveUploadedScrappedFileOptions<T> = {},
): Promise<Results> {
  const log = getConfiguration().logger;
  const results: Results = {
    ingested: [],
    skippedDuplicates: [],
    errors: [],
  };
  const db = getDb();
  const batchSize = options.batchSize ?? 100;
  const extensions = options.extensions ?? [".md", ".txt"];

  for (const source of listSources(files)) {
    const filename = source.name;
    if (!extensions.some((ext) => filename.endsWith(ext))) {
      results.errors.push(`Skipped ${filename}: Unsupported file type`);
      continue;
    }

    try {
      const read = await readSource(source);
      if (!read) continue;
      const data = read.text;
      const documentHash = generateHash(data);

      const existing = await db
        .selectFrom("documents")
        .select("id")
        .where("content_hash", "=", documentHash)
        .limit(1)
        .executeTakeFirst();
      if (existing) {
        log.debug({ filename }, "Duplicate skipped");
        results.skippedDuplicates.push(filename);
        continue;
      }

      const prepare = await prepareScrape<T, never>(
        filename,
        data,
        options.jsonData as T,
        options.prepare,
      );

      await db.transaction().execute(async (tx) => {
        const inserted = await tx
          .insertInto("documents")
          .values({
            title: prepare.title,
            raw_content: prepare.fullContent,
            content_hash: documentHash,
            user_id: userId ?? null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();

        await chunkProcess(prepare.chunks, batchSize, async (chunkBatch) => {
          await tx
            .insertInto("document_chunks")
            .values(
              chunkBatch.map((chunk) => ({
                document_id: inserted.id,
                chunk_index: chunk.chunkIndex,
                chunk_text: chunk.chunkText,
                embedding: toVec(chunk.embedding),
              })),
            )
            .execute();
        });

        results.ingested.push(filename);
      });
    } catch (err) {
      log.error({ err }, `Failed to digest file: ${filename}`);
      results.errors.push(`Failed ${filename}`);
    }
  }

  return results;
}

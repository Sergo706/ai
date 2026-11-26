import { type Kysely, sql, type CreateTableBuilder } from "kysely";
import { Migration, Migrator } from "kysely/migration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createLibMigrator(
  db: Kysely<any>,
  isPg: boolean,
  dimensions: number,
) {
  const dims = dimensions;

  const tsType = isPg ? "timestamptz" : "text";
  const jsonType = isPg ? "jsonb" : "text";
  const vecType = isPg ? sql`vector(${sql.raw(String(dims))})` : "blob";

  const addSerialPk = <TB extends string, TE extends string>(
    qb: CreateTableBuilder<TB, TE>,
  ) =>
    isPg
      ? qb.addColumn("id", "serial", (c) => c.primaryKey())
      : qb.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement());

  const migrations: Record<string, Migration> = {
    "001_init": {
      async up(db) {
        if (isPg) {
          await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
        }

        await db.schema
          .createTable("documents")
          .$call(addSerialPk)
          .addColumn("created_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("user_id", "varchar(500)")
          .addColumn("raw_content", "text", (c) => c.notNull())
          .addColumn("content_hash", "varchar(64)", (c) => c.notNull().unique())
          .addColumn("title", "text", (c) => c.notNull())
          .execute();

        await db.schema
          .createTable("document_chunks")
          .$call(addSerialPk)
          .addColumn("created_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("document_id", "integer", (c) =>
            c.references("documents.id").onDelete("no action"),
          )
          .addColumn("chunk_index", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("chunk_text", "text", (c) => c.notNull())
          .addColumn("embedding", vecType)
          .execute();

        await db.schema
          .createIndex("document_chunks_document_id_chunk_index_idx")
          .on("document_chunks")
          .columns(["document_id", "chunk_index"])
          .execute();

        await db.schema
          .createTable("conversations")
          .$call(addSerialPk)
          .addColumn("user_id", "varchar(500)", (c) => c.notNull())
          .addColumn("title", "varchar(500)")
          .addColumn("compacted_summary", "text")
          .addColumn("compacted_through_message_id", "integer")
          .addColumn("created_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("updated_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .execute();

        await db.schema
          .createTable("messages")
          .$call(addSerialPk)
          .addColumn("conversation_id", "integer", (c) =>
            c.notNull().references("conversations.id"),
          )
          .addColumn("role", "varchar(50)", (c) => c.notNull())
          .addColumn("content", "text", (c) => c.notNull())
          .addColumn("trace", jsonType)
          .addColumn("created_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("embedding", vecType)
          .addColumn("tools_used", jsonType)
          .execute();

        await db.schema
          .createTable("runs")
          .addColumn("id", "varchar(64)", (c) => c.primaryKey())
          .addColumn("kind", "varchar(32)", (c) => c.notNull())
          .addColumn("status", "varchar(32)", (c) =>
            c
              .notNull()
              .defaultTo("running")
              .check(
                sql`status IN ('running', 'finished', 'aborted', 'failed', 'interrupted')`,
              ),
          )
          .addColumn("conversation_id", "integer", (c) =>
            c.references("conversations.id").onDelete("cascade"),
          )
          .addColumn("message_id", "integer")
          .addColumn("query", "text", (c) => c.notNull())
          .addColumn("user_id", "varchar(500)")
          .addColumn("input", jsonType)
          .addColumn("partial", jsonType)
          .addColumn("checkpoint", jsonType)
          .addColumn("stop_reason", "varchar(64)")
          .addColumn("error", "text")
          .addColumn("owner", "varchar(128)")
          .addColumn("claimed_at", tsType)
          .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("started_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("updated_at", tsType, (c) =>
            c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
          )
          .addColumn("finished_at", tsType)
          .execute();

        await db.schema
          .createIndex("runs_conversation_idx")
          .on("runs")
          .columns(["conversation_id", "started_at"])
          .execute();
        await db.schema
          .createIndex("runs_status_idx")
          .on("runs")
          .columns(["status", "started_at"])
          .execute();
        await db.schema
          .createIndex("runs_lease_idx")
          .on("runs")
          .columns(["status", "claimed_at"])
          .execute();

        if (isPg) {
          await sql`
            CREATE INDEX IF NOT EXISTS "embeddingIndexChunk"
            ON document_chunks USING hnsw (embedding vector_cosine_ops)
          `.execute(db);

          await sql`
            CREATE INDEX IF NOT EXISTS "messageEmbeddingIndex"
            ON messages USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
          `.execute(db);
        }
      },

      async down(db) {
        await db.schema.dropTable("runs").ifExists().execute();
        await db.schema.dropTable("messages").ifExists().execute();
        await db.schema.dropTable("conversations").ifExists().execute();
        await db.schema.dropTable("document_chunks").ifExists().execute();
        await db.schema.dropTable("documents").ifExists().execute();
      },
    },
  };

  return new Migrator({
    db,
    migrationTableName: "@riavzon/ai_migrations",
    provider: {
      getMigrations() {
        return Promise.resolve(migrations);
      },
    },
  });
}

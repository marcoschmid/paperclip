import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0136_phase6_memory_tables.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describeEmbeddedPostgres("0136 Phase-6 memory bridge migration", () => {
  it("is replay-safe and removes the legacy agents.executor column", async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-phase6-bridge-");
    cleanups.push(db.cleanup);
    const sql = postgres(db.connectionString, { max: 1 });

    try {
      await sql`
        ALTER TABLE "agents"
        ADD COLUMN "executor" text NOT NULL DEFAULT 'mc-dispatch'
        CHECK ("executor" IN ('hermes', 'mc-dispatch'))
      `;

      const migration = await fs.promises.readFile(
        new URL(`./migrations/${MIGRATION}`, import.meta.url),
        "utf8",
      );
      const hash = createHash("sha256").update(migration).digest("hex");
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${hash}
      `;

      await applyPendingMigrations(db.connectionString);

      const executorColumns = await sql<{ column_name: string }[]>`
        SELECT "column_name"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'agents'
          AND "column_name" = 'executor'
      `;
      expect(executorColumns).toEqual([]);

      const bridgeColumns = await sql<{ table_name: string; column_name: string }[]>`
        SELECT "table_name", "column_name"
        FROM "information_schema"."columns"
        WHERE ("table_name", "column_name") IN (
          ('projects', 'icon'),
          ('documents', 'tags'),
          ('documents', 'metadata')
        )
        ORDER BY "table_name", "column_name"
      `;
      expect(bridgeColumns).toEqual([
        { table_name: "documents", column_name: "metadata" },
        { table_name: "documents", column_name: "tags" },
        { table_name: "projects", column_name: "icon" },
      ]);
    } finally {
      await sql.end();
    }
  }, 30_000);
});


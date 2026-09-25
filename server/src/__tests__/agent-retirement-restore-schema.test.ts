import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { RETIREMENT_RESTORE_FULL_COLUMNS } from "../services/agent-retirement-restore-inventory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The retirement dump parser demands the exact COPY column set for every tracked table,
// so any migration that adds or drops a column must be mirrored in the full-row proof.
describeEmbeddedPostgres("agent retirement restore proof schema", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retirement-restore-schema-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("tracks exactly the columns of every migrated retirement table", async () => {
    const rows = await db.execute(sql.raw(
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
    )) as unknown as Array<{ table_name: string; column_name: string }>;
    const migratedColumns = new Map<string, string[]>();
    for (const row of rows) {
      migratedColumns.set(row.table_name, [...(migratedColumns.get(row.table_name) ?? []), row.column_name]);
    }

    const drift = Object.entries(RETIREMENT_RESTORE_FULL_COLUMNS).flatMap(([table, columns]) => {
      const migrated = new Set(migratedColumns.get(table) ?? []);
      const proof = new Set(columns);
      const proofOnly = columns.filter((column) => !migrated.has(column));
      const migratedOnly = [...migrated].filter((column) => !proof.has(column));
      return proofOnly.length === 0 && migratedOnly.length === 0
        ? []
        : [{ table, proofOnly: proofOnly.sort(), migratedOnly: migratedOnly.sort() }];
    });

    expect(drift).toEqual([]);
  });
});

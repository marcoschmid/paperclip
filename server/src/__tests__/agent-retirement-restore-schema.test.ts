import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { RETIREMENT_RESTORE_COLUMN_SPECS } from "../services/agent-retirement-restore-inventory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Postgres data types each proof column type normalizes; `projects.target_date` is a date kept as text.
const PG_TYPES_BY_PROOF_TYPE: Record<string, readonly string[]> = {
  uuid: ["uuid"],
  integer: ["integer"],
  bigint: ["bigint"],
  boolean: ["boolean"],
  timestamp: ["timestamp with time zone"],
  json: ["jsonb"],
  text: ["text", "date"],
};

type MigratedColumn = { table_name: string; column_name: string; data_type: string; is_nullable: string };

// The retirement dump parser demands the exact COPY column set for every tracked table, and the
// full-row proof rejects nulls and values its declared type cannot normalize, so any migration that
// adds, drops, retypes or relaxes a column must be mirrored in the proof schema.
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

  it("tracks exactly the columns, types and nullability of every migrated retirement table", async () => {
    const rows = await db.execute(sql.raw(
      "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public'",
    )) as unknown as MigratedColumn[];
    const migratedByTable = new Map<string, Map<string, MigratedColumn>>();
    for (const row of rows) {
      const columns = migratedByTable.get(row.table_name) ?? new Map<string, MigratedColumn>();
      columns.set(row.column_name, row);
      migratedByTable.set(row.table_name, columns);
    }

    const drift = Object.entries(RETIREMENT_RESTORE_COLUMN_SPECS).flatMap(([table, specs]) => {
      const migrated = migratedByTable.get(table) ?? new Map<string, MigratedColumn>();
      const proofNames = new Set(specs.map((spec) => spec.name));
      const proofOnly = specs.filter((spec) => !migrated.has(spec.name)).map((spec) => spec.name);
      const migratedOnly = [...migrated.keys()].filter((name) => !proofNames.has(name));
      const mismatched = specs.flatMap((spec) => {
        const column = migrated.get(spec.name);
        if (!column) return [];
        const typeMatches = PG_TYPES_BY_PROOF_TYPE[spec.type]?.includes(column.data_type) ?? false;
        const nullableMatches = spec.nullable === (column.is_nullable === "YES");
        return typeMatches && nullableMatches
          ? []
          : [`${spec.name}: proof ${spec.type}${spec.nullable ? "?" : ""}, migrated ${column.data_type}${column.is_nullable === "YES" ? "?" : ""}`];
      });
      return proofOnly.length === 0 && migratedOnly.length === 0 && mismatched.length === 0
        ? []
        : [{ table, proofOnly: proofOnly.sort(), migratedOnly: migratedOnly.sort(), mismatched }];
    });

    expect(drift).toEqual([]);
  });
});

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0146_historical_agent_tombstone_access_cleanup.sql";
const TOMBSTONES = [
  {
    agentId: "8d403783-c4e2-4746-adad-7689cd95ae33",
    companyId: "0a7df9a5-299e-4d64-a4d4-0c4c63784425",
  },
  {
    agentId: "dcd3cadb-8203-4048-be1e-77701a3a43a0",
    companyId: "0d49d45f-63d7-4dd3-9b1e-90992eb45226",
  },
] as const;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function migrationHash(): Promise<string> {
  const migration = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(migration).digest("hex");
}

describeEmbeddedPostgres("0146 historical agent tombstone access cleanup", () => {
  it("is a no-op when the fixed tombstones are absent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-tombstone-access-empty-");
    cleanups.push(database.cleanup);
    const hash = await migrationHash();
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(sql<{ count: string }[]>`
        SELECT count(*)::text AS "count"
        FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${hash}
      `).resolves.toEqual([{ count: "1" }]);
    } finally {
      await sql.end();
    }
  });

  it("fails closed for a present tombstone with wrong lifecycle identity", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-tombstone-access-invalid-");
    cleanups.push(database.cleanup);
    const hash = await migrationHash();
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const otherCompanyId = randomUUID();
    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES
          (${TOMBSTONES[0].companyId}, 'Historical company one', 'HT1'),
          (${otherCompanyId}, 'Unrelated company', 'HTX')
      `;
      await sql`
        INSERT INTO "agents" (
          "id", "company_id", "name", "role", "status", "adapter_type", "adapter_config"
        ) VALUES (
          ${TOMBSTONES[0].agentId}, ${TOMBSTONES[0].companyId},
          'Mission Control Builder', 'builder', 'idle', 'process', '{}'::jsonb
        )
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status"
        ) VALUES (
          ${TOMBSTONES[0].companyId}, 'agent', ${TOMBSTONES[0].agentId}, 'active'
        )
      `;
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;
    } finally {
      await sql.end();
    }

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      /historical tombstone identity requires terminated status and expected company/i,
    );

    const afterStatusFailure = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(afterStatusFailure<{ count: string }[]>`
        SELECT count(*)::text AS "count" FROM "company_memberships"
        WHERE "principal_id" = ${TOMBSTONES[0].agentId} AND "status" = 'active'
      `).resolves.toEqual([{ count: "1" }]);
      await expect(afterStatusFailure<{ count: string }[]>`
        SELECT count(*)::text AS "count" FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${hash}
      `).resolves.toEqual([{ count: "0" }]);
      await afterStatusFailure`
        UPDATE "agents"
        SET "status" = 'terminated', "company_id" = ${otherCompanyId}
        WHERE "id" = ${TOMBSTONES[0].agentId}
      `;
    } finally {
      await afterStatusFailure.end();
    }

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      /historical tombstone identity requires terminated status and expected company/i,
    );

    const afterCompanyFailure = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(afterCompanyFailure<{ count: string }[]>`
        SELECT count(*)::text AS "count" FROM "company_memberships"
        WHERE "principal_id" = ${TOMBSTONES[0].agentId} AND "status" = 'active'
      `).resolves.toEqual([{ count: "1" }]);
      await expect(afterCompanyFailure<{ count: string }[]>`
        SELECT count(*)::text AS "count" FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${hash}
      `).resolves.toEqual([{ count: "0" }]);
    } finally {
      await afterCompanyFailure.end();
    }
  });

  it("cleans only live access, preserves history, and replays idempotently", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-tombstone-access-cleanup-");
    cleanups.push(database.cleanup);
    const hash = await migrationHash();
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const historicalIssueId = randomUUID();
    const historicalRunId = randomUUID();
    const secretIds = TOMBSTONES.map(() => randomUUID());
    const definitionIds = TOMBSTONES.map(() => randomUUID());
    const skillIds = TOMBSTONES.map(() => randomUUID());
    const otherSecretId = randomUUID();
    const otherDefinitionId = randomUUID();
    const otherSkillId = randomUUID();

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES
          (${TOMBSTONES[0].companyId}, 'Historical company one', 'HT1'),
          (${TOMBSTONES[1].companyId}, 'Historical company two', 'HT2'),
          (${otherCompanyId}, 'Unrelated company', 'HTX')
      `;
      await sql`
        INSERT INTO "agents" (
          "id", "company_id", "name", "role", "status", "adapter_type", "adapter_config"
        ) VALUES
          (${TOMBSTONES[0].agentId}, ${TOMBSTONES[0].companyId}, 'Mission Control Builder', 'builder', 'terminated', 'process', '{}'::jsonb),
          (${TOMBSTONES[1].agentId}, ${TOMBSTONES[1].companyId}, 'OpenClaw Gateway', 'gateway', 'terminated', 'process', '{}'::jsonb),
          (${otherAgentId}, ${otherCompanyId}, 'Unrelated terminated agent', 'other', 'terminated', 'process', '{}'::jsonb)
      `;

      for (const [index, tombstone] of TOMBSTONES.entries()) {
        await sql`
          INSERT INTO "agent_api_keys" (
            "agent_id", "company_id", "name", "key_hash", "revoked_at"
          ) VALUES
            (${tombstone.agentId}, ${tombstone.companyId}, ${`active-${index}`}, ${`active-hash-${index}`}, NULL),
            (${tombstone.agentId}, ${tombstone.companyId}, ${`revoked-${index}`}, ${`revoked-hash-${index}`}, '2026-01-01T00:00:00Z')
        `;
        await sql`
          INSERT INTO "principal_permission_grants" (
            "company_id", "principal_type", "principal_id", "permission_key"
          ) VALUES (${tombstone.companyId}, 'agent', ${tombstone.agentId}, 'tasks:assign')
        `;
        await sql`
          INSERT INTO "company_memberships" (
            "company_id", "principal_type", "principal_id", "status"
          ) VALUES (${tombstone.companyId}, 'agent', ${tombstone.agentId}, 'active')
        `;
        await sql`
          INSERT INTO "agent_memberships" (
            "company_id", "agent_id", "user_id", "state", "starred_at"
          ) VALUES
            (${tombstone.companyId}, ${tombstone.agentId}, ${`joined-${index}`}, 'joined', now()),
            (${tombstone.companyId}, ${tombstone.agentId}, ${`left-${index}`}, 'left', NULL)
        `;
        await sql`
          INSERT INTO "company_secrets" (
            "id", "company_id", "scope", "key", "name"
          ) VALUES (${secretIds[index]}, ${tombstone.companyId}, 'company', ${`secret-${index}`}, ${`Secret ${index}`})
        `;
        await sql`
          INSERT INTO "company_secret_bindings" (
            "company_id", "secret_id", "target_type", "target_id", "config_path"
          ) VALUES (${tombstone.companyId}, ${secretIds[index]}, 'agent', ${tombstone.agentId}, 'env.TEST_TOKEN')
        `;
        await sql`
          INSERT INTO "user_secret_definitions" (
            "id", "company_id", "key", "name"
          ) VALUES (${definitionIds[index]}, ${tombstone.companyId}, ${`user-secret-${index}`}, ${`User secret ${index}`})
        `;
        await sql`
          INSERT INTO "user_secret_declarations" (
            "company_id", "user_secret_definition_id", "target_type", "target_id", "config_path", "env_key"
          ) VALUES (
            ${tombstone.companyId}, ${definitionIds[index]}, 'agent', ${tombstone.agentId},
            'env.USER_TEST_TOKEN', 'USER_TEST_TOKEN'
          )
        `;
        await sql`
          INSERT INTO "company_skills" (
            "id", "company_id", "key", "slug", "name", "markdown"
          ) VALUES (${skillIds[index]}, ${tombstone.companyId}, ${`skill-${index}`}, ${`skill-${index}`}, ${`Skill ${index}`}, '# skill')
        `;
        await sql`
          INSERT INTO "company_skill_stars" ("company_id", "company_skill_id", "agent_id")
          VALUES (${tombstone.companyId}, ${skillIds[index]}, ${tombstone.agentId})
        `;
      }

      await sql`
        INSERT INTO "agent_api_keys" ("agent_id", "company_id", "name", "key_hash")
        VALUES (${otherAgentId}, ${otherCompanyId}, 'other-key', 'other-key-hash')
      `;
      await sql`
        INSERT INTO "principal_permission_grants" (
          "company_id", "principal_type", "principal_id", "permission_key"
        ) VALUES (${otherCompanyId}, 'agent', ${otherAgentId}, 'tasks:assign')
      `;
      await sql`
        INSERT INTO "company_memberships" (
          "company_id", "principal_type", "principal_id", "status"
        ) VALUES (${otherCompanyId}, 'agent', ${otherAgentId}, 'active')
      `;
      await sql`
        INSERT INTO "agent_memberships" ("company_id", "agent_id", "user_id", "state")
        VALUES (${otherCompanyId}, ${otherAgentId}, 'other-user', 'joined')
      `;
      await sql`
        INSERT INTO "company_secrets" ("id", "company_id", "scope", "key", "name")
        VALUES (${otherSecretId}, ${otherCompanyId}, 'company', 'other-secret', 'Other secret')
      `;
      await sql`
        INSERT INTO "company_secret_bindings" (
          "company_id", "secret_id", "target_type", "target_id", "config_path"
        ) VALUES (${otherCompanyId}, ${otherSecretId}, 'agent', ${otherAgentId}, 'env.OTHER_TOKEN')
      `;
      await sql`
        INSERT INTO "user_secret_definitions" ("id", "company_id", "key", "name")
        VALUES (${otherDefinitionId}, ${otherCompanyId}, 'other-user-secret', 'Other user secret')
      `;
      await sql`
        INSERT INTO "user_secret_declarations" (
          "company_id", "user_secret_definition_id", "target_type", "target_id", "config_path", "env_key"
        ) VALUES (
          ${otherCompanyId}, ${otherDefinitionId}, 'agent', ${otherAgentId},
          'env.OTHER_USER_TOKEN', 'OTHER_USER_TOKEN'
        )
      `;
      await sql`
        INSERT INTO "company_skills" ("id", "company_id", "key", "slug", "name", "markdown")
        VALUES (${otherSkillId}, ${otherCompanyId}, 'other-skill', 'other-skill', 'Other skill', '# other')
      `;
      await sql`
        INSERT INTO "company_skill_stars" ("company_id", "company_skill_id", "agent_id")
        VALUES (${otherCompanyId}, ${otherSkillId}, ${otherAgentId})
      `;

      await sql`
        INSERT INTO "issues" (
          "id", "company_id", "title", "status", "assignee_agent_id", "completed_at"
        ) VALUES (
          ${historicalIssueId}, ${TOMBSTONES[0].companyId}, 'Historical completed issue',
          'done', ${TOMBSTONES[0].agentId}, '2026-01-02T00:00:00Z'
        )
      `;
      await sql`
        INSERT INTO "heartbeat_runs" (
          "id", "company_id", "agent_id", "status", "started_at", "finished_at", "result_json"
        ) VALUES (
          ${historicalRunId}, ${TOMBSTONES[0].companyId}, ${TOMBSTONES[0].agentId},
          'succeeded', '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z', '{"ok":true}'::jsonb
        )
      `;

      const historyBefore = await sql<{ snapshot: string }[]>`
        SELECT jsonb_build_object(
          'agents', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a."id") FROM "agents" a
            WHERE a."id" IN (${TOMBSTONES[0].agentId}, ${TOMBSTONES[1].agentId})),
          'issue', (SELECT to_jsonb(i) FROM "issues" i WHERE i."id" = ${historicalIssueId}),
          'run', (SELECT to_jsonb(r) FROM "heartbeat_runs" r WHERE r."id" = ${historicalRunId})
        )::text AS "snapshot"
      `;

      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;
      await sql.end();
      await applyPendingMigrations(database.connectionString);

      const verify = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        await expect(verify<{ count: string }[]>`
          SELECT count(*)::text AS "count" FROM "agent_api_keys"
          WHERE "agent_id" IN (${TOMBSTONES[0].agentId}, ${TOMBSTONES[1].agentId})
            AND "revoked_at" IS NULL
        `).resolves.toEqual([{ count: "0" }]);
        for (const [table, predicate] of [
          ["principal_permission_grants", `"principal_type" = 'agent' AND "principal_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
          ["company_memberships", `"principal_type" = 'agent' AND "status" = 'active' AND "principal_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
          ["agent_memberships", `"state" <> 'left' AND "agent_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
          ["company_secret_bindings", `"target_type" = 'agent' AND "target_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
          ["user_secret_declarations", `"target_type" = 'agent' AND "target_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
          ["company_skill_stars", `"agent_id" IN ('${TOMBSTONES[0].agentId}', '${TOMBSTONES[1].agentId}')`],
        ] as const) {
          const rows = await verify.unsafe<{ count: string }[]>(
            `SELECT count(*)::text AS count FROM "${table}" WHERE ${predicate}`,
          );
          expect(rows, table).toEqual([{ count: "0" }]);
        }
        await expect(verify<{ count: string }[]>`
          SELECT count(*)::text AS "count" FROM "agent_api_keys"
          WHERE "agent_id" IN (${TOMBSTONES[0].agentId}, ${TOMBSTONES[1].agentId})
        `).resolves.toEqual([{ count: "4" }]);
        await expect(verify<{ count: string }[]>`
          SELECT count(*)::text AS "count" FROM "agent_memberships"
          WHERE "agent_id" IN (${TOMBSTONES[0].agentId}, ${TOMBSTONES[1].agentId})
        `).resolves.toEqual([{ count: "2" }]);

        const unrelatedAccess = await verify<{ count: string }[]>`
          SELECT (
            (SELECT count(*) FROM "agent_api_keys" WHERE "agent_id" = ${otherAgentId} AND "revoked_at" IS NULL)
            + (SELECT count(*) FROM "principal_permission_grants" WHERE "principal_id" = ${otherAgentId})
            + (SELECT count(*) FROM "company_memberships" WHERE "principal_id" = ${otherAgentId} AND "status" = 'active')
            + (SELECT count(*) FROM "agent_memberships" WHERE "agent_id" = ${otherAgentId} AND "state" <> 'left')
            + (SELECT count(*) FROM "company_secret_bindings" WHERE "target_id" = ${otherAgentId})
            + (SELECT count(*) FROM "user_secret_declarations" WHERE "target_id" = ${otherAgentId})
            + (SELECT count(*) FROM "company_skill_stars" WHERE "agent_id" = ${otherAgentId})
          )::text AS "count"
        `;
        expect(unrelatedAccess).toEqual([{ count: "7" }]);

        await expect(verify<{ snapshot: string }[]>`
          SELECT jsonb_build_object(
            'agents', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a."id") FROM "agents" a
              WHERE a."id" IN (${TOMBSTONES[0].agentId}, ${TOMBSTONES[1].agentId})),
            'issue', (SELECT to_jsonb(i) FROM "issues" i WHERE i."id" = ${historicalIssueId}),
            'run', (SELECT to_jsonb(r) FROM "heartbeat_runs" r WHERE r."id" = ${historicalRunId})
          )::text AS "snapshot"
        `).resolves.toEqual(historyBefore);

        const firstPoststate = await verify<{ snapshot: string }[]>`
          SELECT jsonb_build_object(
            'keys', (SELECT jsonb_agg(to_jsonb(k) ORDER BY k."id") FROM "agent_api_keys" k),
            'grants', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g."id") FROM "principal_permission_grants" g),
            'memberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "company_memberships" m),
            'agentMemberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "agent_memberships" m),
            'bindings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b."id") FROM "company_secret_bindings" b),
            'declarations', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d."id") FROM "user_secret_declarations" d),
            'stars', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s."id") FROM "company_skill_stars" s)
          )::text AS "snapshot"
        `;
        await verify`
          DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
        `;
        await verify.end();
        await applyPendingMigrations(database.connectionString);

        const replay = postgres(database.connectionString, { max: 1, onnotice: () => {} });
        try {
          await expect(replay<{ snapshot: string }[]>`
            SELECT jsonb_build_object(
              'keys', (SELECT jsonb_agg(to_jsonb(k) ORDER BY k."id") FROM "agent_api_keys" k),
              'grants', (SELECT jsonb_agg(to_jsonb(g) ORDER BY g."id") FROM "principal_permission_grants" g),
              'memberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "company_memberships" m),
              'agentMemberships', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m."id") FROM "agent_memberships" m),
              'bindings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b."id") FROM "company_secret_bindings" b),
              'declarations', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d."id") FROM "user_secret_declarations" d),
              'stars', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s."id") FROM "company_skill_stars" s)
            )::text AS "snapshot"
          `).resolves.toEqual(firstPoststate);
        } finally {
          await replay.end();
        }
      } finally {
        await verify.end().catch(() => {});
      }
    } finally {
      await sql.end().catch(() => {});
    }
  });
});

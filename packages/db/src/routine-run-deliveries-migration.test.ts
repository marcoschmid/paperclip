import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0145_routine_run_deliveries.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describeEmbeddedPostgres("0145 durable routine delivery migration", () => {
  it("terminalizes legacy received runs and proves success only from exact mutually-bound wake evidence", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-delivery-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const migration = await fs.promises.readFile(new URL(`./migrations/${MIGRATION}`, import.meta.url), "utf8");
    const migrationHash = createHash("sha256").update(migration).digest("hex");

    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const exact = { runId: randomUUID(), issueId: randomUUID() };
    const absent = { runId: randomUUID(), issueId: randomUUID() };
    const ambiguous = { runId: randomUUID(), issueId: randomUUID() };
    const absentFollowerRunId = randomUUID();
    const absentDeliveredOwnerRunId = randomUUID();
    const absentPendingWakeupRequestId = randomUUID();
    const absentLiveHeartbeatRunId = randomUUID();

    try {
      await sql`
        DROP TRIGGER IF EXISTS "agent_wakeup_requests_routine_delivery_evidence_update_guard"
        ON "agent_wakeup_requests"
      `;
      await sql`
        DROP TRIGGER IF EXISTS "agent_wakeup_requests_routine_delivery_evidence_delete_guard"
        ON "agent_wakeup_requests"
      `;
      await sql`
        DROP TRIGGER IF EXISTS "heartbeat_runs_routine_delivery_evidence_update_guard"
        ON "heartbeat_runs"
      `;
      await sql`
        DROP TRIGGER IF EXISTS "heartbeat_runs_routine_delivery_evidence_delete_guard"
        ON "heartbeat_runs"
      `;
      await sql`DROP FUNCTION IF EXISTS "protect_delivered_routine_wakeup_evidence"()`;
      await sql`DROP FUNCTION IF EXISTS "protect_delivered_routine_heartbeat_evidence"()`;
      await sql`DROP TABLE "routine_run_deliveries" CASCADE`;
      await sql`DROP FUNCTION IF EXISTS "enforce_routine_run_delivery_identity"()`;
      await sql`DROP INDEX IF EXISTS "agent_wakeup_requests_routine_delivery_idempotency_unique"`;
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${migrationHash}
      `;

      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Routine migration company', 'RDM')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config")
        VALUES (${agentId}, ${companyId}, 'Routine migration agent', 'engineer', 'active', 'process', '{}'::jsonb)
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "assignee_agent_id")
        VALUES (${routineId}, ${companyId}, 'Legacy routine', ${agentId})
      `;

      for (const [label, candidate] of Object.entries({ exact, absent, ambiguous })) {
        await sql`
          INSERT INTO "routine_runs" ("id", "company_id", "routine_id", "source", "status")
          VALUES (${candidate.runId}, ${companyId}, ${routineId}, 'manual', 'received')
        `;
        await sql`
          INSERT INTO "issues" (
            "id", "company_id", "title", "status", "assignee_agent_id",
            "origin_kind", "origin_id", "origin_run_id", "identifier"
          ) VALUES (
            ${candidate.issueId}, ${companyId}, ${`Legacy ${label}`}, 'todo', ${agentId},
            'routine_execution', ${routineId}, ${candidate.runId}, ${`RDM-${label}`}
          )
        `;
        await sql`
          UPDATE "routine_runs" SET "linked_issue_id" = ${candidate.issueId}
          WHERE "id" = ${candidate.runId}
        `;
      }

      // The no-evidence leader shares its issue with a coalesced follower, a
      // previously delivered owner, and a different queued/live wake chain.
      // None of those references is proof that the issue may be deleted.
      await sql`
        INSERT INTO "routine_runs" (
          "id", "company_id", "routine_id", "source", "status",
          "linked_issue_id", "coalesced_into_run_id"
        ) VALUES (
          ${absentFollowerRunId}, ${companyId}, ${routineId}, 'manual', 'coalesced',
          ${absent.issueId}, ${absent.runId}
        )
      `;
      await sql`
        INSERT INTO "routine_runs" (
          "id", "company_id", "routine_id", "source", "status", "linked_issue_id"
        ) VALUES (
          ${absentDeliveredOwnerRunId}, ${companyId}, ${routineId}, 'manual', 'issue_created',
          ${absent.issueId}
        )
      `;
      await sql`
        INSERT INTO "agent_wakeup_requests" (
          "id", "company_id", "agent_id", "source", "trigger_detail", "reason",
          "payload", "status", "run_id"
        ) VALUES (
          ${absentPendingWakeupRequestId}, ${companyId}, ${agentId}, 'on_demand', 'manual',
          'other_live_owner', ${sql.json({ issueId: absent.issueId })}, 'queued', ${absentLiveHeartbeatRunId}
        )
      `;
      await sql`
        INSERT INTO "heartbeat_runs" (
          "id", "company_id", "agent_id", "invocation_source", "trigger_detail",
          "status", "wakeup_request_id", "context_snapshot"
        ) VALUES (
          ${absentLiveHeartbeatRunId}, ${companyId}, ${agentId}, 'on_demand', 'manual',
          'queued', ${absentPendingWakeupRequestId}, ${sql.json({ issueId: absent.issueId })}
        )
      `;
      await sql`
        UPDATE "issues" SET "execution_run_id" = ${absentLiveHeartbeatRunId}
        WHERE "id" = ${absent.issueId}
      `;

      const insertEvidence = async (candidate: { runId: string; issueId: string }) => {
        const wakeupRequestId = randomUUID();
        const heartbeatRunId = randomUUID();
        await sql`
          INSERT INTO "agent_wakeup_requests" (
            "id", "company_id", "agent_id", "source", "trigger_detail", "reason",
            "payload", "status", "run_id"
          ) VALUES (
            ${wakeupRequestId}, ${companyId}, ${agentId}, 'assignment', 'system', 'issue_assigned',
            ${sql.json({ issueId: candidate.issueId, mutation: "create" })}, 'queued', ${heartbeatRunId}
          )
        `;
        await sql`
          INSERT INTO "heartbeat_runs" (
            "id", "company_id", "agent_id", "invocation_source", "trigger_detail",
            "status", "wakeup_request_id", "context_snapshot"
          ) VALUES (
            ${heartbeatRunId}, ${companyId}, ${agentId}, 'assignment', 'system',
            'queued', ${wakeupRequestId}, ${sql.json({ issueId: candidate.issueId })}
          )
        `;
        return { wakeupRequestId, heartbeatRunId };
      };

      const exactEvidence = await insertEvidence(exact);
      await insertEvidence(ambiguous);
      await insertEvidence(ambiguous);

      await sql.end();
      await applyPendingMigrations(database.connectionString);

      const verify = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        const deliveries = await verify<{
          routine_run_id: string;
          issue_id: string | null;
          status: string;
          last_error: string | null;
          delivered_wakeup_request_id: string | null;
          delivered_heartbeat_run_id: string | null;
        }[]>`
          SELECT "routine_run_id", "issue_id", "status", "last_error",
            "delivered_wakeup_request_id", "delivered_heartbeat_run_id"
          FROM "routine_run_deliveries"
          WHERE "routine_run_id" IN (${exact.runId}, ${absent.runId}, ${ambiguous.runId})
        `;
        expect(deliveries).toHaveLength(3);
        expect(deliveries).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ status: "pending" }),
          expect.objectContaining({ status: "claimed" }),
        ]));
        expect(deliveries).toEqual(expect.arrayContaining([
          expect.objectContaining({
            routine_run_id: exact.runId,
            issue_id: exact.issueId,
            status: "delivered",
            last_error: null,
            delivered_wakeup_request_id: exactEvidence.wakeupRequestId,
            delivered_heartbeat_run_id: exactEvidence.heartbeatRunId,
          }),
          expect.objectContaining({
            routine_run_id: absent.runId,
            issue_id: absent.issueId,
            status: "failed",
            last_error: "legacy_received_no_wake_evidence",
          }),
          expect.objectContaining({
            routine_run_id: ambiguous.runId,
            issue_id: ambiguous.issueId,
            status: "failed",
            last_error: "legacy_received_ambiguous_wake_evidence",
          }),
        ]));

        const runs = await verify<{ id: string; status: string; linked_issue_id: string | null }[]>`
          SELECT "id", "status", "linked_issue_id" FROM "routine_runs"
          WHERE "id" IN (${exact.runId}, ${absent.runId}, ${ambiguous.runId})
        `;
        expect(runs).toEqual(expect.arrayContaining([
          { id: exact.runId, status: "issue_created", linked_issue_id: exact.issueId },
          { id: absent.runId, status: "failed", linked_issue_id: absent.issueId },
          { id: ambiguous.runId, status: "failed", linked_issue_id: ambiguous.issueId },
        ]));
        await expect(verify<{ id: string; execution_run_id: string | null }[]>`
          SELECT "id", "execution_run_id" FROM "issues" WHERE "id" = ${absent.issueId}
        `).resolves.toEqual([{ id: absent.issueId, execution_run_id: absentLiveHeartbeatRunId }]);
        await expect(verify<{
          id: string;
          status: string;
          linked_issue_id: string | null;
          coalesced_into_run_id: string | null;
        }[]>`
          SELECT "id", "status", "linked_issue_id", "coalesced_into_run_id"
          FROM "routine_runs"
          WHERE "id" IN (${absentFollowerRunId}, ${absentDeliveredOwnerRunId})
          ORDER BY "id"
        `).resolves.toEqual(expect.arrayContaining([
          {
            id: absentFollowerRunId,
            status: "coalesced",
            linked_issue_id: absent.issueId,
            coalesced_into_run_id: absent.runId,
          },
          {
            id: absentDeliveredOwnerRunId,
            status: "issue_created",
            linked_issue_id: absent.issueId,
            coalesced_into_run_id: null,
          },
        ]));
        await expect(verify<{
          id: string;
          status: string;
          run_id: string | null;
          issue_id: string | null;
        }[]>`
          SELECT wakeup."id", wakeup."status", wakeup."run_id",
            heartbeat."context_snapshot" ->> 'issueId' AS "issue_id"
          FROM "agent_wakeup_requests" wakeup
          JOIN "heartbeat_runs" heartbeat ON heartbeat."id" = wakeup."run_id"
          WHERE wakeup."id" = ${absentPendingWakeupRequestId}
        `).resolves.toEqual([{
          id: absentPendingWakeupRequestId,
          status: "queued",
          run_id: absentLiveHeartbeatRunId,
          issue_id: absent.issueId,
        }]);
        await expect(verify<{ idempotency_key: string | null }[]>`
          SELECT "idempotency_key" FROM "agent_wakeup_requests"
          WHERE "id" = ${exactEvidence.wakeupRequestId}
        `).resolves.toEqual([{ idempotency_key: `routine-delivery:${exact.runId}` }]);
      } finally {
        await verify.end();
      }
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 60_000);

  it("prevents reverse drift of delivered evidence while allowing terminal state updates", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-delivery-proof-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 2, onnotice: () => {} });
    const driftSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const observerSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const routineRunId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const heartbeatRunId = randomUUID();
    const deliveryId = randomUUID();
    const wakeupIdempotencyKey = `routine-delivery:${routineRunId}`;
    let releaseDeliveryCommit = () => {};

    const rejected = async (operation: Promise<unknown>, expected: RegExp) => {
      const error = await operation.then(() => null, (caught: unknown) => caught);
      expect(error).toBeTruthy();
      expect(String((error as { cause?: unknown }).cause ?? error)).toMatch(expected);
    };

    try {
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Proof company', 'RDP')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config")
        VALUES (${agentId}, ${companyId}, 'Proof agent', 'engineer', 'active', 'process', '{}'::jsonb)
      `;
      await sql`
        INSERT INTO "routines" ("id", "company_id", "title", "assignee_agent_id")
        VALUES (${routineId}, ${companyId}, 'Proof routine', ${agentId})
      `;
      await sql`
        INSERT INTO "routine_runs" ("id", "company_id", "routine_id", "source", "status")
        VALUES (${routineRunId}, ${companyId}, ${routineId}, 'manual', 'issue_created')
      `;
      await sql`
        INSERT INTO "issues" (
          "id", "company_id", "title", "status", "assignee_agent_id",
          "origin_kind", "origin_id", "origin_run_id", "identifier"
        ) VALUES (
          ${issueId}, ${companyId}, 'Proof issue', 'todo', ${agentId},
          'routine_execution', ${routineId}, ${routineRunId}, 'RDP-1'
        )
      `;
      await sql`UPDATE "routine_runs" SET "linked_issue_id" = ${issueId} WHERE "id" = ${routineRunId}`;
      await sql`
        INSERT INTO "agent_wakeup_requests" (
          "id", "company_id", "agent_id", "source", "trigger_detail", "reason",
          "payload", "status", "idempotency_key", "run_id"
        ) VALUES (
          ${wakeupRequestId}, ${companyId}, ${agentId}, 'assignment', 'system', 'issue_assigned',
          ${sql.json({ issueId, mutation: "create" })}, 'queued', ${wakeupIdempotencyKey}, ${heartbeatRunId}
        )
      `;
      await sql`
        INSERT INTO "heartbeat_runs" (
          "id", "company_id", "agent_id", "invocation_source", "trigger_detail",
          "status", "wakeup_request_id", "context_snapshot"
        ) VALUES (
          ${heartbeatRunId}, ${companyId}, ${agentId}, 'assignment', 'system',
          'queued', ${wakeupRequestId}, ${sql.json({ issueId })}
        )
      `;
      let reportDeliveryInserted = () => {};
      const deliveryInserted = new Promise<void>((resolve) => { reportDeliveryInserted = resolve; });
      const holdDeliveryCommit = new Promise<void>((resolve) => { releaseDeliveryCommit = resolve; });
      const deliveryCommit = sql.begin(async (tx) => {
        await tx`
          INSERT INTO "routine_run_deliveries" (
            "id", "company_id", "routine_run_id", "issue_id", "assignee_agent_id",
            "status", "wakeup_idempotency_key", "delivered_wakeup_request_id",
            "delivered_heartbeat_run_id", "delivered_at"
          ) VALUES (
            ${deliveryId}, ${companyId}, ${routineRunId}, ${issueId}, ${agentId},
            'delivered', ${wakeupIdempotencyKey}, ${wakeupRequestId}, ${heartbeatRunId}, now()
          )
        `;
        reportDeliveryInserted();
        await holdDeliveryCommit;
      });
      await deliveryInserted;

      const concurrentDrift = driftSql`
        UPDATE "agent_wakeup_requests"
        SET "payload" = ${driftSql.json({ issueId: randomUUID() })}
        WHERE "id" = ${wakeupRequestId}
      `.then(() => null, (caught: unknown) => caught);
      let observedBlockedEvidenceUpdate = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await observerSql<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE "datname" = current_database()
              AND "pid" <> pg_backend_pid()
              AND "wait_event_type" = 'Lock'
              AND "query" ILIKE '%UPDATE "agent_wakeup_requests"%'
          ) AS "blocked"
        `;
        if (row?.blocked) {
          observedBlockedEvidenceUpdate = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlockedEvidenceUpdate).toBe(true);
      releaseDeliveryCommit();
      await deliveryCommit;
      const concurrentDriftError = await concurrentDrift;
      expect(concurrentDriftError).toBeTruthy();
      expect(String(
        (concurrentDriftError as { cause?: unknown }).cause ?? concurrentDriftError,
      )).toMatch(/routine_delivery_wakeup_evidence_is_immutable/i);

      await rejected(
        sql`UPDATE "heartbeat_runs" SET "context_snapshot" = ${sql.json({ issueId: randomUUID() })}
            WHERE "id" = ${heartbeatRunId}`,
        /routine_delivery_heartbeat_evidence_is_immutable/i,
      );
      await rejected(
        sql`DELETE FROM "agent_wakeup_requests" WHERE "id" = ${wakeupRequestId}`,
        /routine_delivery_wakeup_evidence_is_immutable/i,
      );
      await rejected(
        sql`DELETE FROM "heartbeat_runs" WHERE "id" = ${heartbeatRunId}`,
        /routine_delivery_heartbeat_evidence_is_immutable/i,
      );

      await sql`
        UPDATE "agent_wakeup_requests"
        SET "status" = 'finished', "finished_at" = now()
        WHERE "id" = ${wakeupRequestId}
      `;
      await sql`
        UPDATE "heartbeat_runs"
        SET "status" = 'succeeded', "finished_at" = now(), "result_json" = '{"ok":true}'::jsonb
        WHERE "id" = ${heartbeatRunId}
      `;
      await expect(sql<{ wake_status: string; heartbeat_status: string }[]>`
        SELECT wakeup."status" AS "wake_status", heartbeat."status" AS "heartbeat_status"
        FROM "routine_run_deliveries" delivery
        JOIN "agent_wakeup_requests" wakeup ON wakeup."id" = delivery."delivered_wakeup_request_id"
        JOIN "heartbeat_runs" heartbeat ON heartbeat."id" = delivery."delivered_heartbeat_run_id"
        WHERE delivery."id" = ${deliveryId}
      `).resolves.toEqual([{ wake_status: "finished", heartbeat_status: "succeeded" }]);
    } finally {
      releaseDeliveryCommit();
      await Promise.all([
        sql.end(),
        driftSql.end(),
        observerSql.end(),
      ]);
    }
  }, 40_000);
});

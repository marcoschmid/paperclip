import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { upsertHeartbeatTaskSession } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat task-session lifecycle serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-task-session-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `S${id.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string, status = "idle") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Session agent ${id.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedTerminalRun(companyId: string, agentId: string) {
    return db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      finishedAt: new Date(),
      contextSnapshot: { taskKey: "lifecycle-race" },
    }).returning().then((rows) => rows[0]!);
  }

  it("serializes a terminal-run session update against concurrent agent termination", async () => {
    const companyId = await seedCompany("Task session race");
    const agentId = await seedAgent(companyId);
    const run = await seedTerminalRun(companyId, agentId);
    const [before] = await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "lifecycle-race",
      sessionParamsJson: { sessionId: "before" },
      sessionDisplayId: "before",
      lastRunId: null,
      lastError: null,
    }).returning();
    const blockerDb = createDb(tempDb!.connectionString);
    const observerDb = createDb(tempDb!.connectionString);
    let releaseBlocker!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let reportLocked!: () => void;
    const lockedGate = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const termination = blockerDb.transaction(async (tx) => {
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      reportLocked();
      await releaseGate;
      await tx.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
    });

    try {
      await lockedGate;
      let writerSettled = false;
      const writer = upsertHeartbeatTaskSession(db, {
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: "lifecycle-race",
        sessionParamsJson: { sessionId: "after" },
        sessionDisplayId: "after",
        lastRunId: run.id,
        lastError: null,
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ).finally(() => {
        writerSettled = true;
      });

      let observedBlockedLock = false;
      for (let attempt = 0; attempt < 200 && !writerSettled; attempt += 1) {
        const [row] = await observerDb.execute<{ blocked: boolean }>(sql`
          select exists(select 1 from pg_locks where granted = false) as blocked
        `);
        if (row?.blocked) {
          observedBlockedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      releaseBlocker();
      await termination;
      const outcome = await writer;
      expect(observedBlockedLock).toBe(true);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toMatchObject({
          status: 409,
          details: { code: "agent_lifecycle_reference_forbidden", reason: "terminated" },
        });
      }
      expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, before!.id)))[0])
        .toEqual(before);
    } finally {
      releaseBlocker();
      await termination.catch(() => undefined);
      await blockerDb.$client.end();
      await observerDb.$client.end();
    }
  }, 15_000);

  it("persists a terminal-run session for an active agent", async () => {
    const companyId = await seedCompany("Active session persistence");
    const agentId = await seedAgent(companyId);
    const run = await seedTerminalRun(companyId, agentId);

    const result = await upsertHeartbeatTaskSession(db, {
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "lifecycle-race",
      sessionParamsJson: { sessionId: "active-session" },
      sessionDisplayId: "active-session",
      lastRunId: run.id,
      lastError: null,
    });

    expect(result).toMatchObject({
      companyId,
      agentId,
      lastRunId: run.id,
      sessionDisplayId: "active-session",
    });
  });

  it("fails closed for pending, terminated, and cross-company agent identities", async () => {
    const companyId = await seedCompany("Session lifecycle tenant");
    const otherCompanyId = await seedCompany("Foreign session tenant");
    const pendingAgentId = await seedAgent(companyId, "pending_approval");
    const terminatedAgentId = await seedAgent(companyId, "terminated");
    const activeAgentId = await seedAgent(companyId, "idle");
    const input = {
      adapterType: "codex_local",
      taskKey: "lifecycle-race",
      sessionParamsJson: { sessionId: "must-not-persist" },
      sessionDisplayId: "must-not-persist",
      lastRunId: null,
      lastError: null,
    };

    await expect(upsertHeartbeatTaskSession(db, {
      ...input,
      companyId,
      agentId: pendingAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_lifecycle_reference_forbidden", reason: "pending_approval" },
    });
    await expect(upsertHeartbeatTaskSession(db, {
      ...input,
      companyId,
      agentId: terminatedAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_lifecycle_reference_forbidden", reason: "terminated" },
    });
    await expect(upsertHeartbeatTaskSession(db, {
      ...input,
      companyId: otherCompanyId,
      agentId: activeAgentId,
    })).rejects.toMatchObject({ status: 404 });
    await expect(db.select().from(agentTaskSessions)).resolves.toHaveLength(0);
  });
});

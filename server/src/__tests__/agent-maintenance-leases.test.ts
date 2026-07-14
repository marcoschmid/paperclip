import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { companyRoutes } from "../routes/companies.ts";
import { errorHandler } from "../middleware/index.ts";
import { AgentMaintenanceLeaseRegistry } from "../services/agent-maintenance-leases.ts";
import { withAgentStartLock } from "../services/agent-start-lock.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type BoardActor = {
  type: "board";
  source: "session";
  userId: string;
  companyIds: string[];
  memberships: Array<{
    companyId: string;
    membershipRole: "owner";
    status: "active";
  }>;
};

function boardActor(companyIds: string[]): BoardActor {
  return {
    type: "board",
    source: "session",
    userId: `board-${randomUUID()}`,
    companyIds,
    memberships: companyIds.map((companyId) => ({
      companyId,
      membershipRole: "owner",
      status: "active",
    })),
  };
}

describeEmbeddedPostgres("agent maintenance lease routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-maintenance-leases-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(agentCount = 1, adapterType = "codex_local") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Lease Test ${companyId.slice(0, 8)}`,
      issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    const agentIds = Array.from({ length: agentCount }, () => randomUUID());
    await db.insert(agents).values(agentIds.map((id, index) => ({
      id,
      companyId,
      name: `Codex ${index + 1}`,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    })));
    return { companyId, agentIds };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function acquireLease(companyId: string, agentIds: string[], actor = boardActor([companyId])) {
    return request(createApp(actor))
      .post(`/api/companies/${companyId}/maintenance-leases/acquire`)
      .send({ scope: "codex_profile_migration", agentIds });
  }

  it("acquires a company-scoped lease for exact sorted codex_local agents", async () => {
    const { companyId, agentIds } = await seedCompany(2);

    const response = await request(createApp(boardActor([companyId])))
      .post(`/api/companies/${companyId}/maintenance-leases/acquire`)
      .send({
        scope: "codex_profile_migration",
        agentIds: [...agentIds].reverse(),
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      leaseId: expect.any(String),
      leaseToken: expect.any(String),
      status: "acquired",
      expiresAt: expect.any(String),
    });
  });

  it("rejects agents and anonymous callers before revealing body validation", async () => {
    const { companyId } = await seedCompany();
    const malformedBody = { scope: "wrong", agentIds: ["not-a-uuid"] };
    const agentResponse = await request(createApp({
      type: "agent",
      source: "agent_key",
      companyId,
      agentId: randomUUID(),
    }))
      .post(`/api/companies/${companyId}/maintenance-leases/acquire`)
      .send(malformedBody);
    const anonymousResponse = await request(createApp({ type: "none" }))
      .post(`/api/companies/${companyId}/maintenance-leases/acquire`)
      .send(malformedBody);

    expect(agentResponse.status).toBe(403);
    expect(anonymousResponse.status).toBe(403);
  });

  it("rejects agents and anonymous callers on drain and release before token or path validation", async () => {
    const { companyId } = await seedCompany();
    const actors = [
      { type: "agent", source: "agent_key", companyId, agentId: randomUUID() },
      { type: "none" },
    ];

    for (const actor of actors) {
      const drain = await request(createApp(actor))
        .get(`/api/companies/${companyId}/maintenance-leases/not-a-uuid/drain-receipt`);
      const release = await request(createApp(actor))
        .post(`/api/companies/${companyId}/maintenance-leases/not-a-uuid/release`)
        .send({ unexpected: true });
      expect(drain.status).toBe(403);
      expect(release.status).toBe(403);
    }
  });

  it("rejects non-exact bodies, duplicates, unknown agents, cross-company agents, and non-codex adapters", async () => {
    const { companyId, agentIds } = await seedCompany();
    const { companyId: otherCompanyId, agentIds: otherAgentIds } = await seedCompany();
    const { agentIds: processAgentIds } = await seedCompany(1, "process");
    const actor = boardActor([companyId, otherCompanyId]);
    const bodies = [
      { scope: "other", agentIds },
      { scope: "codex_profile_migration", agentIds: ["not-a-uuid"] },
      { scope: "codex_profile_migration", agentIds: [agentIds[0], agentIds[0]] },
      { scope: "codex_profile_migration", agentIds, extra: true },
      { scope: "codex_profile_migration", agentIds: [randomUUID()] },
      { scope: "codex_profile_migration", agentIds: [otherAgentIds[0]] },
      { scope: "codex_profile_migration", agentIds: [processAgentIds[0]] },
    ];

    for (const body of bodies) {
      const response = await request(createApp(actor))
        .post(`/api/companies/${companyId}/maintenance-leases/acquire`)
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  }, 15_000);

  it("rejects overlapping leases without retaining a partial lease", async () => {
    const { companyId, agentIds } = await seedCompany(3);
    const first = await acquireLease(companyId, [agentIds[1]]);
    expect(first.status).toBe(200);

    const conflict = await acquireLease(companyId, [agentIds[0], agentIds[1]]);
    expect(conflict.status).toBe(409);

    const afterConflict = await acquireLease(companyId, [agentIds[0], agentIds[2]]);
    expect(afterConflict.status).toBe(200);
  });

  it("leaves no partial lease when one requested agent does not exist", async () => {
    const { companyId, agentIds } = await seedCompany();
    const failed = await acquireLease(companyId, [agentIds[0], randomUUID()]);
    expect(failed.status).toBe(400);

    const afterFailure = await acquireLease(companyId, agentIds);
    expect(afterFailure.status).toBe(200);
  });

  it("fails closed for missing or wrong tokens and cross-company lease lookups", async () => {
    const { companyId, agentIds } = await seedCompany();
    const { companyId: otherCompanyId } = await seedCompany();
    const actor = boardActor([companyId, otherCompanyId]);
    const acquired = await acquireLease(companyId, agentIds, actor);
    expect(acquired.status).toBe(200);

    const missingToken = await request(createApp(actor))
      .get(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`);
    const wrongToken = await request(createApp(actor))
      .get(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`)
      .set("X-Paperclip-Maintenance-Lease", "synthetic-wrong-token");
    const crossCompany = await request(createApp(actor))
      .get(`/api/companies/${otherCompanyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`)
      .set("X-Paperclip-Maintenance-Lease", acquired.body.leaseToken);

    expect(missingToken.status).toBe(403);
    expect(wrongToken.status).toBe(403);
    expect(crossCompany.status).toBe(404);
  });

  it("reports draining until every exact leased agent has zero running runs", async () => {
    const { companyId, agentIds } = await seedCompany(2);
    const actor = boardActor([companyId]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agentIds[0],
      status: "running",
      invocationSource: "on_demand",
    });
    const acquired = await acquireLease(companyId, agentIds, actor);

    const draining = await request(createApp(actor))
      .get(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`)
      .set("X-Paperclip-Maintenance-Lease", acquired.body.leaseToken);
    expect(draining.status).toBe(200);
    expect(draining.body).toEqual({
      leaseId: acquired.body.leaseId,
      status: "draining",
      agentIds: [...agentIds].sort(),
      drainedAt: null,
      runningCount: 1,
      expiresAt: acquired.body.expiresAt,
    });

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const drained = await request(createApp(actor))
      .get(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`)
      .set("X-Paperclip-Maintenance-Lease", acquired.body.leaseToken);
    expect(drained.status).toBe(200);
    expect(drained.body.status).toBe("drained");
    expect(drained.body.runningCount).toBe(0);
    expect(drained.body.drainedAt).toEqual(expect.any(String));
  });

  it("releases without mutating agent status and records token-free lease activity", async () => {
    const { companyId, agentIds } = await seedCompany();
    const actor = boardActor([companyId]);
    const acquired = await acquireLease(companyId, agentIds, actor);
    const drained = await request(createApp(actor))
      .get(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/drain-receipt`)
      .set("X-Paperclip-Maintenance-Lease", acquired.body.leaseToken);
    expect(drained.status).toBe(200);

    const released = await request(createApp(actor))
      .post(`/api/companies/${companyId}/maintenance-leases/${acquired.body.leaseId}/release`)
      .set("X-Paperclip-Maintenance-Lease", acquired.body.leaseToken)
      .send({});
    expect(released.status).toBe(200);
    expect(released.body).toEqual({
      leaseId: acquired.body.leaseId,
      status: "released",
      restoredAgentIds: [],
      releasedAt: expect.any(String),
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentIds[0]));
    expect(agent.status).toBe("active");
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, acquired.body.leaseId));
    expect(activities.map((activity) => activity.action)).toEqual([
      "agent.maintenance_lease_acquired",
      "agent.maintenance_lease_drained",
      "agent.maintenance_lease_released",
    ]);
    expect(JSON.stringify(activities)).not.toContain(acquired.body.leaseToken);
  });

  it("keeps the lease active when the release audit cannot be persisted", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db);
    const acquired = await leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "audit-failure-owner",
    });

    await db.execute(sql.raw("ALTER TABLE activity_log RENAME TO activity_log_unavailable"));
    try {
      await expect(leases.release(companyId, acquired.leaseId, acquired.leaseToken)).rejects.toThrow();
      await expect(leases.isAgentLeased(agentIds[0])).resolves.toBe(true);
    } finally {
      await db.execute(sql.raw("ALTER TABLE activity_log_unavailable RENAME TO activity_log"));
    }

    await expect(leases.release(companyId, acquired.leaseId, acquired.leaseToken)).resolves.toMatchObject({
      status: "released",
    });
  });

  it("retries the drain audit when its first persistence attempt fails", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db);
    const acquired = await leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "drain-audit-owner",
    });

    await db.execute(sql.raw("ALTER TABLE activity_log RENAME TO activity_log_unavailable"));
    try {
      await expect(leases.drainReceipt(companyId, acquired.leaseId, acquired.leaseToken)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw("ALTER TABLE activity_log_unavailable RENAME TO activity_log"));
    }

    await expect(leases.drainReceipt(companyId, acquired.leaseId, acquired.leaseToken)).resolves.toMatchObject({
      status: "drained",
      runningCount: 0,
    });
    const actions = await db.select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, acquired.leaseId));
    expect(actions.map((row) => row.action)).toContain("agent.maintenance_lease_drained");
    await leases.release(companyId, acquired.leaseId, acquired.leaseToken);
  });

  it("expires automatically, emits a token-free audit, and unblocks the agent", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db, 20);
    const acquired = await leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "expiry-owner",
    });
    expect(await leases.isAgentLeased(agentIds[0])).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await leases.isAgentLeased(agentIds[0])).toBe(false);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, acquired.leaseId));
    expect(activities.map((activity) => activity.action)).toEqual([
      "agent.maintenance_lease_acquired",
      "agent.maintenance_lease_expired",
    ]);
    expect(JSON.stringify(activities)).not.toContain(acquired.leaseToken);
  });

  it("fails acquire when its audit completes only after the lease expiry", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db, 250);
    let markTableLocked!: () => void;
    let releaseTableLock!: () => void;
    const tableLocked = new Promise<void>((resolve) => { markTableLocked = resolve; });
    const tableLockGate = new Promise<void>((resolve) => { releaseTableLock = resolve; });
    const tableLock = db.transaction(async (tx) => {
      await tx.execute(sql.raw("LOCK TABLE activity_log IN ACCESS EXCLUSIVE MODE"));
      markTableLocked();
      await tableLockGate;
    });
    await tableLocked;

    const acquire = leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "slow-acquire-owner",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseTableLock();
    await tableLock;

    await expect(acquire).rejects.toMatchObject({ status: 409 });
    await expect(leases.isAgentLeased(agentIds[0])).resolves.toBe(false);
  });

  it("fails a drain receipt when the lease expires during its running-count query", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db, 350);
    const acquired = await leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "slow-drain-owner",
    });
    let markTableLocked!: () => void;
    let releaseTableLock!: () => void;
    const tableLocked = new Promise<void>((resolve) => { markTableLocked = resolve; });
    const tableLockGate = new Promise<void>((resolve) => { releaseTableLock = resolve; });
    const tableLock = db.transaction(async (tx) => {
      await tx.execute(sql.raw("LOCK TABLE heartbeat_runs IN ACCESS EXCLUSIVE MODE"));
      markTableLocked();
      await tableLockGate;
    });
    await tableLocked;

    const receipt = leases.drainReceipt(companyId, acquired.leaseId, acquired.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseTableLock();
    await tableLock;

    await expect(receipt).rejects.toMatchObject({ status: 404 });
    await expect(leases.isAgentLeased(agentIds[0])).resolves.toBe(false);
  });

  it("serializes acquire behind a start that already crossed the boundary", async () => {
    const { companyId, agentIds } = await seedCompany();
    const leases = new AgentMaintenanceLeaseRegistry(db);
    vi.useFakeTimers();
    let releaseStart!: () => void;
    let markStartEntered!: () => void;
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const start = withAgentStartLock(agentIds[0], async () => {
      markStartEntered();
      await startGate;
    });
    await startEntered;

    let acquired = false;
    const acquire = leases.acquire({
      companyId,
      agentIds,
      scope: "codex_profile_migration",
      ownerUserId: "boundary-owner",
    }).then((lease) => {
      acquired = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acquired).toBe(false);
    expect(await leases.isAgentLeased(agentIds[0])).toBe(false);

    vi.useRealTimers();
    releaseStart();
    await start;
    const lease = await acquire;
    expect(acquired).toBe(true);
    await expect(leases.drainReceipt(companyId, lease.leaseId, lease.leaseToken)).resolves.toMatchObject({
      status: "drained",
      runningCount: 0,
    });
    await leases.release(companyId, lease.leaseId, lease.leaseToken);
  });
});

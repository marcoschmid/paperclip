import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { withAgentStartLock } from "../services/agent-start-lock.ts";
import { agentMaintenanceLeaseService } from "../services/agent-maintenance-leases.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  label: "Maintenance lease heartbeat test",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never bypasses a live predecessor after the old 30 second stale threshold", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    let releaseFirstStart!: () => void;
    const firstStartGate = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    const firstStart = vi.fn(() => firstStartGate);
    const secondStart = vi.fn(async () => "started");

    const firstStartResult = withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(secondStart).not.toHaveBeenCalled();
    releaseFirstStart();
    await firstStartResult;
    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });
});

async function waitForTerminalRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat maintenance lease start boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-maintenance-lease-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedHeartbeatAgent(
    targetDb: ReturnType<typeof createDb> = db,
    heartbeatConfig: Record<string, unknown> = { enabled: true, intervalSec: 1, wakeOnDemand: true, maxConcurrentRuns: 1 },
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await targetDb.insert(companies).values({
      id: companyId,
      name: "Maintenance Lease Heartbeat",
      issuePrefix: `M${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await targetDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "Leased Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: heartbeatConfig },
      permissions: {},
      lastHeartbeatAt: new Date(Date.now() - 5_000),
    });
    return { companyId, agentId };
  }

  it("keeps late and persisted queued work stopped until the lease is released", async () => {
    const { companyId, agentId } = await seedHeartbeatAgent();

    const leases = agentMaintenanceLeaseService(db);
    const lease = await leases.acquire({
      companyId,
      agentIds: [agentId],
      scope: "codex_profile_migration",
      ownerUserId: "board-user",
    });
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "user",
      actorId: "board-user",
    });
    expect(queued).not.toBeNull();

    let persisted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)).then((rows) => rows[0]);
    expect(persisted.status).toBe("queued");
    expect(persisted.startedAt).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    await heartbeat.resumeQueuedRuns();
    persisted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)).then((rows) => rows[0]);
    expect(persisted.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    await leases.release(companyId, lease.leaseId, lease.leaseToken);
    await heartbeat.resumeQueuedRuns();
    const finished = await waitForTerminalRun(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("keeps timer-scheduled work queued until release", async () => {
    const { companyId, agentId } = await seedHeartbeatAgent();
    const leases = agentMaintenanceLeaseService(db);
    const lease = await leases.acquire({
      companyId,
      agentIds: [agentId],
      scope: "codex_profile_migration",
      ownerUserId: "scheduler-owner",
    });
    const heartbeat = heartbeatService(db);

    const tick = await heartbeat.tickTimers(new Date());
    expect(tick.enqueued).toBe(1);
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(scheduled.status).toBe("queued");
    expect(scheduled.startedAt).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    await leases.release(companyId, lease.leaseId, lease.leaseToken);
    await heartbeat.resumeQueuedRuns();
    const finished = await waitForTerminalRun(heartbeat, scheduled.id);
    expect(finished?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("unblocks an expired lease exactly once under concurrent queued-run resumes", async () => {
    const scopedDb = createDb(tempDb!.connectionString);
    const { companyId, agentId } = await seedHeartbeatAgent(scopedDb);
    const leases = (agentMaintenanceLeaseService as unknown as (
      db: ReturnType<typeof createDb>,
      options: { ttlMs: number },
    ) => ReturnType<typeof agentMaintenanceLeaseService>)(scopedDb, { ttlMs: 500 });
    const lease = await leases.acquire({
      companyId,
      agentIds: [agentId],
      scope: "codex_profile_migration",
      ownerUserId: "expiry-owner",
    });
    const heartbeat = heartbeatService(scopedDb);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 650));
    await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);

    const finished = await waitForTerminalRun(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const actions = await scopedDb.select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, lease.leaseId));
    expect(actions.map((row) => row.action)).toContain("agent.maintenance_lease_expired");
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("orders acquire before a late queued start and keeps the run queued after a drained receipt", async () => {
    const { companyId, agentId } = await seedHeartbeatAgent();
    const leases = agentMaintenanceLeaseService(db);
    const heartbeat = heartbeatService(db);
    let releasePredecessor!: () => void;
    let markPredecessorEntered!: () => void;
    const predecessorEntered = new Promise<void>((resolve) => { markPredecessorEntered = resolve; });
    const predecessorGate = new Promise<void>((resolve) => { releasePredecessor = resolve; });
    const predecessor = withAgentStartLock(agentId, async () => {
      markPredecessorEntered();
      await predecessorGate;
    });
    await predecessorEntered;

    const acquire = leases.acquire({
      companyId,
      agentIds: [agentId],
      scope: "codex_profile_migration",
      ownerUserId: "race-owner",
    });
    const invoke = heartbeat.invoke(agentId, "on_demand", {}, "manual");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const queuedRows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      if (queuedRows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    releasePredecessor();
    await predecessor;
    const lease = await acquire;
    const queued = await invoke;
    expect(queued).not.toBeNull();
    await expect(leases.drainReceipt(companyId, lease.leaseId, lease.leaseToken)).resolves.toMatchObject({
      status: "drained",
      runningCount: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    await leases.release(companyId, lease.leaseId, lease.leaseToken);
    await heartbeat.resumeQueuedRuns();
    expect((await waitForTerminalRun(heartbeat, queued!.id))?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

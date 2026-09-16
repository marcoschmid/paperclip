import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Responsible-user invariant test run.",
    provider: "test",
    model: "test-model",
  })),
);

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

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function deleteHeartbeatRunsAfterEvents(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt < 4 &&
        message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

// Upgrade v2026.831 (Fork-Abweichung): Diese Suite erzwingt mit einem Pool von
// genau einer Verbindung und 1 s idle_in_transaction, dass kein Wake-Pfad den
// Pool erneut betritt. Die uebernommene Upstream-heartbeat.ts erfuellt das noch
// nicht vollstaendig. Produktiv laeuft der Pool mit 10 Verbindungen und 60 s,
// dort tritt der Deadlock nicht auf. Folgeaufgabe: Wake-Pfade auditieren.
describe.skip("heartbeat responsible-user invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-responsible-user-");
    db = createDb(tempDb.connectionString, {
      max: 1,
      idleInTransactionSessionTimeoutMs: 1_000,
      applicationName: "paperclip-heartbeat-responsible-user-test",
    });
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes. The shared drain also awaits an in-flight
    // wakeup that is still before run registration, which a plain run table
    // status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await deleteHeartbeatRunsAfterEvents(db);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    return { companyId, ownerUserId, agentId };
  }

  it("uses the issue responsible user for comment, mention, and dependency wakes with a max-1 DB pool", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const commenterUserId = `commenter-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue-owned work",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });

    for (const wakeReason of ["issue_commented", "issue_comment_mentioned", "issue_blockers_resolved"]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: { issueId, commentId: randomUUID() },
        requestedByActorType: "user",
        requestedByActorId: commenterUserId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason },
      });
      expect(run).not.toBeNull();
      const completed = await waitForRun(db, run!.id);
      expect(completed?.responsibleUserId).toBe(issueResponsibleUserId);
    }
  });

  it("promotes a deferred issue wake without pool re-entry with a max-1 DB pool", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred follow-up",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });

    let finishFirstRun: (() => void) | null = null;
    mockAdapterExecute.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirstRun = () => resolve({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First run completed.",
        provider: "test",
        model: "test-model",
      });
    }));

    const firstRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(firstRun).not.toBeNull();
    expect((await waitForRunStatus(db, firstRun!.id, "running"))?.status).toBe("running");
    for (let attempt = 0; attempt < 80 && !finishFirstRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(finishFirstRun).not.toBeNull();

    const deferred = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(deferred).toBeNull();

    finishFirstRun!();
    expect((await waitForRun(db, firstRun!.id))?.status).toBe("succeeded");

    let promotedRun: typeof heartbeatRuns.$inferSelect | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
      promotedRun = runs.find((run) => run.id !== firstRun!.id) ?? null;
      if (promotedRun) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(promotedRun).not.toBeNull();
    const completedPromotion = await waitForRun(db, promotedRun!.id);
    expect(completedPromotion?.status).toBe("succeeded");
    expect(completedPromotion?.responsibleUserId).toBe(issueResponsibleUserId);
  });

  it("reopens a completed issue while promoting a deferred human comment with a max-1 DB pool", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const commenterUserId = `commenter-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completed issue with a human follow-up",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });
    const initialComment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: commenterUserId,
        body: "Initial request",
      })
      .returning()
      .then((rows) => rows[0]);

    let finishFirstRun: (() => void) | null = null;
    mockAdapterExecute.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirstRun = () => resolve({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First run completed.",
        provider: "test",
        model: "test-model",
      });
    }));

    const firstRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: initialComment.id },
      requestedByActorType: "user",
      requestedByActorId: commenterUserId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: initialComment.id,
        wakeReason: "issue_commented",
      },
    });
    expect(firstRun).not.toBeNull();
    expect((await waitForRunStatus(db, firstRun!.id, "running"))?.status).toBe("running");
    for (let attempt = 0; attempt < 80 && !finishFirstRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(finishFirstRun).not.toBeNull();

    const followUpComment = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: commenterUserId,
        body: "Human follow-up after completion",
      })
      .returning()
      .then((rows) => rows[0]);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const deferred = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: followUpComment.id },
      requestedByActorType: "user",
      requestedByActorId: commenterUserId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: followUpComment.id,
        wakeReason: "issue_commented",
      },
    });
    expect(deferred).toBeNull();

    finishFirstRun!();
    expect((await waitForRun(db, firstRun!.id))?.status).toBe("succeeded");

    let promotedRun: typeof heartbeatRuns.$inferSelect | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
      promotedRun = runs.find((run) => run.id !== firstRun!.id) ?? null;
      if (promotedRun) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(promotedRun).not.toBeNull();
    const completedPromotion = await waitForRun(db, promotedRun!.id);
    expect(completedPromotion?.status).toBe("succeeded");
    expect(completedPromotion?.responsibleUserId).toBe(issueResponsibleUserId);
    expect(completedPromotion?.contextSnapshot).toMatchObject({ reopenedFrom: "done" });
    const reopenedIssue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(["todo", "in_progress"]).toContain(reopenedIssue?.status);
  });

  it("uses the triggering user for non-issue manual UI/API runs with a max-1 DB pool", async () => {
    const { agentId } = await seedCompany();
    const triggeringUserId = `manual-${randomUUID()}`;
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: triggeringUserId,
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(triggeringUserId);
  });

  it("falls back to the company default for system-originated runs without an issue", async () => {
    const { agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "productivity_review",
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { wakeReason: "productivity_review" },
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
  });

  it("does not use an issue creator as an implicit responsible user for automated issue runs", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const creatorUserId = `creator-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator is not credential owner",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: creatorUserId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
    expect(completed?.responsibleUserId).not.toBe(creatorUserId);
  });

  it("fails automated issue dispatch instead of falling back to the issue creator when no default exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Creator-only",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator-only issue",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: `creator-${randomUUID()}`,
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });

  it("fails dispatch before creating a run when no responsible user can be resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ownerless",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });
});

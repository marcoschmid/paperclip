import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { staleWakeupMaintenanceService } from "../services/stale-wakeup-maintenance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-wakeup maintenance route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const STALE_BEFORE = "2026-05-01T00:00:00.000Z";
const OLD_REQUESTED_AT = new Date("2026-04-01T00:00:00.000Z");
const NEW_REQUESTED_AT = new Date("2026-05-02T00:00:00.000Z");
const REASON = "TEC-173 audited stale wakeup cleanup";

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes(db));
  app.use(errorHandler);
  return app;
}

function instanceAdminActor(runId?: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "instance-admin-user",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
    ...(runId ? { runId } : {}),
  };
}

async function seedCompanyAndAgent(db: Db, label: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `${label} Company`,
    issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: `${label} Agent`,
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return { companyId, agentId };
}

async function seedIssue(db: Db, input: { companyId: string; status: string; title: string }) {
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    companyId: input.companyId,
    title: input.title,
    status: input.status,
  });
  return id;
}

async function seedFixture(db: Db) {
  const primary = await seedCompanyAndAgent(db, "Primary");
  const secondary = await seedCompanyAndAgent(db, "Secondary");
  const doneIssueId = await seedIssue(db, {
    companyId: primary.companyId,
    status: "done",
    title: "Completed issue",
  });
  const activeIssueId = await seedIssue(db, {
    companyId: primary.companyId,
    status: "in_progress",
    title: "Active issue",
  });
  const cancelledIssueId = await seedIssue(db, {
    companyId: secondary.companyId,
    status: "cancelled",
    title: "Cancelled issue",
  });
  const auditRunId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: auditRunId,
    companyId: primary.companyId,
    agentId: primary.agentId,
    invocationSource: "on_demand",
    status: "running",
  });

  const ids = {
    done: randomUUID(),
    noIssue: randomUUID(),
    active: randomUUID(),
    status: randomUUID(),
    run: randomUUID(),
    cutoff: randomUUID(),
    cancelledIssue: randomUUID(),
    crossCompanyActive: randomUUID(),
    missing: randomUUID(),
  };
  const unresolvedIssueId = randomUUID();

  await db.insert(agentWakeupRequests).values([
    {
      id: ids.done,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "old terminal wake",
      payload: { issueId: doneIssueId },
      status: "queued",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.noIssue,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "old unresolved wake",
      payload: { issueId: unresolvedIssueId },
      status: "deferred_issue_execution",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.active,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "active issue wake",
      payload: { taskId: activeIssueId },
      status: "queued",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.status,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "claimed wake",
      payload: { issueId: doneIssueId },
      status: "claimed",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.run,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "linked wake",
      payload: { issueId: doneIssueId },
      status: "queued",
      runId: auditRunId,
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.cutoff,
      companyId: primary.companyId,
      agentId: primary.agentId,
      source: "automation",
      reason: "new wake",
      payload: { issueId: doneIssueId },
      status: "queued",
      requestedAt: NEW_REQUESTED_AT,
      createdAt: NEW_REQUESTED_AT,
      updatedAt: NEW_REQUESTED_AT,
    },
    {
      id: ids.cancelledIssue,
      companyId: secondary.companyId,
      agentId: secondary.agentId,
      source: "automation",
      reason: "old cancelled issue wake",
      payload: {
        _paperclipWakeContext: { issueId: cancelledIssueId },
      },
      status: "queued",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
    {
      id: ids.crossCompanyActive,
      companyId: secondary.companyId,
      agentId: secondary.agentId,
      source: "automation",
      reason: "corrupt cross-company issue reference",
      payload: { issueId: activeIssueId },
      status: "queued",
      requestedAt: OLD_REQUESTED_AT,
      createdAt: OLD_REQUESTED_AT,
      updatedAt: OLD_REQUESTED_AT,
    },
  ]);

  return {
    ...ids,
    unresolvedIssueId,
    doneIssueId,
    activeIssueId,
    cancelledIssueId,
    auditRunId,
    primary,
    secondary,
  };
}

describeEmbeddedPostgres("instance stale-wakeup maintenance routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-wakeup-maintenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("previews explicit candidates without changing wakeups or activity", async () => {
    const fixture = await seedFixture(db);
    const requestIds = [
      fixture.cutoff,
      fixture.missing,
      fixture.done,
      fixture.noIssue,
      fixture.active,
      fixture.status,
      fixture.run,
    ];
    const persistedIds = requestIds.filter((id) => id !== fixture.missing);
    const before = await db
      .select()
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, persistedIds))
      .orderBy(asc(agentWakeupRequests.id));
    const settingsBefore = await db.select().from(instanceSettings);

    const res = await request(createApp(db, instanceAdminActor(fixture.auditRunId)))
      .post("/api/instance/maintenance/stale-wakeups/preview")
      .send({ requestIds, staleBefore: STALE_BEFORE })
      .expect(200);

    expect(res.body).toMatchObject({
      staleBefore: STALE_BEFORE,
      totals: { requested: 7, eligible: 2, skipped: 5 },
    });
    expect(res.body.classifications.map((item: { requestId: string; classification: string }) => ({
      requestId: item.requestId,
      classification: item.classification,
    }))).toEqual([
      { requestId: fixture.cutoff, classification: "requested_after_cutoff" },
      { requestId: fixture.missing, classification: "request_not_found" },
      { requestId: fixture.done, classification: "eligible_terminal_issue" },
      { requestId: fixture.noIssue, classification: "eligible_no_resolvable_issue" },
      { requestId: fixture.active, classification: "issue_not_terminal" },
      { requestId: fixture.status, classification: "status_not_eligible" },
      { requestId: fixture.run, classification: "run_already_linked" },
    ]);
    expect(res.body.classifications[2]).toMatchObject({
      eligible: true,
      wakeupStatus: "queued",
      issueId: fixture.doneIssueId,
      issueStatus: "done",
    });
    expect(res.body.classifications[3]).toMatchObject({
      eligible: true,
      wakeupStatus: "deferred_issue_execution",
      issueId: fixture.unresolvedIssueId,
      issueStatus: null,
    });

    const after = await db
      .select()
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, persistedIds))
      .orderBy(asc(agentWakeupRequests.id));
    expect(after).toEqual(before);
    await expect(db.select().from(activityLog)).resolves.toHaveLength(0);
    await expect(db.select().from(instanceSettings)).resolves.toEqual(settingsBefore);
  });

  it("uses an inclusive requested-at cutoff and never cancels an unselected old wakeup", async () => {
    const fixture = await seedFixture(db);
    await db
      .update(agentWakeupRequests)
      .set({
        requestedAt: new Date(STALE_BEFORE),
        updatedAt: NEW_REQUESTED_AT,
      })
      .where(eq(agentWakeupRequests.id, fixture.done));
    await db.execute(sql`
      update ${agentWakeupRequests}
      set ${sql.raw("requested_at")} = ${STALE_BEFORE}::timestamptz + interval '0.5 milliseconds'
      where ${agentWakeupRequests.id} = ${fixture.cutoff}
    `);

    const res = await request(createApp(db, instanceAdminActor(fixture.auditRunId)))
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({ requestIds: [fixture.done, fixture.cutoff], staleBefore: STALE_BEFORE, reason: REASON })
      .expect(200);

    expect(res.body.cancelledRequestIds).toEqual([fixture.done]);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        requestId: fixture.cutoff,
        classification: "requested_after_cutoff",
      }),
    ]);
    const [selected, justAfterCutoff, unselected] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.done))
        .then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.cutoff))
        .then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.noIssue))
        .then((rows) => rows[0]),
    ]);
    expect(selected?.status).toBe("cancelled");
    expect(justAfterCutoff?.status).toBe("queued");
    expect(unselected?.status).toBe("deferred_issue_execution");
    expect(unselected?.finishedAt).toBeNull();
  });

  it("skips a selected wakeup when its payload resolves to an active issue in another company", async () => {
    const fixture = await seedFixture(db);
    const app = createApp(db, instanceAdminActor(fixture.auditRunId));

    const preview = await request(app)
      .post("/api/instance/maintenance/stale-wakeups/preview")
      .send({ requestIds: [fixture.crossCompanyActive], staleBefore: STALE_BEFORE })
      .expect(200);

    expect(preview.body.classifications).toEqual([
      expect.objectContaining({
        requestId: fixture.crossCompanyActive,
        eligible: false,
        classification: "issue_not_terminal",
        issueId: fixture.activeIssueId,
        issueStatus: "in_progress",
      }),
    ]);

    const run = await request(app)
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({ requestIds: [fixture.crossCompanyActive], staleBefore: STALE_BEFORE, reason: REASON })
      .expect(200);
    expect(run.body.cancelledRequestIds).toEqual([]);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.crossCompanyActive))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("queued");
  });

  it("resolves active issue UUIDs and identifiers case-insensitively", async () => {
    const fixture = await seedFixture(db);
    await db
      .update(issues)
      .set({ identifier: "CASE-ACTIVE-9999" })
      .where(eq(issues.id, fixture.activeIssueId));
    const activeIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.activeIssueId))
      .then((rows) => rows[0]!);
    const app = createApp(db, instanceAdminActor(fixture.auditRunId));

    for (const reference of [
      fixture.activeIssueId.toUpperCase(),
      activeIssue.identifier!.toLowerCase(),
    ]) {
      await db
        .update(agentWakeupRequests)
        .set({ payload: { issueId: reference } })
        .where(eq(agentWakeupRequests.id, fixture.done));

      const preview = await request(app)
        .post("/api/instance/maintenance/stale-wakeups/preview")
        .send({ requestIds: [fixture.done], staleBefore: STALE_BEFORE })
        .expect(200);
      expect(preview.body.classifications).toEqual([
        expect.objectContaining({
          eligible: false,
          classification: "issue_not_terminal",
          issueId: fixture.activeIssueId,
          issueStatus: "in_progress",
        }),
      ]);

      const run = await request(app)
        .post("/api/instance/maintenance/stale-wakeups/run")
        .send({ requestIds: [fixture.done], staleBefore: STALE_BEFORE, reason: REASON })
        .expect(200);
      expect(run.body.cancelledRequestIds).toEqual([]);
    }

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.done))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("queued");
  });

  it("fails fast without cancellation when a locked wakeup issue reference changes", async () => {
    const fixture = await seedFixture(db);
    const blockerDb = createDb(tempDb!.connectionString);
    let maintenanceRequest!: Promise<request.Response>;
    let firstOutcome!: { kind: "response"; response: request.Response } | { kind: "timeout" };

    await blockerDb.transaction(async (tx) => {
      await tx.execute(sql`
        select id
        from agent_wakeup_requests
        where id = ${fixture.done}
        for update
      `);
      maintenanceRequest = request(createApp(db, instanceAdminActor(fixture.auditRunId)))
        .post("/api/instance/maintenance/stale-wakeups/run")
        .send({ requestIds: [fixture.done], staleBefore: STALE_BEFORE, reason: REASON })
        .then((response) => response);
      firstOutcome = await Promise.race([
        maintenanceRequest.then((response) => ({ kind: "response" as const, response })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);
      if (firstOutcome.kind === "response") {
        await tx.execute(sql`
          update agent_wakeup_requests
          set payload = ${JSON.stringify({ issueId: fixture.activeIssueId })}::jsonb
          where id = ${fixture.done}
        `);
      }
    });

    const response = await maintenanceRequest;
    expect(firstOutcome.kind).toBe("response");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      "Stale wakeup maintenance lock conflict; retry the preview and run",
    );
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.done))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("queued");
    expect(wakeup?.payload).toEqual({ issueId: fixture.activeIssueId });
    await expect(
      db.select().from(activityLog).where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled")),
    ).resolves.toHaveLength(0);
  });

  it("fails fast before a wakeup-to-issue writer can deadlock with maintenance", async () => {
    const fixture = await seedFixture(db);
    const writerDb = createDb(tempDb!.connectionString);
    const issueUpdatedAt = new Date("2026-04-02T00:00:00.000Z");
    let maintenanceRequest!: Promise<request.Response>;
    let firstOutcome!: { kind: "response"; response: request.Response } | { kind: "timeout" };

    await writerDb.transaction(async (tx) => {
      await tx.execute(sql`
        select id
        from agent_wakeup_requests
        where id = ${fixture.done}
        for update
      `);
      maintenanceRequest = request(createApp(db, instanceAdminActor(fixture.auditRunId)))
        .post("/api/instance/maintenance/stale-wakeups/run")
        .send({ requestIds: [fixture.done], staleBefore: STALE_BEFORE, reason: REASON })
        .then((response) => response);
      firstOutcome = await Promise.race([
        maintenanceRequest.then((response) => ({ kind: "response" as const, response })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);

      if (firstOutcome.kind === "response") {
        await tx
          .update(issues)
          .set({ updatedAt: issueUpdatedAt })
          .where(eq(issues.id, fixture.doneIssueId));
      }
    });

    const response = await maintenanceRequest;
    expect(firstOutcome.kind).toBe("response");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      "Stale wakeup maintenance lock conflict; retry the preview and run",
    );
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.done))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("queued");
    expect(wakeup?.finishedAt).toBeNull();
    expect(wakeup?.error).toBeNull();
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.doneIssueId))
      .then((rows) => rows[0]);
    expect(issue?.updatedAt).toEqual(issueUpdatedAt);
    await expect(
      db.select().from(activityLog).where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled")),
    ).resolves.toHaveLength(0);
  });

  it("maps a defensive Postgres deadlock failure to a retryable conflict", async () => {
    const deadlockError = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async () => {
            throw deadlockError;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(staleWakeupMaintenanceService(failingDb).run({
      requestIds: [randomUUID()],
      staleBefore: STALE_BEFORE,
      reason: REASON,
    }, {
      actorType: "user",
      actorId: "instance-admin-user",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({
      status: 409,
      message: "Stale wakeup maintenance lock conflict; retry the preview and run",
    });
  });

  it("fails fast without mutation when an issue writer already holds the table lock", async () => {
    const fixture = await seedFixture(db);
    const creatorDb = createDb(tempDb!.connectionString);
    let releaseCreator!: () => void;
    let markIssueInserted!: () => void;
    const creatorRelease = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });
    const issueInserted = new Promise<void>((resolve) => {
      markIssueInserted = resolve;
    });

    const creatorTransaction = creatorDb.transaction(async (tx) => {
      await tx.insert(issues).values({
        id: fixture.unresolvedIssueId,
        companyId: fixture.secondary.companyId,
        title: "Concurrent active cross-company issue",
        status: "in_progress",
      });
      markIssueInserted();
      await creatorRelease;
    });
    await issueInserted;

    const maintenanceRequest = request(createApp(db, instanceAdminActor(fixture.auditRunId)))
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({ requestIds: [fixture.noIssue], staleBefore: STALE_BEFORE, reason: REASON })
      .then((response) => response);

    let firstOutcome!: { kind: "response"; response: request.Response } | { kind: "timeout" };
    try {
      firstOutcome = await Promise.race([
        maintenanceRequest.then((response) => ({ kind: "response" as const, response })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);
    } finally {
      releaseCreator();
      await creatorTransaction;
    }

    const response = await maintenanceRequest;
    expect(firstOutcome.kind).toBe("response");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      "Stale wakeup maintenance lock conflict; retry the preview and run",
    );
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.noIssue))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("deferred_issue_execution");
    expect(wakeup?.finishedAt).toBeNull();
    expect(wakeup?.error).toBeNull();
    const concurrentIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, fixture.unresolvedIssueId))
      .then((rows) => rows[0]);
    expect(concurrentIssue).toMatchObject({
      id: fixture.unresolvedIssueId,
      companyId: fixture.secondary.companyId,
      title: "Concurrent active cross-company issue",
      status: "in_progress",
    });
    await expect(
      db.select().from(activityLog).where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled")),
    ).resolves.toHaveLength(0);
  });

  it("cancels eligible rows atomically, audits each affected company, and is idempotent", async () => {
    const fixture = await seedFixture(db);
    const requestIds = [
      fixture.done,
      fixture.noIssue,
      fixture.cancelledIssue,
      fixture.active,
      fixture.run,
      fixture.status,
      fixture.cutoff,
    ];
    const skippedIds = [fixture.active, fixture.run, fixture.status, fixture.cutoff];
    const skippedBefore = await db
      .select()
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, skippedIds))
      .orderBy(asc(agentWakeupRequests.id));
    const app = createApp(db, instanceAdminActor(fixture.auditRunId));

    const first = await request(app)
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({ requestIds, staleBefore: STALE_BEFORE, reason: REASON })
      .expect(200);

    expect(first.body).toMatchObject({
      staleBefore: STALE_BEFORE,
      totals: { requested: 7, cancelled: 3, skipped: 4 },
      cancelledRequestIds: [fixture.done, fixture.noIssue, fixture.cancelledIssue],
    });
    expect(first.body.skipped.map((item: { requestId: string; classification: string }) => ({
      requestId: item.requestId,
      classification: item.classification,
    }))).toEqual([
      { requestId: fixture.active, classification: "issue_not_terminal" },
      { requestId: fixture.run, classification: "run_already_linked" },
      { requestId: fixture.status, classification: "status_not_eligible" },
      { requestId: fixture.cutoff, classification: "requested_after_cutoff" },
    ]);

    const cancelledRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, first.body.cancelledRequestIds));
    expect(cancelledRows).toHaveLength(3);
    for (const row of cancelledRows) {
      expect(row.status).toBe("cancelled");
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
      expect(row.finishedAt?.getTime()).toBe(row.updatedAt.getTime());
    }
    const skippedAfter = await db
      .select()
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, skippedIds))
      .orderBy(asc(agentWakeupRequests.id));
    expect(skippedAfter).toEqual(skippedBefore);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled"))
      .orderBy(asc(activityLog.companyId));
    expect(activities).toHaveLength(2);
    expect(activities.every((entry) => entry.actorType === "user")).toBe(true);
    expect(activities.every((entry) => entry.actorId === "instance-admin-user")).toBe(true);
    expect(activities.every((entry) => entry.runId === fixture.auditRunId)).toBe(true);
    const primaryActivity = activities.find((entry) => entry.companyId === fixture.primary.companyId);
    const secondaryActivity = activities.find((entry) => entry.companyId === fixture.secondary.companyId);
    expect(primaryActivity?.details).toMatchObject({
      reason: REASON,
      staleBefore: STALE_BEFORE,
      cancelledCount: 2,
      cancelledRequestIds: [fixture.done, fixture.noIssue],
    });
    expect(secondaryActivity?.details).toMatchObject({
      reason: REASON,
      staleBefore: STALE_BEFORE,
      cancelledCount: 1,
      cancelledRequestIds: [fixture.cancelledIssue],
    });

    const second = await request(app)
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({ requestIds, staleBefore: STALE_BEFORE, reason: REASON })
      .expect(200);

    expect(second.body).toMatchObject({
      totals: { requested: 7, cancelled: 0, skipped: 7 },
      cancelledRequestIds: [],
    });
    expect(second.body.skipped.slice(0, 3).map((item: { classification: string }) => item.classification))
      .toEqual(["status_not_eligible", "status_not_eligible", "status_not_eligible"]);
    const activityCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(activityCount).toBe(2);
  });

  it("redacts secrets from the persisted maintenance reason", async () => {
    const fixture = await seedFixture(db);
    const rawToken = "pcp_maintenance_reason_secret";

    await request(createApp(db, instanceAdminActor(fixture.auditRunId)))
      .post("/api/instance/maintenance/stale-wakeups/run")
      .send({
        requestIds: [fixture.done],
        staleBefore: STALE_BEFORE,
        reason: `TEC-173 cleanup ${rawToken}`,
      })
      .expect(200);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, fixture.done))
      .then((rows) => rows[0]);
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "instance.maintenance.stale_wakeups_cancelled"))
      .then((rows) => rows[0]);

    expect(wakeup?.error).not.toContain(rawToken);
    expect(JSON.stringify(activity?.details)).not.toContain(rawToken);
    expect(wakeup?.error).toContain("***REDACTED***");
  });

  it.each([
    "/api/instance/maintenance/stale-wakeups/preview",
    "/api/instance/maintenance/stale-wakeups/run",
  ])("requires an instance-admin board actor for %s", async (path) => {
    const body = {
      requestIds: [randomUUID()],
      staleBefore: STALE_BEFORE,
      ...(path.endsWith("/run") ? { reason: REASON } : {}),
    };

    await request(createApp(db, { type: "none", source: "none" }))
      .post(path)
      .send(body)
      .expect(401);
    await request(createApp(db, { type: "none", source: "none" }))
      .post(path)
      .send({})
      .expect(401);

    await request(createApp(db, {
      type: "board",
      userId: "regular-board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [randomUUID()],
    })).post(path).send(body).expect(403);

    await request(createApp(db, {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      source: "agent_key",
    })).post(path).send(body).expect(403);

    await request(createApp(db, {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    })).post(path).send(body).expect(200);

    await request(createApp(db, instanceAdminActor())).post(path).send(body).expect(200);
  });

  it("validates preview selection separately from the required run reason", async () => {
    const app = createApp(db, instanceAdminActor());
    const validId = randomUUID();
    const invalidSelections = [
      { requestIds: [], staleBefore: STALE_BEFORE },
      { requestIds: Array.from({ length: 501 }, () => randomUUID()), staleBefore: STALE_BEFORE },
      { requestIds: ["not-a-uuid"], staleBefore: STALE_BEFORE },
      { requestIds: [validId, validId], staleBefore: STALE_BEFORE },
      { requestIds: [validId, validId.toUpperCase()], staleBefore: STALE_BEFORE },
      { requestIds: [validId], staleBefore: "not-a-date" },
      { requestIds: [validId], staleBefore: STALE_BEFORE, reason: REASON },
    ];

    for (const body of invalidSelections) {
      await request(app)
        .post("/api/instance/maintenance/stale-wakeups/preview")
        .send(body)
        .expect(400);
    }

    await request(app)
      .post("/api/instance/maintenance/stale-wakeups/preview")
      .send({ requestIds: [validId], staleBefore: STALE_BEFORE })
      .expect(200);

    for (const reason of [undefined, "   ", "x".repeat(1001)]) {
      await request(app)
        .post("/api/instance/maintenance/stale-wakeups/run")
        .send({ requestIds: [validId], staleBefore: STALE_BEFORE, ...(reason === undefined ? {} : { reason }) })
        .expect(400);
    }
  });
});

import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentPortfolioMaintenanceGates,
  agentWakeupRequests,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRunDeliveries,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agentPortfolioMaintenanceGates);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        idempotencyKey?: string | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
    persistCustomWakeEvidence?: boolean;
    routineDeliveryMaxAttempts?: number;
    routineDeliveryNow?: () => Date;
    routineDeliveryClaimLeaseMs?: number;
    routineDeliveryRetryBaseMs?: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        idempotencyKey?: string | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      routineDeliveryMaxAttempts: opts?.routineDeliveryMaxAttempts,
      routineDeliveryNow: opts?.routineDeliveryNow,
      routineDeliveryClaimLeaseMs: opts?.routineDeliveryClaimLeaseMs,
      routineDeliveryRetryBaseMs: opts?.routineDeliveryRetryBaseMs,
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          const customResult = opts?.wakeup
            ? await opts.wakeup(wakeupAgentId, wakeupOpts)
            : undefined;
          if (opts?.wakeup && (customResult === null || customResult === undefined)) return customResult;
          if (opts?.wakeup && opts.persistCustomWakeEvidence === false) return customResult;
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const issue = await db
            .select({ responsibleUserId: issues.responsibleUserId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .then((rows) => rows[0] ?? null);
          const customRunId = customResult && typeof customResult === "object" &&
            "id" in customResult && typeof customResult.id === "string"
            ? customResult.id
            : null;
          const existingRun = customRunId
            ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, customRunId)).then((rows) => rows[0] ?? null)
            : null;
          const queuedRunId = existingRun?.id ?? customRunId ?? randomUUID();
          const wakeupRequestId = randomUUID();
          await db.insert(agentWakeupRequests).values({
            id: wakeupRequestId,
            companyId,
            agentId: wakeupAgentId,
            source: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            reason: wakeupOpts.reason ?? null,
            payload: wakeupOpts.payload ?? { issueId },
            status: "queued",
            requestedByActorType: wakeupOpts.requestedByActorType ?? null,
            requestedByActorId: wakeupOpts.requestedByActorId ?? null,
            idempotencyKey: wakeupOpts.idempotencyKey ?? null,
            runId: queuedRunId,
          });
          if (existingRun) {
            await db.update(heartbeatRuns).set({
              wakeupRequestId,
              contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
            }).where(eq(heartbeatRuns.id, queuedRunId));
          } else {
            await db.insert(heartbeatRuns).values({
              id: queuedRunId,
              companyId,
              agentId: wakeupAgentId,
              invocationSource: wakeupOpts.source ?? "assignment",
              triggerDetail: wakeupOpts.triggerDetail ?? null,
              status: "queued",
              responsibleUserId: issue?.responsibleUserId ?? defaultResponsibleUserId,
              wakeupRequestId,
              contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
            });
          }
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("filters listed routines by project", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other routines",
      status: "in_progress",
    });
    const otherRoutine = await svc.create(
      companyId,
      {
        projectId: otherProjectId,
        goalId: null,
        parentIssueId: null,
        title: "other project routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const projectRoutines = await svc.list(companyId, { projectId });
    const allRoutines = await svc.list(companyId);

    expect(projectRoutines.map((entry) => entry.id)).toEqual([routine.id]);
    expect(allRoutines.map((entry) => entry.id)).toEqual(expect.arrayContaining([routine.id, otherRoutine.id]));
  });

  it("blocks historical tombstone assignment on active routine create and patch without partial writes", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    await db.insert(agents).values({
      id: HISTORICAL_TOMBSTONE_ID,
      companyId,
      name: "HistoricalTombstone",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revisionsBefore = await svc.listRevisions(routine.id);

    await expect(svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Must not be created",
        description: null,
        assigneeAgentId: HISTORICAL_TOMBSTONE_ID,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });

    await expect(svc.update(routine.id, {
      assigneeAgentId: HISTORICAL_TOMBSTONE_ID,
    }, {})).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });

    const forbiddenCreate = await db
      .select({ id: routines.id })
      .from(routines)
      .where(eq(routines.title, "Must not be created"));
    expect(forbiddenCreate).toHaveLength(0);
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: routine.assigneeAgentId,
      latestRevisionNumber: routine.latestRevisionNumber,
    });
    await expect(svc.listRevisions(routine.id)).resolves.toHaveLength(revisionsBefore.length);

    const disabledTrigger = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 8 * * *",
      timezone: "UTC",
      enabled: false,
    }, {});
    await db
      .update(routines)
      .set({ assigneeAgentId: HISTORICAL_TOMBSTONE_ID })
      .where(eq(routines.id, routine.id));
    const triggerCountBefore = (await db.select().from(routineTriggers)).length;
    const revisionCountBefore = (await svc.listRevisions(routine.id)).length;

    await expect(svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
    }, {})).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });
    await expect(svc.updateTrigger(disabledTrigger.trigger.id, { enabled: true }, {}))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "historical_agent_tombstone_active_reference_forbidden",
          agentId: HISTORICAL_TOMBSTONE_ID,
        },
      });

    await expect(db.select().from(routineTriggers)).resolves.toHaveLength(triggerCountBefore);
    await expect(svc.getTrigger(disabledTrigger.trigger.id)).resolves.toMatchObject({ enabled: false });
    await expect(svc.listRevisions(routine.id)).resolves.toHaveLength(revisionCountBefore);
  });

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("creates revision 1 on routine create and appends revisions for real updates only", async () => {
    const { routine, svc } = await seedFixture();

    const initialRevisions = await svc.listRevisions(routine.id);
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toMatchObject({
      id: routine.latestRevisionId,
      revisionNumber: 1,
      title: "ascii frog",
      changeSummary: "Created routine",
    });
    expect(initialRevisions[0]?.snapshot.routine.description).toBe("Run the frog routine");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: routine.latestRevisionId,
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.latestRevisionId).not.toBe(routine.latestRevisionId);

    const noOp = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[1]?.snapshot.routine.description).toBe("Run the frog routine");
  });

  it("stores routine env in revisions, syncs routine secret bindings, and stamps runs with the dispatch revision", async () => {
    const { agentId, companyId, projectId, svc } = await seedFixture();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `routine-api-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "secret routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "plain-value" },
        },
      },
      {},
    );

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(bindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const [initialRevision] = await svc.listRevisions(routine.id);
    expect(initialRevision?.snapshot.routine.env).toEqual(routine.env);

    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, routine.id));
    const repaired = await svc.update(routine.id, { env: routine.env }, {});
    expect(repaired).not.toBeNull();
    const repairedBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, routine.id));
    expect(repairedBindings).toMatchObject([
      {
        companyId,
        secretId: secret.id,
        targetType: "routine",
        configPath: "env.ROUTINE_API_KEY",
      },
    ]);

    const currentRoutine = repaired ?? routine;
    const runBefore = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runBefore.routineRevisionId).toBe(currentRoutine.latestRevisionId);

    const updated = await svc.update(
      routine.id,
      {
        env: {
          ROUTINE_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          ROUTINE_PLAIN: { type: "plain", value: "changed" },
        },
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(currentRoutine.latestRevisionNumber + 1);

    const runAfter = await svc.runRoutine(routine.id, { source: "manual" });
    expect(runAfter.routineRevisionId).toBe(updated?.latestRevisionId);
    expect(runAfter.dispatchFingerprint).not.toBe(runBefore.dispatchFingerprint);
  });

  it("rejects stale routine baseRevisionId updates", async () => {
    const { routine, svc } = await seedFixture();
    const updated = await svc.update(routine.id, { description: "new description" }, {});
    await expect(
      svc.update(routine.id, {
        title: "stale update",
        baseRevisionId: routine.latestRevisionId,
      }, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: updated?.latestRevisionId,
      },
    });
  });

  it("restores an older routine revision append-only and preserves run history", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const revision2Routine = await svc.update(routine.id, { description: "revision 2" }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("rejects restoring the current latest routine revision", async () => {
    const { routine, svc } = await seedFixture();

    await expect(
      svc.restoreRevision(routine.id, routine.latestRevisionId!, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: routine.latestRevisionId,
      },
    });
  });

  it("recreates deleted webhook trigger secrets when restoring a historical revision", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    await svc.deleteTrigger(created.trigger.id, {});
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const restored = await svc.restoreRevision(routine.id, created.revision.id, {});

    expect(restored.secretMaterials).toHaveLength(1);
    expect(restored.secretMaterials[0]).toMatchObject({
      triggerId: created.trigger.id,
    });
    expect(restored.secretMaterials[0]?.webhookSecret).toBeTruthy();
    expect(restored.secretMaterials[0]?.webhookUrl).toContain("/api/routine-triggers/public/");

    const restoredTrigger = await svc.getTrigger(created.trigger.id);
    expect(restoredTrigger?.secretId).toBeTruthy();
    expect(restoredTrigger?.publicId).toBeTruthy();
    expect(restoredTrigger?.publicId).not.toBe(created.trigger.publicId);
  });

  it("persists custom schedule cron expressions exactly", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const cronExpression = "0 8-18/2 * * 1-5";

    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      label: "Business hours",
      cronExpression,
      timezone: "UTC",
    }, {});

    expect(created.trigger.cronExpression).toBe(cronExpression);

    const storedTrigger = await svc.getTrigger(created.trigger.id);
    expect(storedTrigger?.cronExpression).toBe(cronExpression);

    const [listed] = await svc.list(companyId);
    expect(listed?.triggers[0]?.cronExpression).toBe(cronExpression);
  });

  it("blocks agents from restoring routine revisions assigned to another agent", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revision1Id = routine.latestRevisionId!;

    await svc.update(routine.id, { assigneeAgentId: otherAgentId }, {});

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { agentId: otherAgentId }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agents can only restore routine revisions assigned to themselves",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: otherAgentId,
      latestRevisionNumber: 2,
    });
  });

  it("blocks restoring routine revisions assigned to agents that are no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    await svc.update(routine.id, { description: "revision 2" }, {});
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
    });
  });

  it("blocks routine reassignment to agents under terminated managers", async () => {
    const { agentId, companyId, routine, svc } = await seedFixture();
    const terminatedManagerId = randomUUID();
    const blockedAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: terminatedManagerId,
        companyId,
        name: "TerminatedManager",
        role: "manager",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAgentId,
        companyId,
        name: "BlockedRoutineCoder",
        role: "engineer",
        status: "active",
        reportsTo: terminatedManagerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await expect(svc.update(routine.id, {
      assigneeAgentId: blockedAgentId,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "ancestor_terminated",
        assigneeAgentId: blockedAgentId,
        invalidAncestorAgentId: terminatedManagerId,
      },
    });

    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: agentId,
    });
  });

  it("blocks manual routine runs when the persisted assignee is no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(svc.runRoutine(routine.id, {
      source: "manual",
      payload: null,
      variables: null,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: agentId,
      },
    });
  });

  it("appends safe trigger metadata revisions without leaking webhook secrets", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    expect(created.revision.revisionNumber).toBe(2);
    expect(created.secretMaterial?.webhookSecret).toBeTruthy();

    const updated = await svc.updateTrigger(created.trigger.id, { label: "deploy hook" }, {});
    expect(updated?.revision.revisionNumber).toBe(3);

    const rotated = await svc.rotateTriggerSecret(created.trigger.id, {});
    expect(rotated.revision.revisionNumber).toBe(4);
    expect(rotated.secretMaterial.webhookSecret).toBeTruthy();

    const deleted = await svc.deleteTrigger(created.trigger.id, {});
    expect(deleted.revision?.revisionNumber).toBe(5);
    await expect(db.select().from(companySecrets).where(eq(companySecrets.id, created.trigger.secretId!))).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, created.trigger.secretId!))).resolves.toHaveLength(0);

    const revisions = await svc.listRevisions(routine.id);
    const serialized = JSON.stringify(revisions.map((revision) => revision.snapshot));
    expect(serialized).toContain(created.trigger.publicId!);
    expect(serialized).not.toContain(created.secretMaterial!.webhookSecret);
    expect(serialized).not.toContain(rotated.secretMaterial.webhookSecret);
    expect(serialized).not.toContain(created.trigger.secretId!);
    expect(revisions[0]?.snapshot.triggers).toHaveLength(0);
  });

  it("applies trigger and revision CAS atomically and rejects stale or racing writers without partial history", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 8 * * *",
      timezone: "UTC",
    }, {});
    const baseRevisionId = created.revision.id;
    const before = await svc.listRevisions(routine.id);

    const stale = await svc.updateTrigger(created.trigger.id, {
      enabled: false,
      baseRevisionId: routine.latestRevisionId,
    }, {}).catch((error) => error);
    expect(stale).toMatchObject({
      status: 409,
      details: { currentRevisionId: baseRevisionId },
    });
    expect((await svc.getTrigger(created.trigger.id))?.enabled).toBe(true);
    expect(await svc.listRevisions(routine.id)).toHaveLength(before.length);

    const raced = await Promise.allSettled([
      svc.updateTrigger(created.trigger.id, {
        label: "winner-a",
        baseRevisionId,
      }, {}),
      svc.updateTrigger(created.trigger.id, {
        label: "winner-b",
        baseRevisionId,
      }, {}),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = raced.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    const after = await svc.listRevisions(routine.id);
    expect(after).toHaveLength(before.length + 1);
    const currentRoutine = await svc.get(routine.id);
    expect(currentRoutine?.latestRevisionId).toBe(after[0]?.id);
    const winner = raced.find((result) => result.status === "fulfilled");
    if (winner?.status === "fulfilled") {
      expect(winner.value?.revision.id).toBe(currentRoutine?.latestRevisionId);
    }
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(await db.select().from(routineRunDeliveries).where(eq(routineRunDeliveries.routineRunId, run.id)))
      .toEqual([expect.objectContaining({ status: "delivered", lastError: null })]);

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          idempotencyKey: expect.stringMatching(/^routine-delivery:/),
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("uses the injected delivery clock for dispatch and delivery timestamps", async () => {
    const clock = new Date("2035-01-02T03:04:05.000Z");
    const { routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
    });

    const dispatched = await svc.runRoutine(routine.id, { source: "manual" });
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, dispatched.id));
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, dispatched.id));

    expect(run?.triggeredAt.getTime()).toBe(clock.getTime());
    expect(delivery?.availableAt.getTime()).toBe(clock.getTime());
    expect(delivery?.deliveredAt?.getTime()).toBe(clock.getTime());
  });

  it("publishes the execution issue and linked routine-run receipt in one commit before wakeup", async () => {
    let observed: {
      issueId: string;
      originRunId: string | null;
      runId: string | null;
      runStatus: string | null;
      linkedIssueId: string | null;
    } | null = null;
    const { routine, svc } = await seedFixture({
      wakeup: async (_agentId, wakeupOpts) => {
        const issueId = typeof wakeupOpts.payload?.issueId === "string"
          ? wakeupOpts.payload.issueId
          : null;
        expect(issueId).toBeTruthy();
        const issue = await db
          .select({ id: issues.id, originRunId: issues.originRunId })
          .from(issues)
          .where(eq(issues.id, issueId!))
          .then((rows) => rows[0] ?? null);
        const receipt = issue?.originRunId
          ? await db
              .select({
                id: routineRuns.id,
                status: routineRuns.status,
                linkedIssueId: routineRuns.linkedIssueId,
              })
              .from(routineRuns)
              .where(sql`${routineRuns.id}::text = ${issue.originRunId}`)
              .then((rows) => rows[0] ?? null)
          : null;
        observed = {
          issueId: issue?.id ?? issueId!,
          originRunId: issue?.originRunId ?? null,
          runId: receipt?.id ?? null,
          runStatus: receipt?.status ?? null,
          linkedIssueId: receipt?.linkedIssueId ?? null,
        };
        return { id: randomUUID() };
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(observed).toEqual({
      issueId: run.linkedIssueId,
      originRunId: run.id,
      runId: run.id,
      runStatus: "received",
      linkedIssueId: run.linkedIssueId,
    });
  });

  it("deduplicates a repeated idempotency key while the first wakeup is still pending", async () => {
    let reportWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => {
      reportWakeStarted = resolve;
    });
    let releaseWake!: () => void;
    const releaseWakeGate = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        reportWakeStarted();
        await releaseWakeGate;
        return { id: randomUUID() };
      },
    });
    const idempotencyKey = `pending-wake-${randomUUID()}`;

    try {
      const firstPromise = svc.runRoutine(routine.id, {
        source: "manual",
        idempotencyKey,
      });
      await wakeStarted;
      const duplicate = await svc.runRoutine(routine.id, {
        source: "manual",
        idempotencyKey,
      });
      releaseWake();
      const first = await firstPromise;

      expect(duplicate.id).toBe(first.id);
      expect(first.status).toBe("issue_created");
      const persistedRuns = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.idempotencyKey, idempotencyKey));
      expect(persistedRuns).toHaveLength(1);
      const persistedIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.originId, routine.id));
      expect(persistedIssues).toEqual([{ id: first.linkedIssueId }]);
    } finally {
      releaseWake();
    }
  });

  it("records the manual board runner on fresh routine issues so they appear in that user's inbox", async () => {
    const { companyId, agentId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [createdIssue] = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        createdByUserId: issues.createdByUserId,
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
      responsibleUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("uses the routine revision responsible-user snapshot for automatic runs", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const responsibleUserId = randomUUID();
    const driftUserId = randomUUID();
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "snapshotted owner routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      { userId: responsibleUserId },
    );

    await db
      .update(routines)
      .set({ responsibleUserId: driftUserId, updatedAt: new Date() })
      .where(eq(routines.id, routine.id));

    const run = await svc.runRoutine(routine.id, { source: "schedule" });

    expect(run.status).toBe("issue_created");
    expect(run.responsibleUserId).toBe(responsibleUserId);
    const [createdIssue] = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue?.responsibleUserId).toBe(responsibleUserId);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return { id: randomUUID() };
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("touches a coalesced routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("touches a skipped active routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("does not coalesce live routine runs with different resolved variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "pre-pr for {{branch}}",
        description: "Create a pre-PR from {{branch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "branch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const first = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/a" },
    });
    const second = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/b" },
    });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originId, variableRoutine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.title).sort()).toEqual([
      "pre-pr for feature/a",
      "pre-pr for feature/b",
    ]);
    expect(new Set(routineIssues.map((issue) => issue.originFingerprint)).size).toBe(2);
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
  });

  it("infers capital-Date variables, preserves builtin date, and validates submitted date values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const dateRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "date check {{startDate}} on {{date}}",
        description: "Range {{startDate}} to {{endDate}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(dateRoutine.variables).toEqual([
      { name: "startDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
      { name: "endDate", label: null, type: "date", defaultValue: null, required: true, options: [] },
    ]);

    await expect(
      svc.runRoutine(dateRoutine.id, {
        source: "manual",
        variables: { startDate: "2024-02-30", endDate: "2024-03-01" },
      }),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);

    const run = await svc.runRoutine(dateRoutine.id, {
      source: "manual",
      variables: { startDate: "2024-02-29", endDate: "2024-03-01" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toMatch(/^date check 2024-02-29 on \d{4}-\d{2}-\d{2}$/);
    expect(storedIssue?.description).toBe("Range 2024-02-29 to 2024-03-01");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        startDate: "2024-02-29",
        endDate: "2024-03-01",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("auto-populates workspaceBranch from a reused isolated workspace", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
      branchName: "pap-1634-routine-branch",
    });

    const branchRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Review {{workspaceBranch}}",
        description: "Use branch {{workspaceBranch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const run = await svc.runRoutine(branchRoutine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("Review pap-1634-routine-branch");
    expect(storedIssue?.description).toBe("Use branch pap-1634-routine-branch");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("rejects invalid date defaults before persisting routine variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();

    await expect(
      svc.create(
        companyId,
        {
          projectId,
          goalId: null,
          parentIssueId: null,
          title: "date check {{startDate}}",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [
            { name: "startDate", label: null, type: "date", defaultValue: "2024-02-30", required: true, options: [] },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/valid YYYY-MM-DD date/i);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("keeps Agent before Routine lock order when dispatch races trigger revision update", async () => {
    const { routine, svc } = await seedFixture();
    const createdTrigger = await svc.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 8 * * *",
      timezone: "UTC",
      enabled: true,
    }, {});
    const agentId = routine.assigneeAgentId!;
    const blockerDb = createDb(tempDb!.connectionString);
    const updateDb = createDb(tempDb!.connectionString);
    const dispatchDb = createDb(tempDb!.connectionString);
    const observerDb = createDb(tempDb!.connectionString);
    await updateDb.execute(sql`set lock_timeout = '3s'`);
    await dispatchDb.execute(sql`set lock_timeout = '3s'`);
    const updateSvc = routineService(updateDb, { heartbeat: { wakeup: async () => null } });
    const dispatchSvc = routineService(dispatchDb, { heartbeat: { wakeup: async () => null } });
    let releaseAgentLock!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseAgentLock = resolve;
    });
    let reportAgentLocked!: () => void;
    const agentLockedGate = new Promise<void>((resolve) => {
      reportAgentLocked = resolve;
    });
    const blocker = blockerDb.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      reportAgentLocked();
      await releaseGate;
    });

    const waitForBlockedLocks = async (minimum: number) => {
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const [row] = await observerDb.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_locks where granted = false
        `);
        if ((row?.waiting ?? 0) >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${minimum} blocked locks`);
    };

    try {
      await agentLockedGate;
      const triggerUpdateOutcome = updateSvc.updateTrigger(createdTrigger.trigger.id, {
        label: "revision-race-winner",
        baseRevisionId: createdTrigger.revision.id,
      }, {}).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForBlockedLocks(1);

      const dispatchOutcome = dispatchSvc.runRoutine(routine.id, {
        source: "manual",
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForBlockedLocks(2);
      releaseAgentLock();
      await blocker;

      const [triggerUpdate, dispatch] = await Promise.all([triggerUpdateOutcome, dispatchOutcome]);
      expect(triggerUpdate.status).toBe("fulfilled");
      expect(dispatch.status).toBe("rejected");
      if (dispatch.status === "rejected") {
        expect(dispatch.error).toMatchObject({
          status: 409,
          details: {
            code: "routine_dispatch_snapshot_drift",
            field: "latestRevisionId",
          },
        });
      }
      await expect(
        db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)),
      ).resolves.toHaveLength(0);
      await expect(
        db.select().from(issues).where(eq(issues.originId, routine.id)),
      ).resolves.toHaveLength(0);
    } finally {
      releaseAgentLock();
      await blocker.catch(() => undefined);
      await Promise.all([
        blockerDb.$client.end(),
        updateDb.$client.end(),
        dispatchDb.$client.end(),
        observerDb.$client.end(),
      ]);
    }
  }, 20_000);

  it("lets Agent-first termination win a concurrent dispatch without deadlock or partial run", async () => {
    const { routine } = await seedFixture();
    const agentId = routine.assigneeAgentId!;
    const blockerDb = createDb(tempDb!.connectionString);
    const dispatchDb = createDb(tempDb!.connectionString);
    const observerDb = createDb(tempDb!.connectionString);
    await dispatchDb.execute(sql`set lock_timeout = '3s'`);
    const dispatchSvc = routineService(dispatchDb, { heartbeat: { wakeup: async () => null } });
    let allowDependencyLock!: () => void;
    const dependencyLockGate = new Promise<void>((resolve) => {
      allowDependencyLock = resolve;
    });
    let reportAgentLocked!: () => void;
    const agentLockedGate = new Promise<void>((resolve) => {
      reportAgentLocked = resolve;
    });
    const blocker = blockerDb.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      reportAgentLocked();
      await dependencyLockGate;
      await tx.execute(sql`select id from routines where id = ${routine.id} for update`);
      await tx.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
    });

    try {
      await agentLockedGate;
      let dispatchSettled = false;
      const dispatchOutcome = dispatchSvc.runRoutine(routine.id, {
        source: "manual",
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ).finally(() => {
        dispatchSettled = true;
      });

      let observedBlockedLock = false;
      for (let attempt = 0; attempt < 250 && !dispatchSettled; attempt += 1) {
        const [row] = await observerDb.execute<{ blocked: boolean }>(sql`
          select exists(select 1 from pg_locks where granted = false) as blocked
        `);
        if (row?.blocked) {
          observedBlockedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlockedLock).toBe(true);
      allowDependencyLock();
      await blocker;
      const dispatch = await dispatchOutcome;
      expect(dispatch.status).toBe("rejected");
      if (dispatch.status === "rejected") {
        expect(dispatch.error).toMatchObject({
          status: 409,
          details: { code: "agent_lifecycle_reference_forbidden", reason: "terminated" },
        });
      }
      await expect(
        db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)),
      ).resolves.toHaveLength(0);
      await expect(
        db.select().from(issues).where(eq(issues.originId, routine.id)),
      ).resolves.toHaveLength(0);
    } finally {
      allowDependencyLock();
      await blocker.catch(() => undefined);
      await Promise.all([
        blockerDb.$client.end(),
        dispatchDb.$client.end(),
        observerDb.$client.end(),
      ]);
    }
  }, 20_000);

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      routineDeliveryMaxAttempts: 1,
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("treats a heartbeat noop as a skipped delivery and never marks issue_created", async () => {
    const { routine, svc } = await seedFixture({
      routineDeliveryMaxAttempts: 1,
      wakeup: async () => null,
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const delivery = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id)).then((rows) => rows[0]);

    expect(run.status).toBe("failed");
    expect(run.linkedIssueId).toBeNull();
    expect(delivery).toMatchObject({ status: "failed", issueId: null, attemptCount: 1 });
    expect(delivery?.lastError).toContain("heartbeat_noop");
  });

  it("does not finalize a queued receipt without exact durable wake evidence", async () => {
    const { routine, svc } = await seedFixture({
      routineDeliveryMaxAttempts: 3,
      routineDeliveryRetryBaseMs: 0,
      persistCustomWakeEvidence: false,
      wakeup: async () => ({ id: randomUUID() }),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const delivery = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id)).then((rows) => rows[0]);

    expect(run.status).toBe("received");
    expect(delivery).toMatchObject({
      status: "pending",
      attemptCount: 1,
      deliveredAt: null,
    });
    expect(delivery?.lastError).toMatch(/exact durable wake evidence/i);
  });

  it("redacts and bounds adapter failures before storing delivery diagnostics", async () => {
    const secret = "sk-live-routine-delivery-secret";
    const { routine, svc } = await seedFixture({
      routineDeliveryMaxAttempts: 1,
      wakeup: async () => {
        throw new Error(`export OPENAI_API_KEY=${secret} ${"x".repeat(2_000)}`);
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id));

    expect(delivery).toMatchObject({ status: "failed" });
    expect(delivery?.lastError).not.toContain(secret);
    expect(delivery?.lastError?.length).toBeLessThanOrEqual(1_024);
  });

  it("defers a paused assignee without consuming another delivery attempt or invoking heartbeat", async () => {
    let clock = new Date("2026-07-14T15:00:00.000Z");
    let wakeCalls = 0;
    const { agentId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      wakeup: async () => {
        wakeCalls += 1;
        throw new Error("seed pending delivery");
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [before] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const callsBefore = wakeCalls;
    clock = new Date(clock.getTime() + 1_000);

    await svc.processRunDelivery(before!.id);

    const [after] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.id, before!.id));
    expect(after).toMatchObject({ status: "pending", attemptCount: before!.attemptCount });
    expect(after?.availableAt.getTime()).toBe(clock.getTime() + 30_000);
    expect(after?.lastError).toMatch(/agent is paused/i);
    expect(wakeCalls).toBe(callsBefore);
  });

  it("defers a maintenance-gated assignee without consuming another delivery attempt", async () => {
    let clock = new Date("2026-07-14T15:10:00.000Z");
    let wakeCalls = 0;
    const { companyId, agentId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      wakeup: async () => {
        wakeCalls += 1;
        throw new Error("seed pending delivery");
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [before] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id));
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId,
      agentId,
      operationId: `test-${randomUUID()}`,
      expectedSnapshotFingerprint: "snapshot",
      recoveryFingerprint: "recovery",
      receiptId: `receipt-${randomUUID()}`,
      stage: "quiesced",
      issuedByUserId: "test-board-user",
    });
    const callsBefore = wakeCalls;
    clock = new Date(clock.getTime() + 1_000);

    await svc.processRunDelivery(before!.id);

    const [after] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.id, before!.id));
    expect(after).toMatchObject({ status: "pending", attemptCount: before!.attemptCount });
    expect(after?.lastError).toMatch(/maintenance gate/i);
    expect(wakeCalls).toBe(callsBefore);
  });

  it("retries a durable pending delivery and finalizes only after wake acceptance", async () => {
    let clock = new Date("2026-07-14T10:00:00.000Z");
    let failWake = true;
    const { routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      routineDeliveryMaxAttempts: 3,
      wakeup: async () => {
        if (failWake) throw new Error("transient queue outage");
        return { id: randomUUID() };
      },
    });

    const first = await svc.runRoutine(routine.id, { source: "manual" });
    const pending = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, first.id)).then((rows) => rows[0]);
    expect(first.status).toBe("received");
    expect(pending).toMatchObject({ status: "pending", attemptCount: 1 });

    failWake = false;
    clock = new Date(clock.getTime() + 1_000);
    const result = await svc.reconcileRunDeliveries();
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, first.id));
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, first.id));
    expect(result).toMatchObject({ scanned: 1, delivered: 1 });
    expect(run?.status).toBe("issue_created");
    expect(delivery).toMatchObject({ status: "delivered", attemptCount: 2, lastError: null });
  });

  it("allows only one worker to own a non-expired delivery claim", async () => {
    let clock = new Date("2026-07-14T11:00:00.000Z");
    let phase: "fail" | "block" = "fail";
    let acceptedWakeCount = 0;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      routineDeliveryClaimLeaseMs: 60_000,
      wakeup: async () => {
        if (phase === "fail") throw new Error("seed pending delivery");
        acceptedWakeCount += 1;
        reportStarted();
        await gate;
        return { id: randomUUID() };
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const delivery = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id)).then((rows) => rows[0])!;
    phase = "block";
    clock = new Date(clock.getTime() + 1_000);

    const firstWorker = svc.processRunDelivery(delivery.id);
    await started;
    const secondWorker = svc.processRunDelivery(delivery.id);
    release();
    await Promise.all([firstWorker, secondWorker]);

    expect(acceptedWakeCount).toBe(1);
    expect(await db.select().from(routineRunDeliveries).where(eq(routineRunDeliveries.id, delivery.id)))
      .toEqual([expect.objectContaining({ status: "delivered", attemptCount: 2 })]);
  });

  it("starts a full claim lease from the post-lock clock and prevents a waiting worker from stealing it", async () => {
    let clock = new Date("2035-02-03T04:05:06.000Z");
    let phase: "fail" | "block" = "fail";
    let acceptedWakeCount = 0;
    let reportWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => { reportWakeStarted = resolve; });
    let releaseWake!: () => void;
    const wakeGate = new Promise<void>((resolve) => { releaseWake = resolve; });
    const { agentId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      routineDeliveryClaimLeaseMs: 60_000,
      wakeup: async () => {
        if (phase === "fail") throw new Error("seed pending delivery");
        acceptedWakeCount += 1;
        reportWakeStarted();
        await wakeGate;
        return { id: randomUUID() };
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id));
    phase = "block";
    clock = new Date(clock.getTime() + 1_000);

    const blockerDb = createDb(tempDb!.connectionString);
    const observerDb = createDb(tempDb!.connectionString);
    let reportAgentLocked!: () => void;
    const agentLocked = new Promise<void>((resolve) => { reportAgentLocked = resolve; });
    let releaseAgentLock!: () => void;
    const agentLockGate = new Promise<void>((resolve) => { releaseAgentLock = resolve; });
    const blocker = blockerDb.transaction(async (tx) => {
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      reportAgentLocked();
      await agentLockGate;
    });
    let firstWorker: Promise<unknown> | null = null;
    let secondWorker: Promise<unknown> | null = null;

    try {
      await agentLocked;
      firstWorker = svc.processRunDelivery(delivery!.id);
      let observedBlockedLock = false;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const [row] = await observerDb.execute<{ blocked: boolean }>(sql`
          select exists(select 1 from pg_locks where granted = false) as blocked
        `);
        if (row?.blocked) {
          observedBlockedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlockedLock).toBe(true);

      clock = new Date(clock.getTime() + 120_000);
      const lockedNow = new Date(clock);
      releaseAgentLock();
      await blocker;
      await wakeStarted;

      const [claimed] = await db.select().from(routineRunDeliveries)
        .where(eq(routineRunDeliveries.id, delivery!.id));
      expect(claimed).toMatchObject({ status: "claimed", attemptCount: 2 });
      expect(claimed?.claimedAt?.getTime()).toBe(lockedNow.getTime());
      expect(claimed?.claimExpiresAt?.getTime()).toBe(lockedNow.getTime() + 60_000);

      secondWorker = svc.processRunDelivery(delivery!.id);
      const secondOutcome = await Promise.race([
        secondWorker.then(() => "completed" as const),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 500)),
      ]);
      expect(secondOutcome).toBe("completed");
      expect(acceptedWakeCount).toBe(1);

      releaseWake();
      await Promise.all([firstWorker, secondWorker]);
      await expect(db.select().from(routineRunDeliveries)
        .where(eq(routineRunDeliveries.id, delivery!.id)))
        .resolves.toEqual([expect.objectContaining({ status: "delivered", attemptCount: 2 })]);
    } finally {
      releaseAgentLock();
      releaseWake();
      await blocker.catch(() => undefined);
      await Promise.allSettled([firstWorker, secondWorker].filter(Boolean) as Promise<unknown>[]);
      await Promise.all([blockerDb.$client.end(), observerDb.$client.end()]);
    }
  }, 20_000);

  it.each(["paused", "maintenance-gated"] as const)(
    "defers a %s assignee from the post-lock clock without a hot loop",
    async (deferMode) => {
      let clock = new Date("2035-03-04T05:06:07.000Z");
      let wakeCalls = 0;
      const { companyId, agentId, routine, svc } = await seedFixture({
        routineDeliveryNow: () => new Date(clock),
        routineDeliveryRetryBaseMs: 0,
        wakeup: async () => {
          wakeCalls += 1;
          throw new Error("seed pending delivery");
        },
      });
      const run = await svc.runRoutine(routine.id, { source: "manual" });
      const [delivery] = await db.select().from(routineRunDeliveries)
        .where(eq(routineRunDeliveries.routineRunId, run.id));
      if (deferMode === "paused") {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      } else {
        await db.insert(agentPortfolioMaintenanceGates).values({
          companyId,
          agentId,
          operationId: `test-${randomUUID()}`,
          expectedSnapshotFingerprint: "snapshot",
          recoveryFingerprint: "recovery",
          receiptId: `receipt-${randomUUID()}`,
          stage: "quiesced",
          issuedByUserId: "test-board-user",
        });
      }
      const wakeCallsBeforeDefer = wakeCalls;
      clock = new Date(clock.getTime() + 1_000);

      const blockerDb = createDb(tempDb!.connectionString);
      const observerDb = createDb(tempDb!.connectionString);
      let reportAgentLocked!: () => void;
      const agentLocked = new Promise<void>((resolve) => { reportAgentLocked = resolve; });
      let releaseAgentLock!: () => void;
      const agentLockGate = new Promise<void>((resolve) => { releaseAgentLock = resolve; });
      const blocker = blockerDb.transaction(async (tx) => {
        await tx.execute(sql`select id from agents where id = ${agentId} for update`);
        reportAgentLocked();
        await agentLockGate;
      });
      let worker: Promise<unknown> | null = null;

      try {
        await agentLocked;
        worker = svc.processRunDelivery(delivery!.id);
        let observedBlockedLock = false;
        for (let attempt = 0; attempt < 250; attempt += 1) {
          const [row] = await observerDb.execute<{ blocked: boolean }>(sql`
            select exists(select 1 from pg_locks where granted = false) as blocked
          `);
          if (row?.blocked) {
            observedBlockedLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedBlockedLock).toBe(true);

        clock = new Date(clock.getTime() + 120_000);
        const lockedNow = new Date(clock);
        releaseAgentLock();
        await blocker;
        await worker;

        const [afterFirstDefer] = await db.select().from(routineRunDeliveries)
          .where(eq(routineRunDeliveries.id, delivery!.id));
        expect(afterFirstDefer).toMatchObject({
          status: "pending",
          attemptCount: delivery!.attemptCount,
        });
        expect(afterFirstDefer?.availableAt.getTime()).toBe(lockedNow.getTime() + 30_000);
        expect(wakeCalls).toBe(wakeCallsBeforeDefer);

        await svc.processRunDelivery(delivery!.id);
        const [afterImmediateRetry] = await db.select().from(routineRunDeliveries)
          .where(eq(routineRunDeliveries.id, delivery!.id));
        expect(afterImmediateRetry?.availableAt.getTime()).toBe(afterFirstDefer?.availableAt.getTime());
        expect(afterImmediateRetry?.updatedAt.getTime()).toBe(afterFirstDefer?.updatedAt.getTime());
        expect(wakeCalls).toBe(wakeCallsBeforeDefer);
      } finally {
        releaseAgentLock();
        await blocker.catch(() => undefined);
        if (worker) await worker.catch(() => undefined);
        await Promise.all([blockerDb.$client.end(), observerDb.$client.end()]);
      }
    },
    20_000,
  );

  it("adopts exact durable wake evidence after a claimed-worker crash", async () => {
    let clock = new Date("2026-07-14T12:00:00.000Z");
    let wakeCalls = 0;
    const { companyId, agentId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      routineDeliveryClaimLeaseMs: 1_000,
      wakeup: async () => {
        wakeCalls += 1;
        throw new Error("seed pending delivery");
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const pending = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id)).then((rows) => rows[0])!;
    clock = new Date(clock.getTime() + 1_000);
    const claimed = await svc.claimRunDelivery(pending.id);
    expect(claimed?.delivery.status).toBe("claimed");

    const wakeupRequestId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: pending.issueId, mutation: "create" },
      status: "queued",
      idempotencyKey: pending.wakeupIdempotencyKey,
      runId: heartbeatRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: randomUUID(),
      wakeupRequestId,
      contextSnapshot: { issueId: pending.issueId },
    });
    const callsBeforeRecovery = wakeCalls;
    clock = new Date(clock.getTime() + 2_000);

    const result = await svc.reconcileRunDeliveries();
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.id, pending.id));
    expect(result).toMatchObject({ delivered: 1 });
    expect(wakeCalls).toBe(callsBeforeRecovery);
    expect(delivery).toMatchObject({
      status: "delivered",
      deliveredWakeupRequestId: wakeupRequestId,
      deliveredHeartbeatRunId: heartbeatRunId,
    });
  });

  it("retains delivered wake evidence while the delivery receipt references it", async () => {
    const { routine, svc } = await seedFixture();
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id));

    const deletion = await db.delete(heartbeatRuns)
      .where(eq(heartbeatRuns.id, delivery!.deliveredHeartbeatRunId!))
      .then(() => null, (error: unknown) => error);

    expect(deletion).toBeTruthy();
    expect(String((deletion as { cause?: unknown }).cause ?? deletion))
      .toMatch(/routine_delivery_heartbeat_evidence_is_immutable/i);
    await expect(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, delivery!.deliveredHeartbeatRunId!)))
      .resolves.toEqual([{ id: delivery!.deliveredHeartbeatRunId }]);
  });

  it("fails a leader and every coalesced follower atomically when delivery is skipped", async () => {
    let clock = new Date("2026-07-14T13:00:00.000Z");
    let noop = false;
    const { companyId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      wakeup: async () => {
        if (!noop) throw new Error("seed pending delivery");
        return null;
      },
    });
    const leader = await svc.runRoutine(routine.id, { source: "manual" });
    const followerId = randomUUID();
    await db.insert(routineRuns).values({
      id: followerId,
      companyId,
      routineId: routine.id,
      source: "manual",
      status: "coalesced",
      linkedIssueId: leader.linkedIssueId,
      coalescedIntoRunId: leader.id,
      completedAt: clock,
    });
    const delivery = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, leader.id)).then((rows) => rows[0])!;
    noop = true;
    clock = new Date(clock.getTime() + 1_000);
    await svc.processRunDelivery(delivery.id);

    const runs = await db.select().from(routineRuns).where(sql`${routineRuns.id} in (${leader.id}, ${followerId})`);
    expect(runs).toHaveLength(2);
    expect(runs.every((row) => row.status === "failed" && row.linkedIssueId === null)).toBe(true);
    expect(await db.select().from(issues).where(eq(issues.id, leader.linkedIssueId!))).toHaveLength(0);
  });

  it("rolls back follower cleanup when the delivery terminal CAS is suppressed", async () => {
    let clock = new Date("2026-07-14T15:20:00.000Z");
    let noop = false;
    const { companyId, routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      routineDeliveryMaxAttempts: 3,
      wakeup: async () => {
        if (!noop) throw new Error("seed pending delivery");
        return null;
      },
    });
    const leader = await svc.runRoutine(routine.id, { source: "manual" });
    const [delivery] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, leader.id));
    const followerId = randomUUID();
    await db.insert(routineRuns).values({
      id: followerId,
      companyId,
      routineId: routine.id,
      source: "manual",
      status: "coalesced",
      linkedIssueId: leader.linkedIssueId,
      coalescedIntoRunId: leader.id,
      completedAt: clock,
    });
    await db.execute(sql.raw(`
      create or replace function suppress_routine_delivery_failed_cas() returns trigger
      language plpgsql as $$ begin return null; end $$;
      create trigger suppress_routine_delivery_failed_cas_trigger
      before update on routine_run_deliveries
      for each row when (new.status = 'failed')
      execute function suppress_routine_delivery_failed_cas();
    `));
    noop = true;
    clock = new Date(clock.getTime() + 1_000);

    try {
      await svc.processRunDelivery(delivery!.id);
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists suppress_routine_delivery_failed_cas_trigger on routine_run_deliveries;
        drop function if exists suppress_routine_delivery_failed_cas();
      `));
    }

    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, followerId)))
      .resolves.toEqual([expect.objectContaining({
        status: "coalesced",
        linkedIssueId: leader.linkedIssueId,
        coalescedIntoRunId: leader.id,
      })]);
    await expect(db.select().from(routineRunDeliveries).where(eq(routineRunDeliveries.id, delivery!.id)))
      .resolves.toEqual([expect.objectContaining({ status: "pending" })]);
    await expect(db.select().from(issues).where(eq(issues.id, leader.linkedIssueId!)))
      .resolves.toHaveLength(1);
  });

  it("quarantines one poisoned delivery and continues the reconciliation batch", async () => {
    let clock = new Date("2026-07-14T15:30:00.000Z");
    let failWake = true;
    const { routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      wakeup: async () => {
        if (failWake) throw new Error("seed pending delivery");
        return { id: randomUUID() };
      },
    });
    await db.update(routines).set({ concurrencyPolicy: "always_enqueue" })
      .where(eq(routines.id, routine.id));
    const first = await svc.runRoutine(routine.id, { source: "manual" });
    const second = await svc.runRoutine(routine.id, { source: "manual" });
    const [poison] = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, first.id));
    await db.execute(sql.raw(`
      create sequence routine_delivery_poison_once_seq start 1;
      create or replace function poison_routine_delivery_once() returns trigger
      language plpgsql as $$
      begin
        if nextval('routine_delivery_poison_once_seq') = 1 then
          raise exception 'synthetic_delivery_poison';
        end if;
        return new;
      end $$;
      create trigger poison_routine_delivery_once_trigger
      before update on routine_run_deliveries
      for each row when (new.id = '${poison!.id}'::uuid)
      execute function poison_routine_delivery_once();
    `));
    failWake = false;
    clock = new Date(clock.getTime() + 1_000);

    let result;
    try {
      result = await svc.reconcileRunDeliveries();
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists poison_routine_delivery_once_trigger on routine_run_deliveries;
        drop function if exists poison_routine_delivery_once();
        drop sequence if exists routine_delivery_poison_once_seq;
      `));
    }

    expect(result).toMatchObject({ scanned: 2, delivered: 1, quarantined: 1 });
    await expect(db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.id, poison!.id)))
      .resolves.toEqual([expect.objectContaining({
        status: "pending",
        attemptCount: poison!.attemptCount,
        lastError: expect.stringMatching(/quarantined.*synthetic_delivery_poison/i),
      })]);
    await expect(db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, second.id)))
      .resolves.toEqual([expect.objectContaining({ status: "delivered" })]);
  });

  it("rejects cross-company delivery drift at the database boundary without invoking heartbeat", async () => {
    let clock = new Date("2026-07-14T14:00:00.000Z");
    let wakeCalls = 0;
    const { routine, svc } = await seedFixture({
      routineDeliveryNow: () => new Date(clock),
      routineDeliveryRetryBaseMs: 0,
      wakeup: async () => {
        wakeCalls += 1;
        throw new Error("seed pending delivery");
      },
    });
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const delivery = await db.select().from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.routineRunId, run.id)).then((rows) => rows[0])!;
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other tenant",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const callsBefore = wakeCalls;
    const driftWrite = await db.update(routineRunDeliveries).set({ companyId: otherCompanyId })
      .where(eq(routineRunDeliveries.id, delivery.id)).then(
        () => null,
        (error: unknown) => error,
      );

    expect(driftWrite).toBeTruthy();
    expect(String((driftWrite as { cause?: unknown }).cause ?? driftWrite))
      .toMatch(/routine_run_delivery_identity_mismatch/i);
    await expect(db.select({ companyId: routineRunDeliveries.companyId })
      .from(routineRunDeliveries).where(eq(routineRunDeliveries.id, delivery.id)))
      .resolves.toEqual([{ companyId: routine.companyId }]);
    expect(wakeCalls).toBe(callsBefore);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("uses the configured provider for generated webhook trigger secrets", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") {
        return originalGetSecretProvider(provider);
      }
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v1" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v1",
        }),
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v2",
        }),
        linkExternalSecret: async ({ externalRef, providerVersionRef }) => ({
          material: { source: "external", secretId: externalRef, versionId: providerVersionRef ?? null },
          valueSha256: "external",
          fingerprintSha256: "external",
          externalRef,
          providerVersionRef: providerVersionRef ?? null,
        }),
        resolveVersion: async () => "resolved-secret",
        deleteOrArchive: async () => undefined,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { routine, svc } = await seedFixture();
      const { trigger } = await svc.createTrigger(
        routine.id,
        {
          kind: "webhook",
          signingMode: "hmac_sha256",
          replayWindowSec: 300,
        },
        {},
      );

      const [secret] = await db
        .select({
          id: companySecrets.id,
          provider: companySecrets.provider,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trigger.secretId!));

      expect(secret).toMatchObject({
        id: trigger.secretId,
        provider: "aws_secrets_manager",
      });
    } finally {
      getSecretProviderSpy.mockRestore();
    }
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    });

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("suppresses scheduled ticks while the routine project is paused, then resumes when unpaused", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
      },
      {},
    );

    const pastDue = new Date("2020-01-01T00:00:00.000Z");

    // Pause the project and make the schedule trigger due.
    await db
      .update(projects)
      .set({ pausedAt: new Date(), pauseReason: "manual pause" })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const pausedResult = await svc.tickScheduledTriggers(new Date());
    expect(pausedResult.triggered).toBe(0);

    // No execution issue should be created while paused.
    const issuesWhilePaused = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesWhilePaused).toHaveLength(0);

    // One skipped routine run with pause-specific reason and no linked issue.
    const skippedRuns = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(skippedRuns).toHaveLength(1);
    expect(skippedRuns[0]?.status).toBe("skipped");
    expect(skippedRuns[0]?.source).toBe("schedule");
    expect(skippedRuns[0]?.failureReason).toBe("paused");
    expect(skippedRuns[0]?.linkedIssueId).toBeNull();
    expect(skippedRuns[0]?.completedAt).not.toBeNull();

    // Trigger advanced past the paused firing and audit reflects the pause skip.
    const pausedTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, trigger.id))
      .then((rows) => rows[0]);
    expect(pausedTrigger?.nextRunAt).not.toBeNull();
    expect(pausedTrigger!.nextRunAt!.getTime()).toBeGreaterThan(pastDue.getTime());
    expect(pausedTrigger?.lastResult).toMatch(/paused/i);

    // Unpause and make the trigger due again; a normal tick now creates an issue.
    await db
      .update(projects)
      .set({ pausedAt: null, pauseReason: null })
      .where(eq(projects.id, projectId));
    await db
      .update(routineTriggers)
      .set({ nextRunAt: pastDue })
      .where(eq(routineTriggers.id, trigger.id));

    const resumedResult = await svc.tickScheduledTriggers(new Date());
    expect(resumedResult.triggered).toBe(1);

    const issuesAfterResume = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issuesAfterResume).toHaveLength(1);

    const runsAfterResume = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routine.id));
    expect(runsAfterResume).toHaveLength(2);
    expect(runsAfterResume.some((run) => run.status === "issue_created")).toBe(true);
  });
});

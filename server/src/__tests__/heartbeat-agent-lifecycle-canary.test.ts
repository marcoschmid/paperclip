import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentPortfolioMaintenanceGates,
  agentWakeupRequests,
  agents,
  companySkills,
  companySkillVersions,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  computeAgentLifecycleConfigFingerprint,
  createAgentLifecycleCanaryReceipt,
  hashAgentLifecycleContent,
} from "../services/agent-lifecycle.js";
import { createAgentConfigurationFingerprint } from "../services/effective-run-config-fingerprints.js";
import * as heartbeatModule from "../services/heartbeat.js";
import { portfolioMaintenanceService } from "../services/portfolio-maintenance.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  label: "Lifecycle canary boundary test",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
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
const INSTRUCTIONS = "bounded pending lifecycle canary instructions";

function pendingLifecycle(canaryIssueId: string) {
  return {
    schemaVersion: "1.0.0" as const,
    owner: { ownerType: "board_user" as const, ownerUserId: "better-auth:user-marco" },
    purpose: "Prove one bounded pending lifecycle canary.",
    acceptedTaskTypes: ["bounded canary issue"],
    rejectedTaskTypes: ["all other work"],
    taskSources: ["paperclip:canary"],
    operatingMode: "issue_routed" as const,
    serviceLevel: {
      availabilityClass: "business_hours" as const,
      triageTargetMinutes: 120,
      completionTargetMinutes: 1_440,
      targetExceptionReason: null,
    },
    canaryIssueId,
    lastCanaryAt: null,
    lastCanaryResult: "pending" as const,
    canaryFreshnessDays: 30,
    reviewAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString(),
    retirementCriterion: "Retire only after reviewed replacement evidence.",
    decisionIssueId: randomUUID(),
  };
}

describeEmbeddedPostgres("pending lifecycle canary queue boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-canary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPendingCanary(options: {
    withSkill?: boolean;
    withNullGrant?: boolean;
    issueStatus?: "backlog" | "todo";
    agentId?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = options.agentId ?? randomUUID();
    const canaryIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Canary ${companyId}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const lifecycle = pendingLifecycle(canaryIssueId);
    const permissions = {
      canCreateAgents: false,
      canCreateSkills: true,
      bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: false },
      exception: { kind: "none" },
    };
    let desiredSkills: Array<{ key: string; skillId: string; versionId: string }> = [];
    let skill: { id: string; currentVersionId: string; key: string } | null = null;
    if (options.withSkill) {
      const key = `company/${companyId}/bounded-canary`;
      const [createdSkill] = await db.insert(companySkills).values({
        companyId,
        key,
        slug: `bounded-canary-${companyId.slice(0, 8)}`,
        name: "Bounded canary",
        markdown: "# Bounded canary",
      }).returning();
      const [version] = await db.insert(companySkillVersions).values({
        companyId,
        companySkillId: createdSkill!.id,
        revisionNumber: 1,
        fileInventory: [],
      }).returning();
      await db.update(companySkills).set({ currentVersionId: version!.id }).where(eq(companySkills.id, createdSkill!.id));
      skill = { id: createdSkill!.id, currentVersionId: version!.id, key };
      desiredSkills = [{ key, skillId: createdSkill!.id, versionId: version!.id }];
    }
    const adapterConfig = {
      model: "gpt-5.6-terra",
      promptTemplate: INSTRUCTIONS,
      ...(skill ? { paperclipSkillSync: { desiredSkills: [skill.key] } } : {}),
    };
    const [agent] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Pending canary ${agentId}`,
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
      permissions,
      metadata: { lifecycle },
    }).returning();
    const grants = options.withNullGrant
      ? [{ permissionKey: "tasks:assign", scope: null }]
      : [];
    if (options.withNullGrant) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
      });
    }
    await db.insert(issues).values({
      id: canaryIssueId,
      companyId,
      title: "Lifecycle canary",
      status: options.issueStatus ?? "todo",
      assigneeAgentId: agentId,
      responsibleUserId: "better-auth:user-marco",
    });
    const fingerprintInput = {
      agentId,
      companyId,
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
      permissions,
      grants,
      desiredSkills,
      lifecycle,
      contextPackSha256: hashAgentLifecycleContent(INSTRUCTIONS),
      managedInstructionsSha256: hashAgentLifecycleContent({ "AGENTS.md": INSTRUCTIONS }),
      companyProfileSha256: null,
    };
    const configFingerprint = computeAgentLifecycleConfigFingerprint(fingerprintInput);
    const createReceipt = (runId = randomUUID()) => createAgentLifecycleCanaryReceipt({
      fingerprintInput,
      canaryIssueId,
      runId,
      expectedConfigFingerprint: configFingerprint,
    });
    const agentConfigurationFingerprint = createAgentConfigurationFingerprint({
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
    });
    return {
      agent: agent!,
      agentId,
      companyId,
      canaryIssueId,
      configFingerprint,
      agentConfigurationFingerprint,
      skill,
      createReceipt,
    };
  }

  async function injectUnmediatedActiveConflict(agentId: string, insertConflict: () => Promise<unknown>) {
    const persisted = await db.select({
      status: agents.status,
      metadata: agents.metadata,
    }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    // The DB fence now prevents this drift through every mediated run/wake
    // write. Temporarily remove the fence inputs only to preserve the deeper
    // claim/bootstrap revalidation tests against an already-corrupt snapshot.
    await db.update(agents).set({ status: "idle", metadata: {} }).where(eq(agents.id, agentId));
    try {
      await insertConflict();
    } finally {
      await db.update(agents).set(persisted).where(eq(agents.id, agentId));
    }
  }

  async function recordCanaryIssueDone(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
  }) {
    await db.update(issues).set({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: new Date(),
    }).where(eq(issues.id, input.issueId));
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.agentId,
      runId: input.runId,
      details: {
        status: "done",
        _previous: { status: "in_progress" },
      },
    });
  }

  it("atomically resumes only into the server-bound force-fresh canary run", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const enqueue = (heartbeatModule as Record<string, any>).enqueueLifecycleCanaryRun;

    expect(enqueue).toBeDefined();
    const result = await enqueue(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });

    expect(result.run).toMatchObject({ id: receipt.runId, status: "queued" });
    expect(result.run.contextSnapshot).toMatchObject({
      issueId: seeded.canaryIssueId,
      forceFreshSession: true,
      lifecycleCanary: {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        runId: receipt.runId,
        configFingerprint: receipt.configFingerprint,
        receiptHash: receipt.receiptHash,
      },
    });
    const persistedAgent = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(persistedAgent?.status).toBe("idle");
    expect((persistedAgent?.metadata as Record<string, any>).lifecycleCanaryGate).toEqual(receipt);
    const audit = await db.select().from(activityLog).where(eq(activityLog.runId, receipt.runId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "better-auth:user-marco",
      action: "agent.lifecycle_canary_queued",
      entityType: "agent",
      entityId: seeded.agentId,
      agentId: seeded.agentId,
      runId: receipt.runId,
      details: {
        canaryIssueId: seeded.canaryIssueId,
        runId: receipt.runId,
        configFingerprint: receipt.configFingerprint,
        receiptExpiresAt: receipt.expiresAt,
      },
    });
  });

  it("preserves a null grant scope identically between receipt creation and claim revalidation", async () => {
    const seeded = await seedPendingCanary({ withNullGrant: true, issueStatus: "backlog" });
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const claimedAt = new Date();

    const result = await heartbeatModule.revalidatePendingLifecycleCanaryBoundary(db, {
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      runId: queued.run.id,
      phase: "claim",
      now: claimedAt,
      claim: { responsibleUserId: "better-auth:user-marco", claimedAt },
    });

    expect(result).toMatchObject({ ok: true, pending: true, reason: "authorized" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId));
    expect(issue).toMatchObject({
      status: "in_progress",
      checkoutRunId: queued.run.id,
      executionRunId: queued.run.id,
    });
  });

  it("atomically terminalizes an exact claim-boundary canary failure under portfolio maintenance", async () => {
    const seeded = await seedPendingCanary({ issueStatus: "backlog" });
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"1".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"2".repeat(64)}`,
      receiptId: `v1:sha256:${"3".repeat(64)}`,
      stage: "quiesced",
      issuedByUserId: "better-auth:user-marco",
    });
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "tasks:assign",
      scope: null,
    });

    const result = await heartbeatModule.revalidatePendingLifecycleCanaryBoundary(db, {
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      runId: queued.run.id,
      phase: "claim",
    });

    expect(result).toEqual({ ok: false, pending: true, reason: "fingerprint_mismatch" });
    const [run, wake, agent, issue, comments] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id)).then((rows) => rows[0]),
      db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]),
      db.select().from(issueComments).where(and(
        eq(issueComments.issueId, seeded.canaryIssueId),
        eq(issueComments.createdByRunId, queued.run.id),
      )),
    ]);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "agent_lifecycle_canary_claim_fingerprint_mismatch",
      finishedAt: expect.any(Date),
    });
    expect(wake).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    expect(agent).toMatchObject({ status: "paused", pauseReason: "system" });
    expect((agent!.metadata as Record<string, any>).lifecycle).toMatchObject({
      lastCanaryResult: "failed",
      pause: { outcome: "claim_fingerprint_mismatch", repairIssueId: seeded.canaryIssueId },
    });
    expect(issue).toMatchObject({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toMatch(/^Lifecycle canary failed closed \(claim_fingerprint_mismatch\)\./);
  });

  it("rolls back claim-boundary run and wake cancellation when the failed agent state cannot persist", async () => {
    const seeded = await seedPendingCanary({ issueStatus: "backlog" });
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"1".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"2".repeat(64)}`,
      receiptId: `v1:sha256:${"3".repeat(64)}`,
      stage: "quiesced",
      issuedByUserId: "better-auth:user-marco",
    });
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "tasks:assign",
      scope: null,
    });
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION reject_failed_canary_agent_state() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paused' THEN
          RAISE EXCEPTION 'failed canary agent state unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_failed_canary_agent_state_update
      BEFORE UPDATE ON agents
      FOR EACH ROW EXECUTE FUNCTION reject_failed_canary_agent_state();
    `));
    try {
      await expect(heartbeatModule.revalidatePendingLifecycleCanaryBoundary(db, {
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        runId: queued.run.id,
        phase: "claim",
      })).rejects.toBeDefined();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS reject_failed_canary_agent_state_update ON agents;
        DROP FUNCTION IF EXISTS reject_failed_canary_agent_state();
      `));
    }

    const [run, wake, agent, issue, comments] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id)).then((rows) => rows[0]),
      db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]),
      db.select().from(issueComments).where(and(
        eq(issueComments.issueId, seeded.canaryIssueId),
        eq(issueComments.createdByRunId, queued.run.id),
      )),
    ]);
    expect(run).toMatchObject({ status: "queued", error: null, errorCode: null, finishedAt: null });
    expect(wake).toMatchObject({ status: "queued", error: null, finishedAt: null });
    expect(agent!.status).toBe("idle");
    expect((agent!.metadata as Record<string, any>).lifecycle.lastCanaryResult).toBe("pending");
    expect((agent!.metadata as Record<string, any>).lifecycleCanaryGate).toEqual(receipt);
    expect(issue).toMatchObject({ status: "backlog", checkoutRunId: null, executionRunId: null });
    expect(comments).toHaveLength(0);
  });

  it("binds the exact Home Barista workspace proof into the receipt-bound Home Ops run context", async () => {
    const seeded = await seedPendingCanary({
      agentId: "2f430983-3c02-4e58-90e3-821ae00f80c2",
    });
    const receipt = seeded.createReceipt();
    const proof = {
      schemaVersion: "1.0.0" as const,
      sourceAgentId: "0e989281-9933-47b9-87e5-b6da87d4d0a9" as const,
      replacementSystemRef: "workspace:projects/kaffee" as const,
      scenario: "workspace-project-binding" as const,
      nonce: "a".repeat(32),
      observedRef: "workspace:projects/kaffee:PROJECT.md" as const,
      observedSha256: "b".repeat(64),
    };
    await expect(heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_lifecycle_canary_system_proof_required" },
    });

    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
      systemReplacementProof: proof,
    });
    expect((queued.run.contextSnapshot as Record<string, any>).lifecycleCanary.systemReplacementReceipt)
      .toEqual({
        ...proof,
        runId: receipt.runId,
        canaryIssueId: seeded.canaryIssueId,
        configFingerprint: receipt.configFingerprint,
      });
  });

  it("rolls back the resume, wake, and run when the required audit cannot be written", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION reject_lifecycle_canary_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'agent.lifecycle_canary_queued' THEN
          RAISE EXCEPTION 'lifecycle canary audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_lifecycle_canary_audit_insert
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_canary_audit();
    `));
    try {
      await expect(heartbeatModule.enqueueLifecycleCanaryRun(db, {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        receipt,
        expectedAgentUpdatedAt: seeded.agent.updatedAt,
        requestedByUserId: "better-auth:user-marco",
      })).rejects.toBeDefined();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS reject_lifecycle_canary_audit_insert ON activity_log;
        DROP FUNCTION IF EXISTS reject_lifecycle_canary_audit();
      `));
    }

    const persistedAgent = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(persistedAgent?.status).toBe("paused");
    expect((persistedAgent?.metadata as Record<string, any>).lifecycleCanaryGate).toBeUndefined();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, receipt.runId))).toHaveLength(0);
  });

  it("keeps the exact one-shot lifecycle canary as the only narrow execution-gate exception", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"1".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"2".repeat(64)}`,
      receiptId: `v1:sha256:${"3".repeat(64)}`,
      stage: "fenced",
      issuedByUserId: "better-auth:user-marco",
    });

    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    expect(queued.run).toMatchObject({ id: receipt.runId, status: "queued" });
    expect(queued.wakeupRequest).toMatchObject({ status: "queued", runId: receipt.runId });
  });

  it("rejects copied canary-shaped run and wake fields that are not bound to the one-shot receipt", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const forgedRunId = randomUUID();
    await expect(db.insert(heartbeatRuns).values({
      id: forgedRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
      responsibleUserId: "better-auth:user-marco",
      contextSnapshot: {
        ...(queued.run.contextSnapshot as Record<string, unknown>),
        lifecycleCanary: {
          ...((queued.run.contextSnapshot as Record<string, any>).lifecycleCanary),
          runId: forgedRunId,
        },
      },
      sessionIdBefore: null,
    })).rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });
    await expect(db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "on_demand",
      reason: "lifecycle_pending_canary",
      payload: { issueId: seeded.canaryIssueId },
      status: "queued",
      idempotencyKey: `lifecycle-canary:${receipt.runId}`,
      runId: receipt.runId,
    })).rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });
  });

  it("serializes concurrent duplicate requests to exactly one one-shot run", async () => {
    const seeded = await seedPendingCanary();
    const enqueue = (heartbeatModule as Record<string, any>).enqueueLifecycleCanaryRun;
    const receipts = [seeded.createReceipt(), seeded.createReceipt()];

    const outcomes = await Promise.allSettled(receipts.map((receipt) => enqueue(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    })));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.agentId));
    expect(runs).toHaveLength(1);
  });

  it("authorizes only the exact receipt-bound pending run and rejects run-id or context spoofing", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const authorize = (heartbeatModule as Record<string, any>).authorizePendingLifecycleCanaryRun;

    expect(authorize).toBeDefined();
    expect(authorize({ agent: queued.agent, run: queued.run })).toMatchObject({ ok: true, pending: true });
    expect(authorize({
      agent: queued.agent,
      run: { ...queued.run, id: randomUUID() },
    })).toMatchObject({ ok: false, pending: true });
    expect(authorize({
      agent: queued.agent,
      run: {
        ...queued.run,
        contextSnapshot: {
          ...(queued.run.contextSnapshot as Record<string, unknown>),
          lifecycleCanary: {
            ...((queued.run.contextSnapshot as Record<string, any>).lifecycleCanary),
            runId: randomUUID(),
          },
        },
      },
    })).toMatchObject({ ok: false, pending: true });
  });

  it("blocks every ordinary wake path while the lifecycle canary is pending", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });

    const service = heartbeatModule.heartbeatService(db);
    await expect(service.wakeup(seeded.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: seeded.canaryIssueId },
      requestedByActorType: "user",
      requestedByActorId: "better-auth:user-marco",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_lifecycle_canary_only" },
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(receipt.runId);
  });

  it.each([
    ["claim", "config"],
    ["claim", "instructions"],
    ["execute", "grant"],
    ["execute", "skill"],
  ] as const)(
    "fails closed at the %s boundary when the full lifecycle %s fingerprint drifts",
    async (phase, mutation) => {
      const seeded = await seedPendingCanary({ withSkill: mutation === "skill" });
      const receipt = seeded.createReceipt();
      const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        receipt,
        expectedAgentUpdatedAt: seeded.agent.updatedAt,
        requestedByUserId: "better-auth:user-marco",
      });
      if (phase === "execute") {
        await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, queued.run.id));
        await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: new Date() }).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id));
        await db.update(agents).set({ status: "running" }).where(eq(agents.id, seeded.agentId));
      }
      if (mutation === "config") {
        await db.update(agents).set({
          adapterConfig: { model: "changed-after-queue", promptTemplate: INSTRUCTIONS },
        }).where(eq(agents.id, seeded.agentId));
      } else if (mutation === "instructions") {
        await db.update(agents).set({
          adapterConfig: { model: "gpt-5.6-terra", promptTemplate: "changed managed instructions" },
        }).where(eq(agents.id, seeded.agentId));
      } else if (mutation === "grant") {
        await db.insert(principalPermissionGrants).values({
          companyId: seeded.companyId,
          principalType: "agent",
          principalId: seeded.agentId,
          permissionKey: "tasks:assign",
          scope: { projectId: randomUUID() },
        });
      } else {
        const [nextVersion] = await db.insert(companySkillVersions).values({
          companyId: seeded.companyId,
          companySkillId: seeded.skill!.id,
          revisionNumber: 2,
          fileInventory: [],
        }).returning();
        await db.update(companySkills).set({ currentVersionId: nextVersion!.id }).where(eq(companySkills.id, seeded.skill!.id));
      }

      const revalidate = (heartbeatModule as Record<string, any>).revalidatePendingLifecycleCanaryBoundary;
      expect(revalidate).toBeDefined();
      const result = await revalidate(db, {
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        runId: queued.run.id,
        phase,
      });

      expect(result).toEqual({ ok: false, pending: true, reason: "fingerprint_mismatch" });
      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
      expect(persistedRun).toMatchObject({
        status: "cancelled",
        errorCode: `agent_lifecycle_canary_${phase}_fingerprint_mismatch`,
        processPid: null,
        processStartedAt: null,
      });
      const [persistedAgent] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
      const metadata = persistedAgent!.metadata as Record<string, any>;
      expect(persistedAgent!.status).toBe("paused");
      expect(metadata.lifecycle).toMatchObject({
        lastCanaryResult: "failed",
        pause: {
          reasonCode: "canary_failed",
          outcome: `${phase}_fingerprint_mismatch`,
          repairIssueId: seeded.canaryIssueId,
        },
      });
      expect(metadata.lifecycleCanaryGate).toBeUndefined();
      const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId));
      expect(issue!.status).toBe("blocked");
    },
  );

  it("fails closed when a receipt-bound running canary is no longer pending at the execute boundary", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const now = new Date();
    await db.update(heartbeatRuns).set({ status: "running", startedAt: now }).where(eq(heartbeatRuns.id, queued.run.id));
    await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: now }).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id));
    const metadata = queued.agent.metadata as Record<string, any>;
    await db.update(agents).set({
      status: "running",
      metadata: {
        ...metadata,
        lifecycle: {
          ...metadata.lifecycle,
          lastCanaryResult: "passed",
          lastCanaryAt: new Date(Date.now() - 1_000).toISOString(),
        },
      },
    }).where(eq(agents.id, seeded.agentId));

    const result = await heartbeatModule.revalidatePendingLifecycleCanaryBoundary(db, {
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      runId: queued.run.id,
      phase: "execute",
    });

    expect(result).toEqual({ ok: false, pending: true, reason: "lifecycle_not_pending" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "agent_lifecycle_canary_execute_lifecycle_not_pending",
      processPid: null,
      processStartedAt: null,
    });
    const [agent] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
    const persistedMetadata = agent!.metadata as Record<string, any>;
    expect(agent!.status).toBe("paused");
    expect(persistedMetadata.lifecycle).toMatchObject({
      lastCanaryResult: "failed",
      pause: {
        reasonCode: "canary_failed",
        outcome: "execute_lifecycle_not_pending",
        repairIssueId: seeded.canaryIssueId,
      },
    });
    expect(persistedMetadata.lifecycleCanaryGate).toBeUndefined();
    expect(persistedMetadata.lifecycleGate).toBeUndefined();
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId));
    expect(issue!.status).toBe("blocked");
  });

  it.each([
    ["issue reassignment", "issue", "issue_scope_invalid"],
    ["another active run", "run", "other_active_run"],
    ["another active wake", "wakeup", "other_active_wakeup"],
    ["an active routine", "routine", "active_routine"],
    ["an enabled routine trigger", "trigger", "enabled_routine_trigger"],
    ["a received routine run", "routine_run", "received_routine_run"],
  ] as const)(
    "fails closed before claim when isolation gains %s",
    async (_label, mutation, reason) => {
      const seeded = await seedPendingCanary();
      const receipt = seeded.createReceipt();
      const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        receipt,
        expectedAgentUpdatedAt: seeded.agent.updatedAt,
        requestedByUserId: "better-auth:user-marco",
      });
      if (mutation === "issue") {
        await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, seeded.canaryIssueId));
      } else if (mutation === "run") {
        await injectUnmediatedActiveConflict(seeded.agentId, () => db.insert(heartbeatRuns).values({
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            status: "queued",
            responsibleUserId: "better-auth:user-marco",
          }),
        );
      } else if (mutation === "wakeup") {
        await injectUnmediatedActiveConflict(seeded.agentId, () => db.insert(agentWakeupRequests).values({
            companyId: seeded.companyId,
            agentId: seeded.agentId,
            source: "on_demand",
            status: "queued",
          }),
        );
      } else {
        const [routine] = await db.insert(routines).values({
          companyId: seeded.companyId,
          title: "Late conflicting routine",
          assigneeAgentId: seeded.agentId,
          status: mutation === "routine" ? "active" : "paused",
        }).returning();
        if (mutation === "trigger") {
          await db.insert(routineTriggers).values({
            companyId: seeded.companyId,
            routineId: routine!.id,
            kind: "api",
            enabled: true,
          });
        }
        if (mutation === "routine_run") {
          await db.insert(routineRuns).values({
            companyId: seeded.companyId,
            routineId: routine!.id,
            source: "manual",
            status: "received",
            responsibleUserId: "better-auth:user-marco",
          });
        }
      }

      const result = await (heartbeatModule as Record<string, any>).revalidatePendingLifecycleCanaryBoundary(db, {
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        runId: queued.run.id,
        phase: "claim",
      });

      expect(result).toEqual({ ok: false, pending: true, reason });
      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
      expect(persistedRun).toMatchObject({
        status: "cancelled",
        errorCode: `agent_lifecycle_canary_claim_${reason}`,
        processPid: null,
        processStartedAt: null,
      });
      const [persistedAgent] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
      expect((persistedAgent!.metadata as Record<string, any>).lifecycle.pause.outcome).toBe(`claim_${reason}`);
    },
  );

  it("cancels a claim-time fingerprint race before the adapter can be invoked or spawn", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "tasks:assign",
      scope: null,
    });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.id} <> ${queued.run.id} and ${heartbeatRuns.status} = 'queued'`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.id} <> ${queued.wakeupRequest.id} and ${agentWakeupRequests.status} = 'queued'`,
    );

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
      if (run && !["queued", "running"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "agent_lifecycle_canary_claim_fingerprint_mismatch",
      processPid: null,
      processStartedAt: null,
    });
  });

  it("does not invoke or spawn the adapter when a claimed canary becomes non-pending before execute", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.id} <> ${queued.run.id} and ${heartbeatRuns.status} = 'queued'`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.id} <> ${queued.wakeupRequest.id} and ${agentWakeupRequests.status} = 'queued'`,
    );

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    const [claimedAgent] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
    const metadata = claimedAgent!.metadata as Record<string, any>;
    await db.update(agents).set({
      metadata: {
        ...metadata,
        lifecycle: {
          ...metadata.lifecycle,
          lastCanaryResult: "passed",
          lastCanaryAt: new Date(Date.now() - 1_000).toISOString(),
        },
      },
    }).where(eq(agents.id, seeded.agentId));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
      if (run && !["queued", "running"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "agent_lifecycle_canary_execute_lifecycle_not_pending",
      processPid: null,
      processStartedAt: null,
    });
    const [agent] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
    expect(agent!.status).toBe("paused");
    expect((agent!.metadata as Record<string, any>).lifecycle.lastCanaryResult).toBe("failed");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId));
    expect(issue!.status).toBe("blocked");
  });

  it("atomically promotes an exact successful fresh canary and installs the normal lifecycle gate", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));
    await recordCanaryIssueDone({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      issueId: seeded.canaryIssueId,
      runId: queued.run.id,
    });

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });

    expect(result).toEqual({ updated: true, reason: "canary_promoted" });
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    const metadata = persisted?.metadata as Record<string, any>;
    expect(metadata.lifecycle).toMatchObject({
      canaryIssueId: seeded.canaryIssueId,
      lastCanaryResult: "passed",
    });
    expect(metadata.lifecycle.lastCanaryAt).toEqual(expect.any(String));
    expect(metadata.lifecycleGate).toMatchObject({
      freshSessionRequired: false,
      lastSatisfiedRunId: queued.run.id,
    });
    const persistedRun = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.run.id))
      .then((rows) => rows[0]);
    expect((persistedRun?.contextSnapshot as Record<string, any>).lifecycleCanary).toMatchObject({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      runId: queued.run.id,
      configFingerprint: metadata.lifecycleGate.configFingerprint,
      receiptHash: metadata.lifecycleGate.receiptHash,
    });
    expect(metadata.lifecycleCanaryGate).toBeUndefined();
  });

  it.each([
    ["the canary issue is not done", "not_done"],
    ["the canary completion audit is bound to another run", "wrong_run"],
    ["the canary completion audit is missing", "missing_audit"],
    ["another assigned issue remains nonterminal", "other_issue"],
  ] as const)("fails closed before promotion when %s", async (_label, setup) => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const issueExecutionRunId = setup === "wrong_run" ? randomUUID() : queued.run.id;
    if (setup === "wrong_run") {
      await db.insert(heartbeatRuns).values({
        id: issueExecutionRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        responsibleUserId: "better-auth:user-marco",
        finishedAt: new Date(),
      });
    }
    if (setup !== "not_done") {
      await db.update(issues).set({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: new Date(),
      }).where(eq(issues.id, seeded.canaryIssueId));
      if (setup !== "missing_audit") {
        await db.insert(activityLog).values({
          companyId: seeded.companyId,
          actorType: "agent",
          actorId: seeded.agentId,
          action: "issue.updated",
          entityType: "issue",
          entityId: seeded.canaryIssueId,
          agentId: seeded.agentId,
          runId: issueExecutionRunId,
          details: {
            status: "done",
            _previous: { status: "in_progress" },
          },
        });
      }
    }
    if (setup === "other_issue") {
      await db.insert(issues).values({
        companyId: seeded.companyId,
        title: "Unrelated unfinished work",
        status: "todo",
        assigneeAgentId: seeded.agentId,
      });
    }
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });

    expect(result).toEqual({ updated: false, reason: "canary_scope_invalid" });
    const persistedAgent = await db.select().from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!);
    expect(persistedAgent.status).toBe("paused");
    expect((persistedAgent.metadata as Record<string, any>).lifecycle).toMatchObject({
      lastCanaryResult: "failed",
      pause: { outcome: "scope_invalid" },
    });
  });

  it("terminalizes only the exact failed-promotion canary wake under maintenance", async () => {
    const seeded = await seedPendingCanary();
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"1".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"2".repeat(64)}`,
      receiptId: `v1:sha256:${"3".repeat(64)}`,
      stage: "quiesced",
      issuedByUserId: "better-auth:user-marco",
    });
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });
    expect(result).toEqual({ updated: false, reason: "canary_scope_invalid" });

    await expect(db.update(agentWakeupRequests).set({
      status: "completed",
      finishedAt: new Date(),
      payload: { issueId: randomUUID() },
    }).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id)))
      .rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });

    await expect(db.update(agentWakeupRequests).set({
      status: "completed",
      finishedAt: new Date(),
    }).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id))).resolves.toBeDefined();
    const persistedWake = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queued.wakeupRequest.id))
      .then((rows) => rows[0]);
    expect(persistedWake).toMatchObject({ status: "completed", finishedAt: expect.any(Date) });
  });

  it("runs the real enqueue-claim-execute-promote path after the exact canary issue is done", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')`,
    );
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await recordCanaryIssueDone({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        issueId: seeded.canaryIssueId,
        runId: queued.run.id,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        label: "Lifecycle canary completed its exact issue",
      };
    });

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    let fullyPromoted = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [run, agent] = await Promise.all([
        db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queued.run.id))
          .then((rows) => rows[0]),
        db.select({ status: agents.status, metadata: agents.metadata }).from(agents)
          .where(eq(agents.id, seeded.agentId))
          .then((rows) => rows[0]),
      ]);
      const lifecycle = (agent?.metadata as Record<string, any> | null)?.lifecycle;
      if (run?.status === "succeeded" && agent?.status === "idle" && lifecycle?.lastCanaryResult === "passed") {
        fullyPromoted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fullyPromoted).toBe(true);
    // executeRun releases environment leases after promotion; let its final
    // awaited cleanup settle before the embedded database is torn down.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAdapterExecute.mock.calls.filter((call) => call[0]?.runId === queued.run.id)).toHaveLength(1);
    const persistedRun = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.run.id))
      .then((rows) => rows[0]!);
    expect(persistedRun.status).toBe("succeeded");
    expect(persistedRun.sessionIdBefore).toBeNull();
    expect(persistedRun.contextSnapshot).toMatchObject({
      issueId: seeded.canaryIssueId,
      forceFreshSession: true,
      paperclipIssue: expect.any(Object),
      lifecycleCanary: {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        runId: queued.run.id,
      },
    });
    const persistedAgent = await db.select().from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!);
    expect((persistedAgent.metadata as Record<string, any>).lifecycle.lastCanaryResult).toBe("passed");
    expect((persistedAgent.metadata as Record<string, any>).lifecycleCanaryGate).toBeUndefined();
    const persistedIssue = await db.select().from(issues)
      .where(eq(issues.id, seeded.canaryIssueId))
      .then((rows) => rows[0]!);
    expect(persistedIssue).toMatchObject({
      status: "done",
      assigneeAgentId: seeded.agentId,
    });

    const maintenance = await portfolioMaintenanceService(db).preflight({
      companyId: seeded.companyId,
      agentIds: [seeded.agentId],
    });
    expect(maintenance).toMatchObject({
      ready: true,
      restoreReady: true,
      wakes: [],
      liveRuns: [],
      lifecycleGates: [{ agentId: seeded.agentId, valid: true }],
    });
  });

  it("server-mediates only the run-bound canary issue from an exact structured adapter result", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')`,
    );
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const evidence = "Classified the fixed alert as one deduplicated warning incident.";
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: [
        "Read-only classification task, no code needed.",
        "",
        "PAPERCLIP_LIFECYCLE_CANARY_RESULT_V1",
        JSON.stringify({ outcome: "passed", evidence }),
      ].join("\n"),
      label: "Lifecycle canary returned bounded evidence without a network write",
    }));

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    let fullyPromoted = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [run, agent] = await Promise.all([
        db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queued.run.id))
          .then((rows) => rows[0]),
        db.select({ status: agents.status, metadata: agents.metadata }).from(agents)
          .where(eq(agents.id, seeded.agentId))
          .then((rows) => rows[0]),
      ]);
      const lifecycle = (agent?.metadata as Record<string, any> | null)?.lifecycle;
      if (run?.status === "succeeded" && agent?.status === "idle" && lifecycle?.lastCanaryResult === "passed") {
        fullyPromoted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fullyPromoted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [persistedIssue, persistedRun, comments, audit] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]!),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]!),
      db.select().from(issueComments).where(eq(issueComments.createdByRunId, queued.run.id)),
      db.select().from(activityLog).where(eq(activityLog.runId, queued.run.id)),
    ]);
    expect(persistedIssue).toMatchObject({
      status: "done",
      assigneeAgentId: seeded.agentId,
      executionRunId: null,
    });
    expect((persistedRun.resultJson as Record<string, any>).lifecycleCanaryResultV1).toMatchObject({
      schemaVersion: "1.0.0",
      source: "adapter_final_summary",
      outcome: "passed",
      evidence,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      runId: queued.run.id,
      canaryIssueId: seeded.canaryIssueId,
      receiptHash: receipt.receiptHash,
      configFingerprint: receipt.configFingerprint,
      finalSummarySha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: seeded.canaryIssueId,
        authorType: "agent",
        authorAgentId: seeded.agentId,
        createdByRunId: queued.run.id,
        body: expect.stringContaining(evidence),
      }),
    ]));
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "agent",
        actorId: seeded.agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.canaryIssueId,
        agentId: seeded.agentId,
        runId: queued.run.id,
        details: expect.objectContaining({
          status: "done",
          _previous: { status: "in_progress" },
          source: "lifecycle_canary_adapter_result_v1",
        }),
      }),
    ]));
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "agent",
        actorId: seeded.agentId,
        entityId: seeded.canaryIssueId,
        runId: queued.run.id,
        details: expect.objectContaining({
          status: "in_progress",
          _previous: { status: "todo" },
          source: "lifecycle_canary_server_checkout",
        }),
      }),
    ]));
  }, 15_000);

  it("rejects an adapter-spoofed proof namespace when the final summary has no exact envelope", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')`,
    );
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Completed without the required lifecycle envelope.",
      resultJson: {
        lifecycleCanaryResultV1: {
          schemaVersion: "1.0.0",
          source: "adapter_final_summary",
          outcome: "passed",
          evidence: "This adapter-controlled object must never authorize completion.",
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          runId: queued.run.id,
          canaryIssueId: seeded.canaryIssueId,
          receiptHash: receipt.receiptHash,
          configFingerprint: receipt.configFingerprint,
          finalSummarySha256: `sha256:${"a".repeat(64)}`,
        },
      },
      label: "Lifecycle canary attempted to spoof the reserved proof namespace",
    }));

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    let quarantined = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [run, agent, issue] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]),
        db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
        db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]),
      ]);
      if (
        run?.status === "succeeded"
        && agent?.status === "paused"
        && (agent.metadata as Record<string, any>).lifecycle?.lastCanaryResult === "failed"
        && issue?.status === "blocked"
      ) {
        quarantined = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(quarantined).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [persistedRun, mediatedAudit] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]!),
      db.select().from(activityLog).where(and(
        eq(activityLog.runId, queued.run.id),
        sql`${activityLog.details} ->> 'source' = 'lifecycle_canary_adapter_result_v1'`,
      )),
    ]);
    expect((persistedRun.resultJson as Record<string, any>).lifecycleCanaryResultV1).toBeNull();
    expect(mediatedAudit).toEqual([]);
  }, 15_000);

  it.each([
    ["the issue is moved back to todo", "todo"],
    ["the checkout run binding is cleared", "checkout_null"],
    ["the execution run binding is cleared", "execution_null"],
  ] as const)("fails closed with no success artifacts when %s after execution authorization", async (_label, mutation) => {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')`,
    );
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set(
        mutation === "todo"
          ? { status: "todo", updatedAt: new Date() }
          : mutation === "checkout_null"
            ? { checkoutRunId: null, updatedAt: new Date() }
            : { executionRunId: null, updatedAt: new Date() },
      ).where(eq(issues.id, seeded.canaryIssueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: [
          "PAPERCLIP_LIFECYCLE_CANARY_RESULT_V1",
          JSON.stringify({ outcome: "passed", evidence: "Validated the bounded local lifecycle fixture." }),
        ].join("\n"),
        label: "Lifecycle canary lock-drift test",
      };
    });

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    let quarantined = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [run, agent, issue] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]),
        db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
        db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]),
      ]);
      if (
        run?.status === "succeeded"
        && agent?.status === "paused"
        && (agent.metadata as Record<string, any>).lifecycle?.lastCanaryResult === "failed"
        && issue?.status === "blocked"
      ) {
        quarantined = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(quarantined).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [mediatedAudit, mediatedComments] = await Promise.all([
      db.select().from(activityLog).where(and(
        eq(activityLog.runId, queued.run.id),
        sql`${activityLog.details} ->> 'source' = 'lifecycle_canary_adapter_result_v1'`,
      )),
      db.select().from(issueComments).where(and(
        eq(issueComments.createdByRunId, queued.run.id),
        eq(issueComments.authorType, "agent"),
      )),
    ]);
    expect(mediatedAudit).toEqual([]);
    expect(mediatedComments.filter((comment) => comment.body.includes("server-mediated"))).toEqual([]);
  }, 15_000);

  it("rolls back mediated success artifacts when the final run-promotion CAS misses", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    const now = new Date();
    await db.update(issues).set({
      status: "in_progress",
      checkoutRunId: queued.run.id,
      executionRunId: queued.run.id,
      startedAt: now,
      updatedAt: now,
    }).where(eq(issues.id, seeded.canaryIssueId));
    await db.update(agentWakeupRequests).set({
      status: "claimed",
      claimedAt: now,
      updatedAt: now,
    }).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id));
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      resultJson: {
        lifecycleCanaryResultV1: {
          schemaVersion: "1.0.0",
          source: "adapter_final_summary",
          outcome: "passed",
          evidence: "Validated the bounded local lifecycle fixture.",
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          runId: queued.run.id,
          canaryIssueId: seeded.canaryIssueId,
          receiptHash: receipt.receiptHash,
          configFingerprint: receipt.configFingerprint,
          finalSummarySha256: `sha256:${"b".repeat(64)}`,
        },
      },
    }).where(eq(heartbeatRuns.id, queued.run.id));

    await db.execute(sql.raw(`
      create or replace function test_reject_lifecycle_canary_promotion()
      returns trigger language plpgsql as $$
      begin
        if old.id = '${queued.run.id}'::uuid
          and new.context_snapshot is distinct from old.context_snapshot
          and new.status = 'succeeded'
        then
          return null;
        end if;
        return new;
      end;
      $$;
      drop trigger if exists test_reject_lifecycle_canary_promotion on heartbeat_runs;
      create trigger test_reject_lifecycle_canary_promotion
      before update on heartbeat_runs
      for each row execute function test_reject_lifecycle_canary_promotion();
    `));
    let result: Awaited<ReturnType<typeof heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun>>;
    try {
      result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
        id: queued.run.id,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        freshSession: true,
        agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
      });
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists test_reject_lifecycle_canary_promotion on heartbeat_runs;
        drop function if exists test_reject_lifecycle_canary_promotion();
      `));
    }

    expect(result!).toEqual({ updated: false, reason: "canary_promotion_failed" });
    const [persistedIssue, persistedAgent, mediatedAudit, mediatedComments] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]!),
      db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]!),
      db.select().from(activityLog).where(and(
        eq(activityLog.runId, queued.run.id),
        sql`${activityLog.details} ->> 'source' = 'lifecycle_canary_adapter_result_v1'`,
      )),
      db.select().from(issueComments).where(and(
        eq(issueComments.createdByRunId, queued.run.id),
        eq(issueComments.authorType, "agent"),
      )),
    ]);
    expect(persistedIssue.status).toBe("blocked");
    expect(persistedAgent.status).toBe("paused");
    expect((persistedAgent.metadata as Record<string, any>).lifecycle.lastCanaryResult).toBe("failed");
    expect(mediatedAudit).toEqual([]);
    expect(mediatedComments.filter((comment) => comment.body.includes("server-mediated"))).toEqual([]);
  }, 15_000);

  it("quarantines a failed real canary before ordinary continuation recovery under maintenance", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    );
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(
      sql`${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred_issue_execution')`,
    );
    const seeded = await seedPendingCanary();
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"1".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"2".repeat(64)}`,
      receiptId: `v1:sha256:${"3".repeat(64)}`,
      stage: "quiesced",
      issuedByUserId: "better-auth:user-marco",
    });
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "bounded lifecycle canary failed",
      label: "Lifecycle canary failure",
    }));

    await heartbeatModule.heartbeatService(db).resumeQueuedRuns();
    let quarantined = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [run, agent, issue, wake] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.run.id)).then((rows) => rows[0]),
        db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
        db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]),
        db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequest.id)).then((rows) => rows[0]),
      ]);
      const lifecycle = (agent?.metadata as Record<string, any> | null)?.lifecycle;
      if (
        run?.status === "failed" &&
        agent?.status === "paused" &&
        issue?.status === "blocked" &&
        wake && !["queued", "claimed", "deferred_issue_execution"].includes(wake.status) &&
        lifecycle?.lastCanaryResult === "failed"
      ) {
        quarantined = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(quarantined).toBe(true);

    const [agent, issue, wakes, runs] = await Promise.all([
      db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]!),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId)),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.agentId)),
    ]);
    expect(agent.status).toBe("paused");
    expect(agent.metadata).toMatchObject({
      lifecycle: {
        lastCanaryResult: "failed",
        pause: { reasonCode: "canary_failed", repairIssueId: seeded.canaryIssueId },
      },
    });
    expect((agent.metadata as Record<string, any>).lifecycleCanaryGate).toBeUndefined();
    expect(issue).toMatchObject({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(wakes.filter((wake) => ["queued", "claimed", "deferred_issue_execution"].includes(wake.status))).toEqual([]);
    expect(runs.filter((run) => ["queued", "running", "scheduled_retry"].includes(run.status))).toEqual([]);
  });

  it("serializes concurrent promotion attempts so the one-shot receipt is consumed exactly once", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));
    await recordCanaryIssueDone({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      issueId: seeded.canaryIssueId,
      runId: queued.run.id,
    });
    const reconcile = () => heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });

    const outcomes = await Promise.all([reconcile(), reconcile()]);

    expect(outcomes.filter((result) => result.updated)).toHaveLength(1);
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    const metadata = persisted?.metadata as Record<string, any>;
    expect(metadata.lifecycle.lastCanaryResult).toBe("passed");
    expect(metadata.lifecycleGate.lastSatisfiedRunId).toBe(queued.run.id);
    expect(metadata.lifecycleCanaryGate).toBeUndefined();
  });

  it.each(["failed", "timed_out"] as const)(
    "keeps lifecycle pending, pauses the agent, and consumes the receipt after a %s canary",
    async (status) => {
      const seeded = await seedPendingCanary();
      const receipt = seeded.createReceipt();
      const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
        agentId: seeded.agentId,
        companyId: seeded.companyId,
        canaryIssueId: seeded.canaryIssueId,
        receipt,
        expectedAgentUpdatedAt: seeded.agent.updatedAt,
        requestedByUserId: "better-auth:user-marco",
      });
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, queued.run.id));

      const result = await (heartbeatModule as Record<string, any>).finalizePendingLifecycleCanaryFailure(
        db,
        queued.run.id,
        status,
      );

      expect(result).toMatchObject({ updated: true, reason: "canary_failed_closed" });
      const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
      const metadata = persisted?.metadata as Record<string, any>;
      expect(persisted?.status).toBe("paused");
      expect(metadata.lifecycle).toMatchObject({
        lastCanaryResult: "failed",
        lastCanaryAt: expect.any(String),
        pause: {
          reasonCode: "canary_failed",
          reasonDetail: expect.any(String),
          outcome: status,
          repairIssueId: seeded.canaryIssueId,
          startedAt: expect.any(String),
          expiresAt: expect.any(String),
        },
      });
      expect(
        new Date(metadata.lifecycle.pause.expiresAt).getTime()
          - new Date(metadata.lifecycle.pause.startedAt).getTime(),
      ).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1_000);
      expect(metadata.lifecycleGate).toBeUndefined();
      expect(metadata.lifecycleCanaryGate).toBeUndefined();
      const issue = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]);
      expect(issue?.status).toBe("blocked");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.canaryIssueId));
      expect(comments).toEqual(expect.arrayContaining([
        expect.objectContaining({
          authorType: "system",
          createdByRunId: queued.run.id,
          body: expect.stringContaining("Lifecycle canary"),
        }),
      ]));
    },
  );

  it("treats a nominally successful but reused-session run as a failed canary", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: false,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });

    expect(result).toEqual({ updated: false, reason: "canary_fresh_session_required" });
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    const metadata = persisted?.metadata as Record<string, any>;
    expect(persisted?.status).toBe("paused");
    expect(metadata.lifecycle).toMatchObject({
      lastCanaryResult: "failed",
      pause: {
        reasonCode: "canary_failed",
        outcome: "fresh_session_required",
        repairIssueId: seeded.canaryIssueId,
      },
    });
    expect(metadata.lifecycleCanaryGate).toBeUndefined();
  });

  it("never promotes after canary issue reassignment and fails closed instead", async () => {
    const seeded = await seedPendingCanary();
    const receipt = seeded.createReceipt();
    const queued = await heartbeatModule.enqueueLifecycleCanaryRun(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt,
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    });
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, seeded.canaryIssueId));
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, queued.run.id));

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: queued.run.id,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.agentConfigurationFingerprint,
    });

    expect(result).toMatchObject({ updated: false, reason: "canary_scope_invalid" });
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    const metadata = persisted?.metadata as Record<string, any>;
    expect(persisted?.status).toBe("paused");
    expect(metadata.lifecycle).toMatchObject({
      lastCanaryResult: "failed",
      pause: {
        reasonCode: "canary_failed",
        outcome: "scope_invalid",
        repairIssueId: seeded.canaryIssueId,
      },
    });
    expect(metadata.lifecycleGate).toBeUndefined();
    expect(metadata.lifecycleCanaryGate).toBeUndefined();
    const issue = await db.select().from(issues).where(eq(issues.id, seeded.canaryIssueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it.each([
    ["reassigned canary issue", "issue"],
    ["another nonterminal issue", "other_issue"],
    ["active heartbeat run", "run"],
    ["queued wakeup", "wakeup"],
    ["active routine", "routine"],
    ["enabled routine trigger", "trigger"],
    ["received routine run", "routine_run"],
  ] as const)("rejects isolated bootstrap when there is a %s", async (_label, setup) => {
    const seeded = await seedPendingCanary();
    if (setup === "issue") {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, seeded.canaryIssueId));
    } else if (setup === "other_issue") {
      await db.insert(issues).values({
        companyId: seeded.companyId,
        title: "Unrelated work",
        status: "backlog",
        assigneeAgentId: seeded.agentId,
      });
    } else if (setup === "run") {
      await injectUnmediatedActiveConflict(seeded.agentId, () => db.insert(heartbeatRuns).values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          status: "queued",
          responsibleUserId: "better-auth:user-marco",
        }),
      );
    } else if (setup === "wakeup") {
      await injectUnmediatedActiveConflict(seeded.agentId, () => db.insert(agentWakeupRequests).values({
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          source: "on_demand",
          status: "queued",
        }),
      );
    } else {
      const [routine] = await db.insert(routines).values({
        companyId: seeded.companyId,
        title: "Canary-conflicting routine",
        assigneeAgentId: seeded.agentId,
        status: setup === "routine" ? "active" : "paused",
      }).returning();
      if (setup === "trigger") {
        await db.insert(routineTriggers).values({
          companyId: seeded.companyId,
          routineId: routine!.id,
          kind: "api",
          enabled: true,
        });
      }
      if (setup === "routine_run") {
        await db.insert(routineRuns).values({
          companyId: seeded.companyId,
          routineId: routine!.id,
          source: "manual",
          status: "received",
          responsibleUserId: "better-auth:user-marco",
        });
      }
    }

    const enqueue = (heartbeatModule as Record<string, any>).enqueueLifecycleCanaryRun;
    await expect(enqueue(db, {
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      canaryIssueId: seeded.canaryIssueId,
      receipt: seeded.createReceipt(),
      expectedAgentUpdatedAt: seeded.agent.updatedAt,
      requestedByUserId: "better-auth:user-marco",
    })).rejects.toBeDefined();
    const persistedAgent = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(persistedAgent?.status).toBe("paused");
    expect((persistedAgent?.metadata as Record<string, any>).lifecycleCanaryGate).toBeUndefined();
  });
});

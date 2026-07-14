import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvalExecutionClaims,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
  approvalExecutionClaimConsumeRequestSchema,
  approvalExecutionClaimFinalizeRequestSchema,
  approvalExecutionClaimRecoveryRequestSchema,
  approvalExecutionClaimRequestSchema,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { approvalExecutionClaimRoutes } from "../routes/approval-execution-claims.js";
import { approvalExecutionClaimService } from "../services/approval-execution-claims.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NOW = new Date("2026-07-13T12:00:00.000Z");
const PAYLOAD_SHA = "a".repeat(64);
const CALL_FINGERPRINT_SHA = "b".repeat(64);

describe("approval execution claim contract", () => {
  it("accepts only the exact strict v2 request shape", () => {
    const valid = {
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      executionRunId: "run_media_01",
      originRunId: "11111111-1111-4111-8111-111111111111",
      issueId: "22222222-2222-4222-8222-222222222222",
      approvalPayloadSha256: PAYLOAD_SHA,
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
    };

    expect(approvalExecutionClaimRequestSchema.parse(valid)).toEqual(valid);
    expect(approvalExecutionClaimRequestSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(approvalExecutionClaimRequestSchema.safeParse({ ...valid, schemaVersion: "1.0.0" }).success).toBe(false);
    expect(approvalExecutionClaimRequestSchema.safeParse({ ...valid, executionRunId: " " }).success).toBe(false);
    expect(approvalExecutionClaimRequestSchema.safeParse({ ...valid, approvalPayloadSha256: "A".repeat(64) }).success).toBe(false);
  });

  it("accepts only exact consume and finalize lifecycle contracts", () => {
    const consume = {
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      executionRunId: "run_media_01",
      originRunId: "11111111-1111-4111-8111-111111111111",
      issueId: "22222222-2222-4222-8222-222222222222",
      approvalPayloadSha256: PAYLOAD_SHA,
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      receiptSha256: "c".repeat(64),
    };
    expect(approvalExecutionClaimConsumeRequestSchema.parse(consume)).toEqual(consume);
    expect(approvalExecutionClaimConsumeRequestSchema.safeParse({ ...consume, replayed: true }).success).toBe(false);

    const finalize = {
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      executionRunId: "run_media_01",
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      executionReceiptSha256: "d".repeat(64),
      outcome: "completed",
    };
    expect(approvalExecutionClaimFinalizeRequestSchema.parse(finalize)).toEqual(finalize);
    expect(approvalExecutionClaimFinalizeRequestSchema.safeParse({ ...finalize, outcome: "revoked" }).success).toBe(false);
    expect(approvalExecutionClaimFinalizeRequestSchema.safeParse({
      ...finalize,
      outcome: "failed",
      failureCode: "provider failure: secret=abc",
    }).success).toBe(false);

    const recovery = {
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      executionRunId: "run_media_01",
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      executionReceiptSha256: "d".repeat(64),
      expectedUpdatedAt: "2026-07-13T12:00:00.000Z",
      reason: "Provider outcome cannot be proven after the worker crashed.",
      evidenceSha256: "e".repeat(64),
    };
    expect(approvalExecutionClaimRecoveryRequestSchema.parse(recovery)).toEqual(recovery);
    expect(approvalExecutionClaimRecoveryRequestSchema.safeParse({ ...recovery, extra: true }).success).toBe(false);
    expect(approvalExecutionClaimRecoveryRequestSchema.safeParse({ ...recovery, reason: "expired" }).success).toBe(false);
  });
});

describeEmbeddedPostgres("approval execution claims", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-execution-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(approvalExecutionClaims);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addTrustedExecutor(input: {
    companyId: string;
    agentId: string;
    approvalId: string;
    issueId: string;
    runId?: string;
    requestedByActorType?: string;
    contextPatch?: Record<string, unknown>;
    wakePatch?: Record<string, unknown>;
  }) {
    const runId = input.runId ?? randomUUID();
    const wakeupRequestId = randomUUID();
    const wakePayload = {
      approvalId: input.approvalId,
      approvalStatus: "approved",
      issueId: input.issueId,
      issueIds: [input.issueId],
      ...(input.wakePatch ?? {}),
    };
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "approval_approved",
      payload: wakePayload,
      status: "claimed",
      requestedByActorType: input.requestedByActorType ?? "user",
      requestedByActorId: "board-user",
      runId,
      claimedAt: NOW,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      startedAt: NOW,
      contextSnapshot: {
        source: "approval.approved",
        approvalId: input.approvalId,
        approvalStatus: "approved",
        issueId: input.issueId,
        issueIds: [input.issueId],
        taskId: input.issueId,
        wakeReason: "approval_approved",
        ...(input.contextPatch ?? {}),
      },
    });
    return { runId, wakeupRequestId };
  }

  async function seed(input: {
    decidedAt?: Date | null;
    status?: string;
    type?: string;
    decidedByUserId?: string | null;
    payloadPatch?: Record<string, unknown>;
    trustedWake?: boolean;
    requestedByActorType?: string;
    contextPatch?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const originRunId = randomUUID();
    const approvalId = randomUUID();
    const executionRunId = `pipe_${randomUUID()}`;

    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: `P${companyId.slice(0, 3)}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 3)}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Pipe", role: "operator", status: "idle" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "operator", status: "idle" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Approved pipe task", assigneeAgentId: agentId },
      { id: otherIssueId, companyId: otherCompanyId, title: "Other task", assigneeAgentId: otherAgentId },
    ]);
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date(NOW.getTime() - 120_000),
      finishedAt: new Date(NOW.getTime() - 90_000),
      contextSnapshot: { issueId, taskId: issueId },
    });

    const binding = {
      company_id: companyId,
      issue_id: issueId,
      agent_id: agentId,
      paperclip_run_id: originRunId,
      execution_run_id: executionRunId,
    };
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      requestedByAgentId: agentId,
      type: input.type ?? "request_board_approval",
      status: input.status ?? "approved",
      payload: {
        kind: "media_pipe_quote",
        binding,
        execution_snapshot_sha256: "b".repeat(64),
        created_at: new Date(NOW.getTime() - 90_000).toISOString(),
        approval_payload_sha256: PAYLOAD_SHA,
        ...(input.payloadPatch ?? {}),
      },
      decidedByUserId: input.decidedByUserId === undefined ? "board-user" : input.decidedByUserId,
      decidedAt: input.decidedAt === undefined ? new Date(NOW.getTime() - 60_000) : input.decidedAt,
      createdAt: new Date(NOW.getTime() - 90_000),
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByUserId: "board-user",
    });

    const executor = await addTrustedExecutor({
      companyId,
      agentId,
      approvalId,
      issueId,
      requestedByActorType: input.requestedByActorType,
      contextPatch: input.contextPatch,
    });
    if (input.trustedWake === false) {
      await db.update(agentWakeupRequests)
        .set({ reason: "on_demand" })
        .where(eq(agentWakeupRequests.id, executor.wakeupRequestId));
    }

    return {
      companyId,
      otherCompanyId,
      agentId,
      otherAgentId,
      issueId,
      otherIssueId,
      originRunId,
      approvalId,
      executionRunId,
      executorRunId: executor.runId,
      wakeupRequestId: executor.wakeupRequestId,
    };
  }

  function claimInput(fixture: Awaited<ReturnType<typeof seed>>, patch: Record<string, unknown> = {}) {
    return {
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      executorRunId: fixture.executorRunId,
      request: {
        schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
        executionRunId: fixture.executionRunId,
        originRunId: fixture.originRunId,
        issueId: fixture.issueId,
        approvalPayloadSha256: PAYLOAD_SHA,
        callFingerprintSha256: CALL_FINGERPRINT_SHA,
      },
      ...patch,
    } as any;
  }

  function consumeInput(
    fixture: Awaited<ReturnType<typeof seed>>,
    receiptSha256: string,
    patch: Record<string, unknown> = {},
  ) {
    return {
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      executorRunId: fixture.executorRunId,
      request: {
        schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
        executionRunId: fixture.executionRunId,
        originRunId: fixture.originRunId,
        issueId: fixture.issueId,
        approvalPayloadSha256: PAYLOAD_SHA,
        callFingerprintSha256: CALL_FINGERPRINT_SHA,
        receiptSha256,
      },
      ...patch,
    } as any;
  }

  function finalizeInput(
    fixture: Awaited<ReturnType<typeof seed>>,
    executionReceiptSha256: string,
    outcome: "completed" | "failed" = "completed",
    patch: Record<string, unknown> = {},
  ) {
    return {
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      executorRunId: fixture.executorRunId,
      request: {
        schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
        executionRunId: fixture.executionRunId,
        callFingerprintSha256: CALL_FINGERPRINT_SHA,
        executionReceiptSha256,
        outcome,
        ...(outcome === "failed" ? { failureCode: "provider_failed" } : {}),
      },
      ...patch,
    } as any;
  }

  function recoveryInput(
    fixture: Awaited<ReturnType<typeof seed>>,
    execution: { executionReceiptSha256: string; executionStartedAt: string },
    patch: Record<string, unknown> = {},
  ) {
    return {
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      actorUserId: "board-user",
      request: {
        schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
        executionRunId: fixture.executionRunId,
        callFingerprintSha256: CALL_FINGERPRINT_SHA,
        executionReceiptSha256: execution.executionReceiptSha256,
        expectedUpdatedAt: execution.executionStartedAt,
        reason: "Provider outcome cannot be proven after the worker crashed.",
        evidenceSha256: "e".repeat(64),
      },
      ...patch,
    } as any;
  }

  function service() {
    return approvalExecutionClaimService(db, { now: () => NOW });
  }

  async function expectConflict(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({
      status: 409,
      details: { code: "approval_execution_claim_rejected" },
    });
  }

  function nestedDatabaseCode(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    return nestedDatabaseCode(record.cause);
  }

  async function expectLeaseBlocked(promise: Promise<unknown>) {
    try {
      await promise;
      throw new Error("expected lifecycle transition to be blocked");
    } catch (error) {
      expect(nestedDatabaseCode(error)).toBe("23514");
    }
  }

  it("claims a human-approved R1 -> trusted R2 execution exactly once and logs it atomically", async () => {
    const fixture = await seed();
    const first = await service().claim(claimInput(fixture));

    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "approvalId",
      "companyId",
      "agentId",
      "issueId",
      "originRunId",
      "executorRunId",
      "executionRunId",
      "approvalPayloadSha256",
      "callFingerprintSha256",
      "status",
      "claimedAt",
      "expiresAt",
      "receiptSha256",
      "replayed",
    ]);
    expect(first).toMatchObject({
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: fixture.issueId,
      originRunId: fixture.originRunId,
      executorRunId: fixture.executorRunId,
      executionRunId: fixture.executionRunId,
      approvalPayloadSha256: PAYLOAD_SHA,
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      status: "pending",
      claimedAt: NOW.toISOString(),
      replayed: false,
    });
    expect(first.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(NOW.getTime());

    const second = await service().claim(claimInput(fixture));
    expect(second).toEqual({ ...first, replayed: true });
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(1);
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.action, "approval.execution_claimed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      companyId: fixture.companyId,
      actorType: "agent",
      actorId: fixture.agentId,
      agentId: fixture.agentId,
      runId: fixture.executorRunId,
      entityType: "approval",
      entityId: fixture.approvalId,
    });
    expect(JSON.stringify(activities[0]?.details)).not.toContain("SECRET");
  });

  it("rejects a different R2 after the global claim", async () => {
    const fixture = await seed();
    await service().claim(claimInput(fixture));
    const foreign = await addTrustedExecutor({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      approvalId: fixture.approvalId,
      issueId: fixture.issueId,
    });

    await expectConflict(service().claim(claimInput(fixture, { executorRunId: foreign.runId })));
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(1);
  });

  it("replays only while the exact executor R2 remains live", async () => {
    const fixture = await seed();
    await service().claim(claimInput(fixture));
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      finishedAt: new Date(NOW.getTime() + 1_000),
    }).where(eq(heartbeatRuns.id, fixture.executorRunId));

    await expectConflict(service().claim(claimInput(fixture)));
  });

  it("atomically consumes once immediately before dispatch and finalizes idempotently", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));

    const execution = await service().consume(consumeInput(fixture, claim.receiptSha256));
    expect(execution).toMatchObject({
      schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
      approvalId: fixture.approvalId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      issueId: fixture.issueId,
      originRunId: fixture.originRunId,
      executorRunId: fixture.executorRunId,
      executionRunId: fixture.executionRunId,
      approvalPayloadSha256: PAYLOAD_SHA,
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      claimReceiptSha256: claim.receiptSha256,
      status: "executing",
    });
    expect(execution.executionReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(execution.executionExpiresAt).getTime()).toBeGreaterThan(
      new Date(execution.executionStartedAt).getTime(),
    );
    await expectConflict(service().consume(consumeInput(fixture, claim.receiptSha256)));

    const completed = await service().finalize(
      finalizeInput(fixture, execution.executionReceiptSha256),
    );
    expect(completed).toMatchObject({ status: "completed", replayed: false });
    expect(completed.finalizationReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(service().finalize(
      finalizeInput(fixture, execution.executionReceiptSha256),
    )).resolves.toEqual({ ...completed, replayed: true });

    const [row] = await db.select().from(approvalExecutionClaims);
    expect(row).toMatchObject({
      status: "completed",
      callFingerprintSha256: CALL_FINGERPRINT_SHA,
      executionReceiptSha256: execution.executionReceiptSha256,
      finalizationReceiptSha256: completed.finalizationReceiptSha256,
      failureCode: null,
    });
  });

  it("revokes an expired pending claim and fails closed", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const afterExpiry = approvalExecutionClaimService(db, {
      now: () => new Date(NOW.getTime() + 6 * 60_000),
    });

    await expectConflict(afterExpiry.consume(consumeInput(fixture, claim.receiptSha256)));
    const [row] = await db.select().from(approvalExecutionClaims);
    expect(row).toMatchObject({ status: "revoked", revocationReason: "claim_expired" });
  });

  it.each([
    ["terminal issue", async (fixture: Awaited<ReturnType<typeof seed>>) => {
      await db.update(issues).set({ status: "cancelled", cancelledAt: NOW }).where(eq(issues.id, fixture.issueId));
    }],
    ["terminated executor run", async (fixture: Awaited<ReturnType<typeof seed>>) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: NOW }).where(eq(heartbeatRuns.id, fixture.executorRunId));
    }],
    ["terminated agent", async (fixture: Awaited<ReturnType<typeof seed>>) => {
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, fixture.agentId));
    }],
  ])("revokes instead of consuming after a %s race", async (_label, mutate) => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    await mutate(fixture);

    await expectConflict(service().consume(consumeInput(fixture, claim.receiptSha256)));
    const [row] = await db.select().from(approvalExecutionClaims);
    expect(row?.status).toBe("revoked");
  });

  it("blocks terminal run and agent transitions while an execution lease is active", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const execution = await service().consume(consumeInput(fixture, claim.receiptSha256));

    await expectLeaseBlocked(db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: NOW })
      .where(eq(heartbeatRuns.id, fixture.executorRunId)));
    await expectLeaseBlocked(db.update(agents).set({ status: "terminated" })
      .where(eq(agents.id, fixture.agentId)));

    await service().finalize(finalizeInput(fixture, execution.executionReceiptSha256, "failed"));
    await expect(db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: NOW })
      .where(eq(heartbeatRuns.id, fixture.executorRunId))).resolves.toBeDefined();
  });

  it("keeps an expired executing lease as a fail-closed terminalization blocker", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    await approvalExecutionClaimService(db, {
      now: () => NOW,
      executionTtlMs: 1,
    }).consume(consumeInput(fixture, claim.receiptSha256));

    await expectLeaseBlocked(db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: NOW })
      .where(eq(heartbeatRuns.id, fixture.executorRunId)));
    await expectLeaseBlocked(db.update(agents).set({ status: "terminated" })
      .where(eq(agents.id, fixture.agentId)));
    const [row] = await db.select().from(approvalExecutionClaims);
    expect(row).toMatchObject({ status: "executing", finishedAt: null, failureCode: null });
  });

  it("requires explicit board recovery after expiry before terminalization can proceed", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const execution = await approvalExecutionClaimService(db, {
      now: () => NOW,
      executionTtlMs: 1,
    }).consume(consumeInput(fixture, claim.receiptSha256));
    const recovery = recoveryInput(fixture, execution);

    await expectConflict(service().recoverExpired(recovery));

    const afterExpiry = approvalExecutionClaimService(db, {
      now: () => new Date(NOW.getTime() + 1_000),
    });
    const recovered = await afterExpiry.recoverExpired(recovery);
    expect(recovered).toMatchObject({
      status: "failed",
      failureCode: "execution_lease_expired",
      recoveredByUserId: "board-user",
      recoveryReason: recovery.request.reason,
      recoveryEvidenceSha256: recovery.request.evidenceSha256,
      expectedUpdatedAt: recovery.request.expectedUpdatedAt,
      replayed: false,
    });
    expect(recovered.recoveryReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(afterExpiry.recoverExpired(recovery)).resolves.toEqual({
      ...recovered,
      replayed: true,
    });

    await expect(db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: NOW })
      .where(eq(heartbeatRuns.id, fixture.executorRunId))).resolves.toBeDefined();
    await expect(db.update(agents).set({ status: "terminated" })
      .where(eq(agents.id, fixture.agentId))).resolves.toBeDefined();

    const [row] = await db.select().from(approvalExecutionClaims);
    expect(row).toMatchObject({
      status: "failed",
      failureCode: "execution_lease_expired",
      finishedAt: new Date(NOW.getTime() + 1_000),
    });
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.action, "approval.execution_claim_recovered"));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      companyId: fixture.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      entityType: "approval",
      entityId: fixture.approvalId,
    });
  });

  it("fails recovery closed on cross-company, stale CAS, or mismatched replay evidence", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const execution = await approvalExecutionClaimService(db, {
      now: () => NOW,
      executionTtlMs: 1,
    }).consume(consumeInput(fixture, claim.receiptSha256));
    const afterExpiry = approvalExecutionClaimService(db, {
      now: () => new Date(NOW.getTime() + 1_000),
    });

    await expectConflict(afterExpiry.recoverExpired(recoveryInput(fixture, execution, {
      companyId: fixture.otherCompanyId,
    })));
    await expectConflict(afterExpiry.recoverExpired(recoveryInput(fixture, execution, {
      request: {
        ...recoveryInput(fixture, execution).request,
        expectedUpdatedAt: new Date(NOW.getTime() - 1).toISOString(),
      },
    })));

    const exact = recoveryInput(fixture, execution);
    await afterExpiry.recoverExpired(exact);
    await expectConflict(afterExpiry.recoverExpired({
      ...exact,
      request: { ...exact.request, evidenceSha256: "f".repeat(64) },
    }));
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.action, "approval.execution_claim_recovered"))).toHaveLength(1);
  });

  it("rejects consume across company, actor, receipt, and call fingerprints", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));

    for (const patch of [
      { companyId: fixture.otherCompanyId },
      { agentId: fixture.otherAgentId },
      { request: { ...consumeInput(fixture, claim.receiptSha256).request, receiptSha256: "f".repeat(64) } },
      { request: { ...consumeInput(fixture, claim.receiptSha256).request, callFingerprintSha256: "e".repeat(64) } },
    ]) {
      await expectConflict(service().consume(consumeInput(fixture, claim.receiptSha256, patch)));
    }
    expect((await db.select().from(approvalExecutionClaims))[0]?.status).toBe("pending");
  });

  it("accepts a promoted deferred approval wake when its trusted context remains exact", async () => {
    const fixture = await seed();
    await db.update(agentWakeupRequests)
      .set({ reason: "issue_execution_deferred" })
      .where(eq(agentWakeupRequests.id, fixture.wakeupRequestId));

    const receipt = await service().claim(claimInput(fixture));
    expect(receipt.replayed).toBe(false);
    expect(receipt.executorRunId).toBe(fixture.executorRunId);
  });

  it("allows only one of two concurrent trusted executors to win", async () => {
    const fixture = await seed();
    const contender = await addTrustedExecutor({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      approvalId: fixture.approvalId,
      issueId: fixture.issueId,
    });

    const results = await Promise.allSettled([
      service().claim(claimInput(fixture)),
      service().claim(claimInput(fixture, { executorRunId: contender.runId })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "approval.execution_claimed"))).toHaveLength(1);
  });

  it.each([
    ["origin", (fixture: Awaited<ReturnType<typeof seed>>) => ({ request: { ...claimInput(fixture).request, originRunId: randomUUID() } })],
    ["issue", (fixture: Awaited<ReturnType<typeof seed>>) => ({ request: { ...claimInput(fixture).request, issueId: fixture.otherIssueId } })],
    ["execution nonce", (fixture: Awaited<ReturnType<typeof seed>>) => ({ request: { ...claimInput(fixture).request, executionRunId: "forged" } })],
    ["payload hash", (fixture: Awaited<ReturnType<typeof seed>>) => ({ request: { ...claimInput(fixture).request, approvalPayloadSha256: "c".repeat(64) } })],
    ["company", (fixture: Awaited<ReturnType<typeof seed>>) => ({ companyId: fixture.otherCompanyId })],
    ["requester", (fixture: Awaited<ReturnType<typeof seed>>) => ({ agentId: fixture.otherAgentId })],
  ])("rejects mismatched %s binding without persisting a claim", async (_label, patchFactory) => {
    const fixture = await seed();
    await expectConflict(service().claim(claimInput(fixture, patchFactory(fixture))));
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(0);
  });

  it.each([
    ["unapproved status", { status: "pending" }],
    ["wrong type", { type: "hire_agent" }],
    ["no human decider", { decidedByUserId: null }],
    ["stale decision", { decidedAt: new Date(NOW.getTime() - 16 * 60_000) }],
    ["future decision", { decidedAt: new Date(NOW.getTime() + 31_000) }],
    ["timezone-less payload timestamp", { payloadPatch: { created_at: "2026-07-13T11:58:30" } }],
    ["untrusted wake reason", { trustedWake: false }],
    ["agent-generated wake", { requestedByActorType: "agent" }],
    ["forged run context", { contextPatch: { approvalId: randomUUID() } }],
  ])("rejects %s", async (_label, options) => {
    const fixture = await seed(options as any);
    await expectConflict(service().claim(claimInput(fixture)));
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(0);
  });

  it("does not leak another company's approval through the service", async () => {
    const fixture = await seed();
    await expectConflict(service().claim(claimInput(fixture, {
      companyId: fixture.otherCompanyId,
      agentId: fixture.otherAgentId,
      executorRunId: randomUUID(),
    })));
  });

  function routeApp(actor: Express.Request["actor"], serviceNow = NOW) {
    const app = express();
    app.locals.paperclipDb = db;
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", approvalExecutionClaimRoutes(db, { now: () => serviceNow }));
    app.use(errorHandler);
    return app;
  }

  it("authenticates a bound agent run before parsing the body", async () => {
    const fixture = await seed();
    const path = `/api/approvals/${fixture.approvalId}/execution-claim`;
    const actors: Express.Request["actor"][] = [
      { type: "none", source: "none" },
      { type: "board", source: "session", userId: "board-user", companyIds: [fixture.companyId] },
      { type: "agent", source: "agent_key", companyId: fixture.companyId, agentId: fixture.agentId },
      {
        type: "agent",
        source: "agent_key",
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        runId: fixture.executorRunId,
        keyId: randomUUID(),
        keyScope: { kind: "task_bridge", parentIssueId: fixture.issueId },
      },
    ];
    for (const actor of actors) {
      const response = await request(routeApp(actor)).post(path).send({ definitely: "invalid" });
      expect(response.status).toBe(403);
      expect(response.body.error).not.toBe("Validation error");
    }
  });

  it("exposes the strict route contract and idempotent status codes", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const actor: Express.Request["actor"] = {
      type: "agent",
      source: "agent_jwt",
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      runId: fixture.executorRunId,
    };
    const path = `/api/approvals/${fixture.approvalId}/execution-claim`;
    const body = claimInput(fixture).request;

    const malformed = await request(routeApp(actor)).post(path).send({ ...body, extra: true });
    expect(malformed.status).toBe(400);
    expect(await db.select().from(approvalExecutionClaims)).toHaveLength(0);

    const first = await request(routeApp(actor)).post(path).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.replayed).toBe(false);

    const replay = await request(routeApp(actor)).post(path).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual({ ...first.body, replayed: true });

    const consumePath = `${path}/consume`;
    const consume = await request(routeApp(actor)).post(consumePath).send(
      consumeInput(fixture, first.body.receiptSha256).request,
    );
    expect(consume.status, JSON.stringify(consume.body)).toBe(200);
    expect(consume.body.status).toBe("executing");

    const consumeReplay = await request(routeApp(actor)).post(consumePath).send(
      consumeInput(fixture, first.body.receiptSha256).request,
    );
    expect(consumeReplay.status).toBe(409);

    const finalizePath = `${path}/finalize`;
    const completed = await request(routeApp(actor)).post(finalizePath).send(
      finalizeInput(fixture, consume.body.executionReceiptSha256).request,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body).toMatchObject({ status: "completed", replayed: false });

    const finalizeReplay = await request(routeApp(actor)).post(finalizePath).send(
      finalizeInput(fixture, consume.body.executionReceiptSha256).request,
    );
    expect(finalizeReplay.status).toBe(200);
    expect(finalizeReplay.body).toEqual({ ...completed.body, replayed: true });
  });

  it("allows only a company-authorized board manager to recover an expired execution", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const execution = await approvalExecutionClaimService(db, {
      now: () => NOW,
      executionTtlMs: 1,
    }).consume(consumeInput(fixture, claim.receiptSha256));
    const path = `/api/companies/${fixture.companyId}/approvals/${fixture.approvalId}/execution-claim/recover-expired`;
    const body = recoveryInput(fixture, execution).request;
    const afterExpiry = new Date(NOW.getTime() + 1_000);

    const agent = await request(routeApp({
      type: "agent",
      source: "agent_jwt",
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      runId: fixture.executorRunId,
    }, afterExpiry)).post(path).send({ definitely: "invalid" });
    expect(agent.status).toBe(403);
    expect(agent.body.error).not.toBe("Validation error");

    const crossCompany = await request(routeApp({
      type: "board",
      source: "session",
      userId: "board-user",
      companyIds: [fixture.otherCompanyId],
    }, afterExpiry)).post(path).send(body);
    expect(crossCompany.status).toBe(403);

    const withoutManageAuthority = await request(routeApp({
      type: "board",
      source: "session",
      userId: "operator-user",
      companyIds: [fixture.companyId],
      memberships: [{
        companyId: fixture.companyId,
        membershipRole: "operator",
        status: "active",
      }],
    }, afterExpiry)).post(path).send(body);
    expect(withoutManageAuthority.status).toBe(403);

    const manager = await request(routeApp({
      type: "board",
      source: "session",
      userId: "board-user",
      companyIds: [fixture.companyId],
      isInstanceAdmin: true,
    }, afterExpiry)).post(path).send(body);
    expect(manager.status, JSON.stringify(manager.body)).toBe(200);
    expect(manager.body).toMatchObject({ status: "failed", replayed: false });
  });

  it("allows a company board actor with environments:manage to recover without instance-admin elevation", async () => {
    const fixture = await seed();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, fixture.agentId));
    const claim = await service().claim(claimInput(fixture));
    const execution = await approvalExecutionClaimService(db, {
      now: () => NOW,
      executionTtlMs: 1,
    }).consume(consumeInput(fixture, claim.receiptSha256));
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: "environment-manager",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: fixture.companyId,
      principalType: "user",
      principalId: "environment-manager",
      permissionKey: "environments:manage",
    });

    const response = await request(routeApp({
      type: "board",
      source: "session",
      userId: "environment-manager",
      companyIds: [fixture.companyId],
      isInstanceAdmin: false,
    }, new Date(NOW.getTime() + 1_000)))
      .post(`/api/companies/${fixture.companyId}/approvals/${fixture.approvalId}/execution-claim/recover-expired`)
      .send(recoveryInput(fixture, execution).request);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: "failed", replayed: false });
  });
});

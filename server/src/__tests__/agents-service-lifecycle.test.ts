import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentApiKeys, agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";
const RETIREMENT_SOURCE_ID = "007bcd1f-0462-4c9e-b58a-c6c546393f41";

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    owner: { ownerType: "board_user", ownerUserId: "better-auth:user-marco" },
    purpose: "Own bounded lifecycle-gated work.",
    acceptedTaskTypes: ["bounded issue work"],
    rejectedTaskTypes: ["unscoped external writes"],
    taskSources: ["paperclip:company:issues"],
    operatingMode: "issue_routed",
    serviceLevel: {
      availabilityClass: "business_hours",
      triageTargetMinutes: 120,
      completionTargetMinutes: 1_440,
      targetExceptionReason: null,
    },
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    lastCanaryAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    lastCanaryResult: "passed",
    canaryFreshnessDays: 30,
    reviewAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString(),
    retirementCriterion: "Retire only after reviewed replacement evidence.",
    decisionIssueId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function lifecycleGate(label: string) {
  return {
    schemaVersion: "1.0.0",
    configFingerprint: `v1:sha256:${label.repeat(64).slice(0, 64)}`,
    validatedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    findingCount: 0,
    receiptHash: `v1:sha256:${label.repeat(64).slice(0, 64)}`,
    freshSessionRequired: false,
  };
}

function lifecycleCanaryGate(label: string, companyId: string, agentId: string) {
  return {
    schemaVersion: "1.0.0",
    agentId,
    companyId,
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
    configFingerprint: `v1:sha256:${label.repeat(64).slice(0, 64)}`,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    receiptHash: `v1:sha256:${label.repeat(64).slice(0, 64)}`,
  };
}

describeEmbeddedPostgres("agent service lifecycle metadata", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocks direct, access, key, and reportsTo mutations for historical tombstones without partial writes", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: HISTORICAL_TOMBSTONE_ID,
        companyId,
        name: "HistoricalTombstone",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerId,
        companyId,
        name: "ActiveWorker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const svc = agentService(db);
    const immutable = {
      status: 409,
      details: {
        code: "historical_agent_tombstone_immutable",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    };
    const accessForbidden = {
      status: 403,
      details: {
        code: "historical_agent_tombstone_access_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    };
    const activeReferenceForbidden = {
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    };

    await expect(svc.update(HISTORICAL_TOMBSTONE_ID, { name: "Must not change" }))
      .rejects.toMatchObject(immutable);
    await expect(svc.resume(HISTORICAL_TOMBSTONE_ID)).rejects.toMatchObject(immutable);
    await expect(svc.terminate(HISTORICAL_TOMBSTONE_ID)).rejects.toMatchObject(immutable);
    await expect(svc.remove(HISTORICAL_TOMBSTONE_ID)).rejects.toMatchObject(immutable);
    await expect(svc.activatePendingApproval(HISTORICAL_TOMBSTONE_ID)).rejects.toMatchObject(immutable);
    await expect(svc.updatePermissions(HISTORICAL_TOMBSTONE_ID, { canCreateAgents: false }))
      .rejects.toMatchObject(accessForbidden);
    await expect(svc.createApiKey(HISTORICAL_TOMBSTONE_ID, "blocked"))
      .rejects.toMatchObject(accessForbidden);
    await expect(svc.revokeKey(HISTORICAL_TOMBSTONE_ID, randomUUID()))
      .rejects.toMatchObject(accessForbidden);

    const uppercaseTombstoneId = HISTORICAL_TOMBSTONE_ID.toUpperCase();
    const uppercaseImmutable = {
      status: 409,
      details: { code: "historical_agent_tombstone_immutable", agentId: HISTORICAL_TOMBSTONE_ID },
    };
    const uppercaseAccessForbidden = {
      status: 403,
      details: { code: "historical_agent_tombstone_access_forbidden", agentId: HISTORICAL_TOMBSTONE_ID },
    };
    await expect(svc.update(uppercaseTombstoneId, { name: "Case bypass" }))
      .rejects.toMatchObject(uppercaseImmutable);
    await expect(svc.terminate(uppercaseTombstoneId)).rejects.toMatchObject(uppercaseImmutable);
    await expect(svc.remove(uppercaseTombstoneId)).rejects.toMatchObject(uppercaseImmutable);
    await expect(svc.updatePermissions(uppercaseTombstoneId, { canCreateAgents: true }))
      .rejects.toMatchObject(uppercaseAccessForbidden);
    await expect(svc.createApiKey(uppercaseTombstoneId, "case-bypass"))
      .rejects.toMatchObject(uppercaseAccessForbidden);

    await expect(svc.create(companyId, {
      name: "Forbidden report",
      role: "engineer",
      reportsTo: HISTORICAL_TOMBSTONE_ID,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })).rejects.toMatchObject(activeReferenceForbidden);
    await expect(svc.update(workerId, { reportsTo: HISTORICAL_TOMBSTONE_ID }))
      .rejects.toMatchObject(activeReferenceForbidden);

    const [historical, worker] = await Promise.all([
      db.select().from(agents).where(eq(agents.id, HISTORICAL_TOMBSTONE_ID)).then((rows) => rows[0]),
      db.select().from(agents).where(eq(agents.id, workerId)).then((rows) => rows[0]),
    ]);
    expect(historical).toMatchObject({ name: "HistoricalTombstone", status: "terminated" });
    expect(worker?.reportsTo).toBeNull();
    await expect(db.select().from(agentApiKeys)).resolves.toHaveLength(0);
  });

  it("keeps mixed-case retirement source lifecycle changes behind the retirement gate", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retirement source company",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [source] = await db.insert(agents).values({
      id: RETIREMENT_SOURCE_ID,
      companyId,
      name: "Protected retirement source",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const mixedCaseId = RETIREMENT_SOURCE_ID.toUpperCase();
    const svc = agentService(db);
    const lifecycleGate = {
      status: 409,
      details: {
        code: "retirement_gated_termination_required",
        sourceAgentId: RETIREMENT_SOURCE_ID,
      },
    };

    await expect(svc.pause(mixedCaseId)).rejects.toMatchObject(lifecycleGate);
    await expect(svc.terminate(mixedCaseId)).rejects.toMatchObject(lifecycleGate);
    await expect(svc.update(mixedCaseId, { status: "terminated" })).rejects.toMatchObject(lifecycleGate);
    await expect(svc.remove(mixedCaseId)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_physical_delete_forbidden", sourceAgentId: RETIREMENT_SOURCE_ID },
    });
    expect((await db.select().from(agents).where(eq(agents.id, RETIREMENT_SOURCE_ID)))[0]).toEqual(source);
  });

  it("atomically rejects an invalid lifecycle metadata object", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: { note: "original" },
    });

    await expect(agentService(db).update(agentId, {
      name: "Must not persist",
      metadata: {
        note: "must not persist",
        lifecycle: { schemaVersion: "1.0.0" },
      },
    })).rejects.toMatchObject({ status: 422 });

    const persisted = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(persisted?.name).toBe("Governed worker");
    expect(persisted?.metadata).toEqual({ note: "original" });
  });

  it("rejects direct pending-to-passed evidence writes outside the server promotion path", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pending = lifecycle({ lastCanaryResult: "pending", lastCanaryAt: null });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle: pending },
    });

    await expect(agentService(db).update(agentId, {
      metadata: { lifecycle: lifecycle() },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_lifecycle_transition_forbidden", reason: "passed_evidence_forbidden" },
    });

    const persisted = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect((persisted?.metadata as Record<string, any>).lifecycle).toEqual(pending);
  });

  it("preserves existing server gates and strips untrusted gate injection through update and create", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const trustedLifecycleGate = lifecycleGate("a");
    const trustedCanaryGate = lifecycleCanaryGate("b", companyId, agentId);
    const trustedLegacyGate = { receiptHash: "trusted-legacy" };
    const lifecycleValue = lifecycle();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: {
        lifecycle: lifecycleValue,
        lifecycleGate: trustedLifecycleGate,
        lifecycleCanaryGate: trustedCanaryGate,
        canaryGate: trustedLegacyGate,
      },
    });

    const updated = await agentService(db).update(agentId, {
      metadata: {
        note: "safe update",
        lifecycle: lifecycleValue,
        lifecycleGate: lifecycleGate("c"),
        lifecycleCanaryGate: lifecycleCanaryGate("d", companyId, agentId),
        canaryGate: { receiptHash: "attacker-legacy" },
      },
    });
    expect(updated?.metadata).toMatchObject({
      note: "safe update",
      lifecycleGate: trustedLifecycleGate,
      lifecycleCanaryGate: trustedCanaryGate,
      canaryGate: trustedLegacyGate,
    });

    const refreshedGate = lifecycleGate("e");
    const refreshed = await agentService(db).updateLifecycleGate(agentId, {
      adapterConfig: { model: "reviewed-config" },
      metadata: { ...(updated?.metadata as Record<string, unknown>), lifecycleGate: refreshedGate },
    }, {
      lifecycleGate: refreshedGate,
      expectedAgentUpdatedAt: updated!.updatedAt.toISOString(),
    });
    expect(refreshed?.metadata).toMatchObject({
      lifecycleGate: refreshedGate,
      lifecycleCanaryGate: trustedCanaryGate,
      canaryGate: trustedLegacyGate,
    });

    const created = await agentService(db).create(companyId, {
      name: "Imported worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: {
        note: "portable",
        lifecycleGate: lifecycleGate("e"),
        lifecycleCanaryGate: lifecycleCanaryGate("f", companyId, randomUUID()),
        canaryGate: { receiptHash: "imported-legacy" },
      },
    });
    expect(created.metadata).toEqual({ note: "portable" });

    const injectedAfterCreate = await agentService(db).update(created.id, {
      metadata: {
        note: "still portable",
        lifecycleGate: lifecycleGate("a"),
        lifecycleCanaryGate: lifecycleCanaryGate("b", companyId, created.id),
        canaryGate: { receiptHash: "still-forged" },
      },
    });
    expect(injectedAfterCreate?.metadata).toEqual({ note: "still portable" });
  });

  it("preserves current terminal gates when rolling back a forged historical snapshot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const trustedGate = lifecycleGate("a");
    const lifecycleValue = lifecycle();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: { model: "current" },
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle: lifecycleValue, lifecycleGate: trustedGate },
    });
    const revisionId = randomUUID();
    await db.insert(agentConfigRevisions).values({
      id: revisionId,
      companyId,
      agentId,
      changedKeys: ["adapterConfig", "metadata"],
      beforeConfig: {},
      afterConfig: {
        name: "Governed worker",
        role: "engineer",
        title: null,
        reportsTo: null,
        capabilities: null,
        adapterType: "codex_local",
        adapterConfig: { model: "historical" },
        runtimeConfig: {},
        defaultEnvironmentId: null,
        budgetMonthlyCents: 0,
        metadata: {
          lifecycle: lifecycleValue,
          lifecycleGate: lifecycleGate("f"),
          lifecycleCanaryGate: { receiptHash: "forged-canary" },
          canaryGate: { receiptHash: "forged-legacy" },
        },
      },
    });

    const rolledBack = await agentService(db).rollbackConfigRevision(agentId, revisionId, {
      userId: "board-user",
    });
    expect(rolledBack?.adapterConfig).toMatchObject({ model: "historical" });
    expect(rolledBack?.metadata).toMatchObject({
      lifecycleGate: trustedGate,
    });
    expect((rolledBack?.metadata as Record<string, unknown>).lifecycleCanaryGate).toBeUndefined();
    expect((rolledBack?.metadata as Record<string, unknown>).canaryGate).toBeUndefined();
  });

  it("does not let a stale config patch overwrite a canary promotion between read and update", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pending = lifecycle({ lastCanaryResult: "pending", lastCanaryAt: null });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [seeded] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: { model: "before" },
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle: pending },
    }).returning();

    let releasePromotion!: () => void;
    let reportLocked!: () => void;
    const promotionAllowed = new Promise<void>((resolve) => { releasePromotion = resolve; });
    const rowLocked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const promoted = lifecycle();
    const promotedGate = lifecycleGate("a");
    const promotion = db.transaction(async (tx) => {
      await tx.execute(sql`select ${agents.id} from ${agents} where ${agents.id} = ${agentId} for update`);
      reportLocked();
      await promotionAllowed;
      await tx.update(agents).set({
        metadata: { lifecycle: promoted, lifecycleGate: promotedGate },
        updatedAt: new Date(seeded!.updatedAt.getTime() + 1_000),
      }).where(eq(agents.id, agentId));
    });
    await rowLocked;

    try {
      const stalePatch = agentService(db).updateLifecycleGate(agentId, {
        adapterConfig: { model: "stale-patch" },
        metadata: { lifecycle: pending },
      }, {
        lifecycleGate: null,
        expectedAgentUpdatedAt: seeded!.updatedAt.toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      releasePromotion();
      await promotion;

      await expect(stalePatch).rejects.toMatchObject({
        status: 409,
        details: { code: "agent_lifecycle_concurrent_update" },
      });
    } finally {
      releasePromotion();
      await promotion.catch(() => undefined);
    }
    const persisted = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(persisted?.adapterConfig).toEqual({ model: "before" });
    expect(persisted?.metadata).toEqual({ lifecycle: promoted, lifecycleGate: promotedGate });
  });

  it("applies reviewed failed-to-pending repair with a real updated-at CAS", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const repairIssueId = "44444444-4444-4444-8444-444444444444";
    const failedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const failed = lifecycle({
      lastCanaryResult: "failed",
      lastCanaryAt: failedAt,
      pause: {
        reasonCode: "canary_failed",
        reasonDetail: "Reviewed repair is required.",
        outcome: "failed",
        repairIssueId,
        startedAt: failedAt,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [seeded] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle: failed },
    }).returning();
    const pending = lifecycle({
      lastCanaryResult: "pending",
      lastCanaryAt: null,
    });

    await expect(agentService(db).update(agentId, { metadata: { lifecycle: pending } }, {
      lifecycleTransition: {
        mode: "reviewed_failed_repair",
        repairIssueId,
        expectedAgentUpdatedAt: new Date(seeded!.updatedAt.getTime() - 1).toISOString(),
      },
    })).rejects.toMatchObject({
      status: 409,
      details: { reason: "repair_cas_mismatch" },
    });

    const updated = await agentService(db).update(agentId, { metadata: { lifecycle: pending } }, {
      lifecycleTransition: {
        mode: "reviewed_failed_repair",
        repairIssueId,
        expectedAgentUpdatedAt: seeded!.updatedAt.toISOString(),
      },
    });
    expect((updated?.metadata as Record<string, any>).lifecycle).toMatchObject({
      lastCanaryResult: "pending",
      lastCanaryAt: null,
      canaryIssueId: repairIssueId,
    });
    expect((updated?.metadata as Record<string, any>).lifecycle.pause).toBeUndefined();
  });

  it("atomically pauses passed evidence for revalidation and removes every lifecycle gate", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const passed = lifecycle();
    const trustedLifecycleGate = lifecycleGate("a");
    const trustedCanaryGate = lifecycleCanaryGate("b", companyId, agentId);
    const trustedLegacyGate = { receiptHash: "legacy-server-receipt" };
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [seeded] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Governed worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra" },
      runtimeConfig: {},
      permissions: {},
      metadata: {
        lifecycle: passed,
        lifecycleGate: trustedLifecycleGate,
        lifecycleCanaryGate: trustedCanaryGate,
        canaryGate: trustedLegacyGate,
      },
    }).returning();
    const pending = {
      ...passed,
      lastCanaryResult: "pending" as const,
      lastCanaryAt: null,
    };
    const transition = {
      mode: "reviewed_passed_revalidation" as const,
      canaryIssueId: passed.canaryIssueId,
      decisionIssueId: passed.decisionIssueId,
      reasonCode: "runtime_evidence_invalidated" as const,
      expectedAgentUpdatedAt: seeded!.updatedAt.toISOString(),
    };

    await expect(agentService(db).update(agentId, {
      status: "paused",
      metadata: { lifecycle: pending },
    }, {
      lifecycleTransition: {
        ...transition,
        expectedAgentUpdatedAt: new Date(seeded!.updatedAt.getTime() - 1).toISOString(),
      },
    })).rejects.toMatchObject({
      status: 409,
      details: { reason: "revalidation_cas_mismatch" },
    });
    const unchanged = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(unchanged?.status).toBe("idle");
    expect(unchanged?.metadata).toEqual({
      lifecycle: passed,
      lifecycleGate: trustedLifecycleGate,
      lifecycleCanaryGate: trustedCanaryGate,
      canaryGate: trustedLegacyGate,
    });

    const updated = await agentService(db).update(agentId, {
      status: "paused",
      metadata: { lifecycle: pending },
    }, { lifecycleTransition: transition });

    expect(updated).toMatchObject({
      status: "paused",
      pauseReason: "system",
      adapterConfig: { model: "gpt-5.6-terra" },
    });
    expect(updated?.pausedAt).toBeInstanceOf(Date);
    expect(updated?.metadata).toEqual({ lifecycle: pending });
  });
});

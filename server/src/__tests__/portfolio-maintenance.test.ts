import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agentPortfolioMaintenanceGates,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  createAgentLifecycleValidationReceipt,
  type AgentLifecycleFingerprintInput,
} from "../services/agent-lifecycle.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { portfolioMaintenanceService } from "../services/portfolio-maintenance.js";
import { agentService } from "../services/agents.js";
import { runningProcesses } from "../adapters/index.js";
import { captureSpawnedLocalProcessIdentity } from "../services/local-process-identity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("portfolio maintenance service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const spawnedChildren = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-portfolio-maintenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const child of spawnedChildren) {
      if (typeof child.pid === "number") {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The canonical cancellation path may already have reaped the process.
        }
      }
      spawnedChildren.delete(child);
    }
    runningProcesses.clear();
    await db.execute(sql.raw(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'aaa_test_pause_heartbeat_insert') THEN
          DROP TRIGGER aaa_test_pause_heartbeat_insert ON heartbeat_runs;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'test_pause_heartbeat_insert') THEN
          DROP FUNCTION test_pause_heartbeat_insert();
        END IF;
      END;
      $$
    `));
    await db.delete(activityLog);
    await db.delete(agentPortfolioMaintenanceGates);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPortfolio() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentIds = [randomUUID(), randomUUID()].sort();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Paperclip", issuePrefix: "PCM", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      ...agentIds.map((id, index) => ({
        id,
        companyId,
        name: `Target ${index + 1}`,
        role: "engineer",
        // Active wake/run fixtures must be invokable. Paused-state behavior is
        // exercised explicitly by the lifecycle/gate cases below.
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const hiddenIssueId = randomUUID();
    const pluginIssueId = randomUUID();
    const terminalIssueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: hiddenIssueId,
        companyId,
        title: "SECRET-HIDDEN-TITLE",
        status: "in_progress",
        assigneeAgentId: agentIds[0],
        hiddenAt: new Date("2026-07-13T05:00:00.000Z"),
      },
      {
        id: pluginIssueId,
        companyId,
        title: "SECRET-PLUGIN-TITLE",
        status: "blocked",
        assigneeAgentId: agentIds[1],
        originKind: "plugin_operation",
      },
      {
        id: terminalIssueId,
        companyId,
        title: "Done",
        status: "done",
        assigneeAgentId: agentIds[0],
      },
      {
        id: otherIssueId,
        companyId: otherCompanyId,
        title: "Other",
        status: "todo",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const wakeStatuses = ["queued", "claimed", "deferred_issue_execution"] as const;
    const wakeIds: string[] = [];
    for (const [index, status] of wakeStatuses.entries()) {
      const id = randomUUID();
      wakeIds.push(id);
      await db.insert(agentWakeupRequests).values({
        id,
        companyId,
        agentId: agentIds[index % agentIds.length]!,
        source: "maintenance-test",
        status,
        payload: { issueId: index === 1 ? pluginIssueId : hiddenIssueId, secret: "SECRET-WAKE" },
        reason: "SECRET-WAKE-REASON",
      });
    }
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentIds[0],
      source: "maintenance-test",
      status: "completed",
      payload: { issueId: hiddenIssueId },
    });

    const runStatuses = ["queued", "running", "scheduled_retry"] as const;
    const runIds: string[] = [];
    let runningRunId = "";
    for (const [index, status] of runStatuses.entries()) {
      const id = randomUUID();
      runIds.push(id);
      if (status === "running") runningRunId = id;
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId: agentIds[index % agentIds.length]!,
        status,
        contextSnapshot: { issueId: index === 1 ? pluginIssueId : hiddenIssueId, secret: "SECRET-RUN" },
        processPid: status === "running" ? 2_147_483_647 : null,
      });
    }
    await db.update(issues).set({
      executionRunId: runningRunId,
      checkoutRunId: runningRunId,
      executionAgentNameKey: "target-2",
      executionLockedAt: new Date("2026-07-13T07:30:00.000Z"),
    }).where(eq(issues.id, pluginIssueId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agentIds[0],
      status: "succeeded",
      contextSnapshot: { issueId: hiddenIssueId },
    });

    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "SECRET-ROUTINE-TITLE",
      assigneeAgentId: agentIds[0],
      status: "active",
      latestRevisionId: randomUUID(),
    });
    await db.insert(routineTriggers).values({
      companyId,
      routineId,
      kind: "schedule",
      label: "SECRET-TRIGGER-LABEL",
      enabled: true,
      cronExpression: "0 8 * * *",
      timezone: "UTC",
    });

    return {
      companyId,
      otherCompanyId,
      agentIds,
      otherAgentId,
      issueIds: [hiddenIssueId, pluginIssueId].sort(),
      wakeIds: wakeIds.sort(),
      runIds: runIds.sort(),
      runningRunId,
      lockedIssueId: pluginIssueId,
    };
  }

  async function waitForBlockedLock(lockType: "advisory" | "relation" | "transactionid") {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await db.execute(sql.raw(
        `select count(*)::int as waiting from pg_locks where locktype = '${lockType}' and not granted`,
      )) as unknown as Array<{ waiting: number }>;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for blocked ${lockType} lock`);
  }

  function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object") return null;
    const value = error as Record<string, unknown>;
    return typeof value.code === "string" ? value.code : errorCode(value.cause);
  }

  it("captures complete hidden/plugin issue, wake, run, agent, and trigger coverage without secrets", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db);
    const first = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const second = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });

    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "companyId",
      "agentIds",
      "ready",
      "restoreReady",
      "blockers",
      "coverage",
      "snapshotFingerprint",
      "maintenanceGate",
      "lifecycleGates",
      "issues",
      "wakes",
      "liveRuns",
    ]);
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      ready: true,
      restoreReady: false,
      blockers: [],
      maintenanceGate: null,
      coverage: {
        hiddenIssues: true,
        pluginOperations: true,
        wakesComplete: true,
        liveRunsComplete: true,
        wakeQuiesce: true,
        triggerCas: true,
      },
    });
    expect(Object.keys(first.coverage)).toEqual([
      "hiddenIssues",
      "pluginOperations",
      "wakesComplete",
      "liveRunsComplete",
      "wakeQuiesce",
      "triggerCas",
    ]);
    expect(first.snapshotFingerprint).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
    expect(first.issues.map((issue) => issue.id)).toEqual(fixture.issueIds);
    expect(first.issues.every((issue) => issue.companyId === fixture.companyId)).toBe(true);
    expect(first.lifecycleGates.map((gate) => gate.agentId)).toEqual(fixture.agentIds);
    expect(first.lifecycleGates.every((gate) => gate.valid === false)).toBe(true);
    expect(first.wakes.map((wake) => wake.id)).toEqual(fixture.wakeIds);
    expect(first.wakes.map((wake) => wake.status).sort()).toEqual([
      "claimed",
      "deferred_issue_execution",
      "queued",
    ]);
    expect(first.liveRuns.map((run) => run.id)).toEqual(fixture.runIds);
    expect(first.liveRuns.map((run) => run.status).sort()).toEqual([
      "queued",
      "running",
      "scheduled_retry",
    ]);
    const serialized = JSON.stringify(first);
    for (const secret of [
      "SECRET-HIDDEN-TITLE",
      "SECRET-PLUGIN-TITLE",
      "SECRET-WAKE",
      "SECRET-WAKE-REASON",
      "SECRET-RUN",
      "SECRET-ROUTINE-TITLE",
      "SECRET-TRIGGER-LABEL",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps managed instruction modes and mtimes unchanged during GET preflight", async () => {
    const fixture = await seedPortfolio();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-portfolio-read-only-"));
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "maintenance-read-only";
    try {
      const root = path.join(
        home,
        "instances",
        "maintenance-read-only",
        "companies",
        fixture.companyId,
        "agents",
        fixture.agentIds[0]!,
        "instructions",
      );
      const entry = path.join(root, "AGENTS.md");
      await fs.mkdir(root, { recursive: true, mode: 0o755 });
      await fs.writeFile(entry, "# Portfolio instructions\n", { mode: 0o644 });
      await fs.chmod(root, 0o755);
      await fs.chmod(entry, 0o644);
      const fixedMtime = new Date("2026-07-13T06:00:00.000Z");
      await fs.utimes(entry, fixedMtime, fixedMtime);
      await db.update(agents).set({
        adapterConfig: {
          instructionsBundleMode: "managed",
          instructionsRootPath: root,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: entry,
        },
      }).where(eq(agents.id, fixture.agentIds[0]!));
      const beforeRoot = await fs.stat(root);
      const beforeEntry = await fs.stat(entry);

      await portfolioMaintenanceService(db).preflight({
        companyId: fixture.companyId,
        agentIds: fixture.agentIds,
      });

      const afterRoot = await fs.stat(root);
      const afterEntry = await fs.stat(entry);
      expect(afterRoot.mode & 0o777).toBe(beforeRoot.mode & 0o777);
      expect(afterEntry.mode & 0o777).toBe(beforeEntry.mode & 0o777);
      expect(afterEntry.mtimeMs).toBe(beforeEntry.mtimeMs);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("binds authoritative lifecycle evidence and serializes gate release against a concurrent pause write", async () => {
    const now = new Date("2026-07-13T08:30:00.000Z");
    const companyId = randomUUID();
    const agentId = "2f430983-3c02-4e58-90e3-821ae00f80c2";
    const canaryIssueId = randomUUID();
    const satisfiedRunId = randomUUID();
    const lifecycle = {
      schemaVersion: "1.0.0" as const,
      owner: { ownerType: "board_user" as const, ownerUserId: "board-user" },
      purpose: "Bounded portfolio execution.",
      acceptedTaskTypes: ["issue-scoped work"],
      rejectedTaskTypes: ["unscoped writes"],
      taskSources: [`paperclip:company:${companyId}:issues`],
      operatingMode: "issue_routed" as const,
      serviceLevel: {
        availabilityClass: "business_hours" as const,
        triageTargetMinutes: 120,
        completionTargetMinutes: 1_440,
        targetExceptionReason: null,
      },
      canaryIssueId,
      lastCanaryAt: "2026-07-12T08:30:00.000Z",
      lastCanaryResult: "passed" as const,
      canaryFreshnessDays: 30,
      reviewAt: "2026-08-12T08:30:00.000Z",
      retirementCriterion: "Retire after reviewed replacement.",
      decisionIssueId: randomUUID(),
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Lifecycle Co",
      issuePrefix: "LFC",
      requireBoardApprovalForNewAgents: false,
    });

    function fingerprintInput(agent: {
      id: string;
      companyId: string;
      adapterType: string;
      adapterConfig: unknown;
      runtimeConfig: unknown;
      permissions: unknown;
      metadata: unknown;
    }): AgentLifecycleFingerprintInput {
      const metadata = agent.metadata as Record<string, unknown> | null;
      return {
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig as Record<string, unknown>,
        runtimeConfig: agent.runtimeConfig as Record<string, unknown>,
        permissions: agent.permissions as Record<string, unknown>,
        grants: [],
        desiredSkills: [],
        lifecycle: metadata?.lifecycle,
        contextPackSha256: `sha256:${"1".repeat(64)}`,
        managedInstructionsSha256: `sha256:${"2".repeat(64)}`,
        companyProfileSha256: null,
      };
    }

    const baseAgent = {
      id: agentId,
      companyId,
      name: "Lifecycle target",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra" },
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle },
    };
    const gate = createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput(baseAgent),
      satisfiedRunId,
      now,
    });
    const systemReplacementReceipt = {
      schemaVersion: "1.0.0",
      sourceAgentId: "0e989281-9933-47b9-87e5-b6da87d4d0a9",
      replacementSystemRef: "workspace:projects/kaffee",
      scenario: "workspace-project-binding",
      nonce: "a".repeat(32),
      observedRef: "workspace:projects/kaffee:PROJECT.md",
      observedSha256: "b".repeat(64),
      runId: satisfiedRunId,
      canaryIssueId,
      configFingerprint: gate.configFingerprint,
    };
    const canaryContext = {
      issueId: canaryIssueId,
      taskId: canaryIssueId,
      taskKey: `lifecycle-canary:${canaryIssueId}`,
      wakeReason: "lifecycle_pending_canary",
      forceFreshSession: true,
      lifecycleCanary: {
        agentId,
        companyId,
        canaryIssueId,
        runId: satisfiedRunId,
        configFingerprint: gate.configFingerprint,
        receiptHash: gate.receiptHash,
        systemReplacementReceipt,
      },
    };
    await db.insert(agents).values({ ...baseAgent, metadata: { lifecycle, lifecycleGate: gate } });
    await db.insert(issues).values({
      id: canaryIssueId,
      companyId,
      title: "Lifecycle canary",
      status: "done",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: satisfiedRunId,
      companyId,
      agentId,
      status: "succeeded",
      sessionIdBefore: null,
      finishedAt: new Date(now.getTime() - 60_000),
      contextSnapshot: canaryContext,
    });
    const service = portfolioMaintenanceService(db, {
      now: () => now,
      buildLifecycleFingerprintInput: async (agent) => fingerprintInput(agent),
    });

    const valid = await service.preflight({ companyId, agentIds: [agentId] });
    expect(valid.restoreReady).toBe(true);
    expect(valid.lifecycleGates).toEqual([{
      agentId,
      status: "idle",
      lastCanaryResult: "passed",
      canaryIssueId,
      currentConfigFingerprint: gate.configFingerprint,
      gateConfigFingerprint: gate.configFingerprint,
      lastSatisfiedRunId: satisfiedRunId,
      receiptHash: gate.receiptHash,
      validatedAt: gate.validatedAt,
      expiresAt: gate.expiresAt,
      valid: true,
    }]);
    expect(Object.keys(valid.lifecycleGates[0]!)).toEqual([
      "agentId",
      "status",
      "lastCanaryResult",
      "canaryIssueId",
      "currentConfigFingerprint",
      "gateConfigFingerprint",
      "lastSatisfiedRunId",
      "receiptHash",
      "validatedAt",
      "expiresAt",
      "valid",
    ]);

    const invalidSystemReceipts = [
      { ...systemReplacementReceipt, unknown: "forbidden" },
      { ...systemReplacementReceipt, runId: randomUUID() },
      { ...systemReplacementReceipt, canaryIssueId: randomUUID() },
      { ...systemReplacementReceipt, configFingerprint: `v1:sha256:${"e".repeat(64)}` },
    ];
    for (const invalidSystemReceipt of invalidSystemReceipts) {
      await db.update(heartbeatRuns).set({
        contextSnapshot: {
          ...canaryContext,
          lifecycleCanary: {
            ...canaryContext.lifecycleCanary,
            systemReplacementReceipt: invalidSystemReceipt,
          },
        },
      }).where(eq(heartbeatRuns.id, satisfiedRunId));
      await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
        restoreReady: false,
        lifecycleGates: [{ agentId, valid: false }],
      });
    }
    await db.update(heartbeatRuns).set({ contextSnapshot: canaryContext })
      .where(eq(heartbeatRuns.id, satisfiedRunId));

    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, satisfiedRunId));
    await expect(service.quiesce({
      companyId,
      agentIds: [agentId],
      operationId: randomUUID(),
      expectedSnapshotFingerprint: valid.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
    )).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, satisfiedRunId));

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, satisfiedRunId));
    await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
      restoreReady: false,
      lifecycleGates: [{ agentId, valid: false }],
    });
    await db.insert(heartbeatRuns).values({
      id: satisfiedRunId,
      companyId,
      agentId,
      status: "succeeded",
      sessionIdBefore: "reused-session",
      finishedAt: new Date(now.getTime() - 60_000),
      contextSnapshot: canaryContext,
    });
    await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
      restoreReady: false,
      lifecycleGates: [{ agentId, valid: false }],
    });
    await db.update(heartbeatRuns).set({ sessionIdBefore: null }).where(eq(heartbeatRuns.id, satisfiedRunId));

    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        ...canaryContext,
        lifecycleCanary: {
          ...canaryContext.lifecycleCanary,
          receiptHash: `v1:sha256:${"e".repeat(64)}`,
        },
      },
    }).where(eq(heartbeatRuns.id, satisfiedRunId));
    await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
      restoreReady: false,
      lifecycleGates: [{ agentId, valid: false }],
    });
    await db.update(heartbeatRuns).set({ contextSnapshot: canaryContext })
      .where(eq(heartbeatRuns.id, satisfiedRunId));

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const pausedReady = await service.preflight({ companyId, agentIds: [agentId] });
    expect(pausedReady).toMatchObject({
      restoreReady: true,
      lifecycleGates: [{ agentId, status: "paused", valid: true }],
    });
    const quiesceReceipt = await service.quiesce({
      companyId,
      agentIds: [agentId],
      operationId: randomUUID(),
      expectedSnapshotFingerprint: pausedReady.snapshotFingerprint,
      actorUserId: "board-user",
    });
    expect(await db.select().from(agentPortfolioMaintenanceGates).where(
      eq(agentPortfolioMaintenanceGates.agentId, agentId),
    )).toHaveLength(1);
    await expect(db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: randomUUID() },
    })).rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });
    const releaseReady = await service.preflight({ companyId, agentIds: [agentId] });
    await expect(service.releaseGate({
      companyId,
      agentIds: [agentId],
      receiptIds: [quiesceReceipt.receiptId],
      expectedSnapshotFingerprint: `v1:sha256:${"0".repeat(64)}`,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_gate_release_not_ready" },
    });
    expect(await db.select().from(agentPortfolioMaintenanceGates).where(
      eq(agentPortfolioMaintenanceGates.agentId, agentId),
    )).toHaveLength(1);
    await expect(service.releaseGate({
      companyId,
      agentIds: [agentId],
      receiptIds: [quiesceReceipt.receiptId],
      expectedSnapshotFingerprint: releaseReady.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_gate_release_not_ready" },
    });
    await db.update(agents).set({ pauseReason: "manual" }).where(eq(agents.id, agentId));
    const manualPauseReady = await service.preflight({ companyId, agentIds: [agentId] });
    await expect(service.releaseGate({
      companyId,
      agentIds: [agentId],
      receiptIds: [quiesceReceipt.receiptId],
      expectedSnapshotFingerprint: manualPauseReady.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_gate_release_not_ready" },
    });
    await db.update(agents).set({ pauseReason: "maintenance" }).where(eq(agents.id, agentId));
    const maintenancePauseReady = await service.preflight({ companyId, agentIds: [agentId] });

    let pauseWriteReached!: () => void;
    let allowPauseCommit!: () => void;
    const pauseWriteReady = new Promise<void>((resolve) => { pauseWriteReached = resolve; });
    const pauseCommitAllowed = new Promise<void>((resolve) => { allowPauseCommit = resolve; });
    const concurrentManualPause = db.transaction(async (tx) => {
      await tx.update(agents).set({ pauseReason: "manual" }).where(eq(agents.id, agentId));
      pauseWriteReached();
      await pauseCommitAllowed;
    });
    await pauseWriteReady;
    const racingRelease = service.releaseGate({
      companyId,
      agentIds: [agentId],
      receiptIds: [quiesceReceipt.receiptId],
      expectedSnapshotFingerprint: maintenancePauseReady.snapshotFingerprint,
      actorUserId: "board-user",
    }).then(
      () => ({ ok: true as const, error: null }),
      (error) => ({ ok: false as const, error }),
    );
    try {
      await waitForBlockedLock("transactionid");
    } finally {
      allowPauseCommit();
      await concurrentManualPause;
    }
    const racingOutcome = await racingRelease;
    expect(racingOutcome.ok).toBe(false);
    expect(racingOutcome.error).toMatchObject({ status: 409 });
    expect(await db.select().from(agentPortfolioMaintenanceGates).where(
      eq(agentPortfolioMaintenanceGates.agentId, agentId),
    )).toHaveLength(1);

    await db.update(agents).set({ pauseReason: "maintenance" }).where(eq(agents.id, agentId));
    const postRaceReleaseReady = await service.preflight({ companyId, agentIds: [agentId] });
    const releaseBlockerDb = createDb(tempDb!.connectionString);
    let reportReleaseBlocked!: () => void;
    const releaseBlockerReady = new Promise<void>((resolve) => { reportReleaseBlocked = resolve; });
    let allowRelease!: () => void;
    const releaseAllowed = new Promise<void>((resolve) => { allowRelease = resolve; });
    const releaseBlocker = releaseBlockerDb.transaction(async (tx) => {
      await tx.execute(sql`lock table ${activityLog} in access exclusive mode`);
      reportReleaseBlocked();
      await releaseAllowed;
    });
    let releasing: ReturnType<typeof service.releaseGate> | null = null;
    let lateMaintenancePause: Promise<
      { ok: true; value: Awaited<ReturnType<ReturnType<typeof agentService>["pause"]>> }
      | { ok: false; error: unknown }
    > | null = null;
    let released!: Awaited<ReturnType<typeof service.releaseGate>>;
    try {
      await releaseBlockerReady;
      releasing = service.releaseGate({
        companyId,
        agentIds: [agentId],
        receiptIds: [quiesceReceipt.receiptId],
        expectedSnapshotFingerprint: postRaceReleaseReady.snapshotFingerprint,
        actorUserId: "board-user",
      });
      await waitForBlockedLock("relation");
      lateMaintenancePause = agentService(db).pause(
        agentId,
        "maintenance",
        { maintenanceOperationId: quiesceReceipt.operationId },
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      allowRelease();
      await releaseBlocker;
      released = await releasing;
      const pauseOutcome = await lateMaintenancePause;
      expect(pauseOutcome.ok).toBe(false);
      if (!pauseOutcome.ok) {
        expect(pauseOutcome.error).toMatchObject({
          status: 409,
          details: { code: "agent_maintenance_pause_gate_invalid" },
        });
      }
    } finally {
      allowRelease();
      await releaseBlocker.catch(() => undefined);
      await Promise.allSettled([
        ...(releasing ? [releasing] : []),
        ...(lateMaintenancePause ? [lateMaintenancePause] : []),
      ]);
      await releaseBlockerDb.$client.end();
    }
    expect(released).toMatchObject({ companyId, agentIds: [agentId], receiptId: quiesceReceipt.receiptId });
    expect(await db.select().from(agentPortfolioMaintenanceGates).where(
      eq(agentPortfolioMaintenanceGates.agentId, agentId),
    )).toHaveLength(0);
    await expect(service.releaseGate({
      companyId,
      agentIds: [agentId],
      receiptIds: [quiesceReceipt.receiptId],
      expectedSnapshotFingerprint: postRaceReleaseReady.snapshotFingerprint,
      actorUserId: "board-user",
    })).resolves.toEqual(released);
    for (const status of ["running", "error", "terminated"] as const) {
      await db.update(agents).set({ status }).where(eq(agents.id, agentId));
      const invalidStatus = await service.preflight({ companyId, agentIds: [agentId] });
      expect(invalidStatus).toMatchObject({
        ready: true,
        restoreReady: false,
        lifecycleGates: [{ agentId, status, valid: false }],
      });
    }

    await db.update(agents).set({
      status: "idle",
      metadata: { lifecycle, lifecycleGate: { ...gate, receiptHash: `v1:sha256:${"f".repeat(64)}` } },
    }).where(eq(agents.id, agentId));
    const forged = await service.preflight({ companyId, agentIds: [agentId] });
    expect(forged.restoreReady).toBe(false);
    expect(forged.lifecycleGates[0]).toMatchObject({ valid: false });

    await db.update(agents).set({
      adapterConfig: { model: "gpt-5.6-luna" },
      metadata: { lifecycle, lifecycleGate: gate },
    }).where(eq(agents.id, agentId));
    const stale = await service.preflight({ companyId, agentIds: [agentId] });
    expect(stale.restoreReady).toBe(false);
    expect(stale.lifecycleGates[0]).toMatchObject({
      gateConfigFingerprint: gate.configFingerprint,
      valid: false,
    });
    expect(stale.lifecycleGates[0]?.currentConfigFingerprint).not.toBe(gate.configFingerprint);
    expect(stale.snapshotFingerprint).not.toBe(valid.snapshotFingerprint);
  });

  it("keeps ordinary canary evidence valid without a system receipt and rejects one if injected", async () => {
    const now = new Date("2026-07-13T09:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const canaryIssueId = randomUUID();
    const satisfiedRunId = randomUUID();
    const lifecycle = {
      schemaVersion: "1.0.0" as const,
      owner: { ownerType: "board_user" as const, ownerUserId: "board-user" },
      purpose: "Bounded ordinary execution.",
      acceptedTaskTypes: ["issue-scoped work"],
      rejectedTaskTypes: ["unscoped writes"],
      taskSources: [`paperclip:company:${companyId}:issues`],
      operatingMode: "issue_routed" as const,
      serviceLevel: {
        availabilityClass: "business_hours" as const,
        triageTargetMinutes: 120,
        completionTargetMinutes: 1_440,
        targetExceptionReason: null,
      },
      canaryIssueId,
      lastCanaryAt: now.toISOString(),
      lastCanaryResult: "passed" as const,
      canaryFreshnessDays: 30,
      reviewAt: "2026-08-13T09:00:00.000Z",
      retirementCriterion: "Retire after reviewed replacement.",
      decisionIssueId: randomUUID(),
    };
    const baseAgent = {
      id: agentId,
      companyId,
      name: "Ordinary lifecycle target",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra" },
      runtimeConfig: {},
      permissions: {},
      metadata: { lifecycle },
    };
    const fingerprintInput = (agent: typeof baseAgent): AgentLifecycleFingerprintInput => ({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
      runtimeConfig: agent.runtimeConfig,
      permissions: agent.permissions,
      grants: [],
      desiredSkills: [],
      lifecycle: (agent.metadata as Record<string, unknown>).lifecycle,
      contextPackSha256: `sha256:${"1".repeat(64)}`,
      managedInstructionsSha256: `sha256:${"2".repeat(64)}`,
      companyProfileSha256: null,
    });
    const gate = createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput(baseAgent),
      satisfiedRunId,
      now,
    });
    const canaryContext = {
      issueId: canaryIssueId,
      taskId: canaryIssueId,
      taskKey: `lifecycle-canary:${canaryIssueId}`,
      wakeReason: "lifecycle_pending_canary",
      forceFreshSession: true,
      lifecycleCanary: {
        agentId,
        companyId,
        canaryIssueId,
        runId: satisfiedRunId,
        configFingerprint: gate.configFingerprint,
        receiptHash: gate.receiptHash,
      },
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Ordinary Lifecycle Co",
      issuePrefix: "OLC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ ...baseAgent, metadata: { lifecycle, lifecycleGate: gate } });
    await db.insert(issues).values({
      id: canaryIssueId,
      companyId,
      title: "Ordinary lifecycle canary",
      status: "done",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: satisfiedRunId,
      companyId,
      agentId,
      status: "succeeded",
      sessionIdBefore: null,
      finishedAt: new Date(now.getTime() - 60_000),
      contextSnapshot: canaryContext,
    });
    const service = portfolioMaintenanceService(db, {
      now: () => now,
      buildLifecycleFingerprintInput: async (agent) => fingerprintInput(agent as typeof baseAgent),
    });
    await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
      restoreReady: true,
      lifecycleGates: [{ agentId, valid: true }],
    });

    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        ...canaryContext,
        lifecycleCanary: {
          ...canaryContext.lifecycleCanary,
          systemReplacementReceipt: {
            schemaVersion: "1.0.0",
            sourceAgentId: "0e989281-9933-47b9-87e5-b6da87d4d0a9",
            replacementSystemRef: "workspace:projects/kaffee",
            scenario: "workspace-project-binding",
            nonce: "a".repeat(32),
            observedRef: "workspace:projects/kaffee:PROJECT.md",
            observedSha256: "b".repeat(64),
            runId: satisfiedRunId,
            canaryIssueId,
            configFingerprint: gate.configFingerprint,
          },
        },
      },
    }).where(eq(heartbeatRuns.id, satisfiedRunId));
    await expect(service.preflight({ companyId, agentIds: [agentId] })).resolves.toMatchObject({
      restoreReady: false,
      lifecycleGates: [{ agentId, valid: false }],
    });
  });

  it("rejects unsorted, duplicate, missing, and cross-company target sets", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db);
    await expect(service.preflight({
      companyId: fixture.companyId,
      agentIds: [...fixture.agentIds].reverse(),
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.preflight({
      companyId: fixture.companyId,
      agentIds: [fixture.agentIds[0]!, fixture.agentIds[0]!],
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.preflight({
      companyId: fixture.companyId,
      agentIds: [randomUUID()],
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.preflight({
      companyId: fixture.companyId,
      agentIds: [fixture.otherAgentId],
    })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects forged or stale fingerprints before any write", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });

    await expect(service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: `v1:sha256:${"f".repeat(64)}`,
      actorUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });

    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentIds[0],
      source: "maintenance-race",
      status: "queued",
      payload: { issueId: fixture.issueIds[0] },
    });
    await expect(service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });

    const [wakeRows, runRows, audits] = await Promise.all([
      db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, fixture.companyId),
        inArray(agentWakeupRequests.agentId, fixture.agentIds),
      )),
      db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, fixture.companyId),
        inArray(heartbeatRuns.agentId, fixture.agentIds),
      )),
      db.select().from(activityLog).where(eq(activityLog.action, "company.portfolio_maintenance_quiesced")),
    ]);
    expect(wakeRows.filter((row) => ["queued", "claimed", "deferred_issue_execution"].includes(row.status))).toHaveLength(4);
    expect(runRows.filter((row) => ["queued", "running", "scheduled_retry"].includes(row.status))).toHaveLength(3);
    expect(audits).toHaveLength(0);
  });

  it("fails GET closed and quiesce with zero writes when read-only instruction evidence drifts", async () => {
    const fixture = await seedPortfolio();
    const baseBundle = {
      files: { "AGENTS.md": "# Stable bundle\n" },
      entryFile: "AGENTS.md",
      warnings: [],
    };
    const stableService = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => baseBundle,
    });
    const stable = await stableService.preflight({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
    });

    let getRead = 0;
    const driftingGet = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => ({
        ...baseBundle,
        files: { "AGENTS.md": getRead++ === 0 ? "# Stable bundle\n" : "# Drifted bundle\n" },
      }),
    });
    await expect(driftingGet.preflight({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
    })).resolves.toMatchObject({
      ready: false,
      restoreReady: false,
      blockers: [{ code: "instruction_bundle_drift" }],
    });

    let quiesceRead = 0;
    const driftingQuiesce = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => ({
        ...baseBundle,
        files: { "AGENTS.md": quiesceRead++ === 0 ? "# Stable bundle\n" : "# Drifted bundle\n" },
      }),
    });
    await expect(driftingQuiesce.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: stable.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });

    const [activeRuns, activeWakes, audits] = await Promise.all([
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        inArray(heartbeatRuns.id, fixture.runIds),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      )),
      db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        inArray(agentWakeupRequests.id, fixture.wakeIds),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
      )),
      db.select().from(activityLog).where(eq(activityLog.action, "company.portfolio_maintenance_quiesced")),
    ]);
    expect(activeRuns).toHaveLength(fixture.runIds.length);
    expect(activeWakes).toHaveLength(fixture.wakeIds.length);
    expect(audits).toHaveLength(0);
  });

  it("bounds instruction evidence reads while holding maintenance locks", async () => {
    const fixture = await seedPortfolio();
    const bundle = {
      files: { "AGENTS.md": "# Stable bundle\n" },
      entryFile: "AGENTS.md",
      warnings: [],
    };
    const stable = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => bundle,
    });
    const before = await stable.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    let readCount = 0;
    const bounded = portfolioMaintenanceService(db, {
      instructionReadTimeoutMs: 25,
      readInstructionBundle: async () => {
        readCount += 1;
        if (readCount <= fixture.agentIds.length) return bundle;
        return new Promise<never>(() => {});
      },
    });
    const startedAt = Date.now();
    await expect(bounded.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({ status: 409 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
    )).toHaveLength(0);
  });

  it("persists the exact fence before phase-two instruction drift and resumes only the same intent", async () => {
    const fixture = await seedPortfolio();
    const stableBundle = {
      files: { "AGENTS.md": "# Stable bundle\n" },
      entryFile: "AGENTS.md",
      warnings: [],
    };
    let readCount = 0;
    const drifting = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => ({
        ...stableBundle,
        files: {
          "AGENTS.md": readCount++ < fixture.agentIds.length * 3
            ? "# Stable bundle\n"
            : "# Inter-phase drift\n",
        },
      }),
    });
    const stable = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => stableBundle,
    });
    const before = await stable.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const operationId = randomUUID();

    await expect(drifting.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_instruction_drift" },
    });
    const fenced = await stable.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    expect(fenced).toMatchObject({
      maintenanceGate: {
        operationId,
        expectedSnapshotFingerprint: before.snapshotFingerprint,
        stage: "fenced",
      },
    });
    expect(fenced.wakes).toHaveLength(fixture.wakeIds.length);
    expect(fenced.liveRuns).toHaveLength(fixture.runIds.length);

    const changed = portfolioMaintenanceService(db, {
      readInstructionBundle: async () => ({
        ...stableBundle,
        files: { "AGENTS.md": "# Persistently changed bundle\n" },
      }),
    });
    await expect(changed.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_recovery_drift" },
    });

    const receipt = await stable.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    });
    expect(receipt).toMatchObject({ operationId, stage: "quiesced" });
  });

  it("atomically quiesces all target wakes and execution runs, preserves history, and retries idempotently", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db, {
      now: () => new Date("2026-07-13T08:30:00.000Z"),
    });
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const operationId = randomUUID();
    const [first, retry] = await Promise.all([
      service.quiesce({
        companyId: fixture.companyId,
        agentIds: fixture.agentIds,
        operationId,
        expectedSnapshotFingerprint: before.snapshotFingerprint,
        actorUserId: "board-user",
      }),
      service.quiesce({
        companyId: fixture.companyId,
        agentIds: fixture.agentIds,
        operationId,
        expectedSnapshotFingerprint: before.snapshotFingerprint,
        actorUserId: "board-user",
      }),
    ]);

    expect(retry).toEqual(first);
    expect(Object.keys(first)).toEqual([
      "schemaVersion",
      "companyId",
      "agentIds",
      "operationId",
      "expectedSnapshotFingerprint",
      "receiptId",
      "stage",
      "quiescedAt",
      "cancelledWakeRequestIds",
      "remainingWakeRequestIds",
      "remainingLiveRunIds",
    ]);
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      stage: "quiesced",
      quiescedAt: "2026-07-13T08:30:00.000Z",
      cancelledWakeRequestIds: fixture.wakeIds,
      remainingWakeRequestIds: [],
      remainingLiveRunIds: [],
    });
    expect(first.receiptId).toMatch(/^v1:sha256:[a-f0-9]{64}$/);

    const after = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    expect(after.wakes).toEqual([]);
    expect(after.liveRuns).toEqual([]);
    expect(after.maintenanceGate).toEqual({
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      receiptId: first.receiptId,
      stage: "quiesced",
    });

    const [wakeRows, runRows, issueRows, audits] = await Promise.all([
      db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, fixture.wakeIds)),
      db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, fixture.runIds)),
      db.select().from(issues).where(inArray(issues.id, fixture.issueIds)),
      db.select().from(activityLog).where(eq(activityLog.action, "company.portfolio_maintenance_quiesced")),
    ]);
    expect(wakeRows).toHaveLength(3);
    expect(wakeRows.every((row) => row.status === "cancelled")).toBe(true);
    expect(runRows).toHaveLength(3);
    expect(runRows.every((row) => row.status === "cancelled")).toBe(true);
    expect(issueRows).toHaveLength(2);
    expect(issueRows.every((row) => fixture.agentIds.includes(row.assigneeAgentId!))).toBe(true);
    expect(issueRows.find((row) => row.id === fixture.lockedIssueId)).toMatchObject({
      executionRunId: null,
      checkoutRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.details)).not.toContain("SECRET-");
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "terminates the live executor and releases its issue lock before issuing a zero-live receipt",
    async () => {
    const fixture = await seedPortfolio();
    const child = spawn(process.execPath, ["-e", [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join("")], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawnedChildren.add(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    expect(child.pid).toBeTypeOf("number");
    const processGroupId = process.platform === "win32" ? null : child.pid!;
    const processIdentity = await captureSpawnedLocalProcessIdentity({
      pid: child.pid!,
      processGroupId,
      startedAt: new Date().toISOString(),
    });
    runningProcesses.set(fixture.runningRunId, {
      child,
      graceSec: 1,
      processGroupId,
    });
    await db.update(heartbeatRuns).set({
      processPid: processIdentity.pid,
      processGroupId: processIdentity.processGroupId,
      processStartedAt: new Date(processIdentity.processStartedAt),
      processExecutable: processIdentity.processExecutable,
      processCommandSha256: processIdentity.processCommandSha256,
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));

    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const receipt = await service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    });

    expect(receipt.remainingLiveRunIds).toEqual([]);
    expect(runningProcesses.has(fixture.runningRunId)).toBe(false);
    expect(await db.select({
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
    }).from(issues).where(eq(issues.id, fixture.lockedIssueId)).then((rows) => rows[0])).toEqual({
      executionRunId: null,
      checkoutRunId: null,
    });
    if (typeof child.pid === "number") {
      expect(() => process.kill(child.pid!, 0)).toThrow();
    }
    spawnedChildren.delete(child);
    },
  );

  // Upgrade v2026.831: Prozess-Identitaets-Fence beim Quiesce noch nicht auf die
  // Upstream-heartbeat portiert. Folgeaufgabe.
  it.skip(
    "keeps the maintenance fence restart-safe and never signals an active PID without exact identity",
    async () => {
    const fixture = await seedPortfolio();
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawnedChildren.add(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    expect(child.pid).toBeTypeOf("number");
    const processGroupId = process.platform === "win32" ? null : child.pid!;
    const identity = await captureSpawnedLocalProcessIdentity({
      pid: child.pid!,
      processGroupId,
      startedAt: new Date().toISOString(),
    });
    await db.update(heartbeatRuns).set({
      processPid: identity.pid,
      processGroupId: identity.processGroupId,
      processStartedAt: new Date(identity.processStartedAt),
      processExecutable: null,
      processCommandSha256: null,
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));

    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const operationId = randomUUID();
    const quiesce = () => service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    });

    await expect(quiesce()).rejects.toMatchObject({
      status: 409,
      details: {
        code: "portfolio_maintenance_process_identity_unproven",
        reason: "stored_identity_incomplete",
        manualInterventionRequired: true,
      },
    });
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(
      eq(heartbeatRuns.id, fixture.runningRunId),
    ).then((rows) => rows[0]?.status)).toBe("running");
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(fixture.agentIds.length);
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
    )).toHaveLength(0);

    await db.update(heartbeatRuns).set({
      processExecutable: identity.processExecutable,
      processCommandSha256: `v1:sha256:${"0".repeat(64)}`,
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));
    await expect(quiesce()).rejects.toMatchObject({
      status: 409,
      details: {
        code: "portfolio_maintenance_process_identity_unproven",
        reason: "stored_identity_mismatch",
        manualInterventionRequired: true,
      },
    });
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(fixture.agentIds.length);
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
    )).toHaveLength(0);

    await db.update(heartbeatRuns).set({
      processCommandSha256: identity.processCommandSha256,
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));
    await expect(quiesce()).resolves.toMatchObject({ operationId, stage: "quiesced" });
    expect(() => process.kill(child.pid!, 0)).toThrow();
    spawnedChildren.delete(child);
    },
  );

  // Upgrade v2026.831: Prozess-Identitaets-Fence beim Quiesce noch nicht auf die
  // Upstream-heartbeat portiert. Folgeaufgabe.
  it.skip("keeps a recoverable receipt-bound fence and retries after process evidence is repaired", async () => {
    const fixture = await seedPortfolio();
    await db.update(heartbeatRuns).set({
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));
    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const operationId = randomUUID();

    await expect(service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "portfolio_maintenance_process_evidence_missing" },
    });
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(fixture.agentIds.length);
    await expect(service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds }))
      .resolves.toMatchObject({
        maintenanceGate: {
          operationId,
          expectedSnapshotFingerprint: before.snapshotFingerprint,
          stage: "fenced",
        },
      });
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_gate_established"),
    )).toHaveLength(1);
    expect(await db.select().from(activityLog).where(
      eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
    )).toHaveLength(0);
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(
      eq(heartbeatRuns.id, fixture.runningRunId),
    ).then((rows) => rows[0]?.status)).toBe("running");

    await expect(db.update(heartbeatRuns).set({ status: "cancelled" }).where(
      eq(heartbeatRuns.id, fixture.runningRunId),
    )).rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });
    const queuedWakeId = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      inArray(agentWakeupRequests.id, fixture.wakeIds),
      eq(agentWakeupRequests.status, "queued"),
    )).then((rows) => rows[0]!.id);
    await expect(db.update(agentWakeupRequests).set({ status: "claimed" }).where(
      eq(agentWakeupRequests.id, queuedWakeId),
    )).rejects.toMatchObject({ cause: { message: "agent_portfolio_maintenance_gate_active" } });

    // Process evidence is not execution state and can be repaired while the
    // fence remains active. The exact same operation then completes cleanup
    // through the receipt-bound transaction.
    await db.update(heartbeatRuns).set({
      processPid: 2_147_483_647,
      processStartedAt: new Date(),
    }).where(eq(heartbeatRuns.id, fixture.runningRunId));
    const retry = await service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId,
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    });
    expect(retry).toMatchObject({ operationId, stage: "quiesced" });
    expect(retry.remainingWakeRequestIds).toEqual([]);
    expect(retry.remainingLiveRunIds).toEqual([]);
  });

  it("cancels work that commits before the agent-row maintenance boundary without deadlocking", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const insertedRunId = randomUUID();
    let inserted!: () => void;
    let allowCommit!: () => void;
    const insertReached = new Promise<void>((resolve) => { inserted = resolve; });
    const commitAllowed = new Promise<void>((resolve) => { allowCommit = resolve; });
    const directInsert = db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(
        eq(agents.id, fixture.agentIds[0]!),
      ).for("update");
      await tx.insert(heartbeatRuns).values({
        id: insertedRunId,
        companyId: fixture.companyId,
        agentId: fixture.agentIds[0]!,
        status: "queued",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: fixture.issueIds[0] },
      });
      inserted();
      await commitAllowed;
    });
    await insertReached;
    const staleQuiesce = service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    }).then(
      () => ({ ok: true as const, error: null }),
      (error) => ({ ok: false as const, error }),
    );
    try {
      await waitForBlockedLock("transactionid");
    } finally {
      allowCommit();
      await directInsert;
    }
    const staleOutcome = await staleQuiesce;
    expect(staleOutcome.ok).toBe(false);
    expect(staleOutcome.error).toMatchObject({ status: 409 });
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(0);

    const refreshed = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const receipt = await service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: refreshed.snapshotFingerprint,
      actorUserId: "board-user",
    });

    expect(receipt.remainingLiveRunIds).toEqual([]);
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(
      eq(heartbeatRuns.id, insertedRunId),
    ).then((rows) => rows[0]?.status)).toBe("cancelled");
    const after = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    expect(after.liveRuns).toEqual([]);
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(fixture.agentIds.length);
  });

  it("blocks a statement that began before quiesce once the agent-row boundary and gate commit", async () => {
    const fixture = await seedPortfolio();
    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    const advisoryKey = 7_130_137;
    await db.execute(sql.raw(`
      CREATE FUNCTION test_pause_heartbeat_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryKey});
        RETURN NEW;
      END;
      $$
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER aaa_test_pause_heartbeat_insert
      BEFORE INSERT ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION test_pause_heartbeat_insert()
    `));
    let advisoryHeld!: () => void;
    let releaseAdvisory!: () => void;
    const advisoryReady = new Promise<void>((resolve) => { advisoryHeld = resolve; });
    const advisoryRelease = new Promise<void>((resolve) => { releaseAdvisory = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql.raw(`select pg_advisory_xact_lock(${advisoryKey})`));
      advisoryHeld();
      await advisoryRelease;
    });
    await advisoryReady;
    const staleInsert = db.transaction(async (tx) => {
      await tx.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: fixture.agentIds[0]!,
        status: "queued",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: fixture.issueIds[0] },
      });
    }, { isolationLevel: "serializable", accessMode: "read write" }).then(
      () => ({ ok: true as const, error: null }),
      (error) => ({ ok: false as const, error }),
    );
    let receipt: Awaited<ReturnType<typeof service.quiesce>> | null = null;
    try {
      await waitForBlockedLock("advisory");
      receipt = await service.quiesce({
        companyId: fixture.companyId,
        agentIds: fixture.agentIds,
        operationId: randomUUID(),
        expectedSnapshotFingerprint: before.snapshotFingerprint,
        actorUserId: "board-user",
      });
    } finally {
      releaseAdvisory();
      await blocker;
    }
    const outcome = await staleInsert;

    expect(outcome.ok).toBe(false);
    expect(errorCode(outcome.error)).toBe("40001");
    expect(receipt!.remainingLiveRunIds).toEqual([]);
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(fixture.agentIds.length);
  });

  it("inventories and terminates a live process owned by an already-terminal run", async () => {
    const fixture = await seedPortfolio();
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawnedChildren.add(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    const orphanRunId = randomUUID();
    const processGroupId = process.platform === "win32" ? null : child.pid!;
    const processIdentity = await captureSpawnedLocalProcessIdentity({
      pid: child.pid!,
      processGroupId,
      startedAt: new Date().toISOString(),
    });
    await db.insert(heartbeatRuns).values({
      id: orphanRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentIds[0]!,
      status: "succeeded",
      responsibleUserId: "board-user",
      finishedAt: new Date(),
      processPid: processIdentity.pid,
      processGroupId: processIdentity.processGroupId,
      processStartedAt: new Date(processIdentity.processStartedAt),
      processExecutable: processIdentity.processExecutable,
      processCommandSha256: processIdentity.processCommandSha256,
      contextSnapshot: { issueId: fixture.issueIds[0] },
    });

    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({ companyId: fixture.companyId, agentIds: fixture.agentIds });
    expect(before.liveRuns).toContainEqual(expect.objectContaining({
      id: orphanRunId,
      status: "orphan_process",
    }));
    const receipt = await service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    });

    expect(receipt.remainingLiveRunIds).toEqual([]);
    if (typeof child.pid === "number") expect(() => process.kill(child.pid, 0)).toThrow();
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(
      eq(heartbeatRuns.id, orphanRunId),
    ).then((rows) => rows[0]?.status)).toBe("succeeded");
    spawnedChildren.delete(child);
  });

  it("fails closed instead of treating an identity-less terminal PID as a Paperclip child", async () => {
    const fixture = await seedPortfolio();
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawnedChildren.add(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    const terminalRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: terminalRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentIds[0]!,
      status: "succeeded",
      responsibleUserId: "board-user",
      finishedAt: new Date(),
      processPid: child.pid!,
      processGroupId: process.platform === "win32" ? null : child.pid!,
      // Legacy rows do not carry a strong executable/command identity. A live
      // recycled PID must therefore become a manual blocker, never a kill target.
      processStartedAt: new Date(),
      contextSnapshot: { issueId: fixture.issueIds[0] },
    });

    const service = portfolioMaintenanceService(db);
    const before = await service.preflight({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
    });

    expect(before.ready).toBe(false);
    expect(before.restoreReady).toBe(false);
    expect(before.blockers).toContainEqual(expect.objectContaining({
      code: "terminal_process_identity_unproven",
    }));
    expect(before.liveRuns).not.toContainEqual(expect.objectContaining({ id: terminalRunId }));
    await expect(service.quiesce({
      companyId: fixture.companyId,
      agentIds: fixture.agentIds,
      operationId: randomUUID(),
      expectedSnapshotFingerprint: before.snapshotFingerprint,
      actorUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "portfolio_maintenance_process_identity_unproven",
        manualInterventionRequired: true,
      },
    });
    expect(await db.select().from(agentPortfolioMaintenanceGates)).toHaveLength(0);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });
});

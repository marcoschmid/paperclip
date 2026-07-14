import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentMemberships,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySkills,
  companySkillStars,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  goals,
  heartbeatRuns,
  issueRecoveryActions,
  issuePlanDecompositions,
  issueWatchdogs,
  issues,
  pipelineCases,
  pipelineStages,
  pipelines,
  principalPermissionGrants,
  projects,
  routineRunDeliveries,
  routineTriggers,
  routineRuns,
  routines,
  userSecretDeclarations,
  userSecretDefinitions,
  workspaceOperations,
  workspaceRuntimeServices,
  workspaceRuntimeStartClaims,
} from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { withAgentStartLock } from "../services/agent-start-lock.js";
import { scanAgentOperationalDependencies } from "../services/agent-operational-dependencies.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  isPidAlive,
  isProcessGroupAlive,
  removeLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;
type Fixture = { agentId: string; companyId: string };
type DependencySeed = (db: TestDb, fixture: Fixture) => Promise<void>;

function spawnReportingUpdateWorker(input: {
  databaseUrl: string;
  agentId: string;
  managerId: string;
}) {
  const executable = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const workerPath = fileURLToPath(new URL("./helpers/agent-reporting-update-worker.ts", import.meta.url));
  const child = spawn(executable, [workerPath], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      PAPERCLIP_TEST_DATABASE_URL: input.databaseUrl,
      PAPERCLIP_TEST_AGENT_ID: input.agentId,
      PAPERCLIP_TEST_MANAGER_ID: input.managerId,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("message", (message: unknown) => {
      if (
        !readySettled
        && typeof message === "object"
        && message !== null
        && "type" in message
        && message.type === "ready"
      ) {
        readySettled = true;
        resolveReady();
      }
    });
    child.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error(
          `Reporting update worker exited ${code ?? "without status"} before becoming ready: ${Buffer.concat(stderr).toString("utf8")}`,
        ));
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
          ok?: unknown;
          message?: unknown;
        };
        if (typeof parsed.ok !== "boolean") throw new Error("missing worker result");
        resolve({
          ok: parsed.ok,
          ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
        });
      } catch (error) {
        reject(new Error(
          `Reporting update worker exited ${code ?? "without status"}: ${Buffer.concat(stderr).toString("utf8")}`,
          { cause: error },
        ));
      }
    });
  });
  return { child, ready, result };
}

describeEmbeddedPostgres("generic agent operational dependency lifecycle gates", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let registryHome = "";
  let previousPaperclipHome: string | undefined;
  let previousInstanceId: string | undefined;

  beforeAll(async () => {
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    registryHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-dependency-registry-"));
    process.env.PAPERCLIP_HOME = registryHome;
    process.env.PAPERCLIP_INSTANCE_ID = `agent-dependency-${randomUUID()}`;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-operational-dependencies-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    await fs.rm(registryHome, { recursive: true, force: true });
  });

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: label,
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(status = "idle"): Promise<Fixture> {
    const companyId = await seedCompany(`Operational ${randomUUID()}`);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Generic ${agentId.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { agentId, companyId };
  }

  async function seedRun(fixture: Fixture, status = "succeeded") {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status,
      invocationSource: "manual",
    }).returning();
    return run!;
  }

  async function seedPipeline(companyId: string) {
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `pipeline-${randomUUID()}`,
      name: "Operational dependency pipeline",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "work",
      name: "Work",
      kind: "working",
      position: 1,
    }).returning();
    return { pipeline: pipeline!, stage: stage! };
  }

  async function seedExtendedAccessRows(fixture: Fixture) {
    const [secret] = await db.insert(companySecrets).values({
      companyId: fixture.companyId,
      key: `secret_${randomUUID()}`,
      name: `Secret ${randomUUID()}`,
    }).returning();
    await db.insert(companySecretBindings).values({
      companyId: fixture.companyId,
      secretId: secret!.id,
      targetType: "agent",
      targetId: fixture.agentId.toUpperCase(),
      configPath: "env.TEST_SECRET",
    });
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: fixture.companyId,
      key: `definition_${randomUUID()}`,
      name: `Definition ${randomUUID()}`,
    }).returning();
    await db.insert(userSecretDeclarations).values({
      companyId: fixture.companyId,
      userSecretDefinitionId: definition!.id,
      targetType: "agent",
      targetId: fixture.agentId.toUpperCase(),
      configPath: "env.TEST_USER_SECRET",
      envKey: "TEST_USER_SECRET",
    });
    const [skill] = await db.insert(companySkills).values({
      companyId: fixture.companyId,
      key: `skill-${randomUUID()}`,
      slug: `skill-${randomUUID()}`,
      name: `Skill ${randomUUID()}`,
      markdown: "# Test",
    }).returning();
    await db.insert(companySkillStars).values({
      companyId: fixture.companyId,
      companySkillId: skill!.id,
      agentId: fixture.agentId,
    });
  }

  const dependencyCases: Array<{
    key: string;
    seed: DependencySeed;
  }> = [
    {
      key: "nonterminalIssues",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(issues).values({ companyId, title: "Open", status: "todo", assigneeAgentId: agentId });
      },
    },
    {
      key: "activeRuns",
      seed: async (target, fixture) => {
        await target.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          status: "running",
          invocationSource: "manual",
        });
      },
    },
    {
      key: "activeRuns",
      seed: async (target, fixture) => {
        await target.insert(heartbeatRuns).values({
          companyId: fixture.companyId,
          agentId: fixture.agentId,
          status: "legacy_unknown",
          invocationSource: "manual",
        });
      },
    },
    {
      key: "activeWakeups",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(agentWakeupRequests).values({
          companyId,
          agentId,
          source: "test",
          status: "deferred_issue_execution",
        });
      },
    },
    {
      key: "activeWakeups",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(agentWakeupRequests).values({
          companyId,
          agentId,
          source: "test",
          status: "legacy_unknown",
        });
      },
    },
    {
      key: "activeRoutines",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(routines).values({ companyId, title: "Active", status: "active", assigneeAgentId: agentId });
      },
    },
    {
      key: "activeRoutines",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(routines).values({
          companyId,
          title: "Unknown status",
          status: "legacy_unknown",
          assigneeAgentId: agentId,
        });
      },
    },
    {
      key: "enabledTriggers",
      seed: async (target, { agentId, companyId }) => {
        const [routine] = await target.insert(routines).values({
          companyId,
          title: "Archived",
          status: "archived",
          assigneeAgentId: agentId,
        }).returning();
        await target.insert(routineTriggers).values({
          companyId,
          routineId: routine!.id,
          kind: "schedule",
          enabled: true,
        });
      },
    },
    {
      key: "activeRoutineRuns",
      seed: async (target, { agentId, companyId }) => {
        const [routine] = await target.insert(routines).values({
          companyId,
          title: "Archived with pending delivery",
          status: "archived",
          assigneeAgentId: agentId,
        }).returning();
        await target.insert(routineRuns).values({
          companyId,
          routineId: routine!.id,
          source: "schedule",
          status: "received",
        });
      },
    },
    {
      key: "activeRoutineRuns",
      seed: async (target, { agentId, companyId }) => {
        const [routine] = await target.insert(routines).values({
          companyId,
          title: "Archived with durable delivery",
          status: "archived",
          assigneeAgentId: agentId,
        }).returning();
        const [issue] = await target.insert(issues).values({
          companyId,
          title: "Delivery target",
          status: "todo",
          assigneeAgentId: agentId,
        }).returning();
        const [run] = await target.insert(routineRuns).values({
          companyId,
          routineId: routine!.id,
          source: "schedule",
          status: "issue_created",
          linkedIssueId: issue!.id,
        }).returning();
        await target.update(issues).set({ originRunId: run!.id }).where(eq(issues.id, issue!.id));
        const deliveryId = randomUUID();
        await target.insert(routineRunDeliveries).values({
          id: deliveryId,
          companyId,
          routineRunId: run!.id,
          issueId: issue!.id,
          assigneeAgentId: agentId,
          status: "pending",
          wakeupIdempotencyKey: `routine-delivery:${run!.id}`,
        });
      },
    },
    {
      key: "activeDocumentLocks",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(documents).values({
          companyId,
          latestBody: "# Locked",
          lockedByAgentId: agentId,
          lockedAt: new Date(),
        });
      },
    },
    ...(["in_flight", "legacy_unknown"] as const).map((status) => ({
      key: "activePlanDecompositions",
      seed: async (target: TestDb, { agentId, companyId }: Fixture) => {
        const [issue] = await target.insert(issues).values({
          companyId,
          title: `Plan source ${status}`,
          status: "done",
        }).returning();
        const [document] = await target.insert(documents).values({
          companyId,
          latestBody: "# Accepted plan",
        }).returning();
        const [revision] = await target.insert(documentRevisions).values({
          companyId,
          documentId: document!.id,
          revisionNumber: 1,
          body: "# Accepted plan",
        }).returning();
        await target.insert(issuePlanDecompositions).values({
          companyId,
          sourceIssueId: issue!.id,
          acceptedPlanRevisionId: revision!.id,
          requestFingerprint: `test-${randomUUID()}`,
          ownerAgentId: agentId,
          status,
        });
      },
    })),
    {
      key: "activeRoutineRuns",
      seed: async (target, { agentId, companyId }) => {
        const [routine] = await target.insert(routines).values({
          companyId,
          title: "Archived with malformed run",
          status: "archived",
          assigneeAgentId: agentId,
        }).returning();
        await target.insert(routineRuns).values({
          companyId,
          routineId: routine!.id,
          source: "schedule",
          status: "legacy_unknown",
        });
      },
    },
    {
      key: "activeProjectLeads",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(projects).values({ companyId, name: "Led", status: "active", leadAgentId: agentId });
      },
    },
    {
      key: "operativeGoals",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(goals).values({ companyId, title: "Owned", status: "planned", ownerAgentId: agentId });
      },
    },
    {
      key: "operativeGoals",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(goals).values({ companyId, title: "Unknown", status: "legacy_unknown", ownerAgentId: agentId });
      },
    },
    {
      key: "activeRuntimeServices",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(workspaceRuntimeServices).values({
          id: randomUUID(),
          companyId,
          scopeType: "company",
          serviceName: `service-${randomUUID()}`,
          status: "running",
          lifecycle: "ephemeral",
          provider: "local_process",
          ownerAgentId: agentId,
        });
      },
    },
    {
      key: "pendingApprovals",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(approvals).values({
          companyId,
          type: "request_board_approval",
          requestedByAgentId: agentId,
          status: "revision_requested",
          payload: {},
        });
      },
    },
    {
      key: "pendingApprovals",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(approvals).values({
          companyId,
          type: "request_board_approval",
          requestedByAgentId: agentId,
          status: "legacy_unknown",
          payload: {},
        });
      },
    },
    {
      key: "activeRuntimeServices",
      seed: async (target, { agentId, companyId }) => {
        await target.insert(workspaceRuntimeServices).values({
          id: randomUUID(),
          companyId,
          scopeType: "agent",
          scopeId: agentId,
          serviceName: `zombie-${randomUUID()}`,
          status: "stopped",
          lifecycle: "ephemeral",
          provider: "local_process",
          providerRef: "unverifiable-live-ref",
          ownerAgentId: agentId,
        });
      },
    },
    {
      key: "activeIssueWatchdogs",
      seed: async (target, { agentId, companyId }) => {
        const [issue] = await target.insert(issues).values({ companyId, title: "Watched", status: "done" }).returning();
        await target.insert(issueWatchdogs).values({
          companyId,
          issueId: issue!.id,
          watchdogAgentId: agentId,
          status: "active",
        });
      },
    },
    {
      key: "activeIssueWatchdogs",
      seed: async (target, { agentId, companyId }) => {
        const [issue] = await target.insert(issues).values({ companyId, title: "Unknown watchdog", status: "done" }).returning();
        await target.insert(issueWatchdogs).values({
          companyId,
          issueId: issue!.id,
          watchdogAgentId: agentId,
          status: "legacy_unknown",
        });
      },
    },
    {
      key: "activeRecoveryActions",
      seed: async (target, { agentId, companyId }) => {
        const [issue] = await target.insert(issues).values({ companyId, title: "Recover", status: "done" }).returning();
        await target.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId: issue!.id,
          kind: "reassign",
          status: "escalated",
          ownerAgentId: agentId,
          cause: "test",
          fingerprint: `fp-${randomUUID()}`,
          nextAction: "review",
        });
      },
    },
    {
      key: "activeRecoveryActions",
      seed: async (target, { agentId, companyId }) => {
        const [issue] = await target.insert(issues).values({ companyId, title: "Unknown recovery", status: "done" }).returning();
        await target.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId: issue!.id,
          kind: "reassign",
          status: "legacy_unknown",
          ownerAgentId: agentId,
          cause: "test",
          fingerprint: `fp-${randomUUID()}`,
          nextAction: "review",
        });
      },
    },
    {
      key: "unclearedPipelineAgentLeases",
      seed: async (target, { agentId, companyId }) => {
        const { pipeline, stage } = await seedPipeline(companyId);
        await target.insert(pipelineCases).values({
          companyId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          caseKey: `case-${randomUUID()}`,
          title: "Leased case",
          leaseOwnerType: "agent",
          leaseAgentId: agentId,
        });
      },
    },
    {
      key: "activePipelineApprovers",
      seed: async (target, { agentId }) => {
        const crossCompanyId = await seedCompany("Cross-company pipeline");
        const { stage } = await seedPipeline(crossCompanyId);
        await target.update(pipelineStages).set({
          config: { requireApproval: true, approver: { kind: "agent", id: agentId.toUpperCase() } },
        }).where(eq(pipelineStages.id, stage.id));
      },
    },
    {
      key: "activePipelineApprovers",
      seed: async (target, { agentId }) => {
        const crossCompanyId = await seedCompany("Cross-company pipeline automation");
        const { stage } = await seedPipeline(crossCompanyId);
        await target.update(pipelineStages).set({
          config: { automation: { assigneeAgentId: agentId.toUpperCase(), instructionsBody: "Run" } },
        }).where(eq(pipelineStages.id, stage.id));
      },
    },
    {
      key: "activeHireApprovalReferences",
      seed: async (target, { agentId }) => {
        const crossCompanyId = await seedCompany("Cross-company hire approval");
        await target.insert(approvals).values({
          companyId: crossCompanyId,
          type: "hire_agent",
          status: "pending",
          payload: { reportsTo: agentId.toUpperCase() },
        });
      },
    },
    {
      key: "outstandingEnvironmentLeases",
      seed: async (target, fixture) => {
        const run = await seedRun(fixture);
        const [environment] = await target.insert(environments).values({
          name: `sandbox-${randomUUID()}`,
          driver: "sandbox",
        }).returning();
        await target.insert(environmentLeases).values({
          companyId: fixture.companyId,
          environmentId: environment!.id,
          heartbeatRunId: run.id,
          leasePolicy: "reuse_by_environment",
          status: "active",
          cleanupStatus: null,
          metadata: { agentId: fixture.agentId.toUpperCase() },
        });
      },
    },
    {
      key: "runningWorkspaceOperations",
      seed: async (target, fixture) => {
        const run = await seedRun(fixture);
        await target.insert(workspaceOperations).values({
          companyId: fixture.companyId,
          heartbeatRunId: run.id,
          phase: "provision",
          status: "running",
        });
      },
    },
    {
      key: "runningWorkspaceOperations",
      seed: async (target, fixture) => {
        const run = await seedRun(fixture);
        await target.insert(workspaceOperations).values({
          companyId: fixture.companyId,
          heartbeatRunId: run.id,
          phase: "provision",
          status: "legacy_unknown",
        });
      },
    },
    {
      key: "liveDescendants",
      seed: async (target, fixture) => {
        const intermediaryId = randomUUID();
        await target.insert(agents).values({
          id: intermediaryId,
          companyId: fixture.companyId,
          name: "Terminated intermediary",
          role: "engineer",
          status: "terminated",
          reportsTo: fixture.agentId,
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });
        const crossCompanyId = await seedCompany("Cross-company descendant");
        await target.insert(agents).values({
          companyId: crossCompanyId,
          name: "Cross-company live descendant",
          role: "engineer",
          status: "idle",
          reportsTo: intermediaryId,
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        });
      },
    },
  ];

  for (const { key, seed } of dependencyCases) {
    it(`rejects generic termination with stable ${key} counts and no mutation`, async () => {
      const fixture = await seedAgent();
      await seed(db, fixture);

      await expect(agentService(db).terminate(fixture.agentId.toUpperCase())).rejects.toMatchObject({
        status: 409,
        details: {
          code: "agent_active_dependencies",
          dependencyCounts: { [key]: 1 },
        },
      });
      expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status).toBe("idle");
    });
  }

  it("treats a timed-out wake request as terminal retirement history", async () => {
    const fixture = await seedAgent();
    await db.insert(agentWakeupRequests).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "test",
      status: "timed_out",
    });

    await expect(agentService(db).terminate(fixture.agentId))
      .resolves.toMatchObject({ id: fixture.agentId, status: "terminated" });
  });

  it("blocks starting and running runtime claims, ignores terminal claims, and deduplicates persisted services", async () => {
    const fixture = await seedAgent();
    const activeServiceId = randomUUID();
    const claimOnlyServiceId = randomUUID();
    await db.insert(workspaceRuntimeServices).values([
      {
        id: activeServiceId,
        companyId: fixture.companyId,
        scopeType: "agent",
        scopeId: fixture.agentId,
        serviceName: `active-${randomUUID()}`,
        status: "running",
        lifecycle: "ephemeral",
        provider: "local_process",
        ownerAgentId: fixture.agentId,
      },
      {
        id: claimOnlyServiceId,
        companyId: fixture.companyId,
        scopeType: "agent",
        scopeId: fixture.agentId,
        serviceName: `claim-only-${randomUUID()}`,
        status: "stopped",
        lifecycle: "ephemeral",
        provider: "local_process",
        ownerAgentId: fixture.agentId,
      },
    ]);
    const startingClaimId = randomUUID();
    const claimValues = ([
      { id: randomUUID(), status: "running", runtimeServiceId: activeServiceId },
      { id: randomUUID(), status: "running", runtimeServiceId: claimOnlyServiceId },
      { id: startingClaimId, status: "starting", runtimeServiceId: null },
      { id: randomUUID(), status: "stopped", runtimeServiceId: null },
      { id: randomUUID(), status: "failed", runtimeServiceId: null },
    ] as const).map((claim) => ({
      ...claim,
      companyId: fixture.companyId,
      serviceKey: `dependency-claim-${claim.id}`,
      claimId: randomUUID(),
      ownerAgentId: fixture.agentId,
      expiresAt: new Date(Date.now() + 60_000),
      finalizedAt: claim.status === "starting" ? null : new Date(),
    }));
    await db.insert(workspaceRuntimeStartClaims).values(claimValues);

    const dependencies = await scanAgentOperationalDependencies(db, fixture.agentId);

    expect(dependencies.ids.activeRuntimeServices).toEqual(
      [activeServiceId, claimOnlyServiceId, startingClaimId].sort(),
    );
    expect(dependencies.counts.activeRuntimeServices).toBe(3);
  });

  it("blocks termination when a terminal runtime row still owns a live orphan process group", async () => {
    if (process.platform === "win32") return;
    const fixture = await seedAgent();
    const parent = spawn(process.execPath, [
      "-e",
      `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();`,
    ], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      parent.once("spawn", resolve);
      parent.once("error", reject);
    });
    const processGroupId = parent.pid!;
    await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    for (let attempt = 0; attempt < 50 && !isProcessGroupAlive(processGroupId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isPidAlive(processGroupId)).toBe(false);
    expect(isProcessGroupAlive(processGroupId)).toBe(true);
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      scopeType: "agent",
      scopeId: fixture.agentId,
      serviceName: `orphan-group-${randomUUID()}`,
      status: "failed",
      lifecycle: "ephemeral",
      provider: "local_process",
      providerRef: String(processGroupId),
      ownerAgentId: fixture.agentId,
    });

    try {
      await expect(agentService(db).terminate(fixture.agentId)).rejects.toMatchObject({
        status: 409,
        details: {
          code: "agent_active_dependencies",
          dependencyCounts: { activeRuntimeServices: 1 },
        },
      });
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The process group may already have exited.
      }
      for (let attempt = 0; attempt < 50 && isProcessGroupAlive(processGroupId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  });

  it("atomically terminates a zero-dependency agent and removes every access path", async () => {
    const fixture = await seedAgent();
    await seedExtendedAccessRows(fixture);
    await db.insert(agentApiKeys).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      name: "active",
      keyHash: "a".repeat(64),
    });
    await db.insert(principalPermissionGrants).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.agentId.toUpperCase(),
      permissionKey: "tasks:assign",
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.agentId.toUpperCase(),
      status: "inactive",
    });
    await db.insert(agentMemberships).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      userId: `user-${randomUUID()}`,
      state: "left",
    });

    await expect(agentService(db).terminate(fixture.agentId.toUpperCase()))
      .resolves.toMatchObject({ id: fixture.agentId, status: "terminated" });
    expect((await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, fixture.agentId)))[0]?.revokedAt)
      .toBeInstanceOf(Date);
    await expect(db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(companyMemberships)
      .where(eq(companyMemberships.principalId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(agentMemberships).where(eq(agentMemberships.agentId, fixture.agentId)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(companySkillStars).where(eq(companySkillStars.agentId, fixture.agentId)))
      .resolves.toHaveLength(0);
  });

  it("fails closed before termination when local runtime registry JSON is corrupt", async () => {
    const fixture = await seedAgent();
    const registryDir = path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
    const corruptPath = path.resolve(registryDir, `corrupt-${randomUUID()}.json`);
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(corruptPath, '{"version":2,"serviceKey":', "utf8");

    try {
      await expect(agentService(db).terminate(fixture.agentId))
        .rejects.toThrow(/registry.*(invalid|corrupt|parse)/i);
      expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status)
        .toBe("idle");
    } finally {
      await fs.rm(corruptPath, { force: true });
    }
  });

  it("fails closed before termination when runtime registry bindings are duplicated", async () => {
    const fixture = await seedAgent();
    const runtimeServiceId = randomUUID();
    const base: LocalServiceRegistryRecord = {
      version: 1,
      serviceKey: `dependency-duplicate-a-${randomUUID()}`,
      profileKind: "workspace-runtime",
      serviceName: "dependency-duplicate",
      command: "node dependency-duplicate",
      cwd: os.tmpdir(),
      envFingerprint: "dependency-duplicate",
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: null,
      processStartedAt: null,
      processExecutable: null,
      processCommandSha256: null,
      provider: "local_process",
      runtimeServiceId,
      reuseKey: null,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      metadata: { companyId: fixture.companyId, ownerAgentId: fixture.agentId },
    };
    const duplicate = { ...base, serviceKey: `dependency-duplicate-b-${randomUUID()}` };
    await writeLocalServiceRegistryRecord(base);
    await writeLocalServiceRegistryRecord(duplicate);

    try {
      await expect(agentService(db).terminate(fixture.agentId))
        .rejects.toThrow(/duplicate.*runtime service/i);
      expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status)
        .toBe("idle");
    } finally {
      await removeLocalServiceRegistryRecord(base.serviceKey);
      await removeLocalServiceRegistryRecord(duplicate.serviceKey);
    }
  });

  it("makes terminated status absorbing and rejects direct termination writes", async () => {
    const fixture = await seedAgent();
    const service = agentService(db);

    await expect(service.update(fixture.agentId, { status: "terminated" })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_direct_termination_forbidden" },
    });
    await expect(service.create(fixture.companyId, {
      id: randomUUID(),
      name: `Invalid tombstone ${randomUUID()}`,
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_direct_termination_forbidden" },
    });

    await service.terminate(fixture.agentId);
    await expect(service.update(fixture.agentId, { name: "Resurrected" })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_terminated_immutable" },
    });
    await expect(service.updatePermissions(fixture.agentId, { canCreateAgents: false }))
      .rejects.toMatchObject({ status: 409, details: { code: "agent_terminated_immutable" } });
    await expect(service.createApiKey(fixture.agentId, "resurrection-key"))
      .rejects.toMatchObject({ status: 409, details: { code: "agent_terminated_immutable" } });
    await expect(service.activatePendingApproval(fixture.agentId))
      .resolves.toMatchObject({ activated: false, agent: { status: "terminated" } });
  });

  it("serializes a concurrent start before termination and observes its active run", async () => {
    const fixture = await seedAgent();
    let releaseStart!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseStart = resolve; });
    const start = withAgentStartLock(fixture.agentId, async () => {
      markEntered();
      await release;
      await seedRun(fixture, "running");
    });
    await entered;

    const termination = agentService(db).terminate(fixture.agentId);
    await Promise.resolve();
    expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status).toBe("idle");
    releaseStart();
    await start;
    await expect(termination).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_active_dependencies", dependencyCounts: { activeRuns: 1 } },
    });
    expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status).toBe("idle");
  });

  it("serializes reportee creation before manager termination", async () => {
    const manager = await seedAgent();
    const reporteeId = `ffffffff-ffff-4fff-8fff-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let releaseManager!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseManager = resolve; });
    const gate = withAgentStartLock(manager.agentId, async () => {
      markEntered();
      await release;
    });
    await entered;

    const creation = agentService(db).create(manager.companyId, {
      id: reporteeId,
      name: `Concurrent reportee ${reporteeId.slice(-8)}`,
      role: "engineer",
      status: "idle",
      reportsTo: manager.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await Promise.resolve();
    const termination = agentService(db).terminate(manager.agentId);
    releaseManager();
    await gate;

    await expect(creation).resolves.toMatchObject({ id: reporteeId, reportsTo: manager.agentId });
    await expect(termination).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_active_dependencies", dependencyCounts: { liveDescendants: 1 } },
    });
  });

  it("serializes a new reporting relationship before manager termination", async () => {
    const manager = await seedAgent();
    const reporteeId = `ffffffff-ffff-4fff-8fff-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.insert(agents).values({
      id: reporteeId,
      companyId: manager.companyId,
      name: `Concurrent existing reportee ${reporteeId.slice(-8)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    let releaseManager!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseManager = resolve; });
    const gate = withAgentStartLock(manager.agentId, async () => {
      markEntered();
      await release;
    });
    await entered;

    const update = agentService(db).update(reporteeId, { reportsTo: manager.agentId });
    await Promise.resolve();
    const termination = agentService(db).terminate(manager.agentId);
    releaseManager();
    await gate;

    await expect(update).resolves.toMatchObject({ id: reporteeId, reportsTo: manager.agentId });
    await expect(termination).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_active_dependencies", dependencyCounts: { liveDescendants: 1 } },
    });
  });

  it("rejects one of two cross-process reporting updates that would commit a two-agent cycle", async () => {
    const companyId = await seedCompany(`Concurrent cycle ${randomUUID()}`);
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Concurrent cycle A",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Concurrent cycle B",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const workers: ReturnType<typeof spawnReportingUpdateWorker>[] = [];
    try {
      await db.transaction(async (tx) => {
        await tx.select({ id: agents.id }).from(agents)
          .where(inArray(agents.id, [agentAId, agentBId]))
          .orderBy(agents.id)
          .for("update");
        workers.push(
          spawnReportingUpdateWorker({
            databaseUrl: tempDb!.connectionString,
            agentId: agentAId,
            managerId: agentBId,
          }),
          spawnReportingUpdateWorker({
            databaseUrl: tempDb!.connectionString,
            agentId: agentBId,
            managerId: agentAId,
          }),
        );
        await Promise.all(workers.map((worker) => worker.ready));

        let blockedUpdates = 0;
        for (let attempt = 0; attempt < 200 && blockedUpdates < 2; attempt += 1) {
          const rows = await db.execute(sql<{ count: number }>`
            select count(*)::int as "count"
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
          `);
          blockedUpdates = Number(Array.from(rows)[0]?.count ?? 0);
          if (blockedUpdates < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blockedUpdates).toBeGreaterThanOrEqual(2);
      });

      const results = await Promise.all(workers.map((worker) => worker.result));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.message).toMatch(/reporting relationship would create cycle/i);
      const rows = await db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents)
        .where(inArray(agents.id, [agentAId, agentBId]));
      const byId = new Map(rows.map((row) => [row.id, row.reportsTo]));
      expect(byId.get(agentAId) === agentBId && byId.get(agentBId) === agentAId).toBe(false);
    } finally {
      for (const { child } of workers) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled(workers.map((worker) => worker.result));
    }
  }, 30_000);

  it("requires active idle agents to terminate before physical deletion", async () => {
    const fixture = await seedAgent();

    await expect(agentService(db).remove(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_delete_history_preserved", reason: "termination_required" },
    });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(1);
  });

  it("atomically records termination provenance so a service-terminated agent cannot be removed", async () => {
    const fixture = await seedAgent();
    await agentService(db).terminate(fixture.agentId);

    await expect(agentService(db).remove(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_delete_history_preserved" },
    });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(1);
  });

  it("rejects physical deletion while an active executor run exists", async () => {
    const fixture = await seedAgent("terminated");
    const run = await seedRun(fixture, "running");

    await expect(agentService(db).remove(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_active_dependencies", dependencyCounts: { activeRuns: 1 } },
    });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("preserves terminal execution history instead of physically deleting it", async () => {
    const fixture = await seedAgent("terminated");
    const run = await seedRun(fixture, "succeeded");

    await expect(agentService(db).remove(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_delete_history_preserved" },
    });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("preserves a reusable lease whose metadata names the agent without a run FK", async () => {
    const fixture = await seedAgent("pending_approval");
    const [environment] = await db.insert(environments).values({
      name: `orphan-safe-${randomUUID()}`,
      driver: "sandbox",
    }).returning();
    const [lease] = await db.insert(environmentLeases).values({
      companyId: fixture.companyId,
      environmentId: environment!.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      status: "active",
      metadata: { agentId: fixture.agentId.toUpperCase() },
    }).returning();

    await expect(agentService(db).remove(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_active_dependencies" },
    });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(1);
    await expect(db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id)))
      .resolves.toHaveLength(1);
  });

  it("blocks generic termination on a reusable metadata-owned lease without a run FK", async () => {
    const fixture = await seedAgent();
    const [environment] = await db.insert(environments).values({
      name: `metadata-owned-${randomUUID()}`,
      driver: "sandbox",
    }).returning();
    await db.insert(environmentLeases).values({
      companyId: fixture.companyId,
      environmentId: environment!.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      status: "active",
      metadata: {
        reusableSandboxLease: { agentId: fixture.agentId.toUpperCase() },
      },
    });

    await expect(agentService(db).terminate(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_active_dependencies",
        dependencyCounts: { outstandingEnvironmentLeases: 1 },
      },
    });
    expect((await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]?.status).toBe("idle");
  });

  it("physically deletes only a pristine pending-approval agent", async () => {
    const fixture = await seedAgent("pending_approval");

    await expect(agentService(db).remove(fixture.agentId.toUpperCase()))
      .resolves.toMatchObject({ id: fixture.agentId, status: "pending_approval" });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(0);
  });

  it("physically deletes a terminated agent whose only remaining rows are access artifacts", async () => {
    const fixture = await seedAgent("terminated");
    await seedExtendedAccessRows(fixture);
    await db.insert(agentApiKeys).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      name: "revoked",
      keyHash: "b".repeat(64),
      revokedAt: new Date(),
    });
    await db.insert(principalPermissionGrants).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.agentId.toUpperCase(),
      permissionKey: "tasks:assign",
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.agentId.toUpperCase(),
      status: "inactive",
    });
    await db.insert(agentMemberships).values({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      userId: `user-${randomUUID()}`,
      state: "left",
    });

    await expect(agentService(db).remove(fixture.agentId.toUpperCase()))
      .resolves.toMatchObject({ id: fixture.agentId, status: "terminated" });
    await expect(db.select().from(agents).where(eq(agents.id, fixture.agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, fixture.agentId)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(agentMemberships).where(eq(agentMemberships.agentId, fixture.agentId)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, fixture.agentId.toUpperCase())))
      .resolves.toHaveLength(0);
    await expect(db.select().from(companySkillStars).where(eq(companySkillStars.agentId, fixture.agentId)))
      .resolves.toHaveLength(0);
  });
});

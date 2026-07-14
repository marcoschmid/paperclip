import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companySecretBindings,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  secretAccessEvents,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { agentService } from "../services/agents.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "stitch_secret_persistence_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat secret resolution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containsPlaintext(value: unknown, plaintexts: string[]): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return plaintexts.some((plaintext) => serialized.includes(plaintext));
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForRunLeasesToRelease(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return leases;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db
    .select()
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, runId));
}

describeEmbeddedPostgres("heartbeat secret resolution persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot: string | null = null;
  let previousPaperclipHome: string | undefined;
  let previousRunLogBasePath: string | undefined;
  let previousMasterKeyFile: string | undefined;
  let capturedRuntimeSecretSha256: string | null = null;

  beforeAll(async () => {
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    previousRunLogBasePath = process.env.RUN_LOG_BASE_PATH;
    previousMasterKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    try {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-secret-"));
      process.env.PAPERCLIP_HOME = path.join(tempRoot, "paperclip-home");
      process.env.RUN_LOG_BASE_PATH = path.join(tempRoot, "run-logs");
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tempRoot, "master.key");
      tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-secret-resolution-");
      db = createDb(tempDb.connectionString);

      registerServerAdapter({
        type: TEST_ADAPTER_TYPE,
        execute: async (ctx) => {
          const env = (ctx.config.env ?? {}) as Record<string, string>;
          const stitchValue = env.STITCH_API_KEY ?? "";
          capturedRuntimeSecretSha256 = digest(stitchValue);
          await ctx.onMeta?.({
            adapterType: TEST_ADAPTER_TYPE,
            command: "synthetic-stitch-adapter",
            env: {
              STITCH_API_KEY: stitchValue,
              SAFE_CONFIG_VALUE: "safe",
            },
            prompt: `STITCH_API_KEY=${stitchValue}`,
          });
          await ctx.onLog("stdout", `STITCH_API_KEY=${stitchValue}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            resultJson: {
              env: { STITCH_API_KEY: stitchValue },
              transcript: `STITCH_API_KEY=${stitchValue}`,
            },
            summary: `STITCH_API_KEY=${stitchValue}`,
          };
        },
        testEnvironment: async () => ({
          adapterType: TEST_ADAPTER_TYPE,
          status: "pass",
          checks: [],
          testedAt: new Date().toISOString(),
        }),
      });
    } catch (error) {
      unregisterServerAdapter(TEST_ADAPTER_TYPE);
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = previousRunLogBasePath;
      if (previousMasterKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousMasterKeyFile;
      await tempDb?.cleanup();
      if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }, 20_000);

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousRunLogBasePath;
    if (previousMasterKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousMasterKeyFile;
    await tempDb?.cleanup();
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves Stitch env ephemerally and persists only redacted heartbeat surfaces", async () => {
    const companyId = randomUUID();
    const stitchValue = `FAKE_HEARTBEAT_STITCH_VALUE_DO_NOT_USE_${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    const secret = await secretService(db).create(companyId, {
      name: `stitch-heartbeat-${randomUUID()}`,
      provider: "local_encrypted",
      value: stitchValue,
    });
    const agent = await agentService(db).create(companyId, {
      name: "Heartbeat Stitch Agent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {
        env: {
          STITCH_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(capturedRuntimeSecretSha256).toBe(digest(stitchValue));
    const leaseRows = await waitForRunLeasesToRelease(db, queued!.id);
    expect(leaseRows).toHaveLength(1);
    expect(leaseRows[0]?.status).toBe("released");

    const [runRows, eventRows, activityRows, accessRows, wakeupRows, operationRows, agentRows, bindingRows] =
      await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)),
        db
          .select()
          .from(heartbeatRunEvents)
          .where(eq(heartbeatRunEvents.runId, queued!.id))
          .orderBy(heartbeatRunEvents.seq),
        db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
        db.select().from(secretAccessEvents).where(eq(secretAccessEvents.heartbeatRunId, queued!.id)),
        db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, queued!.id)),
        db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, queued!.id)),
        db.select().from(agents).where(eq(agents.id, agent.id)),
        db
          .select()
          .from(companySecretBindings)
          .where(and(
            eq(companySecretBindings.companyId, companyId),
            eq(companySecretBindings.targetId, agent.id),
          )),
      ]);
    const runLog = await heartbeat.readLog(queued!.id);
    const invocationEvent = eventRows.find((event) => event.eventType === "adapter.invoke");

    expect(containsPlaintext(
      {
        runRows,
        eventRows,
        activityRows,
        leaseRows,
        accessRows,
        wakeupRows,
        operationRows,
        agentRows,
        bindingRows,
        runLog,
      },
      [stitchValue],
    )).toBe(false);
    expect(runRows).toHaveLength(1);
    expect(invocationEvent).toBeDefined();
    expect((invocationEvent?.payload?.env as Record<string, string>).STITCH_API_KEY).toBe("***REDACTED***");
    expect(accessRows).toHaveLength(1);
    expect(accessRows.map((event) => ({
      secretId: event.secretId,
      version: event.version,
      consumerType: event.consumerType,
      consumerId: event.consumerId,
      configPath: event.configPath,
      heartbeatRunId: event.heartbeatRunId,
      outcome: event.outcome,
    }))).toEqual([{
      secretId: secret.id,
      version: 1,
      consumerType: "agent",
      consumerId: agent.id,
      configPath: "env.STITCH_API_KEY",
      heartbeatRunId: queued!.id,
      outcome: "success",
    }]);
    expect(activityRows.length).toBeGreaterThan(0);
    expect(wakeupRows).toHaveLength(1);
    expect(operationRows.length).toBeGreaterThan(0);
    const persistedAgentEnv = (
      agentRows[0]?.adapterConfig as { env?: Record<string, unknown> }
    ).env ?? {};
    expect(persistedAgentEnv.STITCH_API_KEY).toEqual({
      type: "secret_ref",
      secretId: secret.id,
      version: "latest",
    });
    expect(bindingRows).toHaveLength(1);
    expect(runLog.content.length).toBeGreaterThan(0);

  });
});

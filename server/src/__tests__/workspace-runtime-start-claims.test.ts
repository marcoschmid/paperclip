import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  workspaceRuntimeServices,
  workspaceRuntimeStartClaims,
} from "@paperclipai/db";
import { inArray } from "drizzle-orm";
import {
  isProcessGroupAlive,
  listLocalServiceRegistryRecordsStrict,
  readLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";
import {
  reconcilePersistedRuntimeServicesOnStartup,
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { reserveWorkspaceRuntimeStartClaim } from "../services/workspace-runtime-start-claims.js";
import { agentService } from "../services/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type WorkerResult = { ok: true; id: string; reused: boolean } | { ok: false; message: string };

describeEmbeddedPostgres("workspace runtime cross-process start claims", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let testRoot = "";
  let registryDir = "";
  let previousRegistryDir: string | undefined;
  const spawnedServicePids = new Set<number>();

  beforeAll(async () => {
    previousRegistryDir = process.env.PAPERCLIP_TEST_RUNTIME_SERVICES_DIR;
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-start-claims-"));
    registryDir = path.join(testRoot, "registry");
    await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
    process.env.PAPERCLIP_TEST_RUNTIME_SERVICES_DIR = registryDir;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-start-claims-db-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const pid of spawnedServicePids) {
      try {
        const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
        const pgid = Number.parseInt(stdout.trim(), 10);
        if (Number.isInteger(pgid) && pgid > 0) process.kill(-pgid, "SIGKILL");
      } catch {
        // Best-effort cleanup of test-owned detached process groups.
      }
    }
    spawnedServicePids.clear();
    await resetRuntimeServicesForTests();
    await db.delete(workspaceRuntimeStartClaims);
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
    await fs.rm(registryDir, { recursive: true, force: true });
    await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
    if (previousRegistryDir === undefined) delete process.env.PAPERCLIP_TEST_RUNTIME_SERVICES_DIR;
    else process.env.PAPERCLIP_TEST_RUNTIME_SERVICES_DIR = previousRegistryDir;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function seedCompanyAndAgent(companyId = randomUUID()) {
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Runtime claim ${companyId}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Runtime agent ${agentId}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function spawnStartWorker(input: {
    companyId: string;
    agentId: string;
    workspaceCwd: string;
    goFile: string;
  }) {
    const executable = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const workerPath = fileURLToPath(new URL("./helpers/workspace-runtime-start-worker.ts", import.meta.url));
    const child = spawn(executable, [workerPath], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        PAPERCLIP_TEST_DATABASE_URL: tempDb!.connectionString,
        PAPERCLIP_TEST_COMPANY_ID: input.companyId,
        PAPERCLIP_TEST_AGENT_ID: input.agentId,
        PAPERCLIP_TEST_WORKSPACE_CWD: input.workspaceCwd,
        PAPERCLIP_TEST_GO_FILE: input.goFile,
        PAPERCLIP_TEST_INVOCATION_ID: randomUUID(),
        PAPERCLIP_TEST_RUNTIME_SERVICES_DIR: registryDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = new Promise<WorkerResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", () => {
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as WorkerResult);
        } catch (error) {
          reject(new Error(Buffer.concat(stderr).toString("utf8"), { cause: error }));
        }
      });
    });
    return { child, result };
  }

  it("serializes two real worker processes so only one local service is spawned", async () => {
    const companyId = randomUUID();
    const first = await seedCompanyAndAgent(companyId);
    const secondAgentId = randomUUID();
    await db.insert(agents).values({
      id: secondAgentId,
      companyId,
      name: "Second runtime starter",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const workspaceCwd = path.join(testRoot, "cross-process-workspace");
    const markerPath = path.join(workspaceCwd, "spawned-pids.txt");
    const goFile = path.join(workspaceCwd, "go");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      `fs.appendFileSync(${JSON.stringify(markerPath)}, String(process.pid) + '\\n');`,
      "setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'), 750);",
    ].join("\n"));
    const workers = [
      spawnStartWorker({ companyId, agentId: first.agentId, workspaceCwd, goFile }),
      spawnStartWorker({ companyId, agentId: secondAgentId, workspaceCwd, goFile }),
    ];
    await fs.writeFile(goFile, "go\n");

    const results = await Promise.all(workers.map((worker) => worker.result));
    const pids = (await fs.readFile(markerPath, "utf8")).trim().split("\n").map(Number);
    pids.forEach((pid) => spawnedServicePids.add(pid));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.flatMap((result) => result.ok ? [result.id] : []))).toHaveLength(1);
    expect(pids).toHaveLength(1);
    expect((await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))).toHaveLength(1);
    expect(await db.select().from(workspaceRuntimeServices)).toHaveLength(1);
  }, 30_000);

  it("blocks generic termination while a durable start claim has no runtime row yet", async () => {
    const fixture = await seedCompanyAndAgent();
    const reservation = await reserveWorkspaceRuntimeStartClaim({
      db,
      companyId: fixture.companyId,
      serviceKey: `workspace-runtime-starting-${randomUUID()}`,
      ownerAgentId: fixture.agentId,
    });
    expect(reservation.kind).toBe("acquired");

    await expect(agentService(db).terminate(fixture.agentId)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_active_dependencies",
        dependencyCounts: { activeRuntimeServices: 1 },
      },
    });
    await expect(db.select({ status: agents.status }).from(agents)
      .where(inArray(agents.id, [fixture.agentId]))
      .then((rows) => rows[0]?.status)).resolves.toBe("idle");
  });

  it("does not reuse or overwrite a same-shaped runtime owned by another company", async () => {
    const first = await seedCompanyAndAgent();
    const second = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "cross-tenant-workspace");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      `fs.appendFileSync(${JSON.stringify(path.join(workspaceCwd, "tenant-pids.txt"))}, String(process.pid) + '\\n');`,
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"));
    const start = (fixture: { companyId: string; agentId: string }) => startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Tenant starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "tenant-web",
        command: "node runtime-service.cjs",
        lifecycle: "shared",
        reuseScope: "project_workspace",
        port: { type: "auto" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
      }] } },
      adapterEnv: {},
    });
    const firstRefs = await start(first);
    const secondRefs = await start(second);
    const pids = (await fs.readFile(path.join(workspaceCwd, "tenant-pids.txt"), "utf8"))
      .trim().split("\n").map(Number);
    pids.forEach((pid) => spawnedServicePids.add(pid));

    expect(firstRefs[0]!.companyId).toBe(first.companyId);
    expect(secondRefs[0]!.companyId).toBe(second.companyId);
    expect(secondRefs[0]!.id).not.toBe(firstRefs[0]!.id);
    expect((await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))).toHaveLength(2);
  }, 20_000);

  it("rejects a running claim whose same-company registry has a copied id but mismatched identity", async () => {
    const fixture = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "running-claim-binding-workspace");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const http = require('node:http');",
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"));
    const service = {
      name: "claim-binding-web",
      command: "node runtime-service.cjs",
      lifecycle: "shared",
      reuseScope: "agent",
      port: { type: "auto" },
      expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
      readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
    };
    const start = () => startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Claim-binding starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [service] } },
      adapterEnv: {},
    });

    const [started] = await start();
    const [registry] = await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" });
    spawnedServicePids.add(registry!.processGroupId ?? registry!.pid);
    await resetRuntimeServicesForTests();
    await writeLocalServiceRegistryRecord({
      ...registry!,
      serviceName: "copied-name",
      command: "node copied-command.cjs",
      cwd: path.join(workspaceCwd, "copied-cwd"),
      reuseKey: "copied-reuse-key",
      metadata: {
        ...registry!.metadata,
        ownerAgentId: randomUUID(),
        scopeType: "run",
        scopeId: randomUUID(),
        startClaimId: randomUUID(),
      },
    });

    await expect(start()).rejects.toThrow(/exact|binding|claim|registry/i);
    await expect(db.select().from(workspaceRuntimeServices)
      .then((rows) => rows[0])).resolves.toMatchObject({ id: started!.id, status: "running" });
    expect(isProcessGroupAlive(registry!.processGroupId)).toBe(true);
  }, 20_000);

  it("blocks a normal start on corrupt exact-key registry evidence without spawning or overwriting", async () => {
    const fixture = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "corrupt-registry-workspace");
    const markerPath = path.join(workspaceCwd, "corrupt-pids.txt");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      `fs.appendFileSync(${JSON.stringify(markerPath)}, String(process.pid) + '\\n');`,
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"));
    const start = () => startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Corrupt starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "corrupt-web",
        command: "node runtime-service.cjs",
        lifecycle: "shared",
        reuseScope: "agent",
        port: { type: "auto" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
      }] } },
      adapterEnv: {},
    });
    const [first] = await start();
    const [record] = await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" });
    const firstPid = record!.pid;
    spawnedServicePids.add(firstPid);
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: "unused",
      runtimeServiceId: first!.id,
    });
    spawnedServicePids.delete(firstPid);
    const registryPath = path.resolve(registryDir, `${record!.serviceKey}.json`);
    await fs.writeFile(registryPath, '{"version":2,"serviceKey":', { encoding: "utf8", mode: 0o600 });

    await expect(start()).rejects.toThrow(/registry.*(invalid|corrupt|parse)/i);
    expect((await fs.readFile(markerPath, "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(readLocalServiceRegistryRecord(record!.serviceKey)).resolves.toBeNull();
    await expect(fs.readFile(registryPath, "utf8")).resolves.toBe('{"version":2,"serviceKey":');
  }, 20_000);

  it("kills the exact spawned process group when registry publication loses a race", async () => {
    const fixture = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "registry-publish-race-workspace");
    const markerPath = path.join(workspaceCwd, "spawned-pid.txt");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      `fs.writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));`,
      "setTimeout(() => http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'), 750);",
    ].join("\n"));

    const startPromise = startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Registry race starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "registry-race-web",
        command: "node runtime-service.cjs",
        lifecycle: "shared",
        reuseScope: "agent",
        port: { type: "auto" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
      }] } },
      adapterEnv: {},
    });

    let spawnedPid = 0;
    let serviceKey = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      spawnedPid = Number.parseInt(await fs.readFile(markerPath, "utf8").catch(() => ""), 10);
      serviceKey = await db.select({ serviceKey: workspaceRuntimeStartClaims.serviceKey })
        .from(workspaceRuntimeStartClaims)
        .then((rows) => rows[0]?.serviceKey ?? "");
      if (Number.isInteger(spawnedPid) && spawnedPid > 0 && serviceKey) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(spawnedPid).toBeGreaterThan(0);
    expect(serviceKey).not.toBe("");
    spawnedServicePids.add(spawnedPid);
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(spawnedPid)]);
    const spawnedProcessGroupId = Number.parseInt(stdout.trim(), 10);
    expect(spawnedProcessGroupId).toBeGreaterThan(0);

    const registryPath = path.join(registryDir, `${serviceKey}.json`);
    const contradictoryEvidence = "{ deliberately: 'contradictory-existing-evidence' }\n";
    await fs.writeFile(registryPath, contradictoryEvidence, { flag: "wx", mode: 0o600 });

    await expect(startPromise).rejects.toThrow(/refusing to overwrite evidence/);
    expect(await fs.readFile(registryPath, "utf8")).toBe(contradictoryEvidence);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(-spawnedProcessGroupId, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(() => process.kill(-spawnedProcessGroupId, 0)).toThrow();
    await expect(db.select().from(workspaceRuntimeServices).then((rows) => rows[0]))
      .resolves.toMatchObject({ status: "failed", healthStatus: "unhealthy" });
    expect(await db.select({ status: workspaceRuntimeStartClaims.status })
      .from(workspaceRuntimeStartClaims)
      .then((rows) => rows[0]?.status)).toBe("failed");
  }, 20_000);

  it("fails atomically when the ready child exits before start-claim finalization", async () => {
    const fixture = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "post-readiness-exit-workspace");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const http = require('node:http');",
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"));
    let processGroupId = 0;
    let terminationAttempts = 0;

    const start = startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Exit-race starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "exit-race-web",
        command: "node runtime-service.cjs",
        lifecycle: "shared",
        reuseScope: "agent",
        port: { type: "auto" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
      }] } },
      adapterEnv: {},
      dependencies: {
        terminateLocalService: async () => {
          terminationAttempts += 1;
          throw new Error("conclusively absent process must not be signalled");
        },
        afterLocalServiceStartedBeforePersist: async (record) => {
          processGroupId = Number.parseInt(record.providerRef ?? "", 10);
          expect(processGroupId).toBeGreaterThan(0);
          spawnedServicePids.add(processGroupId);
          process.kill(-processGroupId, "SIGKILL");
          for (let attempt = 0; attempt < 100 && isProcessGroupAlive(processGroupId); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(isProcessGroupAlive(processGroupId)).toBe(false);
        },
      },
    });

    await expect(start).rejects.toThrow(/exited|not running|process identity/i);
    spawnedServicePids.delete(processGroupId);
    expect(terminationAttempts).toBe(0);
    await expect(db.select().from(workspaceRuntimeServices).then((rows) => rows[0]))
      .resolves.toMatchObject({ status: "failed", healthStatus: "unhealthy" });
    await expect(db.select().from(workspaceRuntimeStartClaims).then((rows) => rows[0]))
      .resolves.toMatchObject({ status: "failed", runtimeServiceId: null });
    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .resolves.toHaveLength(0);
  }, 20_000);

  it("keeps dead-process registry evidence until persisted runtime and claim terminalization commits", async () => {
    const fixture = await seedCompanyAndAgent();
    const workspaceCwd = path.join(testRoot, "persisted-terminalization-fault-workspace");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(path.join(workspaceCwd, "runtime-service.cjs"), [
      "const http = require('node:http');",
      "http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"));
    const [started] = await startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: fixture.agentId, name: "Persisted-fault starter", companyId: fixture.companyId },
      issue: null,
      workspace: {
        baseCwd: workspaceCwd,
        source: "project_primary",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: workspaceCwd,
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      config: { workspaceRuntime: { services: [{
        name: "persisted-fault-web",
        command: "node runtime-service.cjs",
        lifecycle: "shared",
        reuseScope: "agent",
        port: { type: "auto" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
      }] } },
      adapterEnv: {},
    });
    const [registry] = await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" });
    const processGroupId = registry!.processGroupId!;
    spawnedServicePids.add(processGroupId);
    await resetRuntimeServicesForTests();
    process.kill(-processGroupId, "SIGKILL");
    for (let attempt = 0; attempt < 100 && isProcessGroupAlive(processGroupId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isProcessGroupAlive(processGroupId)).toBe(false);
    spawnedServicePids.delete(processGroupId);

    await expect(reconcilePersistedRuntimeServicesOnStartup(db, {
      afterPersistedTerminalizedBeforeRegistryRemove: async () => {
        throw new Error("deterministic persisted post-commit interruption");
      },
    })).rejects.toThrow(/persisted post-commit interruption/);
    await expect(db.select().from(workspaceRuntimeServices).then((rows) => rows[0]))
      .resolves.toMatchObject({ id: started!.id, status: "stopped", healthStatus: "unknown" });
    await expect(db.select().from(workspaceRuntimeStartClaims).then((rows) => rows[0]))
      .resolves.toMatchObject({ status: "stopped", runtimeServiceId: started!.id });
    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .resolves.toContainEqual(expect.objectContaining({ runtimeServiceId: started!.id }));

    await expect(reconcilePersistedRuntimeServicesOnStartup(db))
      .resolves.toMatchObject({ reconciled: 1, adopted: 0 });
    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .resolves.toHaveLength(0);
  }, 20_000);
});

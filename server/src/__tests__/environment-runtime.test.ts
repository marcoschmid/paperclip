import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  activityLog,
  agents,
  companies,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  environmentRuntimeService,
  findReusableSandboxLeaseId,
  type EnvironmentRuntimeDriver,
} from "../services/environment-runtime.ts";
import { agentService } from "../services/agents.ts";
import { environmentService } from "../services/environments.ts";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}) {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

describe("findReusableSandboxLeaseId", () => {
  it("matches reusable plugin-backed sandbox leases by provider", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300000,
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-template-a",
          metadata: {
            provider: "fake-plugin",
            image: "template-a",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-template-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-template-b");
  });

  it("requires image identity for reusable fake sandbox leases", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-image-a",
          metadata: {
            provider: "fake",
            image: "debian:12",
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-image-b",
          metadata: {
            provider: "fake",
            image: "ubuntu:24.04",
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-image-b");
  });
});

describeEmbeddedPostgres("environmentRuntimeService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  const fixtureRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    runtime = environmentRuntimeService(db);
  });

  afterEach(async () => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment(input: {
    driver?: string;
    name?: string;
    status?: "active" | "disabled";
    config?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const driver = input.driver ?? "local";
    const environmentName = input.name ?? `${driver}-${environmentId.slice(0, 8)}`;
    let config = input.config ?? {};

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-runtime-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      await secretService(db).createBinding({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
    }
    const existingLocalEnvironment = driver === "local"
      ? await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0] ?? null)
      : null;
    const environmentRecord = existingLocalEnvironment ?? {
      id: environmentId,
      name: environmentName,
      description: null,
      driver,
      status: input.status ?? "active",
      config,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!existingLocalEnvironment) {
      await db.insert(environments).values({
        id: environmentRecord.id,
        name: environmentRecord.name,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      companyId,
      agentId,
      environment: {
        id: environmentRecord.id,
        companyId,
        name: environmentRecord.name,
        description: environmentRecord.description,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        metadata: environmentRecord.metadata,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      } as const,
      runId,
    };
  }

  async function seedReusablePluginSandboxLease() {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.reusable-sandbox-provider",
      packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Reusable Sandbox Provider",
        description: "Test provider with reusable lease support",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const reusableLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "reusable-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.reusable-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    return { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease };
  }

  async function seedHistoricalHeartbeatRun(
    companyId: string,
    agentId = "8d403783-c4e2-4746-adad-7689cd95ae33",
  ) {
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Historical environment owner ${randomUUID()}`,
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "failed",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { agentId, runId };
  }

  it("acquires and releases a local run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "local",
      executionWorkspaceMode: null,
    });
    expect(acquired.leaseContext).toEqual({
      executionWorkspaceId: null,
      executionWorkspaceMode: null,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("local");
    expect(released[0]?.lease.status).toBe("released");

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, acquired.lease.id));
    expect(rows[0]?.status).toBe("released");
  });

  it("allows projectless runs through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceMode).toBeNull();
  });

  it("rejects truly unsupported drivers before acquiring a lease", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });
    const runtimeWithoutSsh = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("should not acquire");
          },
          releaseRunLease: async () => null,
        },
      ],
    });

    await expect(
      runtimeWithoutSsh.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow('Environment driver "ssh" is not registered in the environment runtime yet.');

    const rows = await db.select().from(environmentLeases);
    expect(rows).toHaveLength(0);
  });

  it("acquires and releases an SSH run lease through the runtime seam", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(
        `Skipping SSH runtime fixture test: ${sshFixtureSupport.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-environment-runtime-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const statePath = path.join(fixtureRoot, "state.json");
    const fixture = await startSshEnvLabFixture({ statePath });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: sshConfig,
    });
    try {
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.lease.status).toBe("active");
      expect(acquired.lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
      expect(acquired.lease.metadata).toMatchObject({
        driver: "ssh",
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        remoteWorkspacePath: sshConfig.remoteWorkspacePath,
        remoteCwd: sshConfig.remoteWorkspacePath,
      });

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.driver).toBe("ssh");
      expect(released[0]?.lease.status).toBe("released");
    } finally {
    }
  });

  it("acquires and releases a fake sandbox run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.providerLeaseId).toMatch(new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`));
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "sandbox",
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("sandbox");
    expect(released[0]?.lease.status).toBe("released");
  });

  it("uses plugin-backed sandbox config for execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Sandbox Provider",
        description: "Test fake plugin provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config).toEqual(expect.objectContaining({
          image: "fake:test",
          timeoutMs: 1234,
          reuseLease: false,
        }));
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          expect(params.config).toEqual({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
          });
          expect(params.config).not.toHaveProperty("driver");
          expect(params.config).not.toHaveProperty("executionWorkspaceMode");
          expect(params.config).not.toHaveProperty("pluginId");
          expect(params.config).not.toHaveProperty("pluginKey");
          expect(params.config).not.toHaveProperty("providerMetadata");
          expect(params.config).not.toHaveProperty("provider");
          expect(params.config).not.toHaveProperty("sandboxProviderPlugin");
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.anything(), 31000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.anything(), 31234);
  });

  it("uses resolved secret-ref config for plugin-backed sandbox execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.secure-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secure Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config.apiKey).toBe("resolved-provider-key");
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "secure-plugin",
              template: "base",
              apiKey: "resolved-provider-key",
              timeoutMs: 1234,
              reuseLease: false,
              sandboxId: "sandbox-1",
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    expect(acquired.lease.metadata).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      sandboxId: "sandbox-1",
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234);
  });

  it("waits briefly for a ready sandbox provider plugin worker to come online", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Eventually Running Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.eventually-running-sandbox-provider",
      packageName: "@acme/eventually-running-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.eventually-running-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Eventually Running Sandbox Provider",
        description: "Test plugin worker startup grace period",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    let runningChecks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        runningChecks += 1;
        return runningChecks >= 3;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.isRunning).toHaveBeenCalledTimes(3);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("extends plugin-backed sandbox lease RPC timeouts from provider config", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1_234,
      bridgeRequestTimeoutMs: 40_000,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Long Lease Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.long-lease-sandbox-provider",
      packageName: "@acme/long-lease-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.long-lease-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Long Lease Sandbox Provider",
        description: "Test plugin worker acquire timeout",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1_234,
              bridgeRequestTimeoutMs: 40_000,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        config: {
          image: "fake:test",
          timeoutMs: 1_234,
          bridgeRequestTimeoutMs: 40_000,
          reuseLease: false,
        },
      }),
      70_000,
    );
  });

  it("falls back to acquire when plugin-backed sandbox lease resume throws", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.fake-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const staleLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          throw new Error("stale sandbox");
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentResumeLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 31234);
    expect(workerManager.call).toHaveBeenNthCalledWith(2, pluginId, "environmentDestroyLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 31234);
    expect(workerManager.call).toHaveBeenNthCalledWith(3, pluginId, "environmentAcquireLease", expect.objectContaining({
      driverKey: "fake-plugin",
      config: {
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
      agentId,
      executionWorkspaceId,
      runId,
    }), 31234);
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("does not resume released reusable plugin sandbox leases after provider config drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "template-a",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.fake-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.image}`,
            metadata: {
              provider: "fake-plugin",
              image: params.config.image,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    expect(first.lease.metadata?.reusableSandboxLease).toMatchObject({
      provider: "fake-plugin",
      leaseFingerprint: expect.objectContaining({
        category: "lease",
        fingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      }),
    });
    await runtimeWithPlugin.releaseRunLeases(runId);

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const updatedEnvironment = {
      ...environment,
      config: {
        ...providerConfig,
        image: "template-b",
      },
    };
    await environmentService(db).update(environment.id, {
      config: updatedEnvironment.config,
    });

    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment: updatedEnvironment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-template-b");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-template-a",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
  });

  it("does not resume released reusable plugin sandbox leases after secret version drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.secure-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secure Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.apiKey}`,
            metadata: {
              provider: "secure-plugin",
              template: params.config.template,
              apiKey: params.config.apiKey,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await runtimeWithPlugin.releaseRunLeases(runId);
    await secretService(db).rotate(apiSecret.id, { value: "rotated-provider-key" });

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-rotated-provider-key");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-resolved-provider-key",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
    const firstMetadata = JSON.stringify(first.lease.metadata);
    expect(firstMetadata).not.toContain("resolved-provider-key");
    expect(firstMetadata).not.toContain("rotated-provider-key");
  });

  it("preserves active reusable sandbox leases held by another running run", async () => {
    const { pluginId, companyId, agentId, environment, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId,
      executionWorkspaceId,
      runId: nextRunId,
    }), 31234);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
    });
  });

  it("does not retain or resume plugin-backed sandbox leases unless the provider opts in", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Non-reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.non-reusable-sandbox-provider",
      packageName: "@acme/non-reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.non-reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Non-reusable Sandbox Provider",
        description: "Test provider without reusable lease support",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Non-reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("destroys scoped reusable plugin-backed sandbox leases", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease.id).toBe(reusableLease.id);
    expect(destroyed[0]?.lease.status).toBe("expired");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "success",
    });
  });

  it("reconciles only the exact built-in lease linked to a terminated agent run", async () => {
    const { companyId, environment, runId: liveRunId } = await seedEnvironment({
      driver: "sandbox",
      name: `Historical lease sandbox ${randomUUID()}`,
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true },
    });
    const { agentId: historicalAgentId, runId: historicalRunId } =
      await seedHistoricalHeartbeatRun(companyId, randomUUID());
    const leases = environmentService(db);
    const sharedMetadata = {
      driver: "sandbox",
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    };
    const historicalLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: historicalRunId,
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: "historical-provider-lease",
      metadata: { ...sharedMetadata, agentId: historicalAgentId },
    });
    const liveLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: liveRunId,
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: "live-provider-lease",
      metadata: sharedMetadata,
    });

    const result = await runtime.reconcileTerminatedAgentLeasesOnStartup();

    expect(result).toMatchObject({ reconciled: 1, destroyed: 1, failed: 0 });
    await expect(leases.getLeaseById(historicalLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(liveLease.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
      providerLeaseId: "live-provider-lease",
    });
  });

  it("quarantines a historical plugin lease when its driver worker cannot destroy it", async () => {
    const { pluginId, companyId, reusableLease } = await seedReusablePluginSandboxLease();
    const { runId: historicalRunId } = await seedHistoricalHeartbeatRun(companyId);
    await db.update(environmentLeases)
      .set({ heartbeatRunId: historicalRunId })
      .where(eq(environmentLeases.id, reusableLease.id));
    const workerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
    } as unknown as PluginWorkerManager;
    const runtimeWithOfflinePlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithOfflinePlugin.reconcileTerminatedAgentLeasesOnStartup();

    expect(result).toMatchObject({ reconciled: 1, destroyed: 0, failed: 1 });
    expect(result.failures).toEqual([
      expect.objectContaining({ leaseId: reusableLease.id }),
    ]);
    expect(workerManager.isRunning).toHaveBeenCalledWith(pluginId);
    expect(workerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "reusable_environment_lease_cleanup_failed",
    });
  });

  it("records exact success when a plugin-backed historical lease is destroyed", async () => {
    const { pluginId, companyId, reusableLease } = await seedReusablePluginSandboxLease();
    const { runId: historicalRunId } = await seedHistoricalHeartbeatRun(companyId);
    await db.update(environmentLeases)
      .set({ heartbeatRunId: historicalRunId })
      .where(eq(environmentLeases.id, reusableLease.id));
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithPlugin.reconcileTerminatedAgentLeasesOnStartup();

    expect(result).toMatchObject({ reconciled: 1, destroyed: 1, failed: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("rejects acquire and resume operations linked to a historical agent run", async () => {
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: `Historical guard sandbox ${randomUUID()}`,
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true },
    });
    const { agentId, runId } = await seedHistoricalHeartbeatRun(companyId);
    const lease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake",
      providerLeaseId: "guarded-historical-lease",
      metadata: { driver: "sandbox", provider: "fake", image: "ubuntu:24.04", reuseLease: true },
    });

    await expect(runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });
    await expect(runtime.resumeRunLease({ environment, lease })).rejects.toMatchObject({
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });
  });

  it("blocks active operations and quarantines reusable leases with missing, malformed, or absent owners", async () => {
    const { companyId, agentId, environment } = await seedEnvironment();
    const leases = environmentService(db);
    const missingOwnerLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "missing-owner",
      metadata: { driver: "local", agentId: randomUUID() },
    });
    const ownerlessLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "ownerless",
      metadata: { driver: "local" },
    });
    const malformedOwnerLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "malformed-owner",
      metadata: { driver: "local", agentId: "not-a-uuid" },
    });
    const expiredUnprovenLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "expired-without-cleanup-proof",
      metadata: { driver: "local" },
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Conflicting reusable lease owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const mismatchedOwnerLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "mismatched-owner",
      metadata: {
        driver: "local",
        agentId,
        reusableSandboxLease: { agentId: otherAgentId },
      },
    });
    const failedSuccessLiveOwnerLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "failed-success-live-owner",
      metadata: { driver: "local", agentId },
    });
    await leases.releaseLease(failedSuccessLiveOwnerLease.id, "failed", {
      failureReason: "released_but_not_destroyed",
      cleanupStatus: "success",
    });
    const unknownStatusLiveOwnerLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "local",
      providerLeaseId: "unknown-status-live-owner",
      metadata: { driver: "local", agentId },
    });
    await db.update(environmentLeases)
      .set({ status: "unknown_reusable_state" })
      .where(eq(environmentLeases.id, unknownStatusLiveOwnerLease.id));
    await expect(runtime.resumeRunLease({ environment, lease: missingOwnerLease }))
      .rejects.toMatchObject({ details: { code: "agent_terminated_active_reference_forbidden" } });
    await expect(runtime.realizeWorkspace({
      environment,
      lease: missingOwnerLease,
      workspace: { localPath: "/tmp/unsafe" },
    })).rejects.toMatchObject({ details: { code: "agent_terminated_active_reference_forbidden" } });
    await expect(runtime.execute({
      environment,
      lease: missingOwnerLease,
      command: "echo",
      args: ["unsafe"],
    })).rejects.toMatchObject({ details: { code: "agent_terminated_active_reference_forbidden" } });
    await expect(runtime.execute({
      environment: { ...environment, id: randomUUID() },
      lease: missingOwnerLease,
      command: "echo",
      args: ["wrong-environment"],
    })).rejects.toMatchObject({ details: { code: "environment_lease_binding_mismatch" } });
    await expect(runtime.resumeRunLease({ environment, lease: ownerlessLease }))
      .rejects.toMatchObject({ details: { code: "agent_environment_lease_owner_invalid" } });
    await expect(runtime.resumeRunLease({ environment, lease: malformedOwnerLease }))
      .rejects.toMatchObject({ details: { code: "agent_environment_lease_owner_invalid" } });
    await expect(runtime.resumeRunLease({ environment, lease: mismatchedOwnerLease }))
      .rejects.toMatchObject({ details: { code: "agent_environment_lease_owner_invalid" } });

    await leases.releaseLease(malformedOwnerLease.id, "failed", {
      failureReason: "provider_cleanup_failed",
      cleanupStatus: "success",
    });
    await leases.releaseLease(expiredUnprovenLease.id, "expired", {
      failureReason: "provider_cleanup_unproven",
      cleanupStatus: "failed",
    });

    const result = await runtime.reconcileTerminatedAgentLeasesOnStartup();
    expect(result).toMatchObject({ reconciled: 7, destroyed: 0, failed: 7 });
    for (const lease of [
      missingOwnerLease,
      ownerlessLease,
      malformedOwnerLease,
      expiredUnprovenLease,
      mismatchedOwnerLease,
      failedSuccessLiveOwnerLease,
      unknownStatusLiveOwnerLease,
    ]) {
      await expect(leases.getLeaseById(lease.id)).resolves.toMatchObject({
        status: "pending_cleanup",
        cleanupStatus: "failed",
      });
    }
  });

  it("reconciles unsafe metadata owners across every lease policy and quarantines cleanup failures", async () => {
    const { companyId, environment } = await seedEnvironment();
    const { agentId: historicalAgentId } = await seedHistoricalHeartbeatRun(companyId);
    const leases = environmentService(db);
    const missingAgentId = randomUUID();
    const otherCompanyId = randomUUID();
    const crossCompanyAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Cross-company lease owner",
      status: "active",
      issuePrefix: `X${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: crossCompanyAgentId,
      companyId: otherCompanyId,
      name: "Cross-company environment owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const historicalEphemeral = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "ephemeral",
      provider: "all-policy-owner-guard",
      providerLeaseId: "historical-null-run-ephemeral",
      metadata: { driver: "local", agentId: historicalAgentId },
    });
    const missingPending = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_execution_workspace",
      provider: "all-policy-owner-guard",
      providerLeaseId: "missing-owner-pending",
      metadata: { driver: "local", agentId: missingAgentId },
    });
    await leases.releaseLease(missingPending.id, "pending_cleanup", {
      failureReason: "prior_cleanup_failure",
      cleanupStatus: "failed",
    });
    const crossCompanyRetained = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "retain_on_failure",
      provider: "all-policy-owner-guard",
      providerLeaseId: "cross-company-owner-active",
      metadata: { driver: "local", agentId: crossCompanyAgentId },
    });

    const destroyRunLease = vi.fn(async (
      input: Parameters<NonNullable<EnvironmentRuntimeDriver["destroyRunLease"]>>[0],
    ) => {
      if (input.lease.id === missingPending.id) {
        throw new Error("synthetic all-policy cleanup failure");
      }
      return await leases.releaseLease(input.lease.id, "expired", {
        failureReason: input.failureReason,
        cleanupStatus: "success",
      });
    });
    const allPolicyRuntime = environmentRuntimeService(db, {
      drivers: [{
        driver: "local",
        async acquireRunLease() {
          return historicalEphemeral;
        },
        async releaseRunLease(input) {
          return await leases.releaseLease(input.lease.id, input.status);
        },
        destroyRunLease,
      }],
    });

    const result = await allPolicyRuntime.reconcileEnvironmentLeasesOnStartup();
    expect(result).toMatchObject({ reconciled: 3, destroyed: 2, failed: 1 });
    expect(destroyRunLease).toHaveBeenCalledTimes(3);
    await expect(leases.getLeaseById(historicalEphemeral.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(crossCompanyRetained.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(missingPending.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
    });
  });

  it("quarantines every destroy path when a lying driver reports synthetic success", async () => {
    const { companyId, agentId, environment } = await seedEnvironment();
    const leases = environmentService(db);
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Lying destroy driver workspace",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Lying destroy driver workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const publicLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "ephemeral",
      provider: "lying-destroy-driver",
      providerLeaseId: "public-live-resource",
      metadata: { driver: "local", agentId },
    });
    const scopedReusableLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "lying-destroy-driver",
      providerLeaseId: "scoped-live-resource",
      metadata: { driver: "local", agentId },
    });
    const startupReusableLease = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "lying-destroy-driver",
      providerLeaseId: "startup-live-resource",
      metadata: { driver: "local", agentId },
    });
    await leases.releaseLease(startupReusableLease.id, "pending_cleanup", {
      failureReason: "retry_destroy",
      cleanupStatus: "failed",
    });

    const destroyRunLease = vi.fn(async (
      input: Parameters<NonNullable<EnvironmentRuntimeDriver["destroyRunLease"]>>[0],
    ) => ({
      ...input.lease,
      status: "expired" as const,
      cleanupStatus: "success" as const,
      releasedAt: new Date(),
      updatedAt: new Date(),
    }));
    const lyingRuntime = environmentRuntimeService(db, {
      drivers: [{
        driver: "local",
        async acquireRunLease() {
          return publicLease;
        },
        async releaseRunLease(input) {
          return await leases.releaseLease(input.lease.id, input.status);
        },
        destroyRunLease,
      }],
    });

    await expect(lyingRuntime.destroyRunLease({ environment, lease: publicLease }))
      .resolves.toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    await expect(lyingRuntime.destroyReusableSandboxLeases({ companyId, executionWorkspaceId }))
      .resolves.toEqual([
        expect.objectContaining({
          lease: expect.objectContaining({ status: "pending_cleanup", cleanupStatus: "failed" }),
        }),
      ]);
    await expect(lyingRuntime.reconcileEnvironmentLeasesOnStartup())
      .resolves.toMatchObject({ reconciled: 2, destroyed: 0, failed: 2 });
    for (const lease of [publicLease, scopedReusableLease, startupReusableLease]) {
      await expect(leases.getLeaseById(lease.id)).resolves.toMatchObject({
        status: "pending_cleanup",
        cleanupStatus: "failed",
        providerLeaseId: lease.providerLeaseId,
      });
    }
  });

  it("quarantines reusable driver output that omits durable owner evidence", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment();
    const leases = environmentService(db);
    let emittedOwnerId: string | null = null;
    let acquireCount = 0;
    const maliciousDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        acquireCount += 1;
        return await leases.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          heartbeatRunId: acquireCount === 3 ? runId : null,
          leasePolicy: "reuse_by_environment",
          provider: "malicious-test",
          providerLeaseId:
            acquireCount === 1
              ? "ownerless-driver-output"
              : acquireCount === 2
                ? "conflicting-driver-output"
                : "mismatched-binding-output",
          metadata: { driver: "local", ...(emittedOwnerId ? { agentId: emittedOwnerId } : {}) },
        });
      },
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
    };
    const runtimeWithMaliciousDriver = environmentRuntimeService(db, { drivers: [maliciousDriver] });

    await expect(runtimeWithMaliciousDriver.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({ details: { code: "agent_environment_lease_owner_invalid" } });

    const persisted = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "ownerless-driver-output"))
      .then((rows) => rows[0]);
    expect(persisted).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });

    emittedOwnerId = randomUUID();
    await db.insert(agents).values({
      id: emittedOwnerId,
      companyId,
      name: "Malicious output owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await expect(runtimeWithMaliciousDriver.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({ details: { code: "agent_environment_lease_owner_invalid" } });
    const conflicting = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "conflicting-driver-output"))
      .then((rows) => rows[0]);
    expect(conflicting).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });

    emittedOwnerId = agentId;
    await expect(runtimeWithMaliciousDriver.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({ details: { code: "environment_lease_binding_mismatch" } });
    const mismatchedBinding = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "mismatched-binding-output"))
      .then((rows) => rows[0]);
    expect(mismatchedBinding).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
  });

  it("rejects unpersisted and divergent driver leases and returns the persisted snapshot", async () => {
    const { companyId, agentId, environment } = await seedEnvironment();
    const leases = environmentService(db);
    const now = new Date();
    const destroyGhost = vi.fn(async () => null);
    const ghostDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        return {
          id: randomUUID(),
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          status: "active",
          leasePolicy: "reuse_by_environment",
          provider: "ghost-provider",
          providerLeaseId: "ghost-provider-lease",
          acquiredAt: now,
          lastUsedAt: now,
          expiresAt: null,
          releasedAt: null,
          failureReason: null,
          cleanupStatus: null,
          metadata: { driver: "local", agentId },
          createdAt: now,
          updatedAt: now,
        };
      },
      async releaseRunLease() {
        return null;
      },
      destroyRunLease: destroyGhost,
    };
    const ghostRuntime = environmentRuntimeService(db, { drivers: [ghostDriver] });

    await expect(ghostRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toThrow(/not correlated with a persisted row/i);
    expect(destroyGhost).toHaveBeenCalledTimes(1);

    const destroyDivergent = vi.fn(async (input: Parameters<NonNullable<EnvironmentRuntimeDriver["destroyRunLease"]>>[0]) =>
      await leases.releaseLease(input.lease.id, "expired", {
        failureReason: "rejected_driver_output",
        cleanupStatus: "success",
      }));
    const divergentDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        const persisted = await leases.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "reuse_by_environment",
          provider: "divergent-provider",
          providerLeaseId: "persisted-provider-lease",
          metadata: { driver: "local", agentId },
        });
        return { ...persisted, providerLeaseId: "returned-provider-lease" };
      },
      async releaseRunLease() {
        return null;
      },
      destroyRunLease: destroyDivergent,
    };
    const divergentRuntime = environmentRuntimeService(db, { drivers: [divergentDriver] });

    await expect(divergentRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({
      details: { code: "environment_lease_persistence_mismatch" },
    });
    expect(destroyDivergent).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ providerLeaseId: "returned-provider-lease" }),
    }));
    const divergentPersisted = await db.select().from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "persisted-provider-lease"))
      .then((rows) => rows[0]);
    expect(destroyDivergent.mock.calls[0]?.[0].lease.id).not.toBe(divergentPersisted.id);
    expect(divergentPersisted).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });

    const unrelated = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "ephemeral",
      provider: "unrelated-provider",
      providerLeaseId: "unrelated-provider-lease",
      metadata: { driver: "local" },
    });
    const collisionDestroy = vi.fn(async (input: Parameters<NonNullable<EnvironmentRuntimeDriver["destroyRunLease"]>>[0]) =>
      await leases.releaseLease(input.lease.id, "expired", { cleanupStatus: "success" }));
    const collisionDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        return {
          ...unrelated,
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          status: "active",
          leasePolicy: "reuse_by_environment",
          provider: "collision-output-provider",
          providerLeaseId: "collision-output-provider-lease",
          metadata: { driver: "local", agentId },
        };
      },
      async releaseRunLease() {
        return null;
      },
      destroyRunLease: collisionDestroy,
    };
    const collisionRuntime = environmentRuntimeService(db, { drivers: [collisionDriver] });
    await expect(collisionRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: randomUUID(),
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toThrow(/not correlated with a persisted row/i);
    expect(collisionDestroy).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({
        providerLeaseId: "collision-output-provider-lease",
      }),
    }));
    const collisionCleanupLeaseId = collisionDestroy.mock.calls[0]?.[0].lease.id;
    expect(collisionCleanupLeaseId).not.toBe(unrelated.id);
    await expect(leases.getLeaseById(unrelated.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
      provider: "unrelated-provider",
      providerLeaseId: "unrelated-provider-lease",
    });

    const snapshotDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        const persisted = await leases.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "reuse_by_environment",
          provider: "snapshot-provider",
          providerLeaseId: "snapshot-provider-lease",
          metadata: { driver: "local", agentId },
        });
        await leases.updateLeaseMetadata(persisted.id, {
          ...(persisted.metadata ?? {}),
          persistedMarker: true,
        });
        return persisted;
      },
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
    };
    const snapshotRuntime = environmentRuntimeService(db, { drivers: [snapshotDriver] });
    const acquired = await snapshotRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    });
    expect(acquired.lease.metadata).toMatchObject({ persistedMarker: true });
  });

  it("blocks pending-approval owners before lease acquisition or resume reaches a driver", async () => {
    const { companyId, agentId, environment } = await seedEnvironment();
    const leases = environmentService(db);
    const persisted = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "pending-owner-provider",
      providerLeaseId: "pending-owner-provider-lease",
      metadata: { driver: "local", agentId },
    });
    const acquireRunLease = vi.fn(async () => persisted);
    const resumeRunLease = vi.fn(async () => persisted);
    const guardedDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      acquireRunLease,
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
      resumeRunLease,
    };
    const guardedRuntime = environmentRuntimeService(db, { drivers: [guardedDriver] });
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, agentId));

    await expect(guardedRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({
      details: {
        code: "agent_lifecycle_active_reference_forbidden",
        reason: "pending_approval",
      },
    });
    await expect(guardedRuntime.resumeRunLease({ environment, lease: persisted }))
      .rejects.toMatchObject({
        details: {
          code: "agent_lifecycle_active_reference_forbidden",
          reason: "pending_approval",
        },
      });
    expect(acquireRunLease).not.toHaveBeenCalled();
    expect(resumeRunLease).not.toHaveBeenCalled();
  });

  it("reloads and validates persisted leases before resume, realization, or execution", async () => {
    const { companyId, agentId, environment } = await seedEnvironment();
    const leases = environmentService(db);
    const persisted = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: null,
      leasePolicy: "reuse_by_environment",
      provider: "guarded-provider",
      providerLeaseId: "guarded-provider-lease",
      metadata: { driver: "local", agentId },
    });
    const resumeRunLease = vi.fn(async () => persisted);
    const destroyRunLease = vi.fn(async () => persisted);
    const realizeWorkspace = vi.fn(async () => ({ cwd: "/tmp", metadata: {} }));
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const guardedDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease() {
        return persisted;
      },
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
      resumeRunLease,
      destroyRunLease,
      realizeWorkspace,
      execute,
    };
    const guardedRuntime = environmentRuntimeService(db, { drivers: [guardedDriver] });

    await expect(guardedRuntime.resumeRunLease({
      environment,
      lease: { ...persisted, providerLeaseId: "forged-provider-lease" },
    })).rejects.toMatchObject({
      details: { code: "environment_lease_persistence_mismatch" },
    });
    await expect(guardedRuntime.destroyRunLease({
      environment,
      lease: { ...persisted, providerLeaseId: "forged-cleanup-provider-lease" },
    })).rejects.toMatchObject({
      details: { code: "environment_lease_persistence_mismatch" },
    });

    await leases.releaseLease(persisted.id, "pending_cleanup", {
      failureReason: "cleanup_required",
      cleanupStatus: "failed",
    });
    await expect(guardedRuntime.realizeWorkspace({
      environment,
      lease: persisted,
      workspace: { localPath: "/tmp" },
    })).rejects.toMatchObject({
      details: { code: "environment_lease_persistence_mismatch" },
    });

    await expect(guardedRuntime.execute({
      environment,
      lease: { ...persisted, id: randomUUID() },
      command: "echo",
    })).rejects.toMatchObject({
      details: { code: "environment_lease_persistence_mismatch" },
    });
    expect(resumeRunLease).not.toHaveBeenCalled();
    expect(destroyRunLease).not.toHaveBeenCalled();
    expect(realizeWorkspace).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects and quarantines an acquisition when agent termination wins the row-lock race", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const leases = environmentService(db);
    let enterAcquire!: () => void;
    const acquireEntered = new Promise<void>((resolve) => { enterAcquire = resolve; });
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
    const gatedDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        enterAcquire();
        await acquireGate;
        return await leases.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "reuse_by_environment",
          provider: "gated-provider",
          providerLeaseId: "gated-provider-lease",
          metadata: { driver: "local", agentId },
        });
      },
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
    };
    const gatedRuntime = environmentRuntimeService(db, { drivers: [gatedDriver] });
    const acquire = gatedRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    });
    await acquireEntered;

    await expect(agentService(db).terminate(agentId)).resolves.toMatchObject({ status: "terminated" });

    releaseAcquire();
    await expect(acquire).rejects.toMatchObject({
      details: { code: "agent_terminated_active_reference_forbidden" },
    });
    await expect(db.select().from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "gated-provider-lease"))
      .then((rows) => rows[0])).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
    });
  });

  it("makes a completed acquisition visible before a concurrent termination scan", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const leases = environmentService(db);
    const driver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease(input) {
        return await leases.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "reuse_by_environment",
          provider: "acquire-first-provider",
          providerLeaseId: "acquire-first-provider-lease",
          metadata: { driver: "local", agentId },
        });
      },
      async releaseRunLease(input) {
        return await leases.releaseLease(input.lease.id, input.status);
      },
    };
    const acquireFirstRuntime = environmentRuntimeService(db, { drivers: [driver] });
    await expect(acquireFirstRuntime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
    })).resolves.toMatchObject({
      lease: { providerLeaseId: "acquire-first-provider-lease" },
    });
    await expect(agentService(db).terminate(agentId)).rejects.toMatchObject({
      details: { code: "agent_active_dependencies" },
    });
    await expect(agentService(db).getById(agentId)).resolves.toMatchObject({ status: "active" });
  });

  it("finalizes active leases left behind by terminal heartbeat runs according to policy", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    const leases = environmentService(db);
    const runStatuses = ["succeeded", "failed", "timed_out"] as const;
    const extraRunIds = runStatuses.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(runStatuses.map((status, index) => ({
      id: extraRunIds[index],
      companyId,
      agentId,
      invocationSource: "manual",
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
    })));
    const staleEphemeral = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
      provider: "startup-finalizer",
      providerLeaseId: "stale-ephemeral",
      metadata: { driver: "local", agentId },
    });
    const staleReusable = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: extraRunIds[0],
      leasePolicy: "reuse_by_environment",
      provider: "startup-finalizer",
      providerLeaseId: "stale-reusable",
      metadata: { driver: "local", agentId },
    });
    const retainedOnFailure = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: extraRunIds[1],
      leasePolicy: "retain_on_failure",
      provider: "startup-finalizer",
      providerLeaseId: "stale-retain-on-failure",
      metadata: { driver: "local", agentId },
    });
    const failedCleanup = await leases.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: extraRunIds[2],
      leasePolicy: "reuse_by_execution_workspace",
      provider: "startup-finalizer",
      providerLeaseId: "stale-cleanup-failure",
      metadata: { driver: "local", agentId },
    });
    const releaseRunLease = vi.fn(async (input: Parameters<EnvironmentRuntimeDriver["releaseRunLease"]>[0]) => {
      if (input.lease.id === failedCleanup.id) {
        throw new Error("synthetic provider cleanup failure");
      }
      const status = input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? "retained"
        : input.status;
      return await leases.releaseLease(input.lease.id, status, { cleanupStatus: "success" });
    });
    const finalizerDriver: EnvironmentRuntimeDriver = {
      driver: "local",
      async acquireRunLease() {
        return staleEphemeral;
      },
      releaseRunLease,
    };
    const finalizerRuntime = environmentRuntimeService(db, { drivers: [finalizerDriver] });

    const result = await finalizerRuntime.reconcileTerminatedAgentLeasesOnStartup();
    expect(result).toMatchObject({ reconciled: 4, destroyed: 3, failed: 1 });
    await expect(leases.getLeaseById(staleEphemeral.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(staleReusable.id)).resolves.toMatchObject({
      status: "released",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(retainedOnFailure.id)).resolves.toMatchObject({
      status: "retained",
      cleanupStatus: "success",
    });
    await expect(leases.getLeaseById(failedCleanup.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "terminal_run_lease_cleanup_failed",
    });
    expect(releaseRunLease).toHaveBeenCalledTimes(4);
  });

  it("retries pending reusable plugin cleanup on startup after the worker recovers", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const offlineWorkerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
    } as unknown as PluginWorkerManager;
    const runtimeWithOfflinePlugin = environmentRuntimeService(db, {
      pluginWorkerManager: offlineWorkerManager,
    });

    const pending = await runtimeWithOfflinePlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.lease.id).toBe(reusableLease.id);
    expect(pending[0]?.lease.status).toBe("pending_cleanup");
    expect(offlineWorkerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "failed",
    });

    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithRecoveredPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });

    const retried = await runtimeWithRecoveredPlugin.reconcileTerminatedAgentLeasesOnStartup();

    expect(retried).toMatchObject({ reconciled: 1, destroyed: 1, failed: 0 });
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "reusable_environment_lease_reconciliation",
      cleanupStatus: "success",
    });
  });

  it("releases a sandbox run lease from metadata after the environment config changes", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(acquired.lease.id);
    expect(released[0]?.lease.status).toBe("released");
  });

  it("does not reuse a sandbox lease owned by a different agent for the same execution workspace", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Existing workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other sandbox agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "manual",
      status: "running",
      updatedAt: new Date(),
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "other-agent-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        template: "base",
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-agent-lease",
            metadata: {
              provider: "fake-plugin",
              template: "base",
              reuseLease: true,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId: otherAgentId,
      heartbeatRunId: otherRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-agent-lease");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId: otherAgentId,
      executionWorkspaceId,
    }));
  });

  it("delegates plugin environment leases through the plugin worker manager", async () => {
    const pluginId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-1",
            expiresAt,
            metadata: {
              driver: "local",
              pluginId: "provider-plugin-id",
              pluginKey: "provider.plugin",
              driverKey: "provider-driver",
              executionWorkspaceMode: "provider-mode",
              provider: "test-provider",
              remoteCwd: "/workspace",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      runId,
      workspaceMode: undefined,
    });
    expect(acquired.lease.providerLeaseId).toBe("plugin-lease-1");
    expect(acquired.lease.expiresAt?.toISOString()).toBe(expiresAt);
    expect(acquired.lease.metadata).toMatchObject({
      driver: "plugin",
      pluginId,
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      executionWorkspaceMode: null,
      providerMetadata: {
        driver: "local",
        pluginId: "provider-plugin-id",
        pluginKey: "provider.plugin",
        driverKey: "provider-driver",
        executionWorkspaceMode: "provider-mode",
        provider: "test-provider",
        remoteCwd: "/workspace",
      },
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: {},
      providerLeaseId: "plugin-lease-1",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
        providerMetadata: expect.objectContaining({
          driver: "local",
        }),
      }),
    });
    expect(released[0]?.lease.status).toBe("released");
  });

  it("delegates the full plugin environment lifecycle through the worker manager", async () => {
    const pluginId = randomUUID();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              resumed: true,
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          return {
            cwd: "/workspace/project",
            metadata: {
              realized: true,
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
            metadata: {
              commandId: "cmd-1",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Full Lifecycle",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const resumed = await runtimeWithPlugin.resumeRunLease({
      environment,
      lease: acquired.lease,
    });
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "echo",
      args: ["ok"],
      cwd: realized.cwd,
      env: { FOO: "bar" },
      stdin: "",
      timeoutMs: 1000,
    });
    const destroyed = await runtimeWithPlugin.destroyRunLease({
      environment,
      lease: acquired.lease,
    });

    expect(resumed).toMatchObject({
      providerLeaseId: "plugin-lease-full",
      metadata: {
        resumed: true,
      },
    });
    expect(realized).toEqual({
      cwd: "/workspace/project",
      metadata: {
        realized: true,
      },
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
    });
    expect(destroyed).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentResumeLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentRealizeWorkspace", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      command: "echo",
      args: ["ok"],
      cwd: "/workspace/project",
      env: { FOO: "bar" },
    }), 31000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
  });

  it("releases with the driver captured on the lease even if the environment driver changes later", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const localRelease = vi.fn(async ({ lease, status }: { lease: { id: string }; status: "released" | "expired" | "failed" }) =>
      await environmentsSvc.releaseLease(lease.id, status)
    );
    const sshRelease = vi.fn(async () => {
      throw new Error("ssh release should not be called");
    });
    const runtimeWithSpies = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async (input) => await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            metadata: {
              driver: input.environment.driver,
              executionWorkspaceMode: input.executionWorkspaceMode,
            },
          }),
          releaseRunLease: localRelease,
        },
        {
          driver: "ssh",
          acquireRunLease: async () => {
            throw new Error("ssh acquire should not be called");
          },
          releaseRunLease: sshRelease,
        },
      ],
    });

    const acquired = await runtimeWithSpies.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentsSvc.update(environment.id, { driver: "ssh" });

    const released = await runtimeWithSpies.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(localRelease).toHaveBeenCalledTimes(1);
    expect(sshRelease).not.toHaveBeenCalled();
    expect(acquired.lease.metadata?.driver).toBe("local");
  });
});

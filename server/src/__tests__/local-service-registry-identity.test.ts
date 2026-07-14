import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { captureSpawnedLocalProcessIdentity } from "../services/local-process-identity.js";
import {
  assertLocalServiceRegistryRecordIdentity,
  createLocalServiceKey,
  findAdoptableLocalService,
  findAdoptableLocalServiceStrict,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  isPidAlive,
  isProcessGroupAlive,
  listLocalServiceRegistryRecordsStrict,
  readLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";

const describeSupported = process.platform === "darwin" || process.platform === "linux"
  ? describe
  : describe.skip;

describeSupported("local service registry process identity", () => {
  let child: ChildProcess | null = null;
  let children: ChildProcess[] = [];
  let paperclipHome = "";
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-registry-identity-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `registry-identity-${randomUUID()}`;
  });

  afterEach(async () => {
    for (const spawnedChild of children) {
      if (typeof spawnedChild.pid !== "number") continue;
      try {
        process.kill(-spawnedChild.pid, "SIGKILL");
      } catch {
        // Best-effort test cleanup.
      }
    }
    child = null;
    children = [];
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  async function spawnService() {
    const startedAt = new Date().toISOString();
    child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
    });
    const identity = await captureSpawnedLocalProcessIdentity({
      pid: child.pid!,
      processGroupId: child.pid!,
      startedAt,
    });
    return { startedAt, identity };
  }

  async function spawnLeaderWithSurvivingGroupChild() {
    const startedAt = new Date().toISOString();
    child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "process.stdout.write('ready\\n');",
          "process.stdin.once('data', () => {",
          "  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "  worker.unref();",
          "  worker.once('spawn', () => {",
          "    process.stdout.write('child-ready\\n');",
          "    setTimeout(() => process.exit(0), 25);",
          "  });",
          "});",
        ].join("\n"),
      ],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    children.push(child);
    let output = "";
    const waitForOutput = (expected: string) => new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        output += String(chunk);
        if (!output.includes(expected)) return;
        child!.stdout!.off("data", onData);
        child!.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child!.stdout!.off("data", onData);
        reject(error);
      };
      child!.stdout!.on("data", onData);
      child!.once("error", onError);
      if (output.includes(expected)) {
        child!.stdout!.off("data", onData);
        child!.off("error", onError);
        resolve();
      }
    });
    await waitForOutput("ready\n");
    const identity = await captureSpawnedLocalProcessIdentity({
      pid: child.pid!,
      processGroupId: child.pid!,
      startedAt,
    });
    const childReady = waitForOutput("child-ready\n");
    child.stdin!.write("start\n");
    await childReady;
    await new Promise<void>((resolve, reject) => {
      child!.once("exit", () => resolve());
      child!.once("error", reject);
    });
    expect(isPidAlive(identity.pid)).toBe(false);
    expect(isProcessGroupAlive(identity.processGroupId)).toBe(true);
    return { startedAt, identity };
  }

  function registryRecord(input: {
    runtimeServiceId: string;
    startedAt: string;
    identity: Awaited<ReturnType<typeof captureSpawnedLocalProcessIdentity>>;
  }): LocalServiceRegistryRecord {
    return {
      version: 2,
      serviceKey: `workspace-runtime-test-${randomUUID()}`,
      profileKind: "workspace-runtime",
      serviceName: "identity-test",
      command: "node identity-test",
      cwd: os.tmpdir(),
      envFingerprint: "identity-test",
      port: null,
      url: null,
      pid: input.identity.pid,
      processGroupId: input.identity.processGroupId,
      processStartedAt: input.identity.processStartedAt,
      processExecutable: input.identity.processExecutable,
      processCommandSha256: input.identity.processCommandSha256,
      provider: "local_process",
      runtimeServiceId: input.runtimeServiceId,
      reuseKey: null,
      startedAt: input.startedAt,
      lastSeenAt: new Date().toISOString(),
      metadata: null,
    };
  }

  it("binds workspace runtime service keys to the owning company", () => {
    const base = {
      profileKind: "workspace-runtime",
      serviceName: "web",
      cwd: os.tmpdir(),
      command: "node server.js",
      envFingerprint: "same-env",
      port: null,
      scope: { scopeType: "project_workspace", scopeId: "same-workspace" },
    };
    expect(createLocalServiceKey({ ...base, companyId: randomUUID() }))
      .not.toBe(createLocalServiceKey({ ...base, companyId: randomUUID() }));
  });

  it("adopts only the exact spawned identity and fails closed on simulated PID reuse", async () => {
    const spawned = await spawnService();
    const runtimeServiceId = randomUUID();
    const record = registryRecord({ runtimeServiceId, ...spawned });
    await writeLocalServiceRegistryRecord(record);

    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId,
      profileKind: "workspace-runtime",
    })).resolves.toMatchObject({
      version: 2,
      processCommandSha256: spawned.identity.processCommandSha256,
    });

    await writeLocalServiceRegistryRecord({
      ...record,
      processStartedAt: new Date(Date.parse(spawned.identity.processStartedAt) - 1_000).toISOString(),
    });
    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId,
      profileKind: "workspace-runtime",
    })).rejects.toThrow(/identity.*unproven.*stored_identity_mismatch/i);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("reads legacy v1 records but never treats missing strong identity as adoptable", async () => {
    const spawned = await spawnService();
    const runtimeServiceId = randomUUID();
    const strong = registryRecord({ runtimeServiceId, ...spawned });
    const legacy: LocalServiceRegistryRecord = {
      ...strong,
      version: 1,
      processStartedAt: undefined,
      processExecutable: undefined,
      processCommandSha256: undefined,
    };
    await writeLocalServiceRegistryRecord(legacy);

    await expect(readLocalServiceRegistryRecord(legacy.serviceKey)).resolves.toMatchObject({
      version: 1,
      processStartedAt: null,
      processExecutable: null,
      processCommandSha256: null,
    });
    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId,
      profileKind: "workspace-runtime",
    })).rejects.toThrow(/stored_identity_incomplete/);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("fails closed when OS identity inspection is unavailable", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await expect(assertLocalServiceRegistryRecordIdentity(
      record,
      async () => ({ kind: "unproven", reason: "process_identity_read_failed" }),
    )).rejects.toThrow(/process_identity_read_failed/);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("atomically replaces registry files with private directory and file modes", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    const registryDir = path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
    const registryPath = path.resolve(registryDir, `${record.serviceKey}.json`);

    await writeLocalServiceRegistryRecord(record);
    await fs.chmod(registryDir, 0o755);
    await fs.chmod(registryPath, 0o644);
    await writeLocalServiceRegistryRecord({ ...record, lastSeenAt: new Date().toISOString() });

    expect((await fs.stat(registryDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(registryPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(registryDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("treats a partial registry record as untrusted and never adopts its live process", async () => {
    const spawned = await spawnService();
    const runtimeServiceId = randomUUID();
    const record = registryRecord({ runtimeServiceId, ...spawned });
    await writeLocalServiceRegistryRecord(record);
    const registryPath = path.resolve(
      resolvePaperclipInstanceRoot(),
      "runtime-services",
      `${record.serviceKey}.json`,
    );
    await fs.writeFile(registryPath, '{"version":2,"serviceKey":', { encoding: "utf8", mode: 0o600 });

    await expect(readLocalServiceRegistryRecord(record.serviceKey)).resolves.toBeNull();
    await expect(findAdoptableLocalService({ serviceKey: record.serviceKey })).resolves.toBeNull();
    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId,
      profileKind: "workspace-runtime",
    })).rejects.toThrow(/registry.*(invalid|corrupt|parse)/i);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("keeps tolerant adoption separate from strict unreadable-file reconciliation", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record);
    const registryPath = path.resolve(
      resolvePaperclipInstanceRoot(),
      "runtime-services",
      `${record.serviceKey}.json`,
    );
    await fs.chmod(registryPath, 0o000);
    try {
      await expect(findAdoptableLocalService({ serviceKey: record.serviceKey })).resolves.toBeNull();
      await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
        .rejects.toThrow(/registry.*(read|unreadable|permission)/i);
      expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    } finally {
      await fs.chmod(registryPath, 0o600);
    }
  });

  it("surfaces an unreadable registry directory instead of proving absence", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record);
    const registryDir = path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
    await fs.chmod(registryDir, 0o000);
    try {
      await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
        .rejects.toThrow(/registry.*(directory|read|permission)/i);
      expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    } finally {
      await fs.chmod(registryDir, 0o700);
    }
  });

  it("rejects duplicate verified registry files for one runtime service id", async () => {
    const runtimeServiceId = randomUUID();
    const first = await spawnService();
    const firstChild = child!;
    const second = await spawnService();
    const secondChild = child!;
    await writeLocalServiceRegistryRecord(registryRecord({ runtimeServiceId, ...first }));
    await writeLocalServiceRegistryRecord(registryRecord({ runtimeServiceId, ...second }));

    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId,
      profileKind: "workspace-runtime",
    })).rejects.toThrow(/duplicate.*runtime service/i);
    expect(() => process.kill(firstChild.pid!, 0)).not.toThrow();
    expect(() => process.kill(secondChild.pid!, 0)).not.toThrow();
  });

  it("rejects registry records whose filename is not bound to their service key", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record);
    const registryDir = path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
    await fs.rename(
      path.resolve(registryDir, `${record.serviceKey}.json`),
      path.resolve(registryDir, `renamed-${record.serviceKey}.json`),
    );

    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .rejects.toThrow(/filename.*service key|service key.*filename/i);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("rejects contradictory duplicate strong process identities", async () => {
    const spawned = await spawnService();
    const first = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    const second = {
      ...registryRecord({ runtimeServiceId: randomUUID(), ...spawned }),
      serviceKey: `workspace-runtime-duplicate-process-${randomUUID()}`,
    };
    await writeLocalServiceRegistryRecord(first);
    await writeLocalServiceRegistryRecord(second);

    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .rejects.toThrow(/duplicate.*(?:process (?:identity|group|pid)|registry pid)/i);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it("rejects duplicate pids even when strong identity and process groups differ", async () => {
    const firstSpawned = await spawnService();
    const first = registryRecord({ runtimeServiceId: randomUUID(), ...firstSpawned });
    const secondSpawned = await spawnService();
    const second = {
      ...registryRecord({ runtimeServiceId: randomUUID(), ...secondSpawned }),
      serviceKey: `workspace-runtime-duplicate-pid-${randomUUID()}`,
      pid: first.pid,
      processStartedAt: new Date(Date.parse(first.processStartedAt!) + 1_000).toISOString(),
      processCommandSha256: "f".repeat(64),
    };
    await writeLocalServiceRegistryRecord(first);
    await writeLocalServiceRegistryRecord(second);

    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .rejects.toThrow(/duplicate.*pid/i);
  });

  it("rejects duplicate positive process groups for incomplete legacy records", async () => {
    const firstSpawned = await spawnService();
    const first = {
      ...registryRecord({ runtimeServiceId: randomUUID(), ...firstSpawned }),
      version: 1 as const,
      processStartedAt: null,
      processExecutable: null,
      processCommandSha256: null,
    };
    const secondSpawned = await spawnService();
    const second = {
      ...registryRecord({ runtimeServiceId: randomUUID(), ...secondSpawned }),
      serviceKey: `workspace-runtime-duplicate-group-${randomUUID()}`,
      version: 1 as const,
      processGroupId: first.processGroupId,
      processStartedAt: null,
      processExecutable: null,
      processCommandSha256: null,
    };
    await writeLocalServiceRegistryRecord(first);
    await writeLocalServiceRegistryRecord(second);

    await expect(listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" }))
      .rejects.toThrow(/duplicate.*process group/i);
  });

  it("can create a registry record without overwriting existing evidence", async () => {
    const spawned = await spawnService();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record, { mode: "create" });

    await expect(writeLocalServiceRegistryRecord({
      ...record,
      runtimeServiceId: randomUUID(),
    }, { mode: "create" })).rejects.toThrow(/already exists|refusing to overwrite/i);
    await expect(readLocalServiceRegistryRecord(record.serviceKey)).resolves.toMatchObject({
      runtimeServiceId: record.runtimeServiceId,
    });
  });

  it("preserves evidence when the registered leader exited but its process group is alive", async () => {
    const spawned = await spawnLeaderWithSurvivingGroupChild();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record);

    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: record.runtimeServiceId!,
      profileKind: "workspace-runtime",
    })).rejects.toThrow(/leader.*not running.*process group.*alive/i);
    await expect(readLocalServiceRegistryRecord(record.serviceKey)).resolves.toMatchObject({
      serviceKey: record.serviceKey,
      processGroupId: spawned.identity.processGroupId,
    });
    expect(isProcessGroupAlive(spawned.identity.processGroupId)).toBe(true);
  });

  it("strict adoption preserves evidence for a live process group whose registered leader exited", async () => {
    const spawned = await spawnLeaderWithSurvivingGroupChild();
    const record = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(record);

    await expect(findAdoptableLocalServiceStrict({
      serviceKey: record.serviceKey,
      profileKind: record.profileKind,
      serviceName: record.serviceName,
      command: record.command,
      cwd: record.cwd,
      envFingerprint: record.envFingerprint,
      port: record.port,
    })).rejects.toThrow(/leader.*not running.*process group.*alive/i);
    await expect(readLocalServiceRegistryRecord(record.serviceKey)).resolves.toMatchObject({
      serviceKey: record.serviceKey,
      processGroupId: spawned.identity.processGroupId,
    });
    expect(isProcessGroupAlive(spawned.identity.processGroupId)).toBe(true);
  });

  it("removes dead-leader registry evidence only after the process group is also absent", async () => {
    const spawned = await spawnLeaderWithSurvivingGroupChild();
    const lookupRecord = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    const adoptionRecord = registryRecord({ runtimeServiceId: randomUUID(), ...spawned });
    await writeLocalServiceRegistryRecord(lookupRecord);
    process.kill(-spawned.identity.processGroupId, "SIGKILL");
    for (let attempt = 0; attempt < 100 && isProcessGroupAlive(spawned.identity.processGroupId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(isProcessGroupAlive(spawned.identity.processGroupId)).toBe(false);

    await expect(findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: lookupRecord.runtimeServiceId!,
      profileKind: "workspace-runtime",
    })).resolves.toBeNull();
    await writeLocalServiceRegistryRecord(adoptionRecord);
    await expect(findAdoptableLocalServiceStrict({
      serviceKey: adoptionRecord.serviceKey,
      profileKind: adoptionRecord.profileKind,
      serviceName: adoptionRecord.serviceName,
      command: adoptionRecord.command,
      cwd: adoptionRecord.cwd,
      envFingerprint: adoptionRecord.envFingerprint,
      port: adoptionRecord.port,
    })).resolves.toBeNull();
    await expect(readLocalServiceRegistryRecord(lookupRecord.serviceKey)).resolves.toBeNull();
    await expect(readLocalServiceRegistryRecord(adoptionRecord.serviceKey)).resolves.toBeNull();
  });
});

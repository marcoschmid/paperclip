import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentConfigRevisions,
  activityLog,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRunEvents,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service secret binding sync", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function containsPlaintext(value: unknown, plaintexts: string[]): boolean {
    const serialized = JSON.stringify(value);
    return plaintexts.some((plaintext) => serialized.includes(plaintext));
  }

  it("creates agent secret bindings when a new agent persists secret_ref env", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `anthropic-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-ant-123",
    });

    const created = await agentService(db).create(companyId, {
      name: "Claude Novita",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
    });
  });

  it("binds and resolves a company-scoped Stitch secret and follows latest rotations without rewriting agent config", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const firstValue = `FAKE_STITCH_TEST_VALUE_DO_NOT_USE_${randomUUID()}`;
    const rotatedValue = `FAKE_STITCH_ROTATED_TEST_VALUE_DO_NOT_USE_${randomUUID()}`;
    const secret = await secrets.create(companyId, {
      name: `stitch-${randomUUID()}`,
      provider: "local_encrypted",
      value: firstValue,
    });

    const service = agentService(db);
    const created = await service.create(companyId, {
      name: "Stitch Codex",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          STITCH_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedBeforeRotation = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id))
      .then((rows) => rows[0]);
    const persistedConfigBeforeRotation = persistedBeforeRotation?.adapterConfig as Record<string, unknown>;
    expect(containsPlaintext(persistedBeforeRotation, [firstValue, rotatedValue])).toBe(false);
    const persistedBindingBeforeRotation = (
      persistedConfigBeforeRotation.env as Record<string, unknown>
    ).STITCH_API_KEY;
    expect(persistedBindingBeforeRotation).toEqual({
      type: "secret_ref",
      secretId: secret.id,
      version: "latest",
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.STITCH_API_KEY",
      versionSelector: "latest",
      required: true,
    });

    const firstResolution = await secrets.resolveAdapterConfigForRuntime(
      companyId,
      persistedConfigBeforeRotation,
      { consumerType: "agent", consumerId: created.id },
      { adapterType: "codex_local" },
    );
    const firstResolvedEnv = firstResolution.config.env as Record<string, string>;
    expect(digest(firstResolvedEnv.STITCH_API_KEY ?? "")).toBe(digest(firstValue));

    await service.update(
      created.id,
      { title: "Stitch-enabled Codex" },
      { recordRevision: { source: "patch" } },
    );
    await secrets.rotate(secret.id, { value: rotatedValue });

    const persistedAfterRotation = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id))
      .then((rows) => rows[0]);
    expect(containsPlaintext(persistedAfterRotation, [firstValue, rotatedValue])).toBe(false);
    expect(digest(JSON.stringify(persistedAfterRotation?.adapterConfig)))
      .toBe(digest(JSON.stringify(persistedConfigBeforeRotation)));

    const rotatedResolution = await secrets.resolveAdapterConfigForRuntime(
      companyId,
      persistedAfterRotation?.adapterConfig as Record<string, unknown>,
      { consumerType: "agent", consumerId: created.id },
      { adapterType: "codex_local" },
    );
    const rotatedResolvedEnv = rotatedResolution.config.env as Record<string, string>;
    expect(digest(rotatedResolvedEnv.STITCH_API_KEY ?? "")).toBe(digest(rotatedValue));
    expect(digest(rotatedResolvedEnv.STITCH_API_KEY ?? "")).not.toBe(digest(firstValue));

    const [revisions, secretRows, versionRows, accessEvents, activityRows, heartbeatEvents] = await Promise.all([
      db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, created.id)),
      db.select().from(companySecrets).where(eq(companySecrets.id, secret.id)),
      db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id)),
      db
        .select()
        .from(secretAccessEvents)
        .where(eq(secretAccessEvents.secretId, secret.id))
        .orderBy(secretAccessEvents.version),
      db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId)),
    ]);
    expect(containsPlaintext(
      {
        persistedAfterRotation,
        revisions,
        secretRows,
        versionRows,
        bindings,
        accessEvents,
        activityRows,
        heartbeatEvents,
      },
      [firstValue, rotatedValue],
    )).toBe(false);
    expect(revisions).toHaveLength(1);
    expect(versionRows).toHaveLength(2);
    expect(accessEvents).toHaveLength(2);
    expect(accessEvents.map((event) => ({
      version: event.version,
      consumerType: event.consumerType,
      consumerId: event.consumerId,
      configPath: event.configPath,
      outcome: event.outcome,
    }))).toEqual([
      {
        version: 1,
        consumerType: "agent",
        consumerId: created.id,
        configPath: "env.STITCH_API_KEY",
        outcome: "success",
      },
      {
        version: 2,
        consumerType: "agent",
        consumerId: created.id,
        configPath: "env.STITCH_API_KEY",
        outcome: "success",
      },
    ]);
    expect(activityRows).toHaveLength(0);
    expect(heartbeatEvents).toHaveLength(0);
  });

  it("rejects a Stitch secret reference owned by another company", async () => {
    const owningCompanyId = await seedCompany();
    const consumingCompanyId = await seedCompany();
    const crossCompanyValue = `FAKE_CROSS_COMPANY_STITCH_VALUE_DO_NOT_USE_${randomUUID()}`;
    const secret = await secretService(db).create(owningCompanyId, {
      name: `stitch-cross-company-${randomUUID()}`,
      provider: "local_encrypted",
      value: crossCompanyValue,
    });

    let rejectionStatus: number | null = null;
    let rejectionMessage = "";
    try {
      await agentService(db).create(consumingCompanyId, {
        name: "Cross-company Stitch Codex",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            STITCH_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
    } catch (error) {
      const rejection = error as { status?: unknown; message?: unknown };
      rejectionStatus = typeof rejection.status === "number" ? rejection.status : null;
      rejectionMessage = typeof rejection.message === "string" ? rejection.message : "";
    }
    expect(rejectionMessage.includes(crossCompanyValue)).toBe(false);
    expect(rejectionStatus === 422).toBe(true);
    expect(rejectionMessage === "Secret must belong to same company").toBe(true);

    const consumingCompanyAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, consumingCompanyId));
    const consumingCompanyBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.companyId, consumingCompanyId));
    expect(consumingCompanyAgents).toHaveLength(0);
    expect(consumingCompanyBindings).toHaveLength(0);
  });

  it("converts Hermes gateway apiKey strings into persisted secret refs", async () => {
    const companyId = await seedCompany();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    const created = await agentService(db).create(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    const persistedConfig = persistedRows[0]?.adapterConfig as Record<string, unknown>;
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
    expect(persistedConfig.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const secretId = (persistedConfig.apiKey as { secretId: string }).secretId;
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId,
      configPath: "apiKey",
      versionSelector: "latest",
      required: true,
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      persistedConfig,
      {
        consumerType: "agent",
        consumerId: created.id,
      },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe(literalApiKey);
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
  });

  it("replaces agent secret bindings when adapterConfig env changes", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const oldSecret = await secrets.create(companyId, {
      name: `old-${randomUUID()}`,
      provider: "local_encrypted",
      value: "old-value",
    });
    const nextSecret = await secrets.create(companyId, {
      name: `next-${randomUUID()}`,
      provider: "local_encrypted",
      value: "next-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Binding Swapper",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
        },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: nextSecret.id,
      configPath: "env.NEW_KEY",
    });
  });

  it("backfills missing secret bindings when a legacy pending agent is approved", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `legacy-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-value",
    });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const beforeBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(beforeBindings).toHaveLength(0);

    const approved = await agentService(db).activatePendingApproval(agentId);

    expect(approved).toMatchObject({
      activated: true,
      agent: {
        id: agentId,
        status: "idle",
      },
    });

    const afterBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));

    expect(afterBindings).toHaveLength(1);
    expect(afterBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
    });
  });

  it("rolls back create when binding sync fails", async () => {
    const companyId = await seedCompany();
    const missingSecretId = randomUUID();

    await expect(
      agentService(db).create(companyId, {
        name: "Broken Create",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: missingSecretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toBeTruthy();

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rolls back adapterConfig updates when binding sync fails", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const validSecret = await secrets.create(companyId, {
      name: `valid-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-value",
    });
    const created = await agentService(db).create(companyId, {
      name: "Transactional Update",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: {
          env: {
            API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
          },
        },
      }),
    ).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.secretId).toBe(validSecret.id);
  });

  it("keeps pending approval status when activation binding sync fails", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).activatePendingApproval(agentId)).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(agentId);
    expect(reloaded?.status).toBe("pending_approval");
  });
});

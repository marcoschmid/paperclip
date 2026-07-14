import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentAdapterSecretExternalizationService } from "../services/agent-adapter-secret-externalization.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent adapter secret externalization tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("OpenClaw gateway adapter secret externalization", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-gateway-externalization-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    writeFileSync(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, randomBytes(32).toString("base64"), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, 0o600);
    const started = await startEmbeddedPostgresTestDatabase("gateway-secret-externalization");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
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

  async function seedLegacyGateway(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const updatedAt = new Date("2026-07-13T08:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Gateway Test",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy OpenClaw Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
      updatedAt,
    });
    return { agentId, companyId, updatedAt };
  }

  function digest(value: unknown): string {
    return createHash("sha256").update(String(value ?? "")).digest("hex");
  }

  function containsAny(value: unknown, candidates: string[]): boolean {
    const serialized = JSON.stringify(value);
    return candidates.some((candidate) => serialized.includes(candidate));
  }

  async function externalizationRequest(
    service: ReturnType<typeof agentAdapterSecretExternalizationService>,
    seeded: { agentId: string; companyId: string },
  ) {
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    return {
      schemaVersion: "1.0.0" as const,
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway" as const,
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    };
  }

  it("keeps historical tombstone adapter config and secret stores unchanged", async () => {
    const companyId = randomUUID();
    const updatedAt = new Date("2026-07-13T08:00:00.000Z");
    const adapterConfig = { url: "ws://127.0.0.1:18789", token: "must-not-move" };
    await db.insert(companies).values({
      id: companyId,
      name: "Historical Gateway Test",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: HISTORICAL_TOMBSTONE_ID,
      companyId,
      name: "Historical OpenClaw Gateway",
      role: "engineer",
      status: "terminated",
      adapterType: "openclaw_gateway",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
      updatedAt,
    });
    const service = agentAdapterSecretExternalizationService(db);
    const request = await externalizationRequest(service, {
      agentId: HISTORICAL_TOMBSTONE_ID,
      companyId,
    });

    await expect(service.externalize(HISTORICAL_TOMBSTONE_ID, request, { userId: "board-user" }))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "historical_agent_tombstone_immutable",
          agentId: HISTORICAL_TOMBSTONE_ID,
        },
      });

    const persisted = await db
      .select({ adapterConfig: agents.adapterConfig, updatedAt: agents.updatedAt })
      .from(agents)
      .where(eq(agents.id, HISTORICAL_TOMBSTONE_ID))
      .then((rows) => rows[0]);
    expect(persisted).toEqual({ adapterConfig, updatedAt });
    await expect(db.select().from(companySecrets)).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretVersions)).resolves.toHaveLength(0);
    await expect(db.select().from(companySecretBindings)).resolves.toHaveLength(0);
  });

  it("rejects generic terminated and pending agents under the locked lifecycle recheck", async () => {
    for (const status of ["terminated", "pending_approval"] as const) {
      const seeded = await seedLegacyGateway({ authToken: `${status}-${randomUUID()}` });
      const service = agentAdapterSecretExternalizationService(db);
      const request = await externalizationRequest(service, seeded);
      await db.update(agents).set({ status }).where(eq(agents.id, seeded.agentId));

      await expect(service.externalize(seeded.agentId.toUpperCase(), request, { userId: "board-user" }))
        .rejects.toMatchObject({
          status: 409,
          details: {
            code: "agent_lifecycle_reference_forbidden",
          },
        });
      await expect(db.select().from(companySecrets).where(eq(companySecrets.companyId, seeded.companyId)))
        .resolves.toHaveLength(0);
      await expect(db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, seeded.agentId)))
        .resolves.toHaveLength(0);
    }
  });

  it("atomically migrates legacy sensitive headers and OpenClaw secret literals to local-encrypted refs", async () => {
    const token = `gateway-token-${randomUUID()}`;
    const password = `gateway-password-${randomUUID()}`;
    const deviceKey = `gateway-device-key-${randomUUID()}`;
    const seeded = await seedLegacyGateway({
      url: "ws://127.0.0.1:18789",
      headers: {
        "X-OpenClaw-Token": token,
        "X-Trace-Id": "safe-trace-id",
      },
      password,
      devicePrivateKeyPem: { type: "plain", value: deviceKey },
    });

    const service = agentAdapterSecretExternalizationService(db);
    const result = await service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    );

    expect(Object.keys(result).sort()).toEqual([
      "agentId",
      "companyId",
      "configFingerprint",
      "createdSecretCount",
      "createdSecretIds",
      "preflightReceipt",
      "proof",
      "removedHeaderCount",
      "removedHeaderPaths",
      "schemaVersion",
      "secretIds",
      "secretRefCount",
      "secretRefPaths",
      "updatedAt",
    ]);
    expect(result).toMatchObject({
      schemaVersion: "1.0.0",
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      createdSecretCount: 3,
      removedHeaderCount: 1,
      removedHeaderPaths: ["headers.x-openclaw-token"],
      secretRefCount: 3,
      secretRefPaths: ["authToken", "devicePrivateKeyPem", "password"],
    });
    expect(result.createdSecretIds).toHaveLength(3);
    expect(result.secretIds).toHaveLength(3);
    expect(containsAny(result, [token, password, deviceKey])).toBe(false);

    const [persistedAgent, secretRows, versionRows, bindings] = await Promise.all([
      db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]),
      db.select().from(companySecrets).where(eq(companySecrets.companyId, seeded.companyId)),
      db.select().from(companySecretVersions),
      db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, seeded.agentId)),
    ]);
    expect(containsAny({ persistedAgent, secretRows, versionRows, bindings }, [token, password, deviceKey])).toBe(false);
    expect(secretRows).toHaveLength(3);
    expect(versionRows).toHaveLength(3);
    expect(bindings).toHaveLength(3);

    const persistedConfig = persistedAgent.adapterConfig as Record<string, unknown>;
    expect(persistedConfig.headers).toEqual({ "X-Trace-Id": "safe-trace-id" });
    for (const key of ["authToken", "password", "devicePrivateKeyPem"] as const) {
      expect(persistedConfig[key]).toMatchObject({ type: "secret_ref", version: "latest" });
    }

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      seeded.companyId,
      persistedConfig,
      { consumerType: "agent", consumerId: seeded.agentId },
      { adapterType: "openclaw_gateway" },
    );
    expect(digest(resolved.config.authToken)).toBe(digest(token));
    expect(digest(resolved.config.password)).toBe(digest(password));
    expect(digest(resolved.config.devicePrivateKeyPem)).toBe(digest(deviceKey));
  });

  it("is idempotent for an already externalized and header-clean gateway", async () => {
    const token = `gateway-token-${randomUUID()}`;
    const seeded = await seedLegacyGateway({ authToken: token, headers: { "X-Trace": "safe" } });
    const service = agentAdapterSecretExternalizationService(db);
    const first = await service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    );
    const second = await service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    );

    expect(second.createdSecretCount).toBe(0);
    expect(second.createdSecretIds).toEqual([]);
    expect(second.removedHeaderCount).toBe(0);
    expect(second.secretIds).toEqual(first.secretIds);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
  });

  it("fails closed without mutation when multiple sensitive header paths are present", async () => {
    const seeded = await seedLegacyGateway({
      headers: {
        "x-openclaw-token": `token-a-${randomUUID()}`,
        Authorization: `Bearer token-b-${randomUUID()}`,
      },
    });

    const service = agentAdapterSecretExternalizationService(db);
    await expect(service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    )).rejects.toMatchObject({ status: 409 });

    expect(await db.select().from(companySecrets)).toHaveLength(0);
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(persisted.updatedAt.toISOString()).toBe(seeded.updatedAt.toISOString());
  });

  it("fails closed without mutation when a sensitive header conflicts with top-level authToken", async () => {
    const seeded = await seedLegacyGateway({
      authToken: `top-level-${randomUUID()}`,
      headers: { "x-openclaw-auth": `header-${randomUUID()}` },
    });

    const service = agentAdapterSecretExternalizationService(db);
    await expect(service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    )).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("enforces exact structural agent CAS before creating any secret", async () => {
    const seeded = await seedLegacyGateway({ authToken: `stale-${randomUUID()}` });
    const service = agentAdapterSecretExternalizationService(db);
    const request = await externalizationRequest(service, seeded);
    request.expectedConfigFingerprint = `v1:hmac-sha256:${"0".repeat(64)}`;
    await expect(service.externalize(seeded.agentId, request, { userId: "board-user" }))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("rolls back prepared secret rows when later secret-ref validation fails", async () => {
    const seeded = await seedLegacyGateway({
      authToken: `rollback-${randomUUID()}`,
      password: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
    });

    const service = agentAdapterSecretExternalizationService(db);
    await expect(service.externalize(
      seeded.agentId,
      await externalizationRequest(service, seeded),
      { userId: "board-user" },
    )).rejects.toBeTruthy();

    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretVersions)).toHaveLength(0);
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(persisted.updatedAt.toISOString()).toBe(seeded.updatedAt.toISOString());
  });

  it("does not use millisecond timestamp equality for a PostgreSQL microsecond row", async () => {
    const token = `microsecond-${randomUUID()}`;
    const seeded = await seedLegacyGateway({ authToken: token });
    await db.execute(sql`
      update ${agents}
      set updated_at = '2026-07-13T08:00:00.000999Z'::timestamptz
      where id = ${seeded.agentId}
    `);
    const service = agentAdapterSecretExternalizationService(db) as any;
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    await expect(service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    }, { userId: "board-user" })).resolves.toMatchObject({ agentId: seeded.agentId });
  });

  it("rejects a same-millisecond structural config race by fingerprint under the row lock", async () => {
    const seeded = await seedLegacyGateway({ authToken: `before-${randomUUID()}` });
    const service = agentAdapterSecretExternalizationService(db) as any;
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    await db.update(agents).set({
      adapterConfig: { authToken: `after-${randomUUID()}` },
      updatedAt: seeded.updatedAt,
    }).where(eq(agents.id, seeded.agentId));

    await expect(service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    }, { userId: "board-user" })).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_adapter_secret_cas_mismatch" },
    });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("rechecks the board-authorized company inside the row-locked transaction", async () => {
    const seeded = await seedLegacyGateway({ authToken: `company-race-${randomUUID()}` });
    const service = agentAdapterSecretExternalizationService(db);
    const request = await externalizationRequest(service, seeded);
    const movedCompanyId = randomUUID();
    await db.insert(companies).values({
      id: movedCompanyId,
      name: "Moved Gateway Company",
      issuePrefix: `M${movedCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.update(agents).set({
      companyId: movedCompanyId,
      updatedAt: seeded.updatedAt,
    }).where(eq(agents.id, seeded.agentId));

    await expect(service.externalize(seeded.agentId, request, { userId: "board-user" }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "agent_adapter_secret_company_mismatch" },
      });
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("repairs a deleted secret binding on an idempotent retry and proves runtime resolution", async () => {
    const seeded = await seedLegacyGateway({ authToken: `binding-${randomUUID()}` });
    const service = agentAdapterSecretExternalizationService(db) as any;
    const firstPreflight = await service.preflight(seeded.agentId, seeded.companyId);
    await service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: firstPreflight.configFingerprint,
      expectedPreflightReceipt: firstPreflight.receipt,
    }, { userId: "board-user" });
    await db.delete(companySecretBindings).where(eq(companySecretBindings.targetId, seeded.agentId));

    const retryPreflight = await service.preflight(seeded.agentId, seeded.companyId);
    const result = await service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: retryPreflight.configFingerprint,
      expectedPreflightReceipt: retryPreflight.receipt,
    }, { userId: "board-user" });
    expect(await db.select().from(companySecretBindings)).toHaveLength(1);
    expect(result.proof).toMatchObject({
      provider: "local_encrypted",
      secretRefCount: 1,
      bindingCount: 1,
      runtimeResolvedCount: 1,
    });
  });

  it("externalizes legacy token and deviceToken literals instead of leaving runtime credentials in config", async () => {
    const token = `legacy-token-${randomUUID()}`;
    const deviceToken = `legacy-device-token-${randomUUID()}`;
    const seeded = await seedLegacyGateway({ token, deviceToken });
    const service = agentAdapterSecretExternalizationService(db) as any;
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    const result = await service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    }, { userId: "board-user" });
    expect(result.secretRefPaths).toEqual(["deviceToken", "token"]);
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect(containsAny(persisted.adapterConfig, [token, deviceToken])).toBe(false);
    expect((persisted.adapterConfig as any).token).toMatchObject({ type: "secret_ref" });
    expect((persisted.adapterConfig as any).deviceToken).toMatchObject({ type: "secret_ref" });
  });

  it("collapses duplicate sensitive headers only when their normalized token values are identical", async () => {
    const token = `same-token-${randomUUID()}`;
    const seeded = await seedLegacyGateway({
      headers: {
        "x-openclaw-token": token,
        Authorization: `Bearer ${token}`,
      },
    });
    const service = agentAdapterSecretExternalizationService(db) as any;
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    const result = await service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    }, { userId: "board-user" });
    expect(result.removedHeaderPaths).toEqual([
      "headers.authorization",
      "headers.x-openclaw-token",
    ]);
    expect(result.secretRefPaths).toEqual(["authToken"]);
  });

  it("returns and rereads a value-free exact postproof receipt", async () => {
    const token = `proof-token-${randomUUID()}`;
    const seeded = await seedLegacyGateway({ authToken: token });
    const service = agentAdapterSecretExternalizationService(db) as any;
    const preflight = await service.preflight(seeded.agentId, seeded.companyId);
    const result = await service.externalize(seeded.agentId, {
      schemaVersion: "1.0.0",
      expectedCompanyId: seeded.companyId,
      expectedAdapterType: "openclaw_gateway",
      expectedConfigFingerprint: preflight.configFingerprint,
      expectedPreflightReceipt: preflight.receipt,
    }, { userId: "board-user" });
    const reread = await service.proof(seeded.agentId, seeded.companyId, result.proof.receipt);
    expect(reread).toEqual(result.proof);
    expect(reread).toMatchObject({
      provider: "local_encrypted",
      secretRefCount: 1,
      bindingCount: 1,
      runtimeResolvedCount: 1,
    });
    expect(reread.receipt).toMatch(/^v1:hmac-sha256:[a-f0-9]{64}$/);
    expect(containsAny({ result, reread }, [token])).toBe(false);
  });
});

import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-token activity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("actorMiddleware agent API key activity logging", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-auth-agent-token-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentApiKey(token: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentApiKeys).values({
      id: keyId,
      agentId,
      companyId,
      name: "primary-key",
      keyHash: hashToken(token),
      responsibleUserId: randomUUID(),
    });

    return { companyId, agentId, keyId };
  }

  function buildApp() {
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    return app;
  }

  it("emits exactly one auth.agent_token_used activity event on a valid agent API key, without leaking the token", async () => {
    const token = `agent-token-${randomUUID()}`;
    const { companyId, agentId, keyId } = await seedAgentApiKey(token);

    const res = await request(buildApp())
      .get("/actor")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      keyId,
      source: "agent_key",
    });

    const repeated = await request(buildApp())
      .get("/actor")
      .set("authorization", `Bearer ${token}`);
    expect(repeated.status).toBe(200);

    const rows = await db.select().from(activityLog);
    const authEvents = rows.filter((row) => row.action === "auth.agent_token_used");

    expect(authEvents).toHaveLength(1);
    const event = authEvents[0]!;
    expect(event).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "auth.agent_token_used",
      entityType: "agent_api_key",
      entityId: keyId,
    });

    const detailsJson = JSON.stringify(event.details ?? {});
    expect(detailsJson).not.toContain(token);
    expect(detailsJson).not.toContain(hashToken(token));
    expect(event.details).toMatchObject({ keyName: "primary-key", source: "agent_key" });
  });

  it("does not emit an auth.agent_token_used event when no valid agent token is presented", async () => {
    const res = await request(buildApp())
      .get("/actor")
      .set("authorization", "Bearer not-a-real-token");

    // Upstream v2026.831 weist unbekannte Bearer-Tokens mit 401 ab statt anonym weiterzureichen.
    expect(res.status).toBe(401);

    const rows = await db.select().from(activityLog);
    const authEvents = rows.filter((row) => row.action === "auth.agent_token_used");
    expect(authEvents).toHaveLength(0);
  });

  it("rejects a fixed historical tombstone key without touching lastUsedAt", async () => {
    const token = `historical-agent-token-${randomUUID()}`;
    const companyId = randomUUID();
    const keyId = randomUUID();
    const lastUsedAt = new Date("2026-07-13T18:00:00.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Historical auth",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: HISTORICAL_TOMBSTONE_ID,
      companyId,
      name: "HistoricalTombstone",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: keyId,
      agentId: HISTORICAL_TOMBSTONE_ID,
      companyId,
      name: "historical-key",
      keyHash: hashToken(token),
      responsibleUserId: randomUUID(),
      lastUsedAt,
    });

    const res = await request(buildApp()).get("/actor").set("authorization", `Bearer ${token}`);

    // Upstream v2026.831 lehnt ungueltige Agent-Keys mit 401 ab; entscheidend bleibt,
    // dass weder lastUsedAt noch das Activity-Log beruehrt werden.
    expect(res.status).toBe(401);
    const persisted = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, keyId))
      .then((rows) => rows[0]);
    expect(persisted?.lastUsedAt).toEqual(lastUsedAt);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("validates API-key company ownership before touching lastUsedAt", async () => {
    const token = `cross-company-agent-token-${randomUUID()}`;
    const agentCompanyId = randomUUID();
    const keyCompanyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const lastUsedAt = new Date("2026-07-13T18:30:00.000Z");
    await db.insert(companies).values([
      {
        id: agentCompanyId,
        name: "Agent company",
        issuePrefix: `A${agentCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: keyCompanyId,
        name: "Key company",
        issuePrefix: `K${keyCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: agentCompanyId,
      name: "CrossCompanyAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: keyId,
      agentId,
      companyId: keyCompanyId,
      name: "forged-company-key",
      keyHash: hashToken(token),
      responsibleUserId: randomUUID(),
      lastUsedAt,
    });

    const res = await request(buildApp()).get("/actor").set("authorization", `Bearer ${token}`);

    // Upstream v2026.831 lehnt ungueltige Agent-Keys mit 401 ab; entscheidend bleibt,
    // dass weder lastUsedAt noch das Activity-Log beruehrt werden.
    expect(res.status).toBe(401);
    const persisted = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, keyId))
      .then((rows) => rows[0]);
    expect(persisted?.lastUsedAt).toEqual(lastUsedAt);
    expect(await db.select().from(activityLog)).toEqual([]);
  });
});

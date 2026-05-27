import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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

    // The raw token and the stored key hash must never appear in details.
    const detailsJson = JSON.stringify(event.details ?? {});
    expect(detailsJson).not.toContain(token);
    expect(detailsJson).not.toContain(hashToken(token));
    expect(event.details).toMatchObject({ keyName: "primary-key", source: "agent_key" });
  });

  it("does not emit an auth.agent_token_used event when no valid agent token is presented", async () => {
    const res = await request(buildApp())
      .get("/actor")
      .set("authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(200);

    const rows = await db.select().from(activityLog);
    const authEvents = rows.filter((row) => row.action === "auth.agent_token_used");
    expect(authEvents).toHaveLength(0);
  });
});

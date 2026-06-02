import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, projects, decisions, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { decisionService } from "./decisions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision service tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decisionService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisions);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Memory Co", issuePrefix: "MEM" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Jarvis OS" })
      .returning();
    return { companyId: company.id, projectId: project.id };
  }

  const baseInput = (projectId: string) => ({
    projectId,
    sourceProjectSlug: "jarvis-os-redesign",
    sourceKey: "adr-0001",
    sourceHash: "hash-1",
    title: "Use Paperclip as project-memory SoT",
    decision: "Store project decisions in Paperclip.",
  });

  it("creates a decision on first upsert", async () => {
    const { companyId, projectId } = await seed();
    const result = await decisionService(db).upsert(companyId, baseInput(projectId));

    expect(result.created).toBe(true);
    expect(result.decision.sourceKey).toBe("adr-0001");
    expect(result.decision.status).toBe("accepted");
  });

  it("updates in place on repeated upsert of the same source_key (no duplicate)", async () => {
    const { companyId, projectId } = await seed();
    const svc = decisionService(db);

    const first = await svc.upsert(companyId, baseInput(projectId));
    const second = await svc.upsert(companyId, {
      ...baseInput(projectId),
      sourceHash: "hash-2",
      title: "Updated title",
      status: "superseded",
    });

    expect(second.created).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.title).toBe("Updated title");
    expect(second.decision.status).toBe("superseded");

    const all = await svc.listByProject(companyId, projectId);
    expect(all).toHaveLength(1);
  });

  it("getByKey returns the decision and null when absent", async () => {
    const { companyId, projectId } = await seed();
    const svc = decisionService(db);
    await svc.upsert(companyId, baseInput(projectId));

    const found = await svc.getByKey(companyId, "adr-0001");
    expect(found?.sourceKey).toBe("adr-0001");
    expect(await svc.getByKey(companyId, "missing")).toBeNull();
  });

  it("listByProject scopes to the project", async () => {
    const { companyId, projectId } = await seed();
    const svc = decisionService(db);
    await svc.upsert(companyId, baseInput(projectId));
    await svc.upsert(companyId, { ...baseInput(projectId), sourceKey: "adr-0002", title: "Second" });

    const rows = await svc.listByProject(companyId, projectId);
    expect(rows.map((r) => r.sourceKey).sort()).toEqual(["adr-0001", "adr-0002"]);
  });
});

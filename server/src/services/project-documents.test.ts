import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, projects, documents, documentRevisions, projectDocuments, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { projectDocumentService } from "./project-documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project-document service tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectDocumentService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-document-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
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

  it("creates a document + first revision + link on first upsert", async () => {
    const { companyId, projectId } = await seed();
    const result = await projectDocumentService(db).upsert(companyId, {
      projectId,
      key: "project-memory",
      body: "# Memory v1",
      tags: ["memory"],
    });

    expect(result.created).toBe(true);
    expect(result.document.latestBody).toBe("# Memory v1");
    expect(result.document.latestRevisionNumber).toBe(1);
    expect(result.document.latestRevisionId).toBe(result.revision.id);
    expect(result.projectDocument.key).toBe("project-memory");
  });

  it("appends a revision to the same document on repeated upsert (no duplicate link)", async () => {
    const { companyId, projectId } = await seed();
    const svc = projectDocumentService(db);

    const first = await svc.upsert(companyId, { projectId, key: "project-memory", body: "# v1" });
    const second = await svc.upsert(companyId, {
      projectId,
      key: "project-memory",
      body: "# v2",
      changeSummary: "second pass",
    });

    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.latestBody).toBe("# v2");
    expect(second.document.latestRevisionNumber).toBe(2);

    const links = await db
      .select()
      .from(projectDocuments)
      .where(eq(projectDocuments.companyId, companyId));
    expect(links).toHaveLength(1);

    const revs = await db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, first.document.id));
    expect(revs).toHaveLength(2);
  });

  it("getByKey returns the current body and null when absent", async () => {
    const { companyId, projectId } = await seed();
    const svc = projectDocumentService(db);
    await svc.upsert(companyId, { projectId, key: "project-memory", body: "# body" });

    const found = await svc.getByKey(companyId, projectId, "project-memory");
    expect(found?.body).toBe("# body");
    expect(await svc.getByKey(companyId, projectId, "missing")).toBeNull();
  });

  it("list scopes to the project", async () => {
    const { companyId, projectId } = await seed();
    const svc = projectDocumentService(db);
    await svc.upsert(companyId, { projectId, key: "project-memory", body: "a" });
    await svc.upsert(companyId, { projectId, key: "decision-index", body: "b" });

    const rows = await svc.list(companyId, projectId);
    expect(rows.map((r) => r.key).sort()).toEqual(["decision-index", "project-memory"]);
  });
});

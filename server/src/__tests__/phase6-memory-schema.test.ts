import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, projects, documents, decisions, projectDocuments, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Slice 0 verification: migration 0090_phase6_memory_tables creates the
// project-memory tables (decisions, project_documents) and documents
// tags/metadata columns on a fresh database, and the Drizzle schema matches.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres phase6 memory schema tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("phase6 memory schema (migration 0090)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-phase6-memory-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(decisions);
    await db.delete(projectDocuments);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyProject() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Memory Co", issuePrefix: "MEM" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Jarvis OS" })
      .returning();
    return { company, project };
  }

  it("creates a decision row with DB defaults and enforces the source_key unique index", async () => {
    const { company, project } = await seedCompanyProject();

    const [decision] = await db
      .insert(decisions)
      .values({
        companyId: company.id,
        projectId: project.id,
        sourceProjectSlug: "jarvis-os-redesign",
        sourceKey: "adr-0001",
        sourceHash: "hash-1",
        title: "Use Paperclip as project-memory SoT",
        decision: "Store project decisions in Paperclip.",
      })
      .returning();

    expect(decision.id).toBeTruthy();
    expect(decision.status).toBe("accepted");
    expect(decision.metadata).toEqual({});

    // Same (company_id, source_key) must be rejected by the unique index.
    await expect(
      db.insert(decisions).values({
        companyId: company.id,
        projectId: project.id,
        sourceProjectSlug: "jarvis-os-redesign",
        sourceKey: "adr-0001",
        sourceHash: "hash-2",
        title: "duplicate",
        decision: "duplicate",
      }),
    ).rejects.toThrow();
  });

  it("creates a project_document and the documents tags/metadata columns default correctly", async () => {
    const { company, project } = await seedCompanyProject();

    const [document] = await db
      .insert(documents)
      .values({ companyId: company.id, latestBody: "# Project Memory" })
      .returning();

    expect(document.tags).toEqual([]);
    expect(document.metadata).toEqual({});

    const [link] = await db
      .insert(projectDocuments)
      .values({
        companyId: company.id,
        projectId: project.id,
        documentId: document.id,
        key: "project-memory",
      })
      .returning();

    expect(link.id).toBeTruthy();
    expect(link.key).toBe("project-memory");
  });
});

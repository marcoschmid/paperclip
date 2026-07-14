import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  goals,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project/goal assignability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("project and goal agent assignability", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-goal-assignability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string, id = randomUUID(), status = "idle") {
    await db.insert(agents).values({
      id,
      companyId,
      name: id === HISTORICAL_TOMBSTONE_ID ? "HistoricalTombstone" : `Agent ${id.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function raceTerminationAgainstActiveReferenceWrite(
    agentId: string,
    writer: () => Promise<unknown>,
  ) {
    const blockerDb = createDb(tempDb!.connectionString);
    const observerDb = createDb(tempDb!.connectionString);
    let releaseBlocker!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let reportLocked!: () => void;
    const lockedGate = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const blocker = blockerDb.transaction(async (tx) => {
      await tx.execute(sql`select id from agents where id = ${agentId} for update`);
      reportLocked();
      await releaseGate;
      await tx.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
    });

    try {
      await lockedGate;
      let writerSettled = false;
      const outcomePromise = writer()
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        )
        .finally(() => {
          writerSettled = true;
        });

      let observedBlockedLock = false;
      for (let attempt = 0; attempt < 200 && !writerSettled; attempt += 1) {
        const [row] = await observerDb.execute<{ blocked: boolean }>(sql`
          select exists(select 1 from pg_locks where granted = false) as blocked
        `);
        if (row?.blocked) {
          observedBlockedLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlockedLock).toBe(true);
      releaseBlocker();
      await blocker;
      const outcome = await outcomePromise;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toMatchObject({
          status: 409,
          details: { code: "agent_lifecycle_reference_forbidden", reason: "terminated" },
        });
      }
    } finally {
      releaseBlocker();
      await blocker.catch(() => undefined);
      await blockerDb.$client.end();
      await observerDb.$client.end();
    }
  }

  it("rejects an active project led by a historical tombstone before inserting it", async () => {
    const companyId = await seedCompany("Project tombstone create");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");

    await expect(projectService(db).create(companyId, {
      name: "Must not exist",
      status: "in_progress",
      leadAgentId: HISTORICAL_TOMBSTONE_ID,
      archivedAt: null,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });

    expect(await db.select().from(projects)).toEqual([]);
  });

  it("serializes active project-lead creation against concurrent termination", async () => {
    const companyId = await seedCompany("Project lifecycle race");
    const agentId = await seedAgent(companyId);

    await raceTerminationAgainstActiveReferenceWrite(agentId, () => projectService(db).create(companyId, {
      name: "Must lose termination race",
      status: "in_progress",
      leadAgentId: agentId,
      archivedAt: null,
    }));

    expect(await db.select().from(projects)).toEqual([]);
  }, 15_000);

  it("rejects a cross-company lead on active project update without changing the row", async () => {
    const companyId = await seedCompany("Project owner company");
    const otherCompanyId = await seedCompany("Project foreign company");
    const foreignAgentId = await seedAgent(otherCompanyId);
    const projectId = randomUUID();
    const updatedAt = new Date("2026-07-14T01:00:00.000Z");
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Original project",
      status: "in_progress",
      leadAgentId: null,
      archivedAt: null,
      updatedAt,
    });
    const before = await db.select().from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0]);

    await expect(projectService(db).update(projectId, {
      name: "Rejected rename",
      leadAgentId: foreignAgentId,
    })).rejects.toMatchObject({ status: 422 });

    const after = await db.select().from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0]);
    expect(after).toEqual(before);
  });

  it("loads the current lead and rejects unarchiving a tombstone-led project without changing it", async () => {
    const companyId = await seedCompany("Project unarchive");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");
    const projectId = randomUUID();
    const archivedAt = new Date("2026-07-13T20:00:00.000Z");
    const updatedAt = new Date("2026-07-13T20:01:00.000Z");
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Historical project",
      status: "completed",
      leadAgentId: HISTORICAL_TOMBSTONE_ID,
      archivedAt,
      updatedAt,
    });
    const before = await db.select().from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0]);

    await expect(projectService(db).update(projectId, {
      archivedAt: null,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });

    const after = await db.select().from(projects).where(eq(projects.id, projectId)).then((rows) => rows[0]);
    expect(after).toEqual(before);
  });

  it("preserves a historical lead while its project remains archived", async () => {
    const companyId = await seedCompany("Archived project history");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Historical project",
      status: "completed",
      leadAgentId: HISTORICAL_TOMBSTONE_ID,
      archivedAt: new Date("2026-07-13T20:00:00.000Z"),
    });

    const updated = await projectService(db).update(projectId, { description: "Preserved history" });

    expect(updated).toMatchObject({
      id: projectId,
      leadAgentId: HISTORICAL_TOMBSTONE_ID,
      description: "Preserved history",
    });
  });

  it("rejects a planned goal owned by a historical tombstone before inserting it", async () => {
    const companyId = await seedCompany("Goal tombstone create");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");

    await expect(goalService(db).create(companyId, {
      title: "Must not exist",
      level: "company",
      status: "planned",
      ownerAgentId: HISTORICAL_TOMBSTONE_ID,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });

    expect(await db.select().from(goals)).toEqual([]);
  });

  it("serializes operative goal-owner creation against concurrent termination", async () => {
    const companyId = await seedCompany("Goal lifecycle race");
    const agentId = await seedAgent(companyId);

    await raceTerminationAgainstActiveReferenceWrite(agentId, () => goalService(db).create(companyId, {
      title: "Must lose termination race",
      level: "company",
      status: "planned",
      ownerAgentId: agentId,
    }));

    expect(await db.select().from(goals)).toEqual([]);
  }, 15_000);

  it("loads current goal state and rejects a cross-company owner without changing the row", async () => {
    const companyId = await seedCompany("Goal owner company");
    const otherCompanyId = await seedCompany("Goal foreign company");
    const foreignAgentId = await seedAgent(otherCompanyId);
    const goalId = randomUUID();
    const updatedAt = new Date("2026-07-14T01:10:00.000Z");
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Original goal",
      level: "company",
      status: "active",
      ownerAgentId: foreignAgentId,
      updatedAt,
    });
    const before = await db.select().from(goals).where(eq(goals.id, goalId)).then((rows) => rows[0]);

    await expect(goalService(db).update(goalId, {
      description: "Rejected mutation",
    })).rejects.toMatchObject({ status: 422 });

    const after = await db.select().from(goals).where(eq(goals.id, goalId)).then((rows) => rows[0]);
    expect(after).toEqual(before);
  });

  it("loads the current owner and rejects reactivating a tombstone-owned goal without changing it", async () => {
    const companyId = await seedCompany("Goal reactivation");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");
    const goalId = randomUUID();
    const updatedAt = new Date("2026-07-14T01:20:00.000Z");
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Historical goal",
      level: "company",
      status: "achieved",
      ownerAgentId: HISTORICAL_TOMBSTONE_ID,
      updatedAt,
    });
    const before = await db.select().from(goals).where(eq(goals.id, goalId)).then((rows) => rows[0]);

    await expect(goalService(db).update(goalId, { status: "active" })).rejects.toMatchObject({
      status: 409,
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });

    const after = await db.select().from(goals).where(eq(goals.id, goalId)).then((rows) => rows[0]);
    expect(after).toEqual(before);
  });

  it("preserves historical ownership while a goal remains terminal", async () => {
    const companyId = await seedCompany("Terminal goal history");
    await seedAgent(companyId, HISTORICAL_TOMBSTONE_ID, "terminated");
    const goalId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Historical goal",
      level: "company",
      status: "achieved",
      ownerAgentId: HISTORICAL_TOMBSTONE_ID,
    });

    const updated = await goalService(db).update(goalId, { description: "Preserved history" });

    expect(updated).toMatchObject({
      id: goalId,
      ownerAgentId: HISTORICAL_TOMBSTONE_ID,
      status: "achieved",
      description: "Preserved history",
    });
  });
});

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, issues } from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("approval requester integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-requester-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(activityLog);
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
      issuePrefix: `A${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function raceTerminationAgainstApprovalWrite(
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

      releaseBlocker();
      await blocker;
      const outcome = await outcomePromise;
      expect(observedBlockedLock).toBe(true);
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

  function agentRow(companyId: string, id: string, status: string) {
    return {
      id,
      companyId,
      name: `Requester ${id.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  function approvalInput(requestedByAgentId: string, status: string) {
    return {
      type: "request_board_approval",
      requestedByAgentId,
      requestedByUserId: null,
      status,
      payload: { title: "Requester integrity" },
    };
  }

  function hireApprovalInput(payload: Record<string, unknown>, status = "pending") {
    return {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status,
      payload,
    };
  }

  it("rejects an open approval attributed to a historical tombstone before insert", async () => {
    const companyId = await seedCompany("Historical requester");
    await db.insert(agents).values(agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "terminated"));

    await expect(approvalService(db).create(
      companyId,
      approvalInput(HISTORICAL_TOMBSTONE_ID, "pending"),
    )).rejects.toMatchObject({
      status: 409,
      details: {
        code: "historical_agent_tombstone_active_reference_forbidden",
        agentId: HISTORICAL_TOMBSTONE_ID,
      },
    });
    await expect(db.select().from(approvals)).resolves.toHaveLength(0);
  });

  it("rejects open approval attribution to terminated or cross-company agents before insert", async () => {
    const companyId = await seedCompany("Approval company");
    const otherCompanyId = await seedCompany("Other company");
    const terminatedAgentId = randomUUID();
    const crossCompanyAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, terminatedAgentId, "terminated"),
      agentRow(otherCompanyId, crossCompanyAgentId, "idle"),
    ]);

    await expect(approvalService(db).create(
      companyId,
      approvalInput(terminatedAgentId, "pending"),
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_not_assignable", reason: "assignee_terminated" },
    });
    await expect(approvalService(db).create(
      companyId,
      approvalInput(crossCompanyAgentId, "revision_requested"),
    )).rejects.toMatchObject({ status: 422 });
    await expect(db.select().from(approvals)).resolves.toHaveLength(0);
  });

  it("preserves terminal imported approval history attributed to a tombstone", async () => {
    const companyId = await seedCompany("Historical import");
    await db.insert(agents).values(agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "terminated"));

    const created = await approvalService(db).create(
      companyId,
      approvalInput(HISTORICAL_TOMBSTONE_ID, "approved"),
    );

    expect(created).toMatchObject({
      companyId,
      requestedByAgentId: HISTORICAL_TOMBSTONE_ID,
      status: "approved",
    });
    await expect(db.select().from(approvals)).resolves.toHaveLength(1);
  });

  it("validates hire payload agentId and reportsTo before create", async () => {
    const companyId = await seedCompany("Hire payload company");
    const otherCompanyId = await seedCompany("Other hire company");
    const validManagerId = randomUUID();
    const crossCompanyPendingId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "pending_approval"),
      agentRow(companyId, validManagerId, "idle"),
      agentRow(otherCompanyId, crossCompanyPendingId, "pending_approval"),
    ]);
    const svc = approvalService(db);

    await expect(svc.create(companyId, hireApprovalInput({
      agentId: HISTORICAL_TOMBSTONE_ID.toUpperCase(),
      reportsTo: validManagerId,
    }))).rejects.toMatchObject({
      status: 409,
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });
    await expect(svc.create(companyId, hireApprovalInput({
      name: "New hire",
      reportsTo: HISTORICAL_TOMBSTONE_ID,
    }))).rejects.toMatchObject({
      status: 409,
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });
    await expect(svc.create(companyId, hireApprovalInput({
      agentId: crossCompanyPendingId,
      reportsTo: validManagerId,
    }))).rejects.toMatchObject({ status: 422 });
    await expect(db.select().from(approvals)).resolves.toHaveLength(0);
  });

  it("serializes open approval creation against concurrent requester termination", async () => {
    const companyId = await seedCompany("Requester create race");
    const requesterAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, requesterAgentId, "idle"));

    await raceTerminationAgainstApprovalWrite(
      requesterAgentId,
      () => approvalService(db).create(companyId, approvalInput(requesterAgentId, "pending")),
    );

    await expect(db.select().from(approvals)).resolves.toHaveLength(0);
  }, 15_000);

  it("serializes hire approval creation against concurrent reportsTo termination", async () => {
    const companyId = await seedCompany("Hire manager create race");
    const pendingAgentId = randomUUID();
    const reportsToAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, pendingAgentId, "pending_approval"),
      agentRow(companyId, reportsToAgentId, "idle"),
    ]);

    await raceTerminationAgainstApprovalWrite(
      reportsToAgentId,
      () => approvalService(db).create(companyId, hireApprovalInput({
        agentId: pendingAgentId,
        reportsTo: reportsToAgentId,
      })),
    );

    await expect(db.select().from(approvals)).resolves.toHaveLength(0);
  }, 15_000);

  it("serializes hire approval resubmission against concurrent candidate termination", async () => {
    const companyId = await seedCompany("Hire candidate resubmit race");
    const pendingAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, pendingAgentId, "pending_approval"));
    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({ agentId: pendingAgentId }, "revision_requested"),
      decisionNote: "Revise candidate",
      decidedByUserId: "board-user",
      decidedAt: new Date(),
    }).returning();

    await raceTerminationAgainstApprovalWrite(
      pendingAgentId,
      () => approvalService(db).resubmit(approval!.id, { agentId: pendingAgentId }),
    );

    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0])
      .toEqual(approval);
  }, 15_000);

  it("keeps create and resubmit company-scoped for every hire-agent reference", async () => {
    const companyId = await seedCompany("Hire reference tenant");
    const otherCompanyId = await seedCompany("Foreign hire reference tenant");
    const pendingAgentId = randomUUID();
    const localManagerId = randomUUID();
    const foreignPendingAgentId = randomUUID();
    const foreignManagerId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, pendingAgentId, "pending_approval"),
      agentRow(companyId, localManagerId, "idle"),
      agentRow(otherCompanyId, foreignPendingAgentId, "pending_approval"),
      agentRow(otherCompanyId, foreignManagerId, "idle"),
    ]);
    const svc = approvalService(db);

    await expect(svc.create(companyId, hireApprovalInput({
      agentId: pendingAgentId,
      reportsTo: foreignManagerId,
    }))).rejects.toMatchObject({ status: 422 });
    await expect(db.select().from(approvals)).resolves.toHaveLength(0);

    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({
        agentId: pendingAgentId,
        reportsTo: localManagerId,
      }, "revision_requested"),
      decisionNote: "Revise candidate",
      decidedByUserId: "board-user",
      decidedAt: new Date(),
    }).returning();

    await expect(svc.resubmit(approval!.id, {
      agentId: foreignPendingAgentId,
      reportsTo: localManagerId,
    })).rejects.toMatchObject({ status: 422 });
    await expect(svc.resubmit(approval!.id, {
      agentId: pendingAgentId,
      reportsTo: foreignManagerId,
    })).rejects.toMatchObject({ status: 422 });
    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0])
      .toEqual(approval);
  });

  it("keeps revision-requested hire approvals unchanged when resubmitted with a tombstone payload", async () => {
    const companyId = await seedCompany("Hire resubmit company");
    await db.insert(agents).values(agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "pending_approval"));
    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({ name: "Repair me" }, "revision_requested"),
      decisionNote: "Fix manager",
      decidedByUserId: "board-user",
      decidedAt: new Date(),
    }).returning();

    await expect(approvalService(db).resubmit(approval!.id, {
      agentId: HISTORICAL_TOMBSTONE_ID.toUpperCase(),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "historical_agent_tombstone_active_reference_forbidden" },
    });
    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0])
      .toEqual(approval);
  });

  it("fails legacy invalid hire approval closed before approve but still allows reject terminalization", async () => {
    const companyId = await seedCompany("Legacy hire approval company");
    await db.insert(agents).values(agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "pending_approval"));
    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({ agentId: HISTORICAL_TOMBSTONE_ID }),
    }).returning();
    const svc = approvalService(db);

    await expect(svc.approve(approval!.id, "board-user", "unsafe"))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "historical_agent_tombstone_active_reference_forbidden" },
      });
    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0])
      .toEqual(approval);

    const rejected = await svc.reject(approval!.id, "board-user", "retire invalid legacy request");
    expect(rejected).toMatchObject({ applied: true, approval: { status: "rejected" } });
    expect((await db.select().from(agents).where(eq(agents.id, HISTORICAL_TOMBSTONE_ID)))[0])
      .toMatchObject({ status: "pending_approval" });
  });

  it("rejects and terminates a valid pending target even when its legacy reportsTo is invalid", async () => {
    const companyId = await seedCompany("Legacy manager rejection company");
    const pendingAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, HISTORICAL_TOMBSTONE_ID, "terminated"),
      agentRow(companyId, pendingAgentId, "pending_approval"),
    ]);
    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({
        agentId: pendingAgentId,
        reportsTo: HISTORICAL_TOMBSTONE_ID.toUpperCase(),
      }),
    }).returning();

    const rejected = await approvalService(db).reject(
      approval!.id,
      "board-user",
      "Reject invalid legacy manager binding",
    );

    expect(rejected).toMatchObject({ applied: true, approval: { status: "rejected" } });
    expect((await db.select().from(agents).where(eq(agents.id, pendingAgentId)))[0])
      .toMatchObject({ status: "terminated" });
  });

  it("rolls back hire rejection when target termination is blocked", async () => {
    const companyId = await seedCompany("Atomic rejection company");
    const pendingAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, pendingAgentId, "pending_approval"));
    const [approval] = await db.insert(approvals).values({
      companyId,
      ...hireApprovalInput({ agentId: pendingAgentId }),
    }).returning();
    await db.insert(issues).values({
      companyId,
      title: "Still assigned",
      status: "todo",
      assigneeAgentId: pendingAgentId,
    });

    await expect(approvalService(db).reject(approval!.id, "board-user", "reject"))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "agent_active_dependencies", dependencyCounts: { nonterminalIssues: 1 } },
      });
    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0])
      .toMatchObject({ status: "pending", decidedAt: null });
    expect((await db.select().from(agents).where(eq(agents.id, pendingAgentId)))[0])
      .toMatchObject({ status: "pending_approval" });
  });
});

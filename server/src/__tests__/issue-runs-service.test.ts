import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRunsService } from "../services/issue-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-runs service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue-runs service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-runs-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRuns);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "test-co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "fixture issue",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });
    return issueId;
  }

  it("acquire creates a running run when none exists", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const result = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
      ttlSeconds: 60,
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error("unreachable");
    expect(result.run.issueId).toBe(issueId);
    expect(result.run.status).toBe("running");
    expect(result.run.leaseOwner).toBe("worker-1");
  });

  it("acquire returns existing run on conflict", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const first = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
    });
    expect(first.acquired).toBe(true);

    const second = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-2",
    });
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("unreachable");
    expect(second.reason).toBe("issue_already_running");
    expect(second.existing?.leaseOwner).toBe("worker-1");
  });

  it("heartbeat extends lease for owner", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);
    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
      ttlSeconds: 60,
    });
    if (!acquired.acquired) throw new Error("acquire failed");

    const originalExpiry = acquired.run.leaseExpiresAt;

    const beat = await svc.heartbeat({
      runId: acquired.run.runId,
      lockedBy: "worker-1",
      extendBySeconds: 300,
    });

    expect(beat.ok).toBe(true);
    if (!beat.ok) throw new Error("heartbeat failed");
    expect(beat.leaseExpiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime());
  });

  it("heartbeat returns lock_lost for wrong owner", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);
    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
    });
    if (!acquired.acquired) throw new Error("acquire failed");

    const beat = await svc.heartbeat({
      runId: acquired.run.runId,
      lockedBy: "worker-2",
    });

    expect(beat.ok).toBe(false);
    if (beat.ok) throw new Error("expected lock_lost");
    expect(beat.reason).toBe("lock_lost");
  });

  it("release marks run completed and clears active partial-unique slot", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);
    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
    });
    if (!acquired.acquired) throw new Error("acquire failed");

    const released = await svc.release({
      runId: acquired.run.runId,
      lockedBy: "worker-1",
      status: "completed",
      exitCode: 0,
      resultSummary: "ok",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) throw new Error("unreachable");
    expect(released.run.status).toBe("completed");
    expect(released.run.exitCode).toBe(0);

    const reacquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-3",
    });
    expect(reacquired.acquired).toBe(true);
  });

  it("release throws conflict for wrong owner", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);
    const acquired = await svc.acquire({
      companyId,
      issueId,
      executor: "hermes",
      lockedBy: "worker-1",
    });
    if (!acquired.acquired) throw new Error("acquire failed");

    await expect(
      svc.release({
        runId: acquired.run.runId,
        lockedBy: "worker-2",
        status: "completed",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("recoverStale finds expired+grace-aged runs and marks them failed_lease_expired", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const runId = randomUUID();
    await db.insert(issueRuns).values({
      runId,
      companyId,
      issueId,
      executor: "hermes",
      leaseOwner: "worker-dead",
      leasedAt: new Date(Date.now() - 60 * 60 * 1000),
      leaseExpiresAt: new Date(Date.now() - 30 * 60 * 1000),
      heartbeatAt: new Date(Date.now() - 30 * 60 * 1000),
      status: "running",
    });

    const result = await svc.recoverStale({ trigger: "watchdog", limit: 50 });
    expect(result.candidates).toHaveLength(1);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.runId).toBe(runId);
  });

  it("recoverStale dry-run does not mutate", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const runId = randomUUID();
    await db.insert(issueRuns).values({
      runId,
      companyId,
      issueId,
      executor: "hermes",
      leaseOwner: "worker-dead",
      leasedAt: new Date(Date.now() - 60 * 60 * 1000),
      leaseExpiresAt: new Date(Date.now() - 30 * 60 * 1000),
      heartbeatAt: new Date(Date.now() - 30 * 60 * 1000),
      status: "running",
    });

    const dry = await svc.recoverStale({ trigger: "manual", dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates).toHaveLength(1);
    expect(dry.recovered).toHaveLength(0);
  });

  it("recoverStale ignores runs still within heartbeat-grace", async () => {
    await seedCompany();
    const issueId = await seedIssue();
    const svc = issueRunsService(db);

    const runId = randomUUID();
    await db.insert(issueRuns).values({
      runId,
      companyId,
      issueId,
      executor: "hermes",
      leaseOwner: "worker-1",
      leasedAt: new Date(Date.now() - 60_000),
      leaseExpiresAt: new Date(Date.now() - 1_000),
      heartbeatAt: new Date(),
      status: "running",
    });

    const result = await svc.recoverStale({ trigger: "watchdog" });
    expect(result.candidates).toHaveLength(0);
  });
});

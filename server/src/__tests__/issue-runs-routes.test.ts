import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSvc = vi.hoisted(() => ({
  acquire: vi.fn(),
  heartbeat: vi.fn(),
  release: vi.fn(),
  recoverStale: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("../services/issue-runs.js", () => ({
  issueRunsService: () => mockSvc,
}));

const COMPANY_ID = "00000000-0000-0000-0000-000000000111";
const ISSUE_ID = "00000000-0000-0000-0000-000000000222";
const RUN_ID = "00000000-0000-0000-0000-000000000333";

type Actor = Record<string, unknown>;

const BOARD_ACTOR: Actor = {
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};

const ADMIN_ACTOR: Actor = { ...BOARD_ACTOR, isInstanceAdmin: true };

const NONE_ACTOR: Actor = { type: "none" };

function chainableSelect(row: unknown) {
  const chain: { from: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> } = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(row ? [row] : []);
  return chain;
}

async function createApp(actor: Actor = BOARD_ACTOR) {
  const [{ errorHandler }, { issueRunRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issue-runs.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Actor }).actor = actor;
    next();
  });
  app.use(issueRunRoutes(mockDb as never));
  app.use(errorHandler);
  return app;
}

describe("issue-runs routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("acquire returns 201 on success", async () => {
    mockSvc.acquire.mockResolvedValue({
      acquired: true,
      run: { runId: RUN_ID, issueId: ISSUE_ID, companyId: COMPANY_ID },
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/internal/issue-runs/acquire")
      .send({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        executor: "hermes",
        lockedBy: "worker-1",
      });

    expect(res.status).toBe(201);
    expect(res.body.acquired).toBe(true);
    expect(mockSvc.acquire).toHaveBeenCalledOnce();
  });

  it("acquire returns 409 on conflict", async () => {
    mockSvc.acquire.mockResolvedValue({
      acquired: false,
      reason: "issue_already_running",
      existing: null,
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/internal/issue-runs/acquire")
      .send({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        executor: "hermes",
        lockedBy: "worker-1",
      });

    expect(res.status).toBe(409);
    expect(res.body.acquired).toBe(false);
  });

  it("acquire 403 cross-company", async () => {
    const app = await createApp({ ...BOARD_ACTOR, companyIds: ["other-co"] });
    const res = await request(app)
      .post("/api/internal/issue-runs/acquire")
      .send({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        executor: "hermes",
        lockedBy: "worker-1",
      });

    expect(res.status).toBe(403);
    expect(mockSvc.acquire).not.toHaveBeenCalled();
  });

  it("acquire 401 without board actor", async () => {
    const app = await createApp(NONE_ACTOR);
    const res = await request(app)
      .post("/api/internal/issue-runs/acquire")
      .send({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        executor: "hermes",
        lockedBy: "worker-1",
      });

    expect(res.status).toBe(403);
  });

  it("acquire 400 invalid body", async () => {
    const app = await createApp();
    const res = await request(app).post("/api/internal/issue-runs/acquire").send({ executor: "x" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockSvc.acquire).not.toHaveBeenCalled();
  });

  it("heartbeat 200 on success", async () => {
    mockDb.select.mockReturnValue(chainableSelect({ runId: RUN_ID, companyId: COMPANY_ID }));
    mockSvc.heartbeat.mockResolvedValue({ ok: true, leaseExpiresAt: new Date(), heartbeatAt: new Date() });

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/heartbeat`)
      .send({ lockedBy: "worker-1" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("heartbeat 409 on lock_lost", async () => {
    mockDb.select.mockReturnValue(chainableSelect({ runId: RUN_ID, companyId: COMPANY_ID }));
    mockSvc.heartbeat.mockResolvedValue({ ok: false, reason: "lock_lost" });

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/heartbeat`)
      .send({ lockedBy: "worker-1" });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  it("heartbeat 404 when run not found", async () => {
    mockDb.select.mockReturnValue(chainableSelect(null));

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/heartbeat`)
      .send({ lockedBy: "worker-1" });

    expect(res.status).toBe(404);
    expect(mockSvc.heartbeat).not.toHaveBeenCalled();
  });

  it("heartbeat 403 cross-company", async () => {
    mockDb.select.mockReturnValue(chainableSelect({ runId: RUN_ID, companyId: "other-co" }));

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/heartbeat`)
      .send({ lockedBy: "worker-1" });

    expect(res.status).toBe(403);
    expect(mockSvc.heartbeat).not.toHaveBeenCalled();
  });

  it("release 200 on success", async () => {
    mockDb.select.mockReturnValue(chainableSelect({ runId: RUN_ID, companyId: COMPANY_ID }));
    mockSvc.release.mockResolvedValue({ ok: true, run: { runId: RUN_ID, status: "completed" } });

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/release`)
      .send({ lockedBy: "worker-1", status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("release 409 on lock_lost", async () => {
    mockDb.select.mockReturnValue(chainableSelect({ runId: RUN_ID, companyId: COMPANY_ID }));
    mockSvc.release.mockResolvedValue({ ok: false, reason: "lock_lost" });

    const app = await createApp();
    const res = await request(app)
      .post(`/api/internal/issue-runs/${RUN_ID}/release`)
      .send({ lockedBy: "worker-1", status: "failed" });

    expect(res.status).toBe(409);
  });

  it("recover-stale requires instance-admin (403 for board)", async () => {
    const app = await createApp(BOARD_ACTOR);
    const res = await request(app)
      .post("/api/internal/issue-runs/recover-stale")
      .send({ trigger: "manual" });

    expect(res.status).toBe(403);
    expect(mockSvc.recoverStale).not.toHaveBeenCalled();
  });

  it("recover-stale 200 for instance-admin", async () => {
    mockSvc.recoverStale.mockResolvedValue({
      trigger: "manual",
      dryRun: false,
      candidates: [],
      recovered: [],
    });

    const app = await createApp(ADMIN_ACTOR);
    const res = await request(app)
      .post("/api/internal/issue-runs/recover-stale")
      .send({ trigger: "manual" });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(mockSvc.recoverStale).toHaveBeenCalledOnce();
  });
});

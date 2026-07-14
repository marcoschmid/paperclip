import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentIds = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const snapshotFingerprint = `v1:sha256:${"a".repeat(64)}`;
const operationId = "55555555-5555-4555-8555-555555555555";

const mockPortfolioMaintenance = vi.hoisted(() => ({
  preflight: vi.fn(),
  quiesce: vi.fn(),
  releaseGate: vi.fn(),
}));

vi.mock("../services/portfolio-maintenance.js", () => ({
  portfolioMaintenanceService: () => mockPortfolioMaintenance,
}));

vi.mock("../services/agent-maintenance-leases.js", () => ({
  AGENT_MAINTENANCE_LEASE_HEADER: "x-paperclip-maintenance-lease",
  AGENT_MAINTENANCE_LEASE_SCOPE: "agent_config_write",
  agentMaintenanceLeaseService: () => ({
    acquire: vi.fn(),
    drainReceipt: vi.fn(),
    release: vi.fn(),
  }),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ decide: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  budgetService: () => ({}),
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => ({}),
  feedbackService: () => ({}),
  logActivity: vi.fn(),
  workTimelineService: () => ({}),
}));

function preflightResponse() {
  return {
    schemaVersion: "1.0.0",
    companyId,
    agentIds,
    ready: true,
    restoreReady: false,
    blockers: [],
    coverage: {
      hiddenIssues: true,
      pluginOperations: true,
      wakesComplete: true,
      liveRunsComplete: true,
      wakeQuiesce: true,
      triggerCas: true,
    },
    snapshotFingerprint,
    maintenanceGate: null,
    lifecycleGates: agentIds.map((agentId, index) => ({
      agentId,
      status: index === 0 ? "idle" : "paused",
      lastCanaryResult: null,
      canaryIssueId: null,
      currentConfigFingerprint: null,
      gateConfigFingerprint: null,
      lastSatisfiedRunId: null,
      receiptHash: null,
      validatedAt: null,
      expiresAt: null,
      valid: false,
    })),
    issues: [],
    wakes: [],
    liveRuns: [],
  };
}

function quiesceResponse() {
  return {
    schemaVersion: "1.0.0",
    companyId,
    agentIds,
    operationId,
    expectedSnapshotFingerprint: snapshotFingerprint,
    receiptId: `v1:sha256:${"b".repeat(64)}`,
    stage: "quiesced",
    quiescedAt: "2026-07-13T09:00:00.000Z",
    cancelledWakeRequestIds: [],
    remainingWakeRequestIds: [],
    remainingLiveRunIds: [],
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/companies.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(allowedCompanyIds = [companyId]) {
  return {
    type: "board",
    userId: "board-user",
    source: "session",
    companyIds: allowedCompanyIds,
    isInstanceAdmin: false,
  };
}

describe("portfolio maintenance routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPortfolioMaintenance.preflight.mockResolvedValue(preflightResponse());
    mockPortfolioMaintenance.quiesce.mockResolvedValue(quiesceResponse());
    mockPortfolioMaintenance.releaseGate.mockResolvedValue({
      schemaVersion: "1.0.0",
      companyId,
      agentIds,
      receiptId: `v1:sha256:${"b".repeat(64)}`,
      expectedSnapshotFingerprint: snapshotFingerprint,
      releasedAt: "2026-07-13T10:00:00.000Z",
    });
  });

  it("is board-only and enforces exact company scope for GET and POST", async () => {
    const agentApp = await createApp({
      type: "agent",
      agentId: agentIds[0],
      companyId,
      source: "agent_key",
    });
    const outsideBoardApp = await createApp(boardActor([otherCompanyId]));

    for (const response of [
      await request(agentApp)
        .get(`/api/companies/${companyId}/portfolio-maintenance-preflight`)
        .query({ agentIds: agentIds.join(",") }),
      await request(agentApp)
      .post(`/api/companies/${companyId}/portfolio-maintenance-wakes/quiesce`)
      .send({ agentIds, operationId, expectedSnapshotFingerprint: snapshotFingerprint }),
      await request(agentApp)
      .post(`/api/companies/${companyId}/portfolio-maintenance-gates/release`)
      .send({ agentIds, receiptIds: [`v1:sha256:${"b".repeat(64)}`], expectedSnapshotFingerprint: snapshotFingerprint }),
      await request(outsideBoardApp)
        .get(`/api/companies/${companyId}/portfolio-maintenance-preflight`)
        .query({ agentIds: agentIds.join(",") }),
      await request(outsideBoardApp)
      .post(`/api/companies/${companyId}/portfolio-maintenance-wakes/quiesce`)
      .send({ agentIds, operationId, expectedSnapshotFingerprint: snapshotFingerprint }),
      await request(outsideBoardApp)
      .post(`/api/companies/${companyId}/portfolio-maintenance-gates/release`)
      .send({ agentIds, receiptIds: [`v1:sha256:${"b".repeat(64)}`], expectedSnapshotFingerprint: snapshotFingerprint }),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(mockPortfolioMaintenance.preflight).not.toHaveBeenCalled();
    expect(mockPortfolioMaintenance.quiesce).not.toHaveBeenCalled();
    expect(mockPortfolioMaintenance.releaseGate).not.toHaveBeenCalled();
  }, 15_000);

  it.each([
    ["missing", ""],
    ["unsorted", [...agentIds].reverse().join(",")],
    ["duplicate", [agentIds[0], agentIds[0]].join(",")],
    ["malformed", `${agentIds[0]},not-a-uuid`],
    ["too many", Array.from({ length: 101 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).join(",")],
  ])("rejects %s GET agentIds before service execution", async (_label, queryValue) => {
    const app = await createApp(boardActor());
    const target = `/api/companies/${companyId}/portfolio-maintenance-preflight`;
    const response = queryValue
      ? await request(app).get(target).query({ agentIds: queryValue })
      : await request(app).get(target);
    expect(response.status).toBe(400);
    expect(mockPortfolioMaintenance.preflight).not.toHaveBeenCalled();
  });

  it("uses the exact sorted GET and strict POST v1 contracts", async () => {
    const app = await createApp(boardActor());
    const getResponse = await request(app)
      .get(`/api/companies/${companyId}/portfolio-maintenance-preflight`)
      .query({ agentIds: agentIds.join(",") });
    expect(getResponse.status, JSON.stringify(getResponse.body)).toBe(200);
    expect(getResponse.body).toEqual(preflightResponse());
    expect(mockPortfolioMaintenance.preflight).toHaveBeenCalledWith({ companyId, agentIds });

    const postResponse = await request(app)
      .post(`/api/companies/${companyId}/portfolio-maintenance-wakes/quiesce`)
      .send({ agentIds, operationId, expectedSnapshotFingerprint: snapshotFingerprint });
    expect(postResponse.status, JSON.stringify(postResponse.body)).toBe(200);
    expect(postResponse.body).toEqual(quiesceResponse());
    expect(mockPortfolioMaintenance.quiesce).toHaveBeenCalledWith({
      companyId,
      agentIds,
      operationId,
      expectedSnapshotFingerprint: snapshotFingerprint,
      actorUserId: "board-user",
    });

    const releaseReceiptId = `v1:sha256:${"b".repeat(64)}`;
    const releaseResponse = await request(app)
      .post(`/api/companies/${companyId}/portfolio-maintenance-gates/release`)
      .send({ agentIds, receiptIds: [releaseReceiptId], expectedSnapshotFingerprint: snapshotFingerprint });
    expect(releaseResponse.status, JSON.stringify(releaseResponse.body)).toBe(200);
    expect(mockPortfolioMaintenance.releaseGate).toHaveBeenCalledWith({
      companyId,
      agentIds,
      receiptIds: [releaseReceiptId],
      expectedSnapshotFingerprint: snapshotFingerprint,
      actorUserId: "board-user",
    });
  });

  it.each([
    ["unsorted", { agentIds: [...agentIds].reverse(), operationId, expectedSnapshotFingerprint: snapshotFingerprint }],
    ["duplicate", { agentIds: [agentIds[0], agentIds[0]], operationId, expectedSnapshotFingerprint: snapshotFingerprint }],
    ["forged shape", { agentIds, operationId, expectedSnapshotFingerprint: snapshotFingerprint, extra: true }],
    ["malformed fingerprint", { agentIds, operationId, expectedSnapshotFingerprint: "sha256:not-v1" }],
  ])("rejects %s POST bodies before service execution", async (_label, body) => {
    const app = await createApp(boardActor());
    const response = await request(app)
      .post(`/api/companies/${companyId}/portfolio-maintenance-wakes/quiesce`)
      .send(body);
    expect(response.status).toBe(400);
    expect(mockPortfolioMaintenance.quiesce).not.toHaveBeenCalled();
  });
});

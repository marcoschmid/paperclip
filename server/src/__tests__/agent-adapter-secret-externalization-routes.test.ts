import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const updatedAt = "2026-07-13T08:00:00.000Z";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockExternalizationService = vi.hoisted(() => ({
  externalize: vi.fn(),
  preflight: vi.fn(),
  proof: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentRetirementService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId, config) => config),
    resolveAdapterConfigForRuntime: vi.fn(async (_companyId, config) => ({ config })),
  }),
}));

vi.mock("../services/agent-adapter-secret-externalization.js", () => ({
  agentAdapterSecretExternalizationService: () => mockExternalizationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function validBody() {
  return {
    schemaVersion: "1.0.0",
    expectedCompanyId: companyId,
    expectedAdapterType: "openclaw_gateway",
    expectedConfigFingerprint: `v1:hmac-sha256:${"a".repeat(64)}`,
    expectedPreflightReceipt: `v1:hmac-sha256:${"b".repeat(64)}`,
  };
}

function safeProof() {
  return {
    schemaVersion: "1.0.0",
    agentId,
    companyId,
    adapterType: "openclaw_gateway",
    configFingerprint: `v1:hmac-sha256:${"c".repeat(64)}`,
    provider: "local_encrypted",
    secretRefCount: 2,
    secretRefPaths: ["authToken", "devicePrivateKeyPem"],
    secretIds: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ],
    bindingCount: 2,
    bindingIds: [
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ],
    runtimeResolvedCount: 2,
    runtimeResolutionHash: "d".repeat(64),
    masterKeyFingerprintSha256: "e".repeat(64),
    receipt: `v1:hmac-sha256:${"f".repeat(64)}`,
  };
}

function safeResponse() {
  return {
    schemaVersion: "1.0.0",
    agentId,
    companyId,
    createdSecretCount: 2,
    createdSecretIds: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ],
    removedHeaderCount: 1,
    removedHeaderPaths: ["headers.x-openclaw-token"],
    secretRefCount: 2,
    secretRefPaths: ["authToken", "devicePrivateKeyPem"],
    secretIds: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ],
    configFingerprint: safeProof().configFingerprint,
    preflightReceipt: validBody().expectedPreflightReceipt,
    proof: safeProof(),
    updatedAt: "2026-07-13T08:00:00.001Z",
  };
}

describe("POST /api/agents/:id/adapter-secrets/externalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      adapterType: "openclaw_gateway",
      updatedAt: new Date(updatedAt),
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockExternalizationService.externalize.mockResolvedValue(safeResponse());
    mockExternalizationService.preflight.mockResolvedValue({
      schemaVersion: "1.0.0",
      agentId,
      companyId,
      adapterType: "openclaw_gateway",
      configFingerprint: validBody().expectedConfigFingerprint,
      masterKeyFingerprintSha256: "e".repeat(64),
      receipt: validBody().expectedPreflightReceipt,
    });
    mockExternalizationService.proof.mockResolvedValue(safeProof());
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("accepts only a company-authorized board and forwards the exact secret-free CAS body", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    const response = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
      .send(validBody());

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual(safeResponse());
    expect(mockExternalizationService.externalize).toHaveBeenCalledWith(
      agentId,
      validBody(),
      { userId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const activity = mockLogActivity.mock.calls[0]?.[1];
    expect(activity.details).toEqual({
      createdSecretCount: 2,
      createdSecretIds: safeResponse().createdSecretIds,
      removedHeaderCount: 1,
      removedHeaderPaths: ["headers.x-openclaw-token"],
      secretRefCount: 2,
      secretRefPaths: ["authToken", "devicePrivateKeyPem"],
      secretIds: safeResponse().secretIds,
      configFingerprint: safeResponse().configFingerprint,
      preflightReceipt: safeResponse().preflightReceipt,
      proofReceipt: safeResponse().proof.receipt,
      updatedAt: "2026-07-13T08:00:00.001Z",
    });
  });

  it("returns a GET preflight but requires explicit POST for the audit-writing runtime postproof", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const preflight = await request(app)
      .get(`/api/agents/${agentId}/adapter-secrets/externalization-preflight`);
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200);
    expect(preflight.body).toMatchObject({
      agentId,
      companyId,
      configFingerprint: validBody().expectedConfigFingerprint,
      masterKeyFingerprintSha256: "e".repeat(64),
      receipt: validBody().expectedPreflightReceipt,
    });
    expect(mockExternalizationService.preflight).toHaveBeenCalledWith(agentId, companyId);

    const rejectedGet = await request(app)
      .get(`/api/agents/${agentId}/adapter-secrets/externalization-proof`);
    expect(rejectedGet.status).toBe(404);
    expect(mockExternalizationService.proof).not.toHaveBeenCalled();

    const proof = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalization-proof`)
      .send({
        schemaVersion: "1.0.0",
        expectedCompanyId: companyId,
        expectedReceipt: safeProof().receipt,
      });
    expect(proof.status, JSON.stringify(proof.body)).toBe(200);
    expect(proof.body).toEqual(safeProof());
    expect(mockExternalizationService.proof).toHaveBeenCalledWith(agentId, companyId, safeProof().receipt);
  });

  it("rejects an expected company mismatch before the transactional service call", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const response = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
      .send({ ...validBody(), expectedCompanyId: "77777777-7777-4777-8777-777777777777" });
    expect(response.status).toBe(409);
    expect(mockExternalizationService.externalize).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated callers before externalization", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "55555555-5555-4555-8555-555555555555",
      companyId,
      source: "agent_key",
    });
    const response = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
      .send(validBody());

    expect(response.status).toBe(403);
    expect(mockExternalizationService.externalize).not.toHaveBeenCalled();
  });

  it("rejects a board without company access before externalization", async () => {
    const app = await createApp({
      type: "board",
      userId: "other-board",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
      memberships: [],
    });
    const response = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
      .send(validBody());

    expect(response.status).toBe(403);
    expect(mockExternalizationService.externalize).not.toHaveBeenCalled();
  });

  it("rejects unknown body fields and malformed CAS inputs", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const invalidBodies = [
      { ...validBody(), unexpected: true },
      { ...validBody(), expectedCompanyId: "not-a-company-id" },
      { ...validBody(), expectedConfigFingerprint: "not-a-fingerprint" },
      { ...validBody(), expectedPreflightReceipt: "not-a-receipt" },
      { ...validBody(), expectedAdapterType: "codex_local" },
      { ...validBody(), schemaVersion: "2.0.0" },
    ];
    for (const body of invalidBodies) {
      const response = await request(app)
        .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
        .send(body);
      expect(response.status).toBe(400);
    }
    expect(mockExternalizationService.externalize).not.toHaveBeenCalled();
  });

  it("surfaces an exact service CAS mismatch as conflict without activity logging", async () => {
    const { conflict } = await import("../errors.js");
    mockExternalizationService.externalize.mockRejectedValueOnce(conflict("Agent CAS mismatch", {
      code: "agent_adapter_secret_cas_mismatch",
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const response = await request(app)
      .post(`/api/agents/${agentId}/adapter-secrets/externalize`)
      .send(validBody());

    expect(response.status).toBe(409);
    expect(response.body.details.code).toBe("agent_adapter_secret_cas_mismatch");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

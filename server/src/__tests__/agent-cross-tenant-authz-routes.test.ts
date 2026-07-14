import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const retirementSourceId = "007bcd1f-0462-4c9e-b58a-c6c546393f41";
const retirementCompanyId = "51eb52b7-49ed-461a-bd67-7384158374e6";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const baseKey = {
  id: keyId,
  agentId,
  companyId,
  name: "exploit",
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  revokedAt: null,
};

function retirementEvidence() {
  return {
    schemaVersion: "1.0.0",
    source: {
      sourceAgentId: agentId,
      companyId,
      decision: "terminate",
      physicalDelete: false,
    },
    expectedUpdatedAt: "2026-07-13T10:00:00.000Z",
    sourceExport: {
      sourceAgentId: agentId,
      path: "/tmp/retirement/source-export.json",
      sha256: "1".repeat(64),
      sizeBytes: 128,
      capturedAt: "2026-07-13T10:01:00.000Z",
    },
    backupRestore: {
      dumpPath: "/tmp/retirement/paperclip.sql.gz",
      dumpSha256: "2".repeat(64),
      dumpSizeBytes: 1024,
      dumpCapturedAt: "2026-07-13T10:02:00.000Z",
      masterKeyBackupPath: "/tmp/retirement/master.key",
      masterKeyBackupSha256: "3".repeat(64),
      masterKeyBackupSizeBytes: 65,
      masterKeyFingerprintSha256: "4".repeat(64),
      masterKeyCapturedAt: "2026-07-13T10:01:30.000Z",
      restoreEvidencePath: "/tmp/retirement/restore-evidence.json",
      restoreEvidenceSha256: "5".repeat(64),
      restoreEvidenceSizeBytes: 2048,
      restoreVerifiedAt: "2026-07-13T10:03:00.000Z",
      restoreStateSha256: "6".repeat(64),
    },
    replacement: {
      replacementAgentId: "44444444-4444-4444-8444-444444444444",
      replacementSystemRef: null,
      canaryAgentId: "44444444-4444-4444-8444-444444444444",
      canaryIssueId: "55555555-5555-4555-8555-555555555555",
      canaryRunId: "66666666-6666-4666-8666-666666666666",
      configFingerprint: `v1:sha256:${"4".repeat(64)}`,
    },
    humanGate: {
      issueIdentifier: "TEC-355",
      issueId: "77777777-7777-4777-8777-777777777777",
      commentId: "88888888-8888-4888-8888-888888888888",
      approvedAt: "2026-07-13T10:04:00.000Z",
      approvalNonce: "c".repeat(64),
      manifestSha256: "a".repeat(64),
      backupSha256: "2".repeat(64),
      restoreReceiptSha256: "5".repeat(64),
      approvedTextSha256: "7".repeat(64),
    },
  };
}

let currentKeyAgentId = agentId;
let currentAccessCanUser = false;

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockAgentRetirementService = vi.hoisted(() => ({
  preflight: vi.fn(),
  cleanup: vi.fn(),
  postcheck: vi.fn(),
  assertTerminationAuthorized: vi.fn(),
  terminateAuthorized: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  exportFiles: vi.fn(),
}));

const mockValidateAgentLifecycleGate = vi.hoisted(() => vi.fn(() => ({ ok: true as const })));

vi.mock("../services/agent-lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-lifecycle.js")>("../services/agent-lifecycle.js");
  return { ...actual, validateAgentLifecycleGate: mockValidateAgentLifecycleGate };
});

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") {
      throw unauthorized();
    }
  }

  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertAuthenticated(req);
    if (req.actor.type === "agent" && req.actor.companyId !== expectedCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
      const allowedCompanies = req.actor.companyIds ?? [];
      if (!allowedCompanies.includes(expectedCompanyId)) {
        throw forbidden("User does not have access to this company");
      }
    }
  }

  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  function getActorInfo(req: Express.Request) {
    assertAuthenticated(req);
    if (req.actor.type === "agent") {
      return {
        actorType: "agent" as const,
        actorId: req.actor.agentId ?? "unknown-agent",
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
      };
    }
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    assertAuthenticated,
    assertBoard,
    assertCompanyAccess,
    assertInstanceAdmin,
    getActorInfo,
  };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
  agentRetirementService: () => mockAgentRetirementService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>, db: Record<string, unknown> = {}) {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function resetMockDefaults() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockAgentService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  for (const mock of Object.values(mockApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockBudgetService)) mock.mockReset();
  for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
  for (const mock of Object.values(mockAgentRetirementService)) mock.mockReset();
  for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockIssueService)) mock.mockReset();
  for (const mock of Object.values(mockSecretService)) mock.mockReset();
  for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
  for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockGetTelemetryClient.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  currentKeyAgentId = agentId;
  currentAccessCanUser = false;
  mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.clearError.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
  mockAgentService.terminate.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.remove.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.listKeys.mockImplementation(async () => []);
  mockAgentService.createApiKey.mockImplementation(async () => ({
    id: keyId,
    name: baseKey.name,
    token: "pcp_test_token",
    createdAt: baseKey.createdAt,
  }));
  mockAgentService.getKeyById.mockImplementation(async () => ({
    ...baseKey,
    agentId: currentKeyAgentId,
  }));
  mockAgentService.revokeKey.mockImplementation(async () => ({
    ...baseKey,
    revokedAt: new Date("2026-04-11T00:05:00.000Z"),
  }));
  mockAccessService.canUser.mockImplementation(async () => currentAccessCanUser);
  mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
    const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
      ? true
      : currentAccessCanUser;
    return {
      allowed,
      action: input.action,
      reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
    };
  });
  mockAccessService.hasPermission.mockImplementation(async () => false);
  mockAccessService.getMembership.mockImplementation(async () => null);
  mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
  mockAccessService.ensureMembership.mockImplementation(async () => undefined);
  mockAccessService.setPrincipalPermission.mockImplementation(async () => undefined);
  mockHeartbeatService.cancelActiveForAgent.mockImplementation(async () => undefined);
  mockHeartbeatService.cancelInvocationsForAgents.mockImplementation(async (agentIds: string[]) => ({
    agentIds,
    runsCancelled: 0,
    wakeupsCancelled: 0,
  }));
  mockAgentRetirementService.preflight.mockImplementation(async (id: string) => ({
    schemaVersion: "1.0.0",
    agentId: id,
    companyId,
    ok: true,
    cleanupEligible: true,
    blockers: [],
    dependencyCounts: {},
    fingerprint: `v1:sha256:${"1".repeat(64)}`,
    observedUpdatedAt: "2026-07-13T10:00:00.000Z",
  }));
  mockAgentRetirementService.cleanup.mockImplementation(async (id: string) => ({
    schemaVersion: "1.0.0",
    ok: true,
    agentId: id,
    companyId,
    receiptId: `v1:sha256:${"2".repeat(64)}`,
  }));
  mockAgentRetirementService.assertTerminationAuthorized.mockImplementation(async () => ({
    agentId: retirementSourceId,
    companyId: retirementCompanyId,
  }));
  mockAgentInstructionsService.exportFiles.mockResolvedValue({
    entryFile: "AGENTS.md",
    files: { "AGENTS.md": "" },
  });
  mockAgentRetirementService.terminateAuthorized.mockImplementation(async () => ({
    agent: {
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      status: "terminated",
    },
    receipt: {},
  }));
  mockLogActivity.mockImplementation(async () => undefined);
}

describe.sequential("agent cross-tenant route authorization", () => {
  beforeEach(() => {
    resetMockDefaults();
  });

  it("enforces company boundaries before mutating or reading agent keys", async () => {
    const crossTenantActor = {
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    };
    const deniedCases = [
      {
        label: "pause",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/pause`).send({})),
        untouched: [mockAgentService.pause, mockHeartbeatService.cancelActiveForAgent],
      },
      {
        label: "clear error",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({})),
        untouched: [mockAgentService.clearError],
      },
      {
        label: "list keys",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}/keys`)),
        untouched: [mockAgentService.listKeys],
      },
      {
        label: "create key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/keys`).send({ name: "exploit" })),
        untouched: [mockAgentService.createApiKey],
      },
      {
        label: "revoke key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`)),
        untouched: [mockAgentService.getKeyById, mockAgentService.revokeKey],
      },
    ];

    for (const deniedCase of deniedCases) {
      resetMockDefaults();
      const app = await createApp(crossTenantActor);
      const res = await deniedCase.request(app);

      expect(res.status, `${deniedCase.label}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error).toContain("User does not have access to this company");
      expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
      for (const mock of deniedCase.untouched) {
        expect(mock).not.toHaveBeenCalled();
      }
    }

    resetMockDefaults();
    currentKeyAgentId = "44444444-4444-4444-8444-444444444444";
    currentAccessCanUser = true;

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`));

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Key not found");
    expect(mockAgentService.getKeyById).toHaveBeenCalledWith(keyId);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("requires board access before clearing an agent error", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
  });

  it("keeps retirement preflight and cleanup board-only and company-scoped", async () => {
    const agentApp = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });
    const agentResponse = await requestApp(agentApp, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/retirement-preflight`).send({}),
    );
    expect(agentResponse.status).toBe(403);
    expect(mockAgentRetirementService.preflight).not.toHaveBeenCalled();

    const crossTenantApp = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    });
    const crossTenantResponse = await requestApp(crossTenantApp, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/retirement-cleanup`).send({}),
    );
    expect(crossTenantResponse.status).toBe(403);
    expect(mockAgentRetirementService.cleanup).not.toHaveBeenCalled();
  });

  it("requires retirement authorization before terminating an exact allowlist source", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      name: "Calendar und Events Butler",
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [retirementCompanyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${retirementSourceId}/terminate`).send({}),
    );

    expect(res.status).toBe(400);
    expect(mockAgentRetirementService.terminateAuthorized).not.toHaveBeenCalled();
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("delegates an allowlisted termination to the receipt gate before lifecycle mutation", async () => {
    const { conflict } = await import("../errors.js");
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      name: "Calendar und Events Butler",
    });
    mockAgentRetirementService.terminateAuthorized.mockRejectedValue(
      conflict("Retirement final preflight is stale or blocked"),
    );
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [retirementCompanyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const body = {
      cleanupReceiptId: `v1:sha256:${"7".repeat(64)}`,
      preflightFingerprint: `v1:sha256:${"8".repeat(64)}`,
      expectedUpdatedAt: "2026-07-13T10:00:00.000Z",
      humanGate: retirementEvidence().humanGate,
      planClaimReceiptId: `v1:sha256:${"9".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"a".repeat(64)}`,
    };

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${retirementSourceId}/terminate`).send(body),
    );

    expect(res.status).toBe(409);
    expect(mockAgentRetirementService.terminateAuthorized).toHaveBeenCalledWith(
      retirementSourceId,
      body,
      { actorUserId: "board-user" },
    );
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("returns the normalized API agent after an atomic allowlisted termination", async () => {
    const existingAgent = {
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      name: "Calendar und Events Butler",
      status: "paused",
    };
    const normalizedTerminatedAgent = {
      ...existingAgent,
      urlKey: "calendar-und-events-butler",
      status: "terminated",
      orgChainHealth: {
        status: "healthy",
        reason: null,
        repairGuidance: null,
      },
    };
    const { urlKey: _urlKey, ...rawTerminatedAgent } = normalizedTerminatedAgent;
    const { orgChainHealth: _orgChainHealth, ...rawDbTerminatedAgent } = rawTerminatedAgent;
    mockAgentService.getById
      .mockResolvedValueOnce(existingAgent)
      .mockResolvedValueOnce(normalizedTerminatedAgent);
    mockAgentRetirementService.terminateAuthorized.mockResolvedValue({
      agent: rawDbTerminatedAgent,
      receipt: {},
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{
            id: retirementSourceId,
            companyId: retirementCompanyId,
            name: "Calendar und Events Butler",
            reportsTo: null,
            status: "terminated",
          }]),
        })),
      })),
    };
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [retirementCompanyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    }, db);
    const body = {
      cleanupReceiptId: `v1:sha256:${"7".repeat(64)}`,
      preflightFingerprint: `v1:sha256:${"8".repeat(64)}`,
      expectedUpdatedAt: "2026-07-13T10:00:00.000Z",
      humanGate: retirementEvidence().humanGate,
      planClaimReceiptId: `v1:sha256:${"9".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"a".repeat(64)}`,
    };

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${retirementSourceId}/terminate`).send(body),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: retirementSourceId,
      status: "terminated",
      urlKey: "calendar-und-events-butler",
      orgChainHealth: { status: "healthy" },
    });
    expect(mockAgentRetirementService.terminateAuthorized).toHaveBeenCalledTimes(1);
    expect(mockAgentService.getById).toHaveBeenCalledTimes(2);
    expect(mockAgentService.getById).toHaveBeenLastCalledWith(retirementSourceId);
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("delegates validated retirement evidence with the real board actor", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const evidence = retirementEvidence();

    const preflight = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/retirement-preflight`).send(evidence),
    );
    expect(preflight.status).toBe(200);
    expect(mockAgentRetirementService.preflight).toHaveBeenCalledWith(
      agentId,
      evidence,
      { actorUserId: "board-user" },
    );

    const cleanupInput = {
      evidence,
      planClaimReceiptId: `v1:sha256:${"9".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"a".repeat(64)}`,
      preflightFingerprint: `v1:sha256:${"6".repeat(64)}`,
    };
    const cleanup = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/retirement-cleanup`).send(cleanupInput),
    );
    expect(cleanup.status).toBe(200);
    expect(mockAgentRetirementService.cleanup).toHaveBeenCalledWith(
      agentId,
      cleanupInput,
      { actorUserId: "board-user" },
    );
  });

  it("forbids physical deletion for an exact retirement source", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      name: "Calendar und Events Butler",
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [retirementCompanyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete(`/api/agents/${retirementSourceId}`),
    );

    expect(res.status).toBe(409);
    expect(res.body.details?.code).toBe("retirement_physical_delete_forbidden");
    expect(mockAgentService.remove).not.toHaveBeenCalled();
  });

  it("keeps mixed-case retirement source pause, terminate, and delete routes gated", async () => {
    const mixedCaseId = retirementSourceId.toUpperCase();
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      id: retirementSourceId,
      companyId: retirementCompanyId,
      name: "Calendar und Events Butler",
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [retirementCompanyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const pause = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${mixedCaseId}/pause`).send({}),
    );
    const terminate = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${mixedCaseId}/terminate`).send({}),
    );
    const remove = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete(`/api/agents/${mixedCaseId}`),
    );

    expect(pause.status).toBe(409);
    expect(pause.body.details).toMatchObject({
      code: "retirement_gated_termination_required",
      sourceAgentId: mixedCaseId,
    });
    expect(terminate.status).toBe(400);
    expect(terminate.body.details?.code).toBe("retirement_termination_invalid");
    expect(remove.status).toBe(409);
    expect(remove.body.details?.code).toBe("retirement_physical_delete_forbidden");
    expect(mockAgentService.pause).not.toHaveBeenCalled();
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
    expect(mockAgentService.remove).not.toHaveBeenCalled();
  });

  it("clears error agents and records a distinct audit action", async () => {
    const errorAgent = {
      ...baseAgent,
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-04-11T00:02:00.000Z"),
    };
    mockAgentService.getById.mockImplementation(async () => ({ ...errorAgent }));
    mockAgentService.clearError.mockImplementation(async () => ({
      ...errorAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date("2026-04-11T00:03:00.000Z"),
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(mockAgentService.clearError).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agentId,
    }));
  });

  it("returns 409 and does not mutate when the agent org chain is invalid", async () => {
    mockAgentService.getById.mockImplementation(async () => ({
      ...baseAgent,
      status: "error",
      orgChainHealth: {
        status: "invalid_org_chain",
        reason: "missing_manager",
        repairGuidance: "Repair the reporting chain first.",
      },
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Repair the reporting chain first");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns a clear 409 for non-error agents", async () => {
    const { conflict } = await import("../errors.js");
    mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
    mockAgentService.clearError.mockImplementation(async () => {
      throw conflict("Only agents in error status can have their error cleared");
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only agents in error status can have their error cleared");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

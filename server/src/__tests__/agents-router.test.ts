import express from "express";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEffectiveRunConfigFingerprints } from "../services/effective-run-config-fingerprints.js";
import {
  computeAgentLifecycleConfigFingerprint,
  createAgentLifecycleValidationReceipt,
  hashAgentLifecycleContent,
} from "../services/agent-lifecycle.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";
const CANARY_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const EXCEPTION_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_USER_ID = "better-auth:user-marco";
const CANARY_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const EFFECTIVE_CONFIG_DIGEST = "a".repeat(64);
const EFFECTIVE_CONFIG_FINGERPRINT = `v1:sha256:${EFFECTIVE_CONFIG_DIGEST}`;
const APPROVED_AT = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();

function agentConfigurationFingerprint(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  runtimeConfig: Record<string, unknown> = {},
) {
  return createEffectiveRunConfigFingerprints({
    session: { adapterType, adapterConfig, runtimeConfig },
  }).sessionFingerprint.fingerprint;
}

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
  update: vi.fn(),
  updateLifecycleGate: vi.fn(),
  updatePermissions: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listMembers: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  enqueueLifecycleCanary: vi.fn(),
  inspectLifecycleCanaryIsolation: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAuthUserIds = vi.hoisted(() => new Set<string>());

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  exportFiles: vi.fn(),
}));

const mockAgentRetirementService = vi.hoisted(() => ({
  preflight: vi.fn(),
  cleanup: vi.fn(),
  postcheck: vi.fn(),
  assertTerminationAuthorized: vi.fn(),
  terminateAuthorized: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => ({ config }),
  ),
  syncEnvBindingsForTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentRetirementService: () => mockAgentRetirementService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Governed worker",
    urlKey: "governed-worker",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
    updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    ...overrides,
  };
}

const GOVERNED_INSTRUCTION_FILES = { "AGENTS.md": "bounded managed instructions" };

function lifecycle(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schemaVersion: "1.0.0",
    owner: { ownerType: "board_user", ownerUserId: OWNER_USER_ID },
    purpose: "Own bounded lifecycle-gated work.",
    acceptedTaskTypes: ["bounded issue work"],
    rejectedTaskTypes: ["unscoped external writes"],
    taskSources: ["paperclip:company:company-1:issues"],
    operatingMode: "issue_routed",
    serviceLevel: {
      availabilityClass: "business_hours",
      triageTargetMinutes: 120,
      completionTargetMinutes: 1_440,
      targetExceptionReason: null,
    },
    canaryIssueId: CANARY_ISSUE_ID,
    lastCanaryAt: new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
    lastCanaryResult: "passed",
    canaryFreshnessDays: 30,
    reviewAt: new Date(now + 20 * 24 * 60 * 60 * 1_000).toISOString(),
    retirementCriterion: "Retire only after a reviewed replacement canary.",
    decisionIssueId: EXCEPTION_ISSUE_ID,
    ...overrides,
  };
}

function lifecycleFingerprintInput(agent: ReturnType<typeof makeAgent>, lifecycleValue: unknown) {
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig,
    permissions: agent.permissions,
    grants: [],
    desiredSkills: [],
    lifecycle: lifecycleValue,
    contextPackSha256: hashAgentLifecycleContent(GOVERNED_INSTRUCTION_FILES["AGENTS.md"]),
    managedInstructionsSha256: hashAgentLifecycleContent(GOVERNED_INSTRUCTION_FILES),
    companyProfileSha256: null,
  };
}

function governedPausedAgent(overrides: Record<string, unknown> = {}) {
  const lifecycleValue = lifecycle();
  const base = makeAgent({
    status: "paused",
    adapterType: "codex_local",
    adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false },
    permissions: {
      canCreateAgents: false,
      canCreateSkills: true,
      bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: false },
      exception: { kind: "none" },
    },
    metadata: { lifecycle: lifecycleValue },
  });
  const gate = createAgentLifecycleValidationReceipt({
    fingerprintInput: lifecycleFingerprintInput(base, lifecycleValue),
  });
  return {
    ...base,
    metadata: { lifecycle: lifecycleValue, lifecycleGate: gate },
    ...overrides,
  };
}

function pendingCanaryAgent(overrides: Record<string, unknown> = {}) {
  const lifecycleValue = lifecycle({
    canaryIssueId: CANARY_ISSUE_ID,
    lastCanaryAt: null,
    lastCanaryResult: "pending",
  });
  return makeAgent({
    status: "paused",
    adapterType: "codex_local",
    adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false },
    permissions: {
      canCreateAgents: false,
      canCreateSkills: true,
      bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: false },
      exception: { kind: "none" },
    },
    metadata: { lifecycle: lifecycleValue },
    ...overrides,
  });
}

function failedCanaryAgent(overrides: Record<string, unknown> = {}) {
  const failedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  return pendingCanaryAgent({
    metadata: {
      lifecycle: lifecycle({
        lastCanaryResult: "failed",
        lastCanaryAt: failedAt,
        pause: {
          reasonCode: "canary_failed",
          reasonDetail: "The bounded canary failed and requires reviewed repair.",
          outcome: "failed",
          repairIssueId: CANARY_ISSUE_ID,
          startedAt: failedAt,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        },
      }),
    },
    ...overrides,
  });
}

function pendingCanaryFingerprint(agent: ReturnType<typeof pendingCanaryAgent>) {
  return computeAgentLifecycleConfigFingerprint(
    lifecycleFingerprintInput(agent, (agent.metadata as Record<string, unknown>).lifecycle),
  );
}

function governedAgentFailure(reason: "lifecycle" | "fingerprint" | "freshness" | "permission" | "fresh_session") {
  const base = governedPausedAgent();
  const metadata = base.metadata as Record<string, any>;
  if (reason === "lifecycle") {
    return { ...base, metadata: { ...metadata, lifecycle: { schemaVersion: "1.0.0" } } };
  }
  if (reason === "fingerprint") {
    return { ...base, adapterConfig: { ...base.adapterConfig, model: "changed-after-receipt" } };
  }
  if (reason === "freshness") {
    return {
      ...base,
      metadata: {
        ...metadata,
        lifecycle: {
          ...metadata.lifecycle,
          lastCanaryAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString(),
          canaryFreshnessDays: 30,
        },
      },
    };
  }
  if (reason === "permission") {
    return {
      ...base,
      adapterConfig: { ...base.adapterConfig, dangerouslyBypassApprovalsAndSandbox: true },
      permissions: {
        ...base.permissions,
        bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: true },
        exception: { kind: "none" },
      },
    };
  }

  const changed = { ...base, adapterConfig: { ...base.adapterConfig, model: "changed-profile" } };
  const changedGate = createAgentLifecycleValidationReceipt({
    fingerprintInput: lifecycleFingerprintInput(changed, metadata.lifecycle),
    previousGate: metadata.lifecycleGate,
  });
  return { ...changed, metadata: { ...metadata, lifecycleGate: changedGate } };
}

function approvedException(bypass: "claude_permission_mode" | "codex_approvals_and_sandbox") {
  return {
    kind: "approved",
    exceptionIssueId: EXCEPTION_ISSUE_ID,
    owner: {
      ownerType: "board_user",
      ownerUserId: OWNER_USER_ID,
    },
    scope: {
      cwdRoots: ["/Users/marco/Code/paperclip"],
      tools: [],
      networkHosts: [],
      bypasses: [bypass],
    },
    justification: "Bounded non-interactive canary requires this permission mode.",
    evidence: {
      canaryIssueId: CANARY_ISSUE_ID,
      runId: RUN_ID,
      configFingerprint: EFFECTIVE_CONFIG_DIGEST,
      result: "passed",
    },
    approvedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function approvedPermissions(input: {
  adapterType: "claude_local" | "codex_local";
  adapterConfig: Record<string, unknown>;
  agentId?: string;
  companyId?: string;
}) {
  const bypass = input.adapterType === "claude_local"
    ? "claude_permission_mode"
    : "codex_approvals_and_sandbox";
  const permissions = {
    canCreateAgents: false,
    canCreateSkills: true,
    bypass: {
      claudePermissionMode: bypass === "claude_permission_mode",
      codexApprovalsAndSandbox: bypass === "codex_approvals_and_sandbox",
    },
    exception: approvedException(bypass),
  };
  return permissions;
}

function approvedBoardDecision(
  bypass: "claude_permission_mode" | "codex_approvals_and_sandbox",
) {
  const exception = approvedException(bypass);
  return {
    id: `approval-${bypass}`,
    companyId: "company-1",
    type: "request_board_approval",
    status: "approved",
    decidedByUserId: OWNER_USER_ID,
    decidedAt: APPROVED_AT,
    payload: {
      action: "agent_permission_exception",
      agentId: AGENT_ID,
      bypasses: [bypass],
      scope: exception.scope,
      configFingerprint: EFFECTIVE_CONFIG_DIGEST,
      agentConfigurationFingerprint: agentConfigurationFingerprint(
        "claude_local",
        {
          cwd: "/Users/marco/Code/paperclip",
          dangerouslySkipPermissions: true,
        },
      ),
      expiresAt: EXPIRES_AT,
    },
  };
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
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
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => selection && Object.keys(selection).length === 1 && "id" in selection
          ? [...mockAuthUserIds].map((id) => ({ id }))
          : [{ id: "company-1", requireBoardApprovalForNewAgents: false }]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("agent permission bypass governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue({
      companyId: "company-1",
      principalType: "user",
      principalId: OWNER_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    mockAccessService.listMembers.mockResolvedValue([]);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) =>
      makeAgent({
        ...input,
        id: String(input.id ?? AGENT_ID),
        adapterType: String(input.adapterType),
        adapterConfig: input.adapterConfig ?? {},
        permissions: input.permissions ?? { canCreateAgents: false },
      }),
    );
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...(await mockAgentService.getById()),
      ...patch,
    }));
    mockAgentService.updateLifecycleGate.mockImplementation(
      async (id: string, patch: Record<string, unknown>, options: Record<string, unknown>) =>
        mockAgentService.update(id, patch, options),
    );
    mockAgentService.updatePermissions.mockImplementation(async (_id: string, permissions: Record<string, unknown>) => ({
      ...(await mockAgentService.getById()),
      permissions,
    }));
    mockAgentService.pause.mockImplementation(async (
      _id: string,
      reason: string = "manual",
    ) => ({
      ...(await mockAgentService.getById()),
      status: "paused",
      pauseReason: reason,
    }));
    mockAgentService.resume.mockImplementation(async () => ({
      ...(await mockAgentService.getById()),
      status: "idle",
    }));
    mockAgentService.clearError.mockImplementation(async () => ({
      ...(await mockAgentService.getById()),
      status: "idle",
    }));
    mockIssueService.getById.mockImplementation(async (id: string) => id === EXCEPTION_ISSUE_ID
      ? {
          id: EXCEPTION_ISSUE_ID,
          companyId: "company-1",
          status: "in_progress",
        }
      : {
          id: CANARY_ISSUE_ID,
          companyId: "company-1",
          assigneeAgentId: AGENT_ID,
          status: "done",
          executionRunId: RUN_ID,
        });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-1",
      agentId: AGENT_ID,
      status: "succeeded",
      contextSnapshot: {
        issueId: CANARY_ISSUE_ID,
        paperclipWorkspace: { cwd: "/Users/marco/Code/paperclip" },
      },
      resultJson: {
        configFreshness: {
          session: {
            nextFingerprint: EFFECTIVE_CONFIG_FINGERPRINT,
            agentConfigurationFingerprint: agentConfigurationFingerprint(
              "claude_local",
              {
                cwd: "/Users/marco/Code/paperclip",
                dangerouslySkipPermissions: true,
              },
            ),
          },
        },
      },
    });
    mockHeartbeatService.enqueueLifecycleCanary.mockImplementation(async (input: Record<string, any>) => ({
      run: { id: input.receipt.runId },
      receipt: input.receipt,
      agent: { ...(await mockAgentService.getById()), status: "idle" },
    }));
    mockHeartbeatService.inspectLifecycleCanaryIsolation.mockResolvedValue({
      ready: true,
      blockers: [],
    });
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([
      approvedBoardDecision("claude_permission_mode"),
      approvedBoardDecision("codex_approvals_and_sandbox"),
    ]);
    mockAuthUserIds.clear();
    mockAuthUserIds.add(OWNER_USER_ID);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>) => ({ adapterConfig: agent.adapterConfig }),
    );
    mockAgentInstructionsService.exportFiles.mockResolvedValue({
      entryFile: "AGENTS.md",
      files: GOVERNED_INSTRUCTION_FILES,
      warnings: [],
    });
  });

  it.each([
    ["PATCH", `/api/agents/${HISTORICAL_TOMBSTONE_ID}`, { name: "Do not rename" }],
    ["DELETE", `/api/agents/${HISTORICAL_TOMBSTONE_ID}`, undefined],
    ["POST", `/api/agents/${HISTORICAL_TOMBSTONE_ID}/resume`, {}],
    ["POST", `/api/agents/${HISTORICAL_TOMBSTONE_ID}/heartbeat/invoke`, {}],
  ] as const)("blocks %s mutations for historical tombstones before service dispatch", async (method, url, body) => {
    const app = await createApp();
    const pending = request(app)[method.toLowerCase() as "patch" | "delete" | "post"](url);
    const response = body === undefined ? await pending : await pending.send(body);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "historical_agent_tombstone_immutable",
      agentId: HISTORICAL_TOMBSTONE_ID,
    });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("blocks historical tombstone API-key mutations with the stable access code", async () => {
    const response = await request(await createApp())
      .post(`/api/agents/${HISTORICAL_TOMBSTONE_ID}/keys`)
      .send({ name: "blocked" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.details).toMatchObject({
      code: "historical_agent_tombstone_access_forbidden",
      agentId: HISTORICAL_TOMBSTONE_ID,
    });
  });

  it("blocks mixed-case historical tombstone lifecycle and access routes before dispatch", async () => {
    const mixedCaseId = HISTORICAL_TOMBSTONE_ID.toUpperCase();
    const app = await createApp();
    const patchResponse = await request(app)
      .patch(`/api/agents/${mixedCaseId}`)
      .send({ name: "Do not rename" });
    const deleteResponse = await request(app).delete(`/api/agents/${mixedCaseId}`);
    const keyResponse = await request(app)
      .post(`/api/agents/${mixedCaseId}/keys`)
      .send({ name: "blocked" });

    expect(patchResponse.status).toBe(409);
    expect(patchResponse.body.details).toMatchObject({
      code: "historical_agent_tombstone_immutable",
      agentId: mixedCaseId,
    });
    expect(deleteResponse.status).toBe(409);
    expect(keyResponse.status).toBe(403);
    expect(keyResponse.body.details).toMatchObject({
      code: "historical_agent_tombstone_access_forbidden",
      agentId: mixedCaseId,
    });
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", "dangerouslySkipPermissions"],
    ["codex_local", "dangerouslyBypassApprovalsAndSandbox"],
  ])("defaults omitted %s bypass to false on create", async (adapterType, key) => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({ name: "Safe worker", adapterType, adapterConfig: {} });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect((createInput.adapterConfig as Record<string, unknown>)[key]).toBe(false);
  });

  it.each([
    ["claude_local", "dangerouslySkipPermissions", "claude_permission_mode"],
    ["codex_local", "dangerouslyBypassApprovalsAndSandbox", "codex_approvals_and_sandbox"],
  ] as const)(
    "rejects explicit %s bypass on create without a current complete exception",
    async (adapterType, key) => {
      const response = await request(await createApp())
        .post("/api/companies/company-1/agents")
        .send({ name: "Unsafe worker", adapterType, adapterConfig: { [key]: true } });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error).toContain("current complete lifecycle permission exception");
      expect(mockAgentService.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["claude_local", "dangerouslySkipPermissions", "claude_permission_mode"],
    ["codex_local", "dangerouslyBypassApprovalsAndSandbox", "codex_approvals_and_sandbox"],
  ] as const)("rejects reused canary evidence when creating a new %s agent", async (adapterType, key, bypass) => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Exception worker",
        adapterType,
        adapterConfig: { [key]: true },
        permissions: {
          canCreateAgents: false,
          bypass: {
            claudePermissionMode: bypass === "claude_permission_mode",
            codexApprovalsAndSandbox: bypass === "codex_approvals_and_sandbox",
          },
          exception: approvedException(bypass),
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each([
    ["none", { kind: "none" }],
    [
      "mismatched scope",
      {
        ...approvedException("claude_permission_mode"),
        scope: {
          ...approvedException("claude_permission_mode").scope,
          bypasses: ["codex_approvals_and_sandbox"],
        },
      },
    ],
    [
      "expired",
      {
        ...approvedException("claude_permission_mode"),
        approvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      },
    ],
    [
      "longer than thirty days",
      {
        ...approvedException("claude_permission_mode"),
        approvedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    ],
    [
      "incomplete evidence",
      {
        ...approvedException("claude_permission_mode"),
        evidence: {
          ...approvedException("claude_permission_mode").evidence,
          runId: undefined,
        },
      },
    ],
  ])("rejects a %s exception as incomplete", async (_label, exception) => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Invalid exception worker",
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: true },
        permissions: {
          canCreateAgents: false,
          bypass: {
            claudePermissionMode: true,
            codexApprovalsAndSandbox: false,
          },
          exception,
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error).toContain("current complete lifecycle permission exception");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", "dangerouslySkipPermissions"],
    ["codex_local", "dangerouslyBypassApprovalsAndSandbox"],
  ])("rejects explicit %s bypass on update without mutating", async (adapterType, key) => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType, adapterConfig: {} }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { [key]: true } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error).toContain("current complete lifecycle permission exception");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", "dangerouslySkipPermissions"],
    ["codex_local", "dangerouslyBypassApprovalsAndSandbox"],
  ])("defaults omitted %s bypass to false on update", async (adapterType, key) => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType, adapterConfig: {} }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "bounded-model" } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect((patch.adapterConfig as Record<string, unknown>)[key]).toBe(false);
  });

  it("disallows permission mutations through the general agent PATCH", async () => {
    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ permissions: { canCreateAgents: true } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error).toBe("Validation error");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("revalidates permissions-only updates against an existing bypass", async () => {
    const adapterConfig = { dangerouslySkipPermissions: true };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({
        canCreateAgents: false,
        canCreateSkills: true,
        canAssignTasks: false,
        bypass: {
          claudePermissionMode: true,
          codexApprovalsAndSandbox: false,
        },
        exception: { kind: "none" },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID Better Auth owner when no actual company user exists", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));
    mockAuthUserIds.clear();

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("rejects stale canary evidence that does not match the persisted run fingerprint", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    permissions.exception.evidence.configFingerprint = "f".repeat(64);
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_run_fingerprint_mismatch");
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("rejects when current adapter/runtime model-profile config differs from the canary", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const canaryRuntimeConfig = {
      modelProfiles: { cheap: { adapterConfig: { model: "canary-model" } } },
    };
    const currentRuntimeConfig = {
      modelProfiles: { cheap: { adapterConfig: { model: "changed-after-canary" } } },
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      runtimeConfig: currentRuntimeConfig,
      permissions,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-1",
      agentId: AGENT_ID,
      status: "succeeded",
      contextSnapshot: {
        issueId: CANARY_ISSUE_ID,
        paperclipWorkspace: { cwd: "/Users/marco/Code/paperclip" },
      },
      resultJson: {
        configFreshness: {
          session: {
            nextFingerprint: EFFECTIVE_CONFIG_FINGERPRINT,
            agentConfigurationFingerprint: agentConfigurationFingerprint(
              "claude_local",
              adapterConfig,
              canaryRuntimeConfig,
            ),
          },
        },
      },
    });

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_current_config_fingerprint_mismatch");
  });

  it("rejects a structurally valid exception without a completed linked Board approval", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_board_approval_missing");
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("rejects a Board approval bound to a different current configuration fingerprint", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    const decision = approvedBoardDecision("claude_permission_mode");
    decision.payload.agentConfigurationFingerprint = `v1:sha256:${"f".repeat(64)}`;
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([decision]);
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_board_approval_missing");
  });

  it("rejects a canary whose actual working directory is outside the approved roots", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-1",
      agentId: AGENT_ID,
      status: "succeeded",
      contextSnapshot: {
        issueId: CANARY_ISSUE_ID,
        paperclipWorkspace: { cwd: "/tmp/outside-approved-root" },
      },
      resultJson: {
        configFreshness: {
          session: {
            nextFingerprint: EFFECTIVE_CONFIG_FINGERPRINT,
            agentConfigurationFingerprint: agentConfigurationFingerprint(
              "claude_local",
              adapterConfig,
            ),
          },
        },
      },
    });

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_cwd_scope_mismatch");
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("rejects a symlink escape even when the lexical canary cwd is under an approved root", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-b6-scope-"));
    const approvedRoot = path.join(tempRoot, "approved");
    const outsideRoot = path.join(tempRoot, "outside");
    const symlinkCwd = path.join(approvedRoot, "escaped-cwd");
    await mkdir(approvedRoot);
    await mkdir(outsideRoot);
    await symlink(outsideRoot, symlinkCwd, "dir");
    try {
      const adapterConfig = {
        cwd: symlinkCwd,
        dangerouslySkipPermissions: true,
      };
      const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
      permissions.exception.scope.cwdRoots = [approvedRoot];
      const decision = approvedBoardDecision("claude_permission_mode");
      decision.payload.scope = permissions.exception.scope;
      decision.payload.agentConfigurationFingerprint = agentConfigurationFingerprint(
        "claude_local",
        adapterConfig,
      );
      mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([decision]);
      mockAgentService.getById.mockResolvedValue(makeAgent({
        adapterType: "claude_local",
        adapterConfig,
        permissions,
      }));
      mockHeartbeatService.getRun.mockResolvedValue({
        id: RUN_ID,
        companyId: "company-1",
        agentId: AGENT_ID,
        status: "succeeded",
        contextSnapshot: {
          issueId: CANARY_ISSUE_ID,
          paperclipWorkspace: { cwd: symlinkCwd },
        },
        resultJson: {
          configFreshness: {
            session: {
              nextFingerprint: EFFECTIVE_CONFIG_FINGERPRINT,
              agentConfigurationFingerprint: agentConfigurationFingerprint(
                "claude_local",
                adapterConfig,
              ),
            },
          },
        },
      });

      const response = await request(await createApp())
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateSkills: false });

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.details?.code).toBe("permission_exception_cwd_scope_mismatch");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a network-host exception because the current runtimes cannot enforce it", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    permissions.exception.scope.networkHosts = ["api.example.com"];
    const decision = approvedBoardDecision("claude_permission_mode");
    decision.payload.scope = permissions.exception.scope;
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([decision]);
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("permission_exception_network_scope_unenforceable");
  });

  it("rejects even a fully evidenced global bypass because its scope is not enforceable", async () => {
    const adapterConfig = {
      cwd: "/Users/marco/Code/paperclip",
      dangerouslySkipPermissions: true,
    };
    const permissions = approvedPermissions({ adapterType: "claude_local", adapterConfig });
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig,
      permissions,
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("global_permission_bypass_unenforceable");
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it("preserves the persisted tasks:assign grant on a partial permission PATCH", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(makeAgent({
      permissions: { canCreateAgents: false, canCreateSkills: true },
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.updatePermissions).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        canCreateAgents: false,
        canCreateSkills: false,
        canAssignTasks: true,
      }),
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      "company-1",
      "agent",
      AGENT_ID,
      "tasks:assign",
      true,
      "local-board",
    );
  });

  it("preserves an explicit persisted canAssignTasks manifest on a partial permission PATCH", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(makeAgent({
      permissions: {
        canCreateAgents: false,
        canCreateSkills: true,
        canAssignTasks: true,
      },
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ canCreateSkills: false });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.updatePermissions).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ canAssignTasks: true }),
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      "company-1",
      "agent",
      AGENT_ID,
      "tasks:assign",
      true,
      "local-board",
    );
  });

  it("deep-merges and revalidates a partial permission exception patch", async () => {
    const existingException = approvedException("claude_permission_mode");
    mockAgentService.getById.mockResolvedValue(makeAgent({
      adapterType: "claude_local",
      adapterConfig: {
        cwd: "/Users/marco/Code/paperclip",
        dangerouslySkipPermissions: true,
      },
      permissions: {
        canCreateAgents: false,
        bypass: { claudePermissionMode: true, codexApprovalsAndSandbox: false },
        exception: existingException,
      },
    }));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}/permissions`)
      .send({ exception: { evidence: { result: "passed" } } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("global_permission_bypass_unenforceable");
    expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", "--dangerously-skip-permissions"],
    ["codex_local", "--dangerously-bypass-approvals-and-sandbox"],
  ] as const)("rejects %s bypass smuggling through extraArgs on create", async (adapterType, flag) => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({ name: "Smuggled worker", adapterType, adapterConfig: { extraArgs: [flag] } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects legacy args bypass smuggling on hire", async () => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Smuggled hire",
        adapterType: "claude_local",
        adapterConfig: { args: ["--dangerously-skip-permissions"] },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects bypass smuggling through extraArgs on update", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType: "codex_local" }));
    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects a bypass hidden in a create-time model-profile adapter config", async () => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Profile-smuggled worker",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: { extraArgs: ["--dangerously-skip-permissions"] },
            },
          },
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects a bypass hidden in an update-time model-profile adapter config", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType: "codex_local" }));
    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                args: ["--dangerously-bypass-approvals-and-sandbox"],
              },
            },
          },
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", "args", "--dangerously-skip-permissions"],
    ["codex_local", "extraArgs", "--dangerously-bypass-approvals-and-sandbox"],
  ] as const)("rejects %s bypass smuggling on the environment probe", async (adapterType, field, flag) => {
    const response = await request(await createApp())
      .post(`/api/companies/company-1/adapters/${adapterType}/test-environment`)
      .send({ adapterConfig: { [field]: [flag] } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("global_permission_bypass_unenforceable");
  });

  it.each([
    ["create", "post", "/api/companies/company-1/agents"],
    ["hire", "post", "/api/companies/company-1/agent-hires"],
    ["update", "patch", `/api/agents/${AGENT_ID}`],
    ["probe", "post", "/api/companies/company-1/adapters/claude_local/test-environment"],
  ] as const)("rejects free-form Claude allowedTools on %s", async (_label, method, route) => {
    if (method === "patch") {
      mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType: "claude_local" }));
    }
    const client = request(await createApp());
    const payload = method === "patch"
      ? { adapterConfig: { allowedTools: ["Read", "Bash"] } }
      : route.includes("test-environment")
        ? { adapterConfig: { allowedTools: ["Read", "Bash"] } }
        : {
            name: "Free tool scope",
            adapterType: "claude_local",
            adapterConfig: { allowedTools: ["Read", "Bash"] },
          };
    const response = method === "patch"
      ? await client.patch(route).send(payload)
      : await client.post(route).send(payload);

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("claude_allowed_tools_board_manifest_required");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects free-form allowedTools hidden in a runtime model profile", async () => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Profile tool scope",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          modelProfiles: {
            cheap: { adapterConfig: { allowedTools: ["Read"] } },
          },
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("claude_allowed_tools_board_manifest_required");
  });

  it("rejects agent-self-managed free-form allowedTools", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ adapterType: "claude_local" }));
    const response = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
    }))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { allowedTools: ["Bash"] } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("claude_allowed_tools_board_manifest_required");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["claude_local", ["--permission-mode", "bypassPermissions"]],
    ["claude_local", ["--allow-dangerously-skip-permissions"]],
    ["codex_local", ["--sandbox=danger-full-access"]],
    ["codex_local", ["-a", "never"]],
    ["codex_local", ["-c", 'approval_policy="never"']],
    ["codex_local", ["--profile=unsafe"]],
  ] as const)("rejects non-allowlisted %s security arguments at the route boundary", async (adapterType, extraArgs) => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({ name: "Policy smuggling", adapterType, adapterConfig: { extraArgs } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("adapter_security_args_not_allowlisted");
  });

  it("rejects direct Codex sandbox policy keys at the route boundary", async () => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Direct sandbox policy",
        adapterType: "codex_local",
        adapterConfig: { sandbox: "danger-full-access" },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("adapter_security_args_not_allowlisted");
  });

  it("rejects alternate Codex policy overrides hidden in a runtime model profile", async () => {
    const response = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Profile policy smuggling",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: { extraArgs: ["--config=approval_policy=\"never\""] },
            },
          },
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.details?.code).toBe("adapter_security_args_not_allowlisted");
  });

  it.each([
    ["lifecycle", "lifecycle_invalid"],
    ["fingerprint", "fingerprint_mismatch"],
    ["freshness", "freshness_expired"],
    ["permission", "permission_mismatch"],
    ["fresh_session", "fresh_session_required"],
  ] as const)("blocks resume on %s lifecycle gate failure without mutation", async (failure, expectedReason) => {
    mockAgentService.getById.mockResolvedValue(governedAgentFailure(failure));

    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe("lifecycle_gate_failed");
    expect(response.body.details?.reason).toBe(expectedReason);
    expect(mockAgentService.resume).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["lifecycle", "lifecycle_invalid"],
    ["fingerprint", "fingerprint_mismatch"],
    ["freshness", "freshness_expired"],
    ["permission", "permission_mismatch"],
    ["fresh_session", "fresh_session_required"],
  ] as const)("blocks PATCH status=idle on %s gate failure without mutation", async (failure, expectedReason) => {
    mockAgentService.getById.mockResolvedValue(governedAgentFailure(failure));

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ status: "idle" });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe("lifecycle_gate_failed");
    expect(response.body.details?.reason).toBe(expectedReason);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("resumes an agent only after an exact current lifecycle receipt", async () => {
    mockAgentService.getById.mockResolvedValue(governedPausedAgent());

    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.resume).toHaveBeenCalledWith(AGENT_ID);
  });

  it("blocks clear-error when the lifecycle gate is stale without mutating the agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...governedAgentFailure("fingerprint"),
      status: "error",
    });

    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/clear-error`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe("lifecycle_gate_failed");
    expect(response.body.details?.reason).toBe("fingerprint_mismatch");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
  });

  it("queues exactly one server-bound fresh run for a valid pending-canary resume", async () => {
    const existing = pendingCanaryAgent({ companyId: CANARY_COMPANY_ID });
    mockAgentService.getById.mockResolvedValue(existing);
    const expectedConfigFingerprint = pendingCanaryFingerprint(existing);

    const response = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [CANARY_COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({
        mode: "pending_canary",
        canaryIssueId: CANARY_ISSUE_ID,
        expectedConfigFingerprint,
        expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body).toMatchObject({
      agentId: AGENT_ID,
      canaryIssueId: CANARY_ISSUE_ID,
      runId: expect.any(String),
      receiptExpiresAt: expect.any(String),
    });
    expect(mockHeartbeatService.enqueueLifecycleCanary).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT_ID,
      companyId: CANARY_COMPANY_ID,
      canaryIssueId: CANARY_ISSUE_ID,
      receipt: expect.objectContaining({
        agentId: AGENT_ID,
        companyId: CANARY_COMPANY_ID,
        canaryIssueId: CANARY_ISSUE_ID,
        configFingerprint: expectedConfigFingerprint,
        runId: response.body.runId,
      }),
    }));
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("supports the real board sequence pending:null to issue patch, preflight, and CAS-bound resume", async () => {
    const initialLifecycle = lifecycle({
      canaryIssueId: null,
      lastCanaryAt: null,
      lastCanaryResult: "pending",
    });
    let current = pendingCanaryAgent({
      companyId: CANARY_COMPANY_ID,
      metadata: { lifecycle: initialLifecycle },
    });
    mockAgentService.getById.mockImplementation(async () => current);
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      current = {
        ...current,
        ...patch,
        updatedAt: new Date("2026-07-13T12:05:00.000Z"),
      };
      return current;
    });
    const actor = {
      type: "board",
      userId: "local-board",
      companyIds: [CANARY_COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const app = await createApp(actor);

    const patchResponse = await request(app)
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        metadata: {
          lifecycle: {
            ...initialLifecycle,
            canaryIssueId: CANARY_ISSUE_ID,
          },
        },
      });
    expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(200);

    const preflight = await request(app)
      .get(`/api/agents/${AGENT_ID}/lifecycle-canary-preflight`);
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200);
    expect(preflight.body).toMatchObject({
      agentId: AGENT_ID,
      companyId: CANARY_COMPANY_ID,
      canaryIssueId: CANARY_ISSUE_ID,
      ready: true,
      blockers: [],
      configFingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      agentUpdatedAt: "2026-07-13T12:05:00.000Z",
    });

    const resume = await request(app)
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({
        mode: "pending_canary",
        canaryIssueId: preflight.body.canaryIssueId,
        expectedConfigFingerprint: preflight.body.configFingerprint,
        expectedAgentUpdatedAt: preflight.body.agentUpdatedAt,
      });
    expect(resume.status, JSON.stringify(resume.body)).toBe(202);
    expect(mockHeartbeatService.enqueueLifecycleCanary).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT_ID,
      companyId: CANARY_COMPANY_ID,
      canaryIssueId: CANARY_ISSUE_ID,
      expectedAgentUpdatedAt: new Date("2026-07-13T12:05:00.000Z"),
      receipt: expect.objectContaining({
        configFingerprint: preflight.body.configFingerprint,
      }),
    }));
  });

  it("keeps lifecycle canary preflight strictly read-only", async () => {
    const existing = pendingCanaryAgent({ companyId: CANARY_COMPANY_ID });
    mockAgentService.getById.mockResolvedValue(existing);

    const response = await request(await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [CANARY_COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    })).get(`/api/agents/${AGENT_ID}/lifecycle-canary-preflight`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      ready: true,
      canaryIssueId: CANARY_ISSUE_ID,
      configFingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      agentUpdatedAt: existing.updatedAt.toISOString(),
    });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.resume).not.toHaveBeenCalled();
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
    expect(mockHeartbeatService.enqueueLifecycleCanary).not.toHaveBeenCalled();
  });

  it.each([
    ["not paused", () => pendingCanaryAgent({ status: "idle" }), null, "agent_lifecycle_canary_status_invalid"],
    ["failed lifecycle", () => {
      const agent = pendingCanaryAgent();
      const metadata = agent.metadata as Record<string, any>;
      const failedAt = new Date().toISOString();
      return {
        ...agent,
        metadata: {
          ...metadata,
          lifecycle: {
            ...metadata.lifecycle,
            lastCanaryResult: "failed",
            lastCanaryAt: failedAt,
            pause: {
              reasonCode: "canary_failed",
              reasonDetail: "Reviewed repair is required.",
              outcome: "failed",
              repairIssueId: CANARY_ISSUE_ID,
              startedAt: failedAt,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
            },
          },
        },
      };
    }, null, "agent_lifecycle_canary_lifecycle_invalid"],
    ["issue mismatch", () => pendingCanaryAgent(), "77777777-7777-4777-8777-777777777777", "agent_lifecycle_canary_issue_mismatch"],
    ["stale fingerprint", () => pendingCanaryAgent(), null, "agent_lifecycle_canary_fingerprint_mismatch"],
  ] as const)("rejects pending-canary resume on %s without queuing", async (_label, buildAgent, issueOverride, expectedCode) => {
    const existing = buildAgent();
    mockAgentService.getById.mockResolvedValue(existing);
    const expectedConfigFingerprint = expectedCode === "agent_lifecycle_canary_fingerprint_mismatch"
      ? `v1:sha256:${"f".repeat(64)}`
      : pendingCanaryFingerprint(existing);

    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({
        mode: "pending_canary",
        canaryIssueId: issueOverride ?? CANARY_ISSUE_ID,
        expectedConfigFingerprint,
        expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe(expectedCode);
    expect(mockHeartbeatService.enqueueLifecycleCanary).not.toHaveBeenCalled();
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("rejects client-supplied canary run IDs before route execution", async () => {
    const existing = pendingCanaryAgent();
    mockAgentService.getById.mockResolvedValue(existing);

    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({
        mode: "pending_canary",
        canaryIssueId: CANARY_ISSUE_ID,
        expectedConfigFingerprint: pendingCanaryFingerprint(existing),
        expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
        runId: RUN_ID,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockHeartbeatService.enqueueLifecycleCanary).not.toHaveBeenCalled();
  });

  it("preserves lifecycle metadata while allowing an unrelated metadata update on a paused agent", async () => {
    const existing = governedPausedAgent();
    mockAgentService.getById.mockResolvedValue(existing);

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ metadata: { note: "reviewed while paused" } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        metadata: expect.objectContaining({
          note: "reviewed while paused",
          lifecycle: (existing.metadata as Record<string, unknown>).lifecycle,
          lifecycleGate: (existing.metadata as Record<string, unknown>).lifecycleGate,
        }),
      }),
      expect.anything(),
    );
  });

  it("rejects an invalid lifecycle metadata patch before any mutation", async () => {
    mockAgentService.getById.mockResolvedValue(governedPausedAgent());

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ metadata: { lifecycle: { schemaVersion: "1.0.0" } } });

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects removal of an existing lifecycle contract through metadata=null", async () => {
    mockAgentService.getById.mockResolvedValue(governedPausedAgent());

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ metadata: null });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.code).toBe("agent_lifecycle_removal_forbidden");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["missing lifecycle", () => makeAgent({ status: "paused", metadata: null })],
    ["pending lifecycle without an issue", () => pendingCanaryAgent({
      metadata: {
        lifecycle: lifecycle({
          canaryIssueId: null,
          lastCanaryAt: null,
          lastCanaryResult: "pending",
        }),
      },
    })],
    ["failed lifecycle", () => failedCanaryAgent()],
  ] as const)("rejects forged passed-canary evidence from a %s without creating a gate", async (_label, buildAgent) => {
    mockAgentService.getById.mockResolvedValue(buildAgent());

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ metadata: { lifecycle: lifecycle() } });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe("agent_lifecycle_transition_forbidden");
    expect(response.body.details?.reason).toBe("passed_evidence_forbidden");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects rewriting passed-canary timestamp evidence and leaves the existing gate untouched", async () => {
    const existing = governedPausedAgent();
    const existingMetadata = existing.metadata as Record<string, any>;
    mockAgentService.getById.mockResolvedValue(existing);

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        metadata: {
          lifecycle: {
            ...existingMetadata.lifecycle,
            lastCanaryAt: new Date().toISOString(),
          },
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details?.reason).toBe("canary_evidence_changed");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect((existing.metadata as Record<string, any>).lifecycleGate).toEqual(existingMetadata.lifecycleGate);
  });

  it("resets failed to pending only through an exact reviewed repair CAS bound to the failed issue", async () => {
    const existing = failedCanaryAgent();
    mockAgentService.getById.mockResolvedValue(existing);
    const failed = (existing.metadata as Record<string, any>).lifecycle;
    const pending = {
      ...failed,
      lastCanaryResult: "pending",
      lastCanaryAt: null,
      pause: undefined,
    };

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        metadata: { lifecycle: pending },
        lifecycleTransition: {
          mode: "reviewed_failed_repair",
          repairIssueId: CANARY_ISSUE_ID,
          expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [updatedId, patch, options] = mockAgentService.update.mock.calls.at(-1)!;
    expect(updatedId).toBe(AGENT_ID);
    expect(patch).toMatchObject({
      metadata: {
        lifecycle: {
          lastCanaryResult: "pending",
          lastCanaryAt: null,
          canaryIssueId: CANARY_ISSUE_ID,
        },
      },
    });
    expect(patch).not.toHaveProperty("lifecycleTransition");
    expect(options).toMatchObject({
      lifecycleTransition: {
        mode: "reviewed_failed_repair",
        repairIssueId: CANARY_ISSUE_ID,
        expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
      },
    });
  });

  it.each([
    ["missing review control", undefined, "reviewed_repair_required"],
    ["stale CAS", {
      mode: "reviewed_failed_repair",
      repairIssueId: CANARY_ISSUE_ID,
      expectedAgentUpdatedAt: "2026-07-12T00:00:00.000Z",
    }, "repair_cas_mismatch"],
    ["wrong repair issue", {
      mode: "reviewed_failed_repair",
      repairIssueId: "77777777-7777-4777-8777-777777777777",
      expectedAgentUpdatedAt: "2026-07-13T00:00:00.000Z",
    }, "repair_issue_mismatch"],
  ] as const)("rejects failed-to-pending repair with %s", async (_label, transition, reason) => {
    const existing = failedCanaryAgent();
    mockAgentService.getById.mockResolvedValue(existing);
    const failed = (existing.metadata as Record<string, any>).lifecycle;
    const body: Record<string, unknown> = {
      metadata: {
        lifecycle: {
          ...failed,
          lastCanaryResult: "pending",
          lastCanaryAt: null,
          pause: undefined,
        },
      },
    };
    if (transition) body.lifecycleTransition = transition;

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send(body);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details?.reason).toBe(reason);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("atomically pauses and strips every lifecycle gate for a reviewed passed-canary revalidation", async () => {
    const governed = governedPausedAgent({ status: "idle" });
    const governedMetadata = governed.metadata as Record<string, any>;
    const existing = {
      ...governed,
      metadata: {
        ...governedMetadata,
        lifecycleCanaryGate: { receiptHash: "server-canary-receipt" },
        canaryGate: { receiptHash: "legacy-server-receipt" },
      },
    };
    mockAgentService.getById.mockResolvedValue(existing);
    const pending = {
      ...governedMetadata.lifecycle,
      lastCanaryResult: "pending",
      lastCanaryAt: null,
    };
    const transition = {
      mode: "reviewed_passed_revalidation",
      canaryIssueId: CANARY_ISSUE_ID,
      decisionIssueId: EXCEPTION_ISSUE_ID,
      reasonCode: "runtime_evidence_invalidated",
      expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
    };

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        status: "paused",
        metadata: { lifecycle: pending },
        lifecycleTransition: transition,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [updatedId, patch, options] = mockAgentService.update.mock.calls.at(-1)!;
    expect(updatedId).toBe(AGENT_ID);
    expect(patch.status).toBe("paused");
    expect(patch.metadata.lifecycle).toMatchObject({
      canaryIssueId: CANARY_ISSUE_ID,
      decisionIssueId: EXCEPTION_ISSUE_ID,
      lastCanaryResult: "pending",
      lastCanaryAt: null,
    });
    expect(patch.metadata).not.toHaveProperty("lifecycleGate");
    expect(patch.metadata).not.toHaveProperty("lifecycleCanaryGate");
    expect(patch.metadata).not.toHaveProperty("canaryGate");
    expect(options).toMatchObject({ lifecycleTransition: transition });
    expect(mockAgentService.updateLifecycleGate).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.updated",
      details: expect.objectContaining({
        lifecycleTransition: transition,
      }),
    }));
  });

  it.each([
    ["stale CAS", (transition: Record<string, unknown>, pending: Record<string, unknown>) => ({
      transition: { ...transition, expectedAgentUpdatedAt: "2026-07-12T00:00:00.000Z" },
      pending,
      extra: {},
      reason: "revalidation_cas_mismatch",
    })],
    ["wrong canary issue", (transition: Record<string, unknown>, pending: Record<string, unknown>) => ({
      transition: { ...transition, canaryIssueId: "77777777-7777-4777-8777-777777777777" },
      pending,
      extra: {},
      reason: "revalidation_issue_mismatch",
    })],
    ["wrong decision issue", (transition: Record<string, unknown>, pending: Record<string, unknown>) => ({
      transition: { ...transition, decisionIssueId: "77777777-7777-4777-8777-777777777777" },
      pending,
      extra: {},
      reason: "revalidation_decision_issue_mismatch",
    })],
    ["policy mutation", (transition: Record<string, unknown>, pending: Record<string, unknown>) => ({
      transition,
      pending: { ...pending, canaryFreshnessDays: 7 },
      extra: {},
      reason: "revalidation_policy_mismatch",
    })],
    ["fingerprint mutation", (transition: Record<string, unknown>, pending: Record<string, unknown>) => ({
      transition,
      pending,
      extra: { adapterConfig: { model: "changed-during-revalidation" } },
      reason: "revalidation_fingerprint_mutation",
    })],
  ] as const)("rejects reviewed passed-canary revalidation with %s", async (_label, mutate) => {
    const existing = governedPausedAgent({ status: "idle" });
    mockAgentService.getById.mockResolvedValue(existing);
    const lifecycleValue = (existing.metadata as Record<string, any>).lifecycle;
    const pending = {
      ...lifecycleValue,
      lastCanaryResult: "pending",
      lastCanaryAt: null,
    };
    const transition = {
      mode: "reviewed_passed_revalidation",
      canaryIssueId: CANARY_ISSUE_ID,
      decisionIssueId: EXCEPTION_ISSUE_ID,
      reasonCode: "runtime_evidence_invalidated",
      expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
    };
    const changed = mutate(transition, pending);

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        status: "paused",
        metadata: { lifecycle: changed.pending },
        lifecycleTransition: changed.transition,
        ...changed.extra,
      });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details?.reason).toBe(changed.reason);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.updateLifecycleGate).not.toHaveBeenCalled();
  });

  it("rejects reviewed passed-canary revalidation from a non-board actor", async () => {
    const existing = governedPausedAgent({ status: "idle" });
    mockAgentService.getById.mockResolvedValue(existing);
    const lifecycleValue = (existing.metadata as Record<string, any>).lifecycle;

    const response = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId: RUN_ID,
    }))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({
        status: "paused",
        metadata: {
          lifecycle: {
            ...lifecycleValue,
            lastCanaryResult: "pending",
            lastCanaryAt: null,
          },
        },
        lifecycleTransition: {
          mode: "reviewed_passed_revalidation",
          canaryIssueId: CANARY_ISSUE_ID,
          decisionIssueId: EXCEPTION_ISSUE_ID,
          reasonCode: "runtime_evidence_invalidated",
          expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
        },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.updateLifecycleGate).not.toHaveBeenCalled();
  });

  it("invalidates the lifecycle receipt when paused configuration changes", async () => {
    const existing = governedPausedAgent();
    mockAgentService.getById.mockResolvedValue(existing);

    const response = await request(await createApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6-luna" } });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, any>;
    expect(patch.metadata.lifecycleGate).toMatchObject({
      freshSessionRequired: true,
    });
    expect(patch.metadata.lifecycleGate.configFingerprint).not.toBe(
      (existing.metadata as Record<string, any>).lifecycleGate.configFingerprint,
    );
    expect(mockAgentService.updateLifecycleGate).toHaveBeenCalledWith(
      AGENT_ID,
      patch,
      expect.objectContaining({
        lifecycleGate: patch.metadata.lifecycleGate,
        expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
      }),
    );
  });

  it("keeps an empty pause request manual and logs only the persisted reason", async () => {
    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.pause).toHaveBeenCalledWith(AGENT_ID, "manual", undefined);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.paused",
      details: { pauseReason: "manual" },
    }));
  });

  it("passes only a validated maintenance operation and logs the verified correlation", async () => {
    const operationId = "99999999-9999-4999-8999-999999999999";
    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({ reason: "maintenance", operationId });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.pause).toHaveBeenCalledWith(
      AGENT_ID,
      "maintenance",
      { maintenanceOperationId: operationId },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.paused",
      details: { pauseReason: "maintenance", maintenanceOperationId: operationId },
    }));
  });

  it.each([
    ["missing operation", { reason: "maintenance" }],
    ["invalid operation", { reason: "maintenance", operationId: "TEC-355" }],
    ["internal budget reason", { reason: "budget" }],
    ["free-form detail", {
      reason: "maintenance",
      operationId: "99999999-9999-4999-8999-999999999999",
      reasonDetail: "must not cross the API boundary",
    }],
  ])("rejects %s without a pause mutation", async (_label, body) => {
    const response = await request(await createApp())
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send(body);

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("keeps the pause endpoint board-only", async () => {
    const response = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
    }))
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import * as shared from "../index.js";
import * as agentValidators from "./agent.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function isoFromNow(days: number) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function validLifecycle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0.0",
    owner: { ownerType: "board_user", ownerUserId: "better-auth:user-marco" },
    purpose: "Own a bounded Paperclip role.",
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
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    lastCanaryAt: isoFromNow(-1),
    lastCanaryResult: "passed",
    canaryFreshnessDays: 30,
    reviewAt: isoFromNow(20),
    retirementCriterion: "Retire after reviewed inactivity and replacement evidence.",
    decisionIssueId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function validApprovedException(overrides: Record<string, unknown> = {}) {
  return {
    kind: "approved",
    exceptionIssueId: "22222222-2222-4222-8222-222222222222",
    owner: { ownerType: "board_user", ownerUserId: "better-auth:user-marco" },
    scope: {
      cwdRoots: ["/Users/marco/Code/paperclip"],
      tools: ["Read"],
      networkHosts: [],
      bypasses: ["claude_permission_mode"],
    },
    justification: "A bounded reviewed exception is required.",
    evidence: {
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      configFingerprint: "a".repeat(64),
      result: "passed",
    },
    approvedAt: isoFromNow(-1),
    expiresAt: isoFromNow(10),
    ...overrides,
  };
}

describe("agent lifecycle contract", () => {
  it("exports the typed lifecycle and receipt schemas", () => {
    const validators = agentValidators as Record<string, unknown>;

    expect(validators.agentLifecycleSchema).toBeDefined();
    expect(validators.agentLifecycleGateSchema).toBeDefined();
    expect(validators.agentLifecycleCanaryGateSchema).toBeDefined();
    expect(validators.resumeAgentSchema).toBeDefined();
    expect(validators.agentLifecyclePermissionExceptionSchema).toBeDefined();
    expect((shared as Record<string, unknown>).agentLifecycleSchema).toBeDefined();
    expect((shared as Record<string, unknown>).agentLifecycleGateSchema).toBeDefined();
    expect((shared as Record<string, unknown>).agentLifecycleCanaryGateSchema).toBeDefined();
    expect((shared as Record<string, unknown>).resumeAgentSchema).toBeDefined();
  });

  it("accepts a complete lifecycle and rejects unknown fields", () => {
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle()).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({ shadowMode: "standby" })).success).toBe(false);
  });

  it("enforces exactly one typed owner reference", () => {
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      owner: {
        ownerType: "agent",
        ownerAgentId: "11111111-1111-4111-8111-111111111111",
        ownerUserId: "better-auth:user-marco",
      },
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      owner: { ownerType: "board_role", ownerRoleSlug: "company-owner" },
    })).success).toBe(true);
  });

  it("enforces operating-mode and service-level exceptions", () => {
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      operatingMode: "manual_assignment_only",
      serviceLevel: {
        availabilityClass: "on_demand",
        triageTargetMinutes: null,
        completionTargetMinutes: null,
        targetExceptionReason: "This role is assigned manually.",
      },
    })).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      operatingMode: "manual_assignment_only",
      serviceLevel: {
        availabilityClass: "on_demand",
        triageTargetMinutes: null,
        completionTargetMinutes: null,
        targetExceptionReason: null,
      },
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({ operatingMode: "standby" })).success).toBe(false);
  });

  it("rejects expired or overlong pause windows without a reviewed exception", () => {
    const pause = {
      reasonCode: "canary_failed",
      reasonDetail: "Canary attempted an undeclared tool.",
      outcome: "undeclared_tool",
      repairIssueId: "66666666-6666-4666-8666-666666666666",
      startedAt: isoFromNow(-2),
      expiresAt: isoFromNow(10),
    };
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({ pause })).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      pause: { ...pause, expiresAt: isoFromNow(-1) },
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      pause: { ...pause, expiresAt: isoFromNow(40) },
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      pause: {
        ...pause,
        expiresAt: isoFromNow(40),
        exceptionApprovedByUserId: "better-auth:user-marco",
        exceptionReason: "A dependency migration needs a bounded extension.",
      },
    })).success).toBe(true);
  });

  it("requires exact replacement references and current canary evidence", () => {
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      replacementAgentId: "11111111-1111-4111-8111-111111111111",
    })).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      replacementAgentId: "11111111-1111-4111-8111-111111111111",
      replacementSystemRef: "system:replacement",
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      lastCanaryResult: "pending",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      lastCanaryAt: null,
    })).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      lastCanaryResult: "pending",
      canaryIssueId: null,
      lastCanaryAt: null,
    })).success).toBe(true);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({
      lastCanaryResult: "passed",
      canaryIssueId: null,
      lastCanaryAt: null,
    })).success).toBe(false);
    expect(agentValidators.agentLifecycleSchema.safeParse(validLifecycle({ canaryFreshnessDays: 91 })).success).toBe(false);
  });

  it("strictly validates bounded permission exceptions", () => {
    expect(agentValidators.agentLifecyclePermissionExceptionSchema.safeParse({ kind: "none" }).success).toBe(true);
    expect(agentValidators.agentLifecyclePermissionExceptionSchema.safeParse(validApprovedException()).success).toBe(true);
    expect(agentValidators.agentLifecyclePermissionExceptionSchema.safeParse(validApprovedException({
      expiresAt: isoFromNow(31),
    })).success).toBe(false);
    expect(agentValidators.agentLifecyclePermissionExceptionSchema.safeParse(validApprovedException({
      unexpected: true,
    })).success).toBe(false);
  });

  it("strictly validates server-calculated lifecycle receipts", () => {
    const receipt = {
      schemaVersion: "1.0.0",
      configFingerprint: `v1:sha256:${"a".repeat(64)}`,
      validatedAt: isoFromNow(-1),
      expiresAt: isoFromNow(10),
      findingCount: 0,
      receiptHash: `v1:sha256:${"b".repeat(64)}`,
      freshSessionRequired: false,
      lastSatisfiedRunId: "55555555-5555-4555-8555-555555555555",
    };
    expect(agentValidators.agentLifecycleGateSchema.safeParse(receipt).success).toBe(true);
    expect(agentValidators.agentLifecycleGateSchema.safeParse({ ...receipt, findingCount: 1 }).success).toBe(false);
    expect(agentValidators.agentLifecycleGateSchema.safeParse({ ...receipt, injected: true }).success).toBe(false);
  });

  it("strictly validates short-lived one-shot lifecycle canary receipts", () => {
    const issuedAt = new Date();
    const receipt = {
      schemaVersion: "1.0.0",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "33333333-3333-4333-8333-333333333333",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      configFingerprint: `v1:sha256:${"a".repeat(64)}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 15 * 60 * 1_000).toISOString(),
      receiptHash: `v1:sha256:${"b".repeat(64)}`,
    };

    expect(agentValidators.agentLifecycleCanaryGateSchema.safeParse(receipt).success).toBe(true);
    expect(agentValidators.agentLifecycleCanaryGateSchema.safeParse({
      ...receipt,
      expiresAt: new Date(issuedAt.getTime() + 15 * 60 * 1_000 + 1).toISOString(),
    }).success).toBe(false);
    expect(agentValidators.agentLifecycleCanaryGateSchema.safeParse({ ...receipt, runId: null }).success).toBe(false);
    expect(agentValidators.agentLifecycleCanaryGateSchema.safeParse({ ...receipt, injected: true }).success).toBe(false);
  });

  it("keeps normal resume backward compatible and strictly validates pending-canary input", () => {
    const fingerprint = `v1:sha256:${"a".repeat(64)}`;
    expect(agentValidators.resumeAgentSchema.safeParse({}).success).toBe(true);
    expect(agentValidators.resumeAgentSchema.safeParse({ mode: "normal" }).success).toBe(true);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: fingerprint,
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
    }).success).toBe(true);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: fingerprint,
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
      systemReplacementProof: {
        schemaVersion: "1.0.0",
        sourceAgentId: "0e989281-9933-47b9-87e5-b6da87d4d0a9",
        replacementSystemRef: "workspace:projects/kaffee",
        scenario: "workspace-project-binding",
        nonce: "a".repeat(32),
        observedRef: "workspace:projects/kaffee:PROJECT.md",
        observedSha256: "b".repeat(64),
      },
    }).success).toBe(true);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: fingerprint,
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
      systemReplacementProof: {
        schemaVersion: "1.0.0",
        sourceAgentId: "0e989281-9933-47b9-87e5-b6da87d4d0a9",
        replacementSystemRef: "workspace:projects/not-kaffee",
        scenario: "workspace-project-binding",
        nonce: "a".repeat(32),
        observedRef: "workspace:projects/kaffee:PROJECT.md",
        observedSha256: "b".repeat(64),
      },
    }).success).toBe(false);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: fingerprint,
    }).success).toBe(false);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: fingerprint,
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
      runId: "55555555-5555-4555-8555-555555555555",
    }).success).toBe(false);
    expect(agentValidators.resumeAgentSchema.safeParse({
      mode: "pending_canary",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      expectedConfigFingerprint: "client-controlled",
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
    }).success).toBe(false);
  });

  it("allows unrelated metadata updates but rejects invalid lifecycle metadata atomically", () => {
    expect(agentValidators.updateAgentSchema.safeParse({ metadata: { note: "still paused" } }).success).toBe(true);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: validLifecycle() },
    }).success).toBe(true);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: validLifecycle({ operatingMode: "standby" }) },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: {
        lifecycle: validLifecycle(),
        lifecycleGate: { configFingerprint: "client-forged" },
      },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: {
        lifecycle: validLifecycle(),
        lifecycleCanaryGate: { receiptHash: "client-forged" },
      },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: {
        lifecycle: validLifecycle(),
        canaryGate: { receiptHash: "legacy-client-forged" },
      },
    }).success).toBe(false);
  });

  it("strictly validates the explicit reviewed failed-canary repair control", () => {
    const repair = {
      mode: "reviewed_failed_repair",
      repairIssueId: "44444444-4444-4444-8444-444444444444",
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
    };
    const pending = validLifecycle({
      canaryIssueId: repair.repairIssueId,
      lastCanaryAt: null,
      lastCanaryResult: "pending",
    });

    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: pending },
      lifecycleTransition: repair,
    }).success).toBe(true);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...repair, expectedAgentUpdatedAt: undefined },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...repair, repairIssueId: "not-a-uuid" },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...repair, injected: true },
    }).success).toBe(false);
  });

  it("strictly validates the reviewed passed-canary revalidation control", () => {
    const revalidation = {
      mode: "reviewed_passed_revalidation",
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      decisionIssueId: "22222222-2222-4222-8222-222222222222",
      reasonCode: "runtime_evidence_invalidated",
      expectedAgentUpdatedAt: "2026-07-13T12:00:00.000Z",
    };
    const pending = validLifecycle({
      canaryIssueId: revalidation.canaryIssueId,
      lastCanaryAt: null,
      lastCanaryResult: "pending",
    });

    expect(agentValidators.updateAgentSchema.safeParse({
      status: "paused",
      metadata: { lifecycle: pending },
      lifecycleTransition: revalidation,
    }).success).toBe(true);
    expect(agentValidators.updateAgentSchema.safeParse({
      status: "paused",
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...revalidation, reasonCode: "operator_requested" },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      status: "paused",
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...revalidation, decisionIssueId: "not-a-uuid" },
    }).success).toBe(false);
    expect(agentValidators.updateAgentSchema.safeParse({
      status: "paused",
      metadata: { lifecycle: pending },
      lifecycleTransition: { ...revalidation, injected: true },
    }).success).toBe(false);
  });
});

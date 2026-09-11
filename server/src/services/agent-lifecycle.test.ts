import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentLifecycle, AgentLifecycleGate } from "@paperclipai/shared";
import * as lifecycleService from "./agent-lifecycle.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
// The lifecycle validator resolves "review overdue" and "canary timestamp in the
// future" against Date.now(), so the suite pins the system clock to NOW. Without
// the pin every fixed fixture date below rots once NOW passes in real time.
const DAY_MS = 24 * 60 * 60 * 1_000;
const OVERDUE_REVIEW_AT = new Date(NOW.getTime() - 7 * DAY_MS).toISOString();
const RENEWED_REVIEW_AT = new Date(NOW.getTime() + 30 * DAY_MS).toISOString();

beforeAll(() => {
  vi.useFakeTimers({ now: NOW });
});

afterAll(() => {
  vi.useRealTimers();
});

function lifecycle(overrides: Partial<AgentLifecycle> = {}): AgentLifecycle {
  return {
    schemaVersion: "1.0.0",
    owner: { ownerType: "board_user", ownerUserId: "better-auth:user-marco" },
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
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    lastCanaryAt: "2026-07-12T12:00:00.000Z",
    lastCanaryResult: "passed",
    canaryFreshnessDays: 30,
    reviewAt: "2026-08-12T12:00:00.000Z",
    retirementCriterion: "Retire only after a reviewed replacement canary.",
    decisionIssueId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function pendingLifecycle(overrides: Partial<AgentLifecycle> = {}): AgentLifecycle {
  return lifecycle({
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    lastCanaryAt: null,
    lastCanaryResult: "pending",
    ...overrides,
  });
}

function fingerprintInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "33333333-3333-4333-8333-333333333333",
    adapterType: "codex_local",
    adapterConfig: { model: "gpt-5.6-terra", reasoning: "medium" },
    runtimeConfig: { profileRef: "paperclip:runtime:bounded" },
    permissions: {
      canCreateAgents: false,
      canCreateSkills: true,
      bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: false },
      exception: { kind: "none" },
    },
    grants: [{ permissionKey: "tasks:assign", scope: { projectId: "project-1" } }],
    desiredSkills: [{ key: "paperclipai/paperclip/paperclip", skillId: "skill-1", versionId: "version-1" }],
    lifecycle: lifecycle(),
    contextPackSha256: `sha256:${"1".repeat(64)}`,
    managedInstructionsSha256: `sha256:${"2".repeat(64)}`,
    companyProfileSha256: `sha256:${"3".repeat(64)}`,
    ...overrides,
  };
}

function createReceipt(overrides: Record<string, unknown> = {}) {
  return lifecycleService.createAgentLifecycleValidationReceipt({
    fingerprintInput: fingerprintInput(),
    now: NOW,
    ...overrides,
  });
}

describe("agent lifecycle service", () => {
  it("exports canonical fingerprint, receipt, validation, and fresh-session helpers", () => {
    const service = lifecycleService as Record<string, unknown>;

    expect(service.computeAgentLifecycleConfigFingerprint).toBeDefined();
    expect(service.createAgentLifecycleValidationReceipt).toBeDefined();
    expect(service.validateAgentLifecycleGate).toBeDefined();
    expect(service.satisfyAgentLifecycleFreshSession).toBeDefined();
    expect(service.hashAgentLifecycleContent).toBeDefined();
    expect(service.createAgentLifecycleCanaryReceipt).toBeDefined();
    expect(service.validateAgentLifecycleCanaryReceipt).toBeDefined();
    expect(service.parseAgentLifecycleCanaryGate).toBeDefined();
  });

  it("hashes context and instruction content deterministically", () => {
    const first = lifecycleService.hashAgentLifecycleContent({
      "AGENTS.md": "bounded instructions",
      "policy.md": "policy",
    });
    const second = lifecycleService.hashAgentLifecycleContent({
      "policy.md": "policy",
      "AGENTS.md": "bounded instructions",
    });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("projects all governance inputs through the canonical effective-run fingerprint", () => {
    const base = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput());
    const reordered = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      permissions: {
        exception: { kind: "none" },
        bypass: { codexApprovalsAndSandbox: false, claudePermissionMode: false },
        canCreateSkills: true,
        canCreateAgents: false,
      },
      grants: [{ scope: { projectId: "project-1" }, permissionKey: "tasks:assign" }],
    }));

    expect(base).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(reordered).toBe(base);
    for (const changed of [
      fingerprintInput({ adapterConfig: { model: "gpt-5.6-luna", reasoning: "low" } }),
      fingerprintInput({ grants: [{ permissionKey: "agents:create", scope: null }] }),
      fingerprintInput({ desiredSkills: [{ key: "paperclipai/paperclip/paperclip", versionId: "version-2" }] }),
      fingerprintInput({ desiredSkills: [{ key: "paperclipai/paperclip/paperclip", skillId: "skill-2", versionId: "version-1" }] }),
      fingerprintInput({ contextPackSha256: `sha256:${"4".repeat(64)}` }),
      fingerprintInput({ managedInstructionsSha256: `sha256:${"5".repeat(64)}` }),
      fingerprintInput({ companyProfileSha256: `sha256:${"6".repeat(64)}` }),
      fingerprintInput({ lifecycle: lifecycle({ purpose: "Changed bounded purpose." }) }),
    ]) {
      expect(lifecycleService.computeAgentLifecycleConfigFingerprint(changed)).not.toBe(base);
    }
  });

  it("binds the resolved company skill identity even when key and version stay unchanged", () => {
    const first = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      desiredSkills: [{
        key: "paperclipai/paperclip/paperclip",
        skillId: "skill-1",
        versionId: "version-1",
      }],
    }));
    const replacement = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      desiredSkills: [{
        key: "paperclipai/paperclip/paperclip",
        skillId: "skill-2",
        versionId: "version-1",
      }],
    }));

    expect(replacement).not.toBe(first);
  });

  it("resolves an unpinned desired skill to the current catalog identity and version", () => {
    const resolveDesiredSkills = (
      lifecycleService as Record<string, any>
    ).resolveAgentLifecycleDesiredSkills;

    expect(resolveDesiredSkills).toBeDefined();
    expect(resolveDesiredSkills(
      [{ key: "paperclipai/paperclip/paperclip", versionId: null }],
      [{
        id: "skill-1",
        key: "paperclipai/paperclip/paperclip",
        currentVersionId: "version-current",
      }],
    )).toEqual([{
      key: "paperclipai/paperclip/paperclip",
      skillId: "skill-1",
      versionId: "version-current",
    }]);
  });

  it("changes the canonical fingerprint when an unpinned skill's current version changes", () => {
    const resolveDesiredSkills = (
      lifecycleService as Record<string, any>
    ).resolveAgentLifecycleDesiredSkills;
    const desired = [{ key: "paperclipai/paperclip/paperclip", versionId: null }];
    const first = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      desiredSkills: resolveDesiredSkills(desired, [{
        id: "skill-1",
        key: "paperclipai/paperclip/paperclip",
        currentVersionId: "version-1",
      }]),
    }));
    const next = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      desiredSkills: resolveDesiredSkills(desired, [{
        id: "skill-1",
        key: "paperclipai/paperclip/paperclip",
        currentVersionId: "version-2",
      }]),
    }));

    expect(next).not.toBe(first);
  });

  it("excludes mutable canary evidence from the canonical fingerprint", () => {
    const base = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput());
    const changedEvidence = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      lifecycle: lifecycle({
        canaryIssueId: "77777777-7777-4777-8777-777777777777",
        lastCanaryAt: "2026-07-12T13:00:00.000Z",
        lastCanaryResult: "failed",
      }),
    }));

    expect(changedEvidence).toBe(base);
  });

  it("normalizes set-like lifecycle arrays with B2 canonical semantics", () => {
    const first = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      lifecycle: lifecycle({ acceptedTaskTypes: ["analysis", "review"] }),
    }));
    const second = lifecycleService.computeAgentLifecycleConfigFingerprint(fingerprintInput({
      lifecycle: lifecycle({ acceptedTaskTypes: ["review", "analysis"] }),
    }));

    expect(second).toBe(first);
  });

  it("creates an Agent/Company-bound receipt and invalidates it on fingerprint change", () => {
    const initial = createReceipt();
    const requiredInput = fingerprintInput({ adapterConfig: { model: "gpt-5.6-luna", reasoning: "low" } });
    const required = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: requiredInput,
      previousGate: initial,
      now: NOW,
    });
    const satisfied = lifecycleService.satisfyAgentLifecycleFreshSession({
      agentId: requiredInput.agentId,
      companyId: requiredInput.companyId,
      gate: required,
      run: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "succeeded",
        freshSession: true,
        configFingerprint: required.configFingerprint,
      },
    });
    const same = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: requiredInput,
      previousGate: satisfied,
      now: NOW,
    });
    const changed = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput({ adapterConfig: { model: "another-change", reasoning: "high" } }),
      previousGate: same,
      now: NOW,
    });
    const otherAgent = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput({ agentId: "88888888-8888-4888-8888-888888888888" }),
      now: NOW,
    });

    expect(initial).toMatchObject({ findingCount: 0, freshSessionRequired: false });
    expect(same).toMatchObject({
      configFingerprint: required.configFingerprint,
      freshSessionRequired: false,
      lastSatisfiedRunId: "55555555-5555-4555-8555-555555555555",
    });
    expect(changed.freshSessionRequired).toBe(true);
    expect(changed.lastSatisfiedRunId).toBeUndefined();
    expect(otherAgent.receiptHash).not.toBe(initial.receiptHash);
  });

  it("creates a short-lived one-shot pending-canary receipt bound to run and scope", () => {
    const input = fingerprintInput({ lifecycle: pendingLifecycle() });
    const expectedConfigFingerprint = lifecycleService.computeAgentLifecycleConfigFingerprint(input);
    const receipt = lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      expectedConfigFingerprint,
      now: NOW,
    });

    expect(receipt).toMatchObject({
      agentId: input.agentId,
      companyId: input.companyId,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      configFingerprint: expectedConfigFingerprint,
      issuedAt: NOW.toISOString(),
    });
    expect(new Date(receipt.expiresAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(15 * 60 * 1_000);
    expect(lifecycleService.validateAgentLifecycleCanaryReceipt({
      receipt,
      agentId: input.agentId,
      companyId: input.companyId,
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      configFingerprint: expectedConfigFingerprint,
      now: NOW,
    })).toEqual({ ok: true, receipt });
  });

  it.each([
    ["agent", { agentId: "88888888-8888-4888-8888-888888888888" }],
    ["company", { companyId: "99999999-9999-4999-8999-999999999999" }],
    ["issue", { canaryIssueId: "77777777-7777-4777-8777-777777777777" }],
    ["run", { runId: "66666666-6666-4666-8666-666666666666" }],
    ["fingerprint", { configFingerprint: `v1:sha256:${"f".repeat(64)}` }],
  ])("rejects a canary receipt with a spoofed %s binding", (_label, override) => {
    const input = fingerprintInput({ lifecycle: pendingLifecycle() });
    const configFingerprint = lifecycleService.computeAgentLifecycleConfigFingerprint(input);
    const receipt = lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      expectedConfigFingerprint: configFingerprint,
      now: NOW,
    });

    expect(lifecycleService.validateAgentLifecycleCanaryReceipt({
      receipt,
      agentId: input.agentId,
      companyId: input.companyId,
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      configFingerprint,
      now: NOW,
      ...override,
    })).toMatchObject({ ok: false, reason: "binding_mismatch" });
  });

  it("rejects expired, tampered, passed-lifecycle, issue-mismatched, and stale-fingerprint bootstrap attempts", () => {
    const input = fingerprintInput({ lifecycle: pendingLifecycle() });
    const configFingerprint = lifecycleService.computeAgentLifecycleConfigFingerprint(input);
    const receipt = lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      expectedConfigFingerprint: configFingerprint,
      now: NOW,
    });

    expect(lifecycleService.validateAgentLifecycleCanaryReceipt({
      receipt,
      agentId: input.agentId,
      companyId: input.companyId,
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      configFingerprint,
      now: new Date(new Date(receipt.expiresAt).getTime() + 1),
    })).toMatchObject({ ok: false, reason: "expired" });
    expect(lifecycleService.validateAgentLifecycleCanaryReceipt({
      receipt: { ...receipt, receiptHash: `v1:sha256:${"f".repeat(64)}` },
      agentId: input.agentId,
      companyId: input.companyId,
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      configFingerprint,
      now: NOW,
    })).toMatchObject({ ok: false, reason: "receipt_invalid" });
    expect(() => lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: fingerprintInput(),
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      expectedConfigFingerprint: configFingerprint,
      now: NOW,
    })).toThrow(/pending/i);
    expect(() => lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "77777777-7777-4777-8777-777777777777",
      runId: receipt.runId,
      expectedConfigFingerprint: configFingerprint,
      now: NOW,
    })).toThrow(/issue/i);
    expect(() => lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: receipt.canaryIssueId,
      runId: receipt.runId,
      expectedConfigFingerprint: `v1:sha256:${"f".repeat(64)}`,
      now: NOW,
    })).toThrow(/fingerprint/i);
  });

  it("accepts an initial pending manifest with no issue but refuses bootstrap until a UUID is patched in", () => {
    const input = fingerprintInput({ lifecycle: pendingLifecycle({ canaryIssueId: null }) });
    const expectedConfigFingerprint = lifecycleService.computeAgentLifecycleConfigFingerprint(input);

    expect(() => lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      expectedConfigFingerprint,
      now: NOW,
    })).toThrow(/issue/i);
  });

  it("refuses a pending-canary retry after the lifecycle has entered failed", () => {
    const input = fingerprintInput({
      lifecycle: lifecycle({
        lastCanaryResult: "failed",
        lastCanaryAt: NOW.toISOString(),
        pause: {
          reasonCode: "canary_failed",
          reasonDetail: "The bounded canary failed and requires review.",
          outcome: "failed",
          repairIssueId: "44444444-4444-4444-8444-444444444444",
          startedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        },
      }),
    });

    expect(() => lifecycleService.createAgentLifecycleCanaryReceipt({
      fingerprintInput: input,
      canaryIssueId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      expectedConfigFingerprint: lifecycleService.computeAgentLifecycleConfigFingerprint(input),
      now: NOW,
    })).toThrow(/pending/i);
  });

  it.each([
    ["initial passed evidence", undefined, lifecycle()],
    ["pending to passed", pendingLifecycle({ canaryIssueId: null }), lifecycle()],
    ["failed to passed", lifecycle({
      lastCanaryResult: "failed",
      pause: {
        reasonCode: "canary_failed",
        reasonDetail: "Reviewed repair is required.",
        outcome: "failed",
        repairIssueId: "44444444-4444-4444-8444-444444444444",
        startedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    }), lifecycle()],
  ] as const)("rejects board-forged %s", (_label, previousLifecycle, nextLifecycle) => {
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle,
      nextLifecycle,
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "passed_evidence_forbidden" });
  });

  it("rejects timestamp forgery but permits an unchanged passed lifecycle", () => {
    const previous = lifecycle();
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: previous,
      nextLifecycle: { ...previous, lastCanaryAt: "2026-07-12T13:00:00.000Z" },
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "canary_evidence_changed" });
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: previous,
      nextLifecycle: { ...previous, purpose: "Reviewed bounded purpose update." },
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toEqual({ ok: true, mode: "preserved_passed_evidence" });
  });

  it("rejects passed-to-pending lifecycle resets through normal config writes", () => {
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: lifecycle(),
      nextLifecycle: pendingLifecycle(),
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "passed_reset_forbidden" });
  });

  it("allows passed to pending only through an exact reviewed evidence revalidation", () => {
    const previous = lifecycle();
    const next = pendingLifecycle();
    const transition = {
      mode: "reviewed_passed_revalidation" as const,
      canaryIssueId: previous.canaryIssueId!,
      decisionIssueId: previous.decisionIssueId,
      reasonCode: "runtime_evidence_invalidated" as const,
      expectedAgentUpdatedAt: NOW.toISOString(),
    };
    const validate = (overrides: Record<string, unknown> = {}) =>
      lifecycleService.validateAgentLifecyclePatchTransition({
        previousLifecycle: previous,
        nextLifecycle: next,
        transition,
        currentAgentUpdatedAt: NOW,
        nextAgentStatus: "paused",
        fingerprintRelevantChange: false,
        ...overrides,
      });

    expect(validate()).toEqual({ ok: true, mode: "reviewed_passed_revalidation" });
    expect(validate({
      transition: { ...transition, expectedAgentUpdatedAt: new Date(NOW.getTime() - 1).toISOString() },
    })).toMatchObject({ ok: false, reason: "revalidation_cas_mismatch" });
    expect(validate({
      transition: { ...transition, canaryIssueId: "55555555-5555-4555-8555-555555555555" },
    })).toMatchObject({ ok: false, reason: "revalidation_issue_mismatch" });
    expect(validate({
      transition: { ...transition, decisionIssueId: "66666666-6666-4666-8666-666666666666" },
    })).toMatchObject({ ok: false, reason: "revalidation_decision_issue_mismatch" });
    expect(validate({
      transition: { ...transition, reasonCode: "operator_requested" } as any,
    })).toMatchObject({ ok: false, reason: "revalidation_reason_invalid" });
    expect(validate({
      nextLifecycle: pendingLifecycle({ canaryFreshnessDays: 7 }),
    })).toMatchObject({ ok: false, reason: "revalidation_policy_mismatch" });
    expect(validate({ nextAgentStatus: "idle" })).toMatchObject({
      ok: false,
      reason: "revalidation_status_invalid",
    });
    expect(validate({ fingerprintRelevantChange: true })).toMatchObject({
      ok: false,
      reason: "revalidation_fingerprint_mutation",
    });
  });

  it("renews an overdue stored review through preserved passed evidence", () => {
    const previous = lifecycle({ reviewAt: OVERDUE_REVIEW_AT });
    const next = lifecycle({ reviewAt: RENEWED_REVIEW_AT });
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: previous,
      nextLifecycle: next,
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toEqual({ ok: true, mode: "preserved_passed_evidence" });
  });

  it("evaluates reviewed revalidation rules instead of rejecting an overdue stored review", () => {
    const previous = lifecycle({ reviewAt: OVERDUE_REVIEW_AT });
    const transition = {
      mode: "reviewed_passed_revalidation" as const,
      canaryIssueId: previous.canaryIssueId!,
      decisionIssueId: previous.decisionIssueId,
      reasonCode: "runtime_evidence_invalidated" as const,
      expectedAgentUpdatedAt: NOW.toISOString(),
    };
    const validate = (nextLifecycle: AgentLifecycle) =>
      lifecycleService.validateAgentLifecyclePatchTransition({
        previousLifecycle: previous,
        nextLifecycle,
        transition,
        currentAgentUpdatedAt: NOW,
        nextAgentStatus: "paused",
        fingerprintRelevantChange: false,
      });

    // The stored overdue review no longer short-circuits as previous_lifecycle_invalid;
    // the transition now fails on its own immutable-policy rule instead.
    expect(validate(pendingLifecycle({ reviewAt: RENEWED_REVIEW_AT })))
      .toMatchObject({ ok: false, reason: "revalidation_policy_mismatch" });
    // Renewing the review first (preserved_passed_evidence) and revalidating afterwards
    // keeps the policy identical and is accepted.
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: lifecycle({ reviewAt: RENEWED_REVIEW_AT }),
      nextLifecycle: pendingLifecycle({ reviewAt: RENEWED_REVIEW_AT }),
      transition,
      currentAgentUpdatedAt: NOW,
      nextAgentStatus: "paused",
      fingerprintRelevantChange: false,
    })).toEqual({ ok: true, mode: "reviewed_passed_revalidation" });
  });

  it("still refuses a next lifecycle whose review deadline has already passed", () => {
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: lifecycle({ reviewAt: OVERDUE_REVIEW_AT }),
      nextLifecycle: lifecycle({ reviewAt: OVERDUE_REVIEW_AT }),
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "next_lifecycle_invalid" });
  });

  it("allows failed to pending only with exact reviewed repair CAS and issue binding", () => {
    const repairIssueId = "44444444-4444-4444-8444-444444444444";
    const failedAt = "2026-07-12T12:00:00.000Z";
    const failed = lifecycle({
      lastCanaryResult: "failed",
      lastCanaryAt: failedAt,
      pause: {
        reasonCode: "canary_failed",
        reasonDetail: "Reviewed repair is required.",
        outcome: "failed",
        repairIssueId,
        startedAt: failedAt,
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
    const pending = pendingLifecycle({ canaryIssueId: repairIssueId });
    const transition = {
      mode: "reviewed_failed_repair" as const,
      repairIssueId,
      expectedAgentUpdatedAt: NOW.toISOString(),
    };

    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: failed,
      nextLifecycle: pending,
      transition: undefined,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "reviewed_repair_required" });
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: failed,
      nextLifecycle: pending,
      transition: { ...transition, expectedAgentUpdatedAt: new Date(NOW.getTime() - 1).toISOString() },
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "repair_cas_mismatch" });
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: failed,
      nextLifecycle: pendingLifecycle({ canaryIssueId: "55555555-5555-4555-8555-555555555555" }),
      transition,
      currentAgentUpdatedAt: NOW,
    })).toMatchObject({ ok: false, reason: "repair_issue_mismatch" });
    expect(lifecycleService.validateAgentLifecyclePatchTransition({
      previousLifecycle: failed,
      nextLifecycle: pending,
      transition,
      currentAgentUpdatedAt: NOW,
    })).toEqual({ ok: true, mode: "reviewed_failed_repair" });
  });

  it("creates a normal passed gate already satisfied by the successful canary run", () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const receipt = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput(),
      satisfiedRunId: runId,
      now: NOW,
    });

    expect(receipt).toMatchObject({
      freshSessionRequired: false,
      lastSatisfiedRunId: runId,
    });
  });

  it("invalidates a valid but expired prior receipt when configuration changed", () => {
    const expiredLifecycle = lifecycle({
      lastCanaryAt: "2026-05-01T12:00:00.000Z",
      canaryFreshnessDays: 30,
    });
    const expired = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput({ lifecycle: expiredLifecycle }),
      now: new Date("2026-05-02T12:00:00.000Z"),
    });
    const changed = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput({ adapterConfig: { model: "changed" } }),
      previousGate: expired,
      now: NOW,
    });

    expect(new Date(expired.expiresAt).getTime()).toBeLessThan(NOW.getTime());
    expect(changed.freshSessionRequired).toBe(true);
  });

  it("accepts a current exact receipt", () => {
    const gate = createReceipt();

    expect(lifecycleService.validateAgentLifecycleGate({
      fingerprintInput: fingerprintInput(),
      gate,
      now: NOW,
    })).toEqual({ ok: true, lifecycle: lifecycle(), gate });
  });

  it.each([
    ["lifecycle_invalid", fingerprintInput({ lifecycle: { schemaVersion: "1.0.0" } }), null],
    ["fingerprint_mismatch", fingerprintInput({ adapterConfig: { model: "changed" } }), null],
    ["freshness_expired", fingerprintInput({
      lifecycle: lifecycle({ lastCanaryAt: "2026-05-01T12:00:00.000Z", canaryFreshnessDays: 30 }),
    }), null],
    ["permission_mismatch", fingerprintInput({
      permissions: {
        canCreateAgents: false,
        bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: true },
        exception: { kind: "none" },
      },
    }), null],
  ] as const)("fails closed with %s", (reason, input, explicitGate) => {
    const gate = explicitGate ?? createReceipt();
    const result = lifecycleService.validateAgentLifecycleGate({
      fingerprintInput: input,
      gate,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason });
  });

  it("rejects fresh-session and receipt-hash mismatches", () => {
    const gate = createReceipt();
    expect(lifecycleService.validateAgentLifecycleGate({
      fingerprintInput: fingerprintInput(),
      gate: { ...gate, freshSessionRequired: true },
      now: NOW,
    })).toMatchObject({ ok: false, reason: "receipt_invalid" });
    expect(lifecycleService.validateAgentLifecycleGate({
      fingerprintInput: fingerprintInput(),
      gate: lifecycleService.createAgentLifecycleValidationReceipt({
        fingerprintInput: fingerprintInput({ adapterConfig: { model: "changed" } }),
        previousGate: gate,
        now: NOW,
      }),
      now: NOW,
    })).toMatchObject({ ok: false, reason: "fingerprint_mismatch" });
  });

  it("clears a fresh-session requirement only with a successful matching fresh run", () => {
    const base = createReceipt();
    const required = lifecycleService.createAgentLifecycleValidationReceipt({
      fingerprintInput: fingerprintInput({ adapterConfig: { model: "changed" } }),
      previousGate: base,
      now: NOW,
    });
    const run = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "succeeded",
      freshSession: true,
      configFingerprint: required.configFingerprint,
    } as const;

    expect(lifecycleService.satisfyAgentLifecycleFreshSession({
      agentId: fingerprintInput().agentId,
      companyId: fingerprintInput().companyId,
      gate: required,
      run: { ...run, configFingerprint: `v1:sha256:${"f".repeat(64)}` },
    })).toBeNull();
    const satisfied = lifecycleService.satisfyAgentLifecycleFreshSession({
      agentId: fingerprintInput().agentId,
      companyId: fingerprintInput().companyId,
      gate: required,
      run,
    });
    expect(satisfied).toMatchObject({
      freshSessionRequired: false,
      lastSatisfiedRunId: run.id,
    });
    expect(satisfied?.receiptHash).not.toBe(required.receiptHash);
  });
});

import type {
  AgentLifecycle,
  AgentLifecycleCanaryGate,
  AgentLifecycleGate,
  AgentLifecycleTransition,
} from "@paperclipai/shared";
import { createHash } from "node:crypto";
import {
  agentLifecycleGateSchema,
  agentLifecycleCanaryGateSchema,
  agentLifecyclePermissionExceptionSchema,
  agentLifecycleSchema,
  agentLifecycleStoredSchema,
} from "@paperclipai/shared";
import {
  createAgentConfigurationFingerprint,
  createEffectiveRunConfigFingerprints,
} from "./effective-run-config-fingerprints.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const LIFECYCLE_CANARY_RECEIPT_TTL_MS = 10 * 60 * 1_000;

type UnknownRecord = Record<string, unknown>;

export interface AgentLifecycleFingerprintInput {
  agentId: string;
  companyId: string;
  adapterType: string;
  adapterConfig: UnknownRecord;
  runtimeConfig: UnknownRecord;
  permissions: UnknownRecord;
  grants: Array<{ permissionKey: string; scope?: UnknownRecord | null }>;
  desiredSkills: AgentLifecycleResolvedSkill[];
  lifecycle: unknown;
  contextPackSha256: string | null;
  managedInstructionsSha256: string | null;
  companyProfileSha256: string | null;
}

export interface AgentLifecycleDesiredSkillSelection {
  key: string;
  versionId: string | null;
}

export interface AgentLifecycleSkillCatalogEntry {
  id: string;
  key: string;
  currentVersionId: string | null;
}

export interface AgentLifecycleResolvedSkill {
  key: string;
  skillId: string | null;
  versionId: string | null;
}

export type AgentLifecycleGateFailureReason =
  | "lifecycle_invalid"
  | "fingerprint_mismatch"
  | "freshness_expired"
  | "permission_mismatch"
  | "fresh_session_required"
  | "receipt_invalid";

export type AgentLifecycleGateValidation =
  | { ok: true; lifecycle: AgentLifecycle; gate: AgentLifecycleGate }
  | {
      ok: false;
      reason: AgentLifecycleGateFailureReason;
      issues?: Array<{ path: string; message: string }>;
    };

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export const SERVER_MANAGED_AGENT_LIFECYCLE_GATE_KEYS = [
  "lifecycleGate",
  "lifecycleCanaryGate",
  "canaryGate",
] as const;

export function stripServerManagedAgentLifecycleGates(metadata: unknown): unknown {
  const record = asRecord(metadata);
  if (!record) return metadata;
  const sanitized = { ...record };
  for (const key of SERVER_MANAGED_AGENT_LIFECYCLE_GATE_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stableNormalize(entry))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  }
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, stableNormalize(record[key])]),
  );
}

export function hashAgentLifecycleContent(value: unknown) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function normalizedPermissionsForFingerprint(permissions: UnknownRecord) {
  const normalized = { ...permissions };
  const exception = asRecord(normalized.exception);
  if (exception?.kind === "approved") {
    const { evidence: _mutableCanaryEvidence, ...policy } = exception;
    normalized.exception = policy;
  }
  return stableNormalize(normalized);
}

function lifecyclePolicyForFingerprint(lifecycle: AgentLifecycle) {
  const {
    canaryIssueId: _canaryIssueId,
    lastCanaryAt: _lastCanaryAt,
    lastCanaryResult: _lastCanaryResult,
    ...policy
  } = lifecycle;
  return stableNormalize(policy);
}

function normalizedGrants(input: AgentLifecycleFingerprintInput["grants"]) {
  return input
    .map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizedDesiredSkills(input: AgentLifecycleFingerprintInput["desiredSkills"]) {
  return input
    .map((skill) => ({
      key: skill.key,
      skillId: skill.skillId,
      versionId: skill.versionId,
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

export function resolveAgentLifecycleDesiredSkills(
  desiredSkillEntries: readonly AgentLifecycleDesiredSkillSelection[],
  skillCatalog: readonly AgentLifecycleSkillCatalogEntry[],
): AgentLifecycleResolvedSkill[] {
  const catalogByKey = new Map(skillCatalog.map((skill) => [skill.key, skill]));
  return desiredSkillEntries.map((entry) => {
    const skill = catalogByKey.get(entry.key);
    return {
      key: entry.key,
      skillId: skill?.id ?? null,
      versionId: entry.versionId ?? skill?.currentVersionId ?? null,
    };
  });
}

export function parseAgentLifecycleGate(value: unknown): AgentLifecycleGate | null {
  const result = agentLifecycleGateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAgentLifecycleCanaryGate(value: unknown): AgentLifecycleCanaryGate | null {
  const result = agentLifecycleCanaryGateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type AgentLifecyclePatchTransitionFailureReason =
  | "previous_lifecycle_invalid"
  | "next_lifecycle_invalid"
  | "passed_evidence_forbidden"
  | "failed_evidence_forbidden"
  | "passed_reset_forbidden"
  | "canary_evidence_changed"
  | "reviewed_repair_required"
  | "repair_cas_mismatch"
  | "repair_issue_mismatch"
  | "repair_state_invalid"
  | "revalidation_cas_mismatch"
  | "revalidation_issue_mismatch"
  | "revalidation_decision_issue_mismatch"
  | "revalidation_reason_invalid"
  | "revalidation_policy_mismatch"
  | "revalidation_state_invalid"
  | "revalidation_status_invalid"
  | "revalidation_fingerprint_mutation"
  | "unexpected_repair_control";

export type AgentLifecyclePatchTransitionValidation =
  | {
      ok: true;
      mode:
        | "pending_contract"
        | "preserved_passed_evidence"
        | "preserved_failed_evidence"
        | "reviewed_failed_repair"
        | "reviewed_passed_revalidation";
    }
  | { ok: false; reason: AgentLifecyclePatchTransitionFailureReason };

/**
 * Board/config writes may preserve existing canary evidence, but they cannot
 * manufacture a terminal result. Board-controlled resets require either a
 * reviewed failed -> pending repair or a reviewed passed -> pending evidence
 * revalidation. Both are issue-bound and guarded by an exact agent updatedAt
 * CAS. Runtime failure/promotion paths write terminal evidence directly inside
 * their serializable transactions.
 */
export function validateAgentLifecyclePatchTransition(input: {
  previousLifecycle: unknown;
  nextLifecycle: unknown;
  transition?: AgentLifecycleTransition;
  currentAgentUpdatedAt: Date;
  nextAgentStatus?: string | null;
  fingerprintRelevantChange?: boolean;
}): AgentLifecyclePatchTransitionValidation {
  const nextResult = agentLifecycleSchema.safeParse(input.nextLifecycle);
  if (!nextResult.success) return { ok: false, reason: "next_lifecycle_invalid" };
  const next = nextResult.data;

  const previousAbsent = input.previousLifecycle === undefined || input.previousLifecycle === null;
  // The stored lifecycle is read with the overdue-review rule relaxed so an
  // expired review can still be renewed; nextLifecycle stays strict above.
  const previousResult = previousAbsent
    ? null
    : agentLifecycleStoredSchema.safeParse(input.previousLifecycle);
  if (previousResult && !previousResult.success) {
    return { ok: false, reason: "previous_lifecycle_invalid" };
  }
  const previous = previousResult?.data ?? null;

  if (next.lastCanaryResult === "passed") {
    if (!previous || previous.lastCanaryResult !== "passed") {
      return { ok: false, reason: "passed_evidence_forbidden" };
    }
    if (
      next.canaryIssueId !== previous.canaryIssueId
      || next.lastCanaryAt !== previous.lastCanaryAt
    ) {
      return { ok: false, reason: "canary_evidence_changed" };
    }
    if (input.transition) return { ok: false, reason: "unexpected_repair_control" };
    return { ok: true, mode: "preserved_passed_evidence" };
  }

  if (next.lastCanaryResult === "failed") {
    if (!previous || previous.lastCanaryResult !== "failed") {
      return { ok: false, reason: "failed_evidence_forbidden" };
    }
    if (
      next.canaryIssueId !== previous.canaryIssueId
      || next.lastCanaryAt !== previous.lastCanaryAt
      || stableStringify(next.pause ?? null) !== stableStringify(previous.pause ?? null)
    ) {
      return { ok: false, reason: "canary_evidence_changed" };
    }
    if (input.transition) return { ok: false, reason: "unexpected_repair_control" };
    return { ok: true, mode: "preserved_failed_evidence" };
  }

  if (previous?.lastCanaryResult === "passed") {
    if (!input.transition) return { ok: false, reason: "passed_reset_forbidden" };
    if (input.transition.mode !== "reviewed_passed_revalidation") {
      return { ok: false, reason: "unexpected_repair_control" };
    }
    if (input.transition.reasonCode !== "runtime_evidence_invalidated") {
      return { ok: false, reason: "revalidation_reason_invalid" };
    }
    if (
      new Date(input.transition.expectedAgentUpdatedAt).getTime()
      !== input.currentAgentUpdatedAt.getTime()
    ) {
      return { ok: false, reason: "revalidation_cas_mismatch" };
    }
    if (
      previous.canaryIssueId !== input.transition.canaryIssueId
      || next.canaryIssueId !== input.transition.canaryIssueId
    ) {
      return { ok: false, reason: "revalidation_issue_mismatch" };
    }
    if (
      previous.decisionIssueId !== input.transition.decisionIssueId
      || next.decisionIssueId !== input.transition.decisionIssueId
    ) {
      return { ok: false, reason: "revalidation_decision_issue_mismatch" };
    }
    if (
      stableStringify(lifecyclePolicyForFingerprint(next))
      !== stableStringify(lifecyclePolicyForFingerprint(previous))
    ) {
      return { ok: false, reason: "revalidation_policy_mismatch" };
    }
    if (next.lastCanaryAt !== null || next.pause !== undefined) {
      return { ok: false, reason: "revalidation_state_invalid" };
    }
    if (input.nextAgentStatus !== "paused") {
      return { ok: false, reason: "revalidation_status_invalid" };
    }
    if (input.fingerprintRelevantChange === true) {
      return { ok: false, reason: "revalidation_fingerprint_mutation" };
    }
    return { ok: true, mode: "reviewed_passed_revalidation" };
  }

  if (previous?.lastCanaryResult === "failed") {
    if (!input.transition || input.transition.mode !== "reviewed_failed_repair") {
      return { ok: false, reason: "reviewed_repair_required" };
    }
    if (
      new Date(input.transition.expectedAgentUpdatedAt).getTime()
      !== input.currentAgentUpdatedAt.getTime()
    ) {
      return { ok: false, reason: "repair_cas_mismatch" };
    }
    if (
      previous.canaryIssueId !== input.transition.repairIssueId
      || previous.pause?.repairIssueId !== input.transition.repairIssueId
      || next.canaryIssueId !== input.transition.repairIssueId
    ) {
      return { ok: false, reason: "repair_issue_mismatch" };
    }
    if (next.lastCanaryAt !== null || next.pause !== undefined) {
      return { ok: false, reason: "repair_state_invalid" };
    }
    return { ok: true, mode: "reviewed_failed_repair" };
  }

  if (input.transition) return { ok: false, reason: "unexpected_repair_control" };
  return { ok: true, mode: "pending_contract" };
}

function parseLifecycleIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}) {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

function readPermissionPolicy(input: AgentLifecycleFingerprintInput, now: Date) {
  const permissions = input.permissions;
  const bypass = asRecord(permissions.bypass) ?? {};
  const declaredClaude = bypass.claudePermissionMode === true;
  const declaredCodex = bypass.codexApprovalsAndSandbox === true;
  const actualClaude = input.adapterConfig.dangerouslySkipPermissions === true;
  const actualCodex = input.adapterConfig.dangerouslyBypassApprovalsAndSandbox === true
    || input.adapterConfig.dangerouslyBypassSandbox === true;
  if (declaredClaude !== actualClaude || declaredCodex !== actualCodex) {
    return { ok: false as const, message: "Declared bypass permissions do not match the effective adapter config" };
  }

  const rawException = permissions.exception ?? { kind: "none" };
  const parsedException = agentLifecyclePermissionExceptionSchema.safeParse(rawException);
  if (!parsedException.success) {
    return { ok: false as const, message: "Permission exception is missing, expired, or structurally invalid" };
  }

  const activeBypasses = [
    ...(declaredClaude ? ["claude_permission_mode"] : []),
    ...(declaredCodex ? ["codex_approvals_and_sandbox"] : []),
  ].sort();
  if (parsedException.data.kind === "none") {
    return activeBypasses.length === 0
      ? { ok: true as const }
      : { ok: false as const, message: "A global bypass requires a current exact permission exception" };
  }

  if (new Date(parsedException.data.expiresAt).getTime() <= now.getTime()) {
    return { ok: false as const, message: "Permission exception has expired" };
  }
  const scopedBypasses = [...parsedException.data.scope.bypasses].sort();
  if (stableStringify(scopedBypasses) !== stableStringify(activeBypasses)) {
    return { ok: false as const, message: "Permission exception scope does not match active bypasses" };
  }
  const effectiveRunDigest = createAgentConfigurationFingerprint({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
    runtimeConfig: input.runtimeConfig,
  }).replace(/^v1:sha256:/, "");
  if (parsedException.data.evidence.configFingerprint !== effectiveRunDigest) {
    return { ok: false as const, message: "Permission exception evidence does not match the effective run config" };
  }
  return { ok: true as const };
}

export function computeAgentLifecycleConfigFingerprint(input: AgentLifecycleFingerprintInput) {
  const parsedLifecycle = agentLifecycleSchema.safeParse(input.lifecycle);
  const runtimeProfileFingerprint = createAgentConfigurationFingerprint({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
    runtimeConfig: input.runtimeConfig,
  });
  return createEffectiveRunConfigFingerprints({
    session: {
      agentId: input.agentId,
      companyId: input.companyId,
      runtimeProfileFingerprint,
      permissions: normalizedPermissionsForFingerprint(input.permissions),
      grants: normalizedGrants(input.grants),
      desiredSkills: normalizedDesiredSkills(input.desiredSkills),
      lifecycle: parsedLifecycle.success
        ? lifecyclePolicyForFingerprint(parsedLifecycle.data)
        : input.lifecycle,
      content: {
        contextPackSha256: input.contextPackSha256,
        managedInstructionsSha256: input.managedInstructionsSha256,
        companyProfileSha256: input.companyProfileSha256,
      },
    },
  }).sessionFingerprint.fingerprint;
}

function receiptHash(input: {
  agentId: string;
  companyId: string;
  gate: Omit<AgentLifecycleGate, "receiptHash">;
}) {
  return createEffectiveRunConfigFingerprints({
    session: {
      kind: "agent_lifecycle_validation_receipt",
      agentId: input.agentId,
      companyId: input.companyId,
      ...input.gate,
    },
  }).sessionFingerprint.fingerprint;
}

function canaryReceiptHash(gate: Omit<AgentLifecycleCanaryGate, "receiptHash">) {
  return createEffectiveRunConfigFingerprints({
    session: {
      kind: "agent_lifecycle_pending_canary_receipt",
      ...gate,
    },
  }).sessionFingerprint.fingerprint;
}

export type AgentLifecycleCanaryReceiptValidation =
  | { ok: true; receipt: AgentLifecycleCanaryGate }
  | { ok: false; reason: "receipt_invalid" | "binding_mismatch" | "expired" };

export function validateAgentLifecycleCanaryReceipt(input: {
  receipt: unknown;
  agentId: string;
  companyId: string;
  canaryIssueId: string;
  runId: string;
  configFingerprint: string;
  now?: Date;
}): AgentLifecycleCanaryReceiptValidation {
  const receipt = parseAgentLifecycleCanaryGate(input.receipt);
  if (!receipt) return { ok: false, reason: "receipt_invalid" };
  if (
    receipt.agentId !== input.agentId
    || receipt.companyId !== input.companyId
    || receipt.canaryIssueId !== input.canaryIssueId
    || receipt.runId !== input.runId
    || receipt.configFingerprint !== input.configFingerprint
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const { receiptHash, ...gateWithoutHash } = receipt;
  if (receiptHash !== canaryReceiptHash(gateWithoutHash)) {
    return { ok: false, reason: "receipt_invalid" };
  }
  if (new Date(receipt.expiresAt).getTime() <= (input.now ?? new Date()).getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, receipt };
}

export function createAgentLifecycleCanaryReceipt(input: {
  fingerprintInput: AgentLifecycleFingerprintInput;
  canaryIssueId: string;
  runId: string;
  expectedConfigFingerprint: string;
  now?: Date;
}): AgentLifecycleCanaryGate {
  const now = input.now ?? new Date();
  const lifecycleResult = agentLifecycleSchema.safeParse(input.fingerprintInput.lifecycle);
  if (!lifecycleResult.success || lifecycleResult.data.lastCanaryResult !== "pending") {
    throw new Error("A pending lifecycle contract is required for canary bootstrap");
  }
  if (lifecycleResult.data.canaryIssueId !== input.canaryIssueId) {
    throw new Error("Pending lifecycle canary issue does not match the requested issue");
  }
  const permissionResult = readPermissionPolicy(input.fingerprintInput, now);
  if (!permissionResult.ok) {
    throw new Error(`Cannot create a lifecycle canary receipt: ${permissionResult.message}`);
  }
  const configFingerprint = computeAgentLifecycleConfigFingerprint({
    ...input.fingerprintInput,
    lifecycle: lifecycleResult.data,
  });
  if (configFingerprint !== input.expectedConfigFingerprint) {
    throw new Error("Expected lifecycle config fingerprint does not match current configuration");
  }
  const gateWithoutHash: Omit<AgentLifecycleCanaryGate, "receiptHash"> = {
    schemaVersion: "1.0.0",
    agentId: input.fingerprintInput.agentId,
    companyId: input.fingerprintInput.companyId,
    canaryIssueId: input.canaryIssueId,
    runId: input.runId,
    configFingerprint,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LIFECYCLE_CANARY_RECEIPT_TTL_MS).toISOString(),
  };
  const receipt: AgentLifecycleCanaryGate = {
    ...gateWithoutHash,
    receiptHash: canaryReceiptHash(gateWithoutHash),
  };
  const parsed = agentLifecycleCanaryGateSchema.safeParse(receipt);
  if (!parsed.success) throw new Error("Generated lifecycle canary receipt is invalid");
  return parsed.data;
}

function receiptExpiry(lifecycle: AgentLifecycle, permissions: UnknownRecord) {
  const lastCanaryAt = lifecycle.lastCanaryAt
    ? new Date(lifecycle.lastCanaryAt).getTime()
    : Number.NEGATIVE_INFINITY;
  const expiries = [
    new Date(lifecycle.reviewAt).getTime(),
    lastCanaryAt + lifecycle.canaryFreshnessDays * DAY_MS,
  ];
  const exception = asRecord(permissions.exception);
  if (exception?.kind === "approved" && typeof exception.expiresAt === "string") {
    expiries.push(new Date(exception.expiresAt).getTime());
  }
  return new Date(Math.min(...expiries));
}

export function createAgentLifecycleValidationReceipt(input: {
  fingerprintInput: AgentLifecycleFingerprintInput;
  previousGate?: AgentLifecycleGate | null;
  satisfiedRunId?: string;
  now?: Date;
}): AgentLifecycleGate {
  const now = input.now ?? new Date();
  const lifecycleResult = agentLifecycleSchema.safeParse(input.fingerprintInput.lifecycle);
  if (!lifecycleResult.success) {
    throw new Error("Cannot create a lifecycle receipt for an invalid lifecycle contract");
  }
  const permissionResult = readPermissionPolicy(input.fingerprintInput, now);
  if (!permissionResult.ok) {
    throw new Error(`Cannot create a lifecycle receipt: ${permissionResult.message}`);
  }
  if (lifecycleResult.data.lastCanaryResult !== "passed" || !lifecycleResult.data.lastCanaryAt) {
    throw new Error("Cannot create a lifecycle receipt without a passed canary");
  }
  const expiresAt = receiptExpiry(lifecycleResult.data, input.fingerprintInput.permissions);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("Cannot create an already expired lifecycle receipt");
  }

  const configFingerprint = computeAgentLifecycleConfigFingerprint({
    ...input.fingerprintInput,
    lifecycle: lifecycleResult.data,
  });
  const parsedPreviousGate = parseAgentLifecycleGate(input.previousGate);
  const previousGate = parsedPreviousGate
    && parsedPreviousGate.receiptHash === expectedReceiptHash({
      agentId: input.fingerprintInput.agentId,
      companyId: input.fingerprintInput.companyId,
      gate: parsedPreviousGate,
    })
    ? parsedPreviousGate
    : null;
  const changed = previousGate !== null && previousGate.configFingerprint !== configFingerprint;
  const gateWithoutHash: Omit<AgentLifecycleGate, "receiptHash"> = {
    schemaVersion: "1.0.0",
    configFingerprint,
    validatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    findingCount: 0,
    freshSessionRequired: input.satisfiedRunId
      ? false
      : changed || previousGate?.freshSessionRequired === true,
    ...(input.satisfiedRunId || (!changed && previousGate?.lastSatisfiedRunId)
      ? { lastSatisfiedRunId: input.satisfiedRunId ?? previousGate?.lastSatisfiedRunId }
      : {}),
  };
  return {
    ...gateWithoutHash,
    receiptHash: receiptHash({
      agentId: input.fingerprintInput.agentId,
      companyId: input.fingerprintInput.companyId,
      gate: gateWithoutHash,
    }),
  };
}

function expectedReceiptHash(input: {
  agentId: string;
  companyId: string;
  gate: AgentLifecycleGate;
}) {
  const { receiptHash: _receiptHash, ...gateWithoutHash } = input.gate;
  return receiptHash({
    agentId: input.agentId,
    companyId: input.companyId,
    gate: gateWithoutHash,
  });
}

export function validateAgentLifecycleGate(input: {
  fingerprintInput: AgentLifecycleFingerprintInput;
  gate: unknown;
  now?: Date;
}): AgentLifecycleGateValidation {
  const now = input.now ?? new Date();
  const lifecycleResult = agentLifecycleSchema.safeParse(input.fingerprintInput.lifecycle);
  if (!lifecycleResult.success) {
    return {
      ok: false,
      reason: "lifecycle_invalid",
      issues: parseLifecycleIssues(lifecycleResult.error),
    };
  }
  if (lifecycleResult.data.lastCanaryResult !== "passed" || !lifecycleResult.data.lastCanaryAt) {
    return { ok: false, reason: "lifecycle_invalid", issues: [{ path: "lastCanaryResult", message: "Canary has not passed" }] };
  }

  const permissionResult = readPermissionPolicy(input.fingerprintInput, now);
  if (!permissionResult.ok) {
    return { ok: false, reason: "permission_mismatch", issues: [{ path: "permissions", message: permissionResult.message }] };
  }

  const canaryExpiresAt = new Date(lifecycleResult.data.lastCanaryAt).getTime()
    + lifecycleResult.data.canaryFreshnessDays * DAY_MS;
  if (
    canaryExpiresAt <= now.getTime()
    || new Date(lifecycleResult.data.reviewAt).getTime() <= now.getTime()
  ) {
    return { ok: false, reason: "freshness_expired" };
  }

  const gateResult = agentLifecycleGateSchema.safeParse(input.gate);
  if (!gateResult.success) {
    return { ok: false, reason: "receipt_invalid", issues: parseLifecycleIssues(gateResult.error) };
  }
  const gate = gateResult.data;
  const currentFingerprint = computeAgentLifecycleConfigFingerprint({
    ...input.fingerprintInput,
    lifecycle: lifecycleResult.data,
  });
  if (gate.configFingerprint !== currentFingerprint) {
    return { ok: false, reason: "fingerprint_mismatch" };
  }
  if (gate.receiptHash !== expectedReceiptHash({
    agentId: input.fingerprintInput.agentId,
    companyId: input.fingerprintInput.companyId,
    gate,
  })) {
    return { ok: false, reason: "receipt_invalid" };
  }
  if (new Date(gate.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "freshness_expired" };
  }
  if (gate.freshSessionRequired) {
    return { ok: false, reason: "fresh_session_required" };
  }
  return { ok: true, lifecycle: lifecycleResult.data, gate };
}

export function satisfyAgentLifecycleFreshSession(input: {
  agentId: string;
  companyId: string;
  gate: AgentLifecycleGate;
  run: {
    id: string;
    status: string;
    freshSession: boolean;
    configFingerprint: string;
  };
}): AgentLifecycleGate | null {
  const gateResult = agentLifecycleGateSchema.safeParse(input.gate);
  if (!gateResult.success) return null;
  const gate = gateResult.data;
  if (gate.receiptHash !== expectedReceiptHash({ agentId: input.agentId, companyId: input.companyId, gate })) {
    return null;
  }
  if (
    !gate.freshSessionRequired
    || input.run.status !== "succeeded"
    || !input.run.freshSession
    || input.run.configFingerprint !== gate.configFingerprint
  ) {
    return null;
  }
  const { receiptHash: _oldReceiptHash, ...currentGateWithoutHash } = gate;
  const gateWithoutHash: Omit<AgentLifecycleGate, "receiptHash"> = {
    ...currentGateWithoutHash,
    freshSessionRequired: false,
    lastSatisfiedRunId: input.run.id,
  };
  return {
    ...gateWithoutHash,
    receiptHash: receiptHash({ agentId: input.agentId, companyId: input.companyId, gate: gateWithoutHash }),
  };
}

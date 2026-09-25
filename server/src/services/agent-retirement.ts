import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agentMemberships,
  agentTaskSessions,
  agentRetirementExecutionClaims,
  agentRetirementExecutionRecoveries,
  agentRetirementPlanEvidenceBundles,
  agentRetirementPlanClaims,
  agentWakeupRequests,
  agents,
  approvals,
  approvalExecutionClaims,
  companies,
  companyMemberships,
  companySecretBindings,
  companySkillStars,
  companySecrets,
  companySecretVersions,
  goals,
  heartbeatRuns,
  environmentLeases,
  issueComments,
  issueRecoveryActions,
  issueWatchdogs,
  issues,
  pipelineCases,
  pipelineStages,
  pipelines,
  principalPermissionGrants,
  projects,
  routineTriggers,
  routineRuns,
  routineRunDeliveries,
  routines,
  userSecretDeclarations,
  workspaceRuntimeStartClaims,
  workspaceRuntimeServices,
  workspaceOperations,
} from "@paperclipai/db";
import {
  AGENT_RETIREMENT_ALLOWLIST,
  getAgentRetirementSource,
  normalizeAgentRetirementId,
  agentLifecycleGateSchema,
  agentLifecycleSchema,
  agentRetirementCleanupSchema,
  agentRetirementCleanupResponseSchema,
  agentRetirementCleanupRequestSchema,
  agentRetirementEvidenceSchema,
  agentRetirementEvidenceBySourceIdSchema,
  agentRetirementExecutionRecoveryRequestSchema,
  agentRetirementPlanSchema,
  agentRetirementPreflightRequestSchema,
  agentRetirementTerminationReceiptSchema,
  agentRetirementTerminationSchema,
  formatAgentRetirementApprovalComment,
  parseAgentRetirementApprovalComment,
  type AgentRetirementBlocker,
  type AgentRetirementCleanup,
  type AgentRetirementCleanupRequest,
  type AgentRetirementCleanupResponse,
  type AgentRetirementDependencyCounts,
  type AgentRetirementEvidence,
  type AgentRetirementEvidenceBySourceId,
  type AgentRetirementExecutionRecoveryRequest,
  type AgentRetirementPlan,
  type AgentRetirementPreflightRequest,
  type AgentRetirementPreflightResponse,
  type AgentRetirementTermination,
  type AgentRetirementTerminationReceipt,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertRetirementCommonArtifactReceipt,
  assertRetirementSourceArtifactReceipt,
  revalidateRetirementCommonArtifactReceipt,
  revalidateRetirementClaimArtifacts,
  revalidateRetirementSourceArtifactReceipt,
  verifyRetirementBackupRestore,
  verifyRetirementSourceExport,
  type RetirementCommonArtifactReceipt,
  type RetirementSourceArtifactReceipt,
} from "./agent-retirement-artifacts.js";
import { verifyRetirementSystemReplacementArtifact } from "./agent-retirement-system-replacement.js";
import {
  RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION,
  assertRetirementRestoreInventory,
  createRetirementRestoreInventory,
  isActiveRetirementHireApprovalStatus,
  isActiveRetirementIssueWatchdogStatus,
  isActiveRetirementRecoveryActionStatus,
  isOperativeRetirementGoalStatus,
  isTerminalRetirementEnvironmentLease,
  isTerminalRetirementWorkspaceOperation,
  type RetirementRestoreInventoryProof,
} from "./agent-retirement-restore-inventory.js";
import {
  assertHistoricalAgentTombstoneMutable,
  assertHistoricalTombstoneWorkInertness,
} from "./agent-retirement-historical-tombstones.js";
import {
  AGENT_OPERATIONAL_DEPENDENCY_KEYS,
  createEmptyAgentOperationalDependencyCounts,
  listLiveAgentDescendants,
  scanAgentOperationalDependencies,
  type AgentOperationalDependencyKey,
} from "./agent-operational-dependencies.js";
import { withAgentStartLock } from "./agent-start-lock.js";

const EVIDENCE_MAX_AGE_MS = 30 * 60 * 1_000;
const EVIDENCE_FUTURE_SKEW_MS = 60 * 1_000;
const EXECUTION_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const SAFE_SOURCE_STATUSES = new Set(["idle", "paused"]);
const DECISION_APPROVER_USER_ID = "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B";
const CLEANUP_BLOCKER_CODES = new Set([
  "active_api_key",
  "principal_permission_grant",
  "company_membership",
  "agent_membership",
]);
const OPERATIONAL_DEPENDENCY_BLOCKERS: Record<
  AgentOperationalDependencyKey,
  { code: string; path: string }
> = {
  nonterminalIssues: { code: "nonterminal_issue", path: "/dependencies/nonterminalIssues" },
  activeRuns: { code: "active_run", path: "/dependencies/activeRuns" },
  activeWakeups: { code: "active_wakeup", path: "/dependencies/activeWakeups" },
  activeRoutines: { code: "active_routine", path: "/dependencies/activeRoutines" },
  enabledTriggers: { code: "enabled_trigger", path: "/dependencies/enabledTriggers" },
  activeRoutineRuns: { code: "active_routine_run", path: "/dependencies/activeRoutineRuns" },
  activeDocumentLocks: { code: "active_document_lock", path: "/dependencies/activeDocumentLocks" },
  activePlanDecompositions: {
    code: "active_plan_decomposition",
    path: "/dependencies/activePlanDecompositions",
  },
  activeProjectLeads: { code: "active_project_lead", path: "/dependencies/activeProjectLeads" },
  operativeGoals: { code: "operative_goal_owner", path: "/dependencies/operativeGoals" },
  activeRuntimeServices: {
    code: "active_runtime_service_owner",
    path: "/dependencies/activeRuntimeServices",
  },
  pendingApprovals: { code: "pending_approval_requester", path: "/dependencies/pendingApprovals" },
  activeIssueWatchdogs: { code: "active_issue_watchdog", path: "/dependencies/activeIssueWatchdogs" },
  activeRecoveryActions: {
    code: "active_recovery_action_owner",
    path: "/dependencies/activeRecoveryActions",
  },
  unclearedPipelineAgentLeases: {
    code: "uncleared_pipeline_agent_lease",
    path: "/dependencies/unclearedPipelineAgentLeases",
  },
  activePipelineApprovers: { code: "active_pipeline_approver", path: "/dependencies/activePipelineApprovers" },
  activeHireApprovalReferences: {
    code: "active_hire_approval_reference",
    path: "/dependencies/activeHireApprovalReferences",
  },
  outstandingEnvironmentLeases: {
    code: "outstanding_environment_lease",
    path: "/dependencies/outstandingEnvironmentLeases",
  },
  runningWorkspaceOperations: {
    code: "running_workspace_operation",
    path: "/dependencies/runningWorkspaceOperations",
  },
  liveDescendants: { code: "live_descendant", path: "/dependencies/liveDescendants" },
};

type UnknownRecord = Record<string, unknown>;
type ServiceOptions = {
  now?: () => Date;
  backupRoot?: string;
  retirementEvidenceRoot?: string;
  workspaceRoot?: string;
  onArtifactOpened?: (kind: string, artifactPath: string) => void | Promise<void>;
};
type Inventory = {
  source: typeof agents.$inferSelect;
  response: AgentRetirementPreflightResponse;
  sourceArtifactReceipt: RetirementSourceArtifactReceipt | null;
  commonArtifactReceipt: RetirementCommonArtifactReceipt | null;
};
type ClaimedArtifacts = {
  sourceArtifactReceipt: RetirementSourceArtifactReceipt;
  commonArtifactReceipt: RetirementCommonArtifactReceipt;
};
type PlanRegistration = {
  registrationReceiptId: string;
  evidenceBySourceId: AgentRetirementEvidenceBySourceId;
  sourceArtifactReceiptsBySourceId: Record<string, RetirementSourceArtifactReceipt>;
  commonArtifactReceipt: RetirementCommonArtifactReceipt;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = asRecord(value);
  if (Object.keys(record).length > 0 || (value && typeof value === "object")) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown) {
  return `v1:sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function parseEvidence(input: unknown): AgentRetirementEvidence {
  const parsed = agentRetirementEvidenceSchema.safeParse(input);
  if (!parsed.success) throw badRequest("Retirement evidence is invalid", { code: "retirement_evidence_invalid" });
  return parsed.data;
}

function parsePreflightRequest(input: unknown): AgentRetirementPreflightRequest | null {
  const parsed = agentRetirementPreflightRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseExecutionRecoveryRequest(input: unknown): AgentRetirementExecutionRecoveryRequest | null {
  const parsed = agentRetirementExecutionRecoveryRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseCleanupRequest(input: unknown): AgentRetirementCleanupRequest | null {
  const parsed = agentRetirementCleanupRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseCleanup(input: unknown): AgentRetirementCleanup {
  const parsed = agentRetirementCleanupSchema.safeParse(input);
  if (!parsed.success) throw badRequest("Retirement cleanup evidence is invalid", { code: "retirement_cleanup_invalid" });
  return parsed.data;
}

function parseTermination(input: unknown): AgentRetirementTermination {
  const parsed = agentRetirementTerminationSchema.safeParse(input);
  if (!parsed.success) throw badRequest("Retirement termination evidence is invalid", { code: "retirement_termination_invalid" });
  return parsed.data;
}

function canonicalRetirementAgentId(agentId: string): string {
  const normalized = normalizeAgentRetirementId(agentId);
  if (normalized === null) throw notFound("Agent not found");
  return normalized;
}

function extractCleanupEvidence(input: AgentRetirementCleanup): AgentRetirementEvidence {
  const { preflightFingerprint: _preflightFingerprint, ...evidence } = input;
  return evidence;
}

function addBlocker(
  blockers: AgentRetirementBlocker[],
  code: string,
  path: string,
  count = 1,
) {
  blockers.push({
    code,
    path,
    count,
    cleanupEligible: CLEANUP_BLOCKER_CODES.has(code),
  });
}

function timestampFresh(value: string, nowMs: number) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed <= nowMs + EVIDENCE_FUTURE_SKEW_MS
    && nowMs - parsed <= EVIDENCE_MAX_AGE_MS;
}

function evidenceFingerprint(evidence: AgentRetirementEvidence) {
  return fingerprint({ kind: "agent_retirement_evidence", evidence });
}

function evidenceBundleSha256(evidenceBySourceId: AgentRetirementEvidenceBySourceId) {
  return createHash("sha256").update(stableStringify(evidenceBySourceId)).digest("hex");
}

function planCore(plan: AgentRetirementPlan) {
  const { receiptId: _receiptId, ...core } = plan;
  return core;
}

function canonicalRetirementSourceIds() {
  return [...AGENT_RETIREMENT_ALLOWLIST.keys()].sort();
}

function canonicalManifestFingerprint() {
  return fingerprint([...AGENT_RETIREMENT_ALLOWLIST.values()]
    .map((entry) => ({
      sourceAgentId: entry.sourceAgentId,
      companyId: entry.companyId,
      sourceName: entry.sourceName,
      decision: "terminate",
      physicalDelete: false,
      replacementAgentId: entry.replacementAgentId,
      replacementSystemRef: entry.replacementSystemRef,
      decisionIssueId: entry.decisionIssueId,
    }))
    .sort((left, right) => left.sourceAgentId.localeCompare(right.sourceAgentId)));
}

function canonicalManifestSha256() {
  return canonicalManifestFingerprint().slice("v1:sha256:".length);
}

function validateClientPlan(
  plan: AgentRetirementPlan,
  evidence: AgentRetirementEvidence,
  observedAt?: Date,
) {
  const validatedAt = new Date(plan.validatedAt);
  const expiresAt = new Date(plan.expiresAt);
  if (
    validatedAt.toISOString() !== plan.validatedAt
    || expiresAt.toISOString() !== plan.expiresAt
    || expiresAt.getTime() - validatedAt.getTime() !== EXECUTION_MAX_AGE_MS
    || (observedAt && validatedAt.getTime() > observedAt.getTime() + EVIDENCE_FUTURE_SKEW_MS)
    || validatedAt.getTime() < Date.parse(evidence.humanGate.approvedAt)
    || validatedAt.getTime() < Date.parse(evidence.backupRestore.restoreVerifiedAt)
    || plan.receiptId !== fingerprint(planCore(plan))
    || plan.manifestFingerprint !== canonicalManifestFingerprint()
    || plan.manifestFingerprint !== `v1:sha256:${evidence.humanGate.manifestSha256}`
    || stableStringify(plan.sourceIds) !== stableStringify(canonicalRetirementSourceIds())
    || plan.approvalCommentId !== evidence.humanGate.commentId
    || plan.approvalFingerprint !== fingerprint(evidence.humanGate)
  ) {
    throw conflict("Retirement plan is not exactly bound to the canonical execution scope", {
      code: "retirement_plan_invalid",
    });
  }
  return plan;
}

function evidenceFreshUntil(evidence: AgentRetirementEvidence) {
  const anchors = [
    evidence.sourceExport.capturedAt,
    evidence.backupRestore.masterKeyCapturedAt,
    evidence.backupRestore.dumpCapturedAt,
    evidence.backupRestore.restoreVerifiedAt,
    evidence.humanGate.approvedAt,
  ].map(Date.parse);
  return new Date(Math.min(...anchors) + EVIDENCE_MAX_AGE_MS);
}

function claimProjection(input: {
  state: AgentRetirementPreflightResponse["claimState"];
  planReceiptId?: string | null;
  executionReceiptId?: string | null;
  startedAt?: Date | null;
  expiresAt?: Date | null;
}) {
  return {
    claimState: input.state,
    planClaimReceiptId: input.planReceiptId ?? null,
    executionClaimReceiptId: input.executionReceiptId ?? null,
    executionStartedAt: input.startedAt?.toISOString() ?? null,
    executionExpiresAt: input.expiresAt?.toISOString() ?? null,
  };
}

function dependencyCounts(): AgentRetirementDependencyCounts {
  return {
    ...createEmptyAgentOperationalDependencyCounts(),
    activeApiKeys: 0,
    principalPermissionGrants: 0,
    companyMemberships: 0,
    agentMemberships: 0,
  };
}

function sortedIds(rows: Array<{ id: string }>) {
  return rows.map((row) => row.id).sort((left, right) => left.localeCompare(right));
}

function readCleanupReceipt(details: unknown): AgentRetirementCleanupResponse | null {
  const record = asRecord(details);
  const response = agentRetirementCleanupResponseSchema.safeParse(record.response);
  return response.success ? response.data : null;
}

function readTerminationReceipt(details: unknown): AgentRetirementTerminationReceipt | null {
  const parsed = agentRetirementTerminationReceiptSchema.safeParse(asRecord(details).receipt);
  return parsed.success ? parsed.data : null;
}

// The instance backup directory may live behind a symlink (relocated to external storage).
// Artifact verification rejects symlinked roots, so the configured default is resolved first;
// a missing path is left to the fail-closed artifact checks.
export function resolveRetirementBackupRoot(configured: string) {
  try {
    return realpathSync(configured);
  } catch {
    return configured;
  }
}

export function agentRetirementService(db: Db, options: ServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const artifactOptions = () => ({
    backupRoot: options.backupRoot
      ?? resolveRetirementBackupRoot(path.join(os.homedir(), "paperclip/instances/default/data/backups")),
    retirementEvidenceRoot: options.retirementEvidenceRoot
      ?? path.join(os.homedir(), ".openclaw/workspace/projects/paperclip/docs/reports/2026-07-12-agent-portfolio/retirement"),
    now: now(),
    maxAgeMs: EVIDENCE_MAX_AGE_MS,
    futureSkewMs: EVIDENCE_FUTURE_SKEW_MS,
    ...(options.onArtifactOpened ? { onArtifactOpened: options.onArtifactOpened } : {}),
  });

  async function buildInventory(
    targetDb: Db,
    sourceId: string,
    rawEvidence: AgentRetirementEvidence,
    verification: {
      claimedArtifacts?: ClaimedArtifacts;
      trustedCommonArtifactReceipt?: RetirementCommonArtifactReceipt;
      requireFreshCanary?: boolean;
    } = {},
  ): Promise<Inventory> {
    const evidence = parseEvidence(rawEvidence);
    const source = await targetDb
      .select()
      .from(agents)
      .where(eq(agents.id, sourceId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Agent not found");

    const blockers: AgentRetirementBlocker[] = [];
    const counts = dependencyCounts();
    const allowlisted = getAgentRetirementSource(sourceId);
    if (
      !allowlisted
      || allowlisted.companyId !== source.companyId
      || allowlisted.sourceName !== source.name
      || evidence.source.sourceAgentId !== sourceId
      || evidence.source.companyId !== source.companyId
      || evidence.humanGate.issueId !== allowlisted.decisionIssueId
      || evidence.replacement.replacementAgentId !== allowlisted.replacementAgentId
      || evidence.replacement.replacementSystemRef !== allowlisted.replacementSystemRef
      || evidence.replacement.canaryAgentId !== allowlisted.canaryAgentId
    ) {
      addBlocker(blockers, "source_not_allowlisted", "/source");
    }
    const observedUpdatedAt = source.updatedAt.toISOString();
    if (observedUpdatedAt !== evidence.expectedUpdatedAt) {
      addBlocker(blockers, "source_state_stale", "/expectedUpdatedAt");
    }
    if (!SAFE_SOURCE_STATUSES.has(source.status)) {
      addBlocker(blockers, "source_status_unsafe", "/source/status");
    }

    const nowMs = now().getTime();
    let sourceArtifactReceipt: RetirementSourceArtifactReceipt | null = null;
    let commonArtifactReceipt: RetirementCommonArtifactReceipt | null = null;
    try {
      sourceArtifactReceipt = verification.claimedArtifacts
        ? await revalidateRetirementSourceArtifactReceipt(evidence, {
            sourceId,
            companyId: source.companyId,
            sourceName: source.name,
            expectedUpdatedAt: evidence.expectedUpdatedAt,
          }, verification.claimedArtifacts.sourceArtifactReceipt, artifactOptions())
        : await verifyRetirementSourceExport(evidence, {
            sourceId,
            companyId: source.companyId,
            sourceName: source.name,
            expectedUpdatedAt: evidence.expectedUpdatedAt,
          }, artifactOptions());
    } catch {
      addBlocker(blockers, "source_export_evidence_invalid", "/sourceExport");
    }
    try {
      commonArtifactReceipt = verification.claimedArtifacts
        ? await revalidateRetirementCommonArtifactReceipt(
            evidence,
            verification.claimedArtifacts.commonArtifactReceipt,
            artifactOptions(),
          )
        : verification.trustedCommonArtifactReceipt
          ? assertRetirementCommonArtifactReceipt(evidence, verification.trustedCommonArtifactReceipt)
          : await verifyRetirementBackupRestore(evidence, artifactOptions());
    } catch {
      addBlocker(blockers, "backup_restore_evidence_invalid", "/backupRestore");
    }
    const masterAt = Date.parse(evidence.backupRestore.masterKeyCapturedAt);
    const dumpAt = Date.parse(evidence.backupRestore.dumpCapturedAt);
    const restoreAt = Date.parse(evidence.backupRestore.restoreVerifiedAt);
    if (
      (!verification.claimedArtifacts && (
        !timestampFresh(evidence.sourceExport.capturedAt, nowMs)
        || !timestampFresh(evidence.backupRestore.masterKeyCapturedAt, nowMs)
        || !timestampFresh(evidence.backupRestore.dumpCapturedAt, nowMs)
        || !timestampFresh(evidence.backupRestore.restoreVerifiedAt, nowMs)
      ))
      || masterAt > dumpAt
      || dumpAt > restoreAt
    ) {
      if (!blockers.some((blocker) => blocker.code === "backup_restore_evidence_invalid")) {
        addBlocker(blockers, "backup_restore_evidence_invalid", "/backupRestore");
      }
    }

    const gateIssue = await targetDb
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.id, evidence.humanGate.issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const gateComment = await targetDb
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        body: issueComments.body,
        authorUserId: issueComments.authorUserId,
        deletedAt: issueComments.deletedAt,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.id, evidence.humanGate.commentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const activeApprovalComments = await targetDb
      .select({
        id: issueComments.id,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, evidence.humanGate.issueId),
        isNull(issueComments.deletedAt),
      ));
    const parsedApproval = gateComment
      ? parseAgentRetirementApprovalComment(gateComment.body)
      : null;
    const expectedApprovalBinding = {
      approvalNonce: evidence.humanGate.approvalNonce,
      manifestSha256: evidence.humanGate.manifestSha256,
      backupSha256: evidence.humanGate.backupSha256,
      restoreReceiptSha256: evidence.humanGate.restoreReceiptSha256,
    };
    const nonceCommentIds = activeApprovalComments
      .filter((candidate) => (
        parseAgentRetirementApprovalComment(candidate.body)?.approvalNonce
          === evidence.humanGate.approvalNonce
      ))
      .map((candidate) => candidate.id);
    if (
      !gateComment
      || gateIssue?.identifier !== "TEC-355"
      || gateComment.issueId !== gateIssue?.id
      || gateComment.authorUserId !== DECISION_APPROVER_USER_ID
      || gateComment.deletedAt !== null
      || gateComment.createdAt.toISOString() !== evidence.humanGate.approvedAt
      || gateComment.createdAt.getTime() <= Date.parse(evidence.backupRestore.restoreVerifiedAt)
      || parsedApproval === null
      || stableStringify(parsedApproval) !== stableStringify(expectedApprovalBinding)
      || gateComment.body !== formatAgentRetirementApprovalComment(expectedApprovalBinding)
      || createHash("sha256").update(gateComment.body).digest("hex") !== evidence.humanGate.approvedTextSha256
      || evidence.humanGate.manifestSha256 !== canonicalManifestSha256()
      || evidence.humanGate.backupSha256 !== evidence.backupRestore.dumpSha256
      || evidence.humanGate.restoreReceiptSha256 !== evidence.backupRestore.restoreEvidenceSha256
      || nonceCommentIds.length !== 1
      || nonceCommentIds[0] !== gateComment.id
    ) {
      addBlocker(blockers, "human_gate_invalid", "/humanGate");
    }

    const canaryAgent = await targetDb
      .select()
      .from(agents)
      .where(eq(agents.id, evidence.replacement.canaryAgentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const canaryRun = await targetDb
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, evidence.replacement.canaryRunId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const canaryIssue = await targetDb
      .select({ id: issues.id, companyId: issues.companyId, status: issues.status, executionRunId: issues.executionRunId, description: issues.description })
      .from(issues)
      .where(eq(issues.id, evidence.replacement.canaryIssueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const metadata = asRecord(canaryAgent?.metadata);
    const lifecycleResult = agentLifecycleSchema.safeParse(metadata.lifecycle);
    const gateResult = agentLifecycleGateSchema.safeParse(metadata.lifecycleGate);
    const lifecycle = lifecycleResult.success ? lifecycleResult.data : null;
    const gate = gateResult.success ? gateResult.data : null;
    const canaryContext = asRecord(canaryRun?.contextSnapshot);
    const lifecycleCanary = asRecord(canaryContext.lifecycleCanary);
    const systemReplacementReceipt = asRecord(lifecycleCanary.systemReplacementReceipt);
    const canaryAt = lifecycle?.lastCanaryAt ? Date.parse(lifecycle.lastCanaryAt) : Number.NaN;
    const canaryFreshUntil = lifecycle && Number.isFinite(canaryAt)
      ? canaryAt + lifecycle.canaryFreshnessDays * 24 * 60 * 60 * 1_000
      : Number.NaN;
    if (
      !canaryAgent
      || canaryAgent.status !== "idle"
      || (evidence.replacement.replacementAgentId !== null
        && canaryAgent.id !== evidence.replacement.replacementAgentId)
      || lifecycle?.lastCanaryResult !== "passed"
      || lifecycle.canaryIssueId !== evidence.replacement.canaryIssueId
      || !Number.isFinite(canaryFreshUntil)
      || ((!verification.claimedArtifacts || verification.requireFreshCanary) && canaryFreshUntil < nowMs)
      || gate?.findingCount !== 0
      || gate.configFingerprint !== evidence.replacement.configFingerprint
      || gate.lastSatisfiedRunId !== evidence.replacement.canaryRunId
      || ((!verification.claimedArtifacts || verification.requireFreshCanary) && Date.parse(gate.expiresAt) < nowMs)
      || canaryRun?.agentId !== canaryAgent.id
      || canaryRun.companyId !== canaryAgent.companyId
      || canaryRun.status !== "succeeded"
      || canaryContext.issueId !== evidence.replacement.canaryIssueId
      || canaryContext.taskId !== evidence.replacement.canaryIssueId
      || canaryContext.taskKey !== `lifecycle-canary:${evidence.replacement.canaryIssueId}`
      || lifecycleCanary.agentId !== canaryAgent.id
      || lifecycleCanary.companyId !== canaryAgent.companyId
      || lifecycleCanary.canaryIssueId !== evidence.replacement.canaryIssueId
      || lifecycleCanary.runId !== evidence.replacement.canaryRunId
      || lifecycleCanary.configFingerprint !== evidence.replacement.configFingerprint
      || lifecycleCanary.receiptHash !== gate?.receiptHash
      || canaryIssue?.companyId !== canaryAgent.companyId
      || canaryIssue?.status !== "done"
      || canaryIssue.executionRunId !== null
    ) {
      addBlocker(blockers, "replacement_canary_invalid", "/replacement");
    }
    if (evidence.replacement.replacementSystemRef !== null) {
      const receiptHash = createHash("sha256")
        .update(stableStringify(systemReplacementReceipt))
        .digest("hex");
      let systemReplacementInvalid = (
        systemReplacementReceipt.schemaVersion !== "1.0.0"
        || systemReplacementReceipt.sourceAgentId !== sourceId
        || systemReplacementReceipt.replacementSystemRef !== evidence.replacement.replacementSystemRef
        || systemReplacementReceipt.scenario !== "workspace-project-binding"
        || systemReplacementReceipt.runId !== evidence.replacement.canaryRunId
        || systemReplacementReceipt.canaryIssueId !== evidence.replacement.canaryIssueId
        || systemReplacementReceipt.configFingerprint !== evidence.replacement.configFingerprint
        || typeof systemReplacementReceipt.nonce !== "string"
        || !/^[a-f0-9]{32,128}$/.test(systemReplacementReceipt.nonce)
        || systemReplacementReceipt.observedRef !== "workspace:projects/kaffee:PROJECT.md"
        || typeof systemReplacementReceipt.observedSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(systemReplacementReceipt.observedSha256)
        || receiptHash !== evidence.replacement.systemCanaryReceiptSha256
      );
      if (!systemReplacementInvalid) {
        try {
          await verifyRetirementSystemReplacementArtifact({
            replacementSystemRef: evidence.replacement.replacementSystemRef,
            observedRef: systemReplacementReceipt.observedRef,
            observedSha256: systemReplacementReceipt.observedSha256,
            workspaceRoot: options.workspaceRoot ?? path.join(os.homedir(), ".openclaw/workspace"),
          });
        } catch {
          systemReplacementInvalid = true;
        }
      }
      if (systemReplacementInvalid) {
        addBlocker(blockers, "replacement_system_canary_invalid", "/replacement/replacementSystemRef");
      }
    }

    const operationalDependencies = await scanAgentOperationalDependencies(targetDb, sourceId);
    Object.assign(counts, operationalDependencies.counts);
    for (const key of AGENT_OPERATIONAL_DEPENDENCY_KEYS) {
      const count = operationalDependencies.counts[key];
      if (count === 0) continue;
      const blocker = OPERATIONAL_DEPENDENCY_BLOCKERS[key];
      addBlocker(blockers, blocker.code, blocker.path, count);
    }

    const keyRows = await targetDb
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.agentId, sourceId), isNull(agentApiKeys.revokedAt)));
    counts.activeApiKeys = keyRows.length;
    if (counts.activeApiKeys > 0) addBlocker(blockers, "active_api_key", "/dependencies/activeApiKeys", counts.activeApiKeys);

    const grantRows = await targetDb
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.principalType, "agent"),
        sql`lower(${principalPermissionGrants.principalId}) = ${sourceId}`,
      ));
    counts.principalPermissionGrants = grantRows.length;
    if (counts.principalPermissionGrants > 0) addBlocker(blockers, "principal_permission_grant", "/dependencies/principalPermissionGrants", counts.principalPermissionGrants);

    const companyMembershipRows = await targetDb
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.principalType, "agent"),
        sql`lower(${companyMemberships.principalId}) = ${sourceId}`,
        eq(companyMemberships.status, "active"),
      ));
    counts.companyMemberships = companyMembershipRows.length;
    if (counts.companyMemberships > 0) addBlocker(blockers, "company_membership", "/dependencies/companyMemberships", counts.companyMemberships);

    const membershipRows = await targetDb
      .select({ id: agentMemberships.id })
      .from(agentMemberships)
      .where(and(eq(agentMemberships.agentId, sourceId), ne(agentMemberships.state, "left")));
    counts.agentMemberships = membershipRows.length;
    if (counts.agentMemberships > 0) addBlocker(blockers, "agent_membership", "/dependencies/agentMemberships", counts.agentMemberships);

    blockers.sort((left, right) => `${left.code}:${left.path}`.localeCompare(`${right.code}:${right.path}`));
    const cleanupEligible = blockers.every((blocker) => blocker.cleanupEligible);
    const inventoryFingerprint = fingerprint({
      schemaVersion: "1.0.0",
      source: {
        id: source.id,
        companyId: source.companyId,
        name: source.name,
        status: source.status,
        updatedAt: observedUpdatedAt,
      },
      evidence,
      blockers,
      dependencyCounts: counts,
      dependencyIds: {
        nonterminalIssues: operationalDependencies.ids.nonterminalIssues,
        activeRuns: operationalDependencies.ids.activeRuns,
        outstandingEnvironmentLeases: operationalDependencies.ids.outstandingEnvironmentLeases,
        runningWorkspaceOperations: operationalDependencies.ids.runningWorkspaceOperations,
        activeWakes: operationalDependencies.ids.activeWakeups,
        activeRoutines: operationalDependencies.ids.activeRoutines,
        enabledTriggers: operationalDependencies.ids.enabledTriggers,
        activeRoutineRuns: operationalDependencies.ids.activeRoutineRuns,
        activeProjects: operationalDependencies.ids.activeProjectLeads,
        operativeGoals: operationalDependencies.ids.operativeGoals,
        activeRuntimeServices: operationalDependencies.ids.activeRuntimeServices,
        pendingApprovals: operationalDependencies.ids.pendingApprovals,
        activeIssueWatchdogs: operationalDependencies.ids.activeIssueWatchdogs,
        activeRecoveryActions: operationalDependencies.ids.activeRecoveryActions,
        unclearedPipelineAgentLeases: operationalDependencies.ids.unclearedPipelineAgentLeases,
        activePipelineApprovers: operationalDependencies.ids.activePipelineApprovers,
        activeHireApprovalReferences: operationalDependencies.ids.activeHireApprovalReferences,
        liveDescendants: operationalDependencies.ids.liveDescendants,
        activeKeys: sortedIds(keyRows),
        grants: sortedIds(grantRows),
        companyMemberships: sortedIds(companyMembershipRows),
        agentMemberships: sortedIds(membershipRows),
      },
    });
    return {
      source,
      response: {
        schemaVersion: "1.0.0",
        agentId: source.id,
        companyId: source.companyId,
        ok: blockers.length === 0,
        cleanupEligible,
        blockers,
        dependencyCounts: counts,
        fingerprint: inventoryFingerprint,
        observedUpdatedAt,
        ...claimProjection({ state: "unclaimed" }),
      },
      sourceArtifactReceipt,
      commonArtifactReceipt,
    };
  }

  async function findPlanClaimByClientReceipt(targetDb: Db, receiptId: string) {
    return targetDb
      .select()
      .from(agentRetirementPlanClaims)
      .where(eq(agentRetirementPlanClaims.clientPlanReceiptId, receiptId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findPlanClaimByReceipt(targetDb: Db, receiptId: string) {
    return targetDb
      .select()
      .from(agentRetirementPlanClaims)
      .where(eq(agentRetirementPlanClaims.receiptId, receiptId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findExecutionClaim(targetDb: Db, sourceId: string) {
    return targetDb
      .select()
      .from(agentRetirementExecutionClaims)
      .where(eq(agentRetirementExecutionClaims.sourceAgentId, sourceId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function registrationReceiptId(input: {
    plan: AgentRetirementPlan;
    evidenceBySourceId: AgentRetirementEvidenceBySourceId;
    sourceArtifactReceiptsBySourceId: Record<string, RetirementSourceArtifactReceipt>;
    commonArtifactReceipt: RetirementCommonArtifactReceipt;
  }) {
    return fingerprint({
      kind: "agent_retirement_plan_registration",
      clientPlan: input.plan,
      evidenceSha256: evidenceBundleSha256(input.evidenceBySourceId),
      sourceArtifactReceiptIds: Object.fromEntries(Object.entries(input.sourceArtifactReceiptsBySourceId)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceId, receipt]) => [sourceId, receipt.receiptId])),
      commonArtifactReceiptId: input.commonArtifactReceipt.receiptId,
    });
  }

  function serverPlanReceiptId(plan: AgentRetirementPlan, registrationReceipt: string) {
    return fingerprint({
      kind: "server_retirement_plan_claim",
      clientPlan: plan,
      registrationReceiptId: registrationReceipt,
    });
  }

  async function findPlanRegistration(
    targetDb: Db,
    planRow: typeof agentRetirementPlanClaims.$inferSelect,
  ): Promise<PlanRegistration> {
    const auditRows = await targetDb
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.retirement_plan_registered"),
        eq(activityLog.entityType, "retirement_plan"),
        eq(activityLog.entityId, planRow.id),
      ));
    const bundleRows = await targetDb
      .select()
      .from(agentRetirementPlanEvidenceBundles)
      .where(eq(agentRetirementPlanEvidenceBundles.planClaimId, planRow.id));
    if (auditRows.length !== 1 || bundleRows.length !== 1) {
      throw conflict("Retirement plan registration audit is missing", {
        code: "retirement_plan_registration_missing",
      });
    }
    const details = asRecord(auditRows[0]?.details);
    const privateBundle = bundleRows[0]!;
    const bundle = agentRetirementEvidenceBySourceIdSchema.safeParse(
      privateBundle.evidenceBySourceId,
    );
    const sourceReceipts = asRecord(privateBundle.sourceArtifactReceiptsBySourceId);
    const parsedPlan = agentRetirementPlanSchema.safeParse(planRow.plan);
    if (!bundle.success || !parsedPlan.success) {
      throw conflict("Retirement plan registration audit is invalid", {
        code: "retirement_plan_registration_drift",
      });
    }
    const commonArtifactReceipt = planRow.commonArtifactReceipt as RetirementCommonArtifactReceipt;
    const sourceArtifactReceiptsBySourceId: Record<string, RetirementSourceArtifactReceipt> = {};
    for (const sourceId of canonicalRetirementSourceIds()) {
      const allowlisted = getAgentRetirementSource(sourceId)!;
      try {
        sourceArtifactReceiptsBySourceId[sourceId] = assertRetirementSourceArtifactReceipt(
          bundle.data[sourceId]!,
          {
            sourceId,
            companyId: allowlisted.companyId,
            sourceName: allowlisted.sourceName,
            expectedUpdatedAt: bundle.data[sourceId]!.expectedUpdatedAt,
          },
          sourceReceipts[sourceId],
        );
      } catch {
        throw conflict("Retirement plan source registration drifted", {
          code: "retirement_plan_registration_drift",
          sourceId,
        });
      }
    }
    const expectedRegistrationReceiptId = registrationReceiptId({
      plan: parsedPlan.data,
      evidenceBySourceId: bundle.data,
      sourceArtifactReceiptsBySourceId,
      commonArtifactReceipt,
    });
    if (
      details.schemaVersion !== "1.0.0"
      || details.sourceCount !== canonicalRetirementSourceIds().length
      || details.clientPlanReceiptId !== planRow.clientPlanReceiptId
      || details.planClaimReceiptId !== planRow.receiptId
      || details.registrationReceiptId !== expectedRegistrationReceiptId
      || privateBundle.registrationReceiptId !== expectedRegistrationReceiptId
      || "evidenceBySourceId" in details
      || "sourceArtifactReceiptsBySourceId" in details
      || planRow.receiptId !== serverPlanReceiptId(parsedPlan.data, expectedRegistrationReceiptId)
      || parsedPlan.data.evidenceSha256 !== evidenceBundleSha256(bundle.data)
    ) {
      throw conflict("Retirement plan registration audit drifted", {
        code: "retirement_plan_registration_drift",
      });
    }
    return {
      registrationReceiptId: expectedRegistrationReceiptId,
      evidenceBySourceId: bundle.data,
      sourceArtifactReceiptsBySourceId,
      commonArtifactReceipt,
    };
  }

  async function createLiveRetirementRestoreInventory(
    targetDb: Db,
    expected: RetirementRestoreInventoryProof,
  ) {
    assertRetirementRestoreInventory(
      expected,
      RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION,
    );
    const partition = RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION;
    const sourceIds = new Set(canonicalRetirementSourceIds());
    const retainedIds = new Set(partition.retainedAgents.map((row) => row.agentId));
    const tombstoneIds = new Set(partition.historicalTombstones.map((row) => row.agentId));
    const classifiedIds = new Set([...sourceIds, ...retainedIds, ...tombstoneIds]);
    const allAgents = await targetDb.select().from(agents);
    const allApiKeys = await targetDb.select().from(agentApiKeys);
    const allGrants = await targetDb.select().from(principalPermissionGrants);
    const allCompanyMemberships = await targetDb.select().from(companyMemberships);
    const allAgentMemberships = await targetDb.select().from(agentMemberships);
    const allCompanies = await targetDb.select().from(companies);
    const allSecrets = await targetDb.select().from(companySecrets);
    const allSecretVersions = await targetDb.select().from(companySecretVersions);
    const allSecretBindings = await targetDb.select().from(companySecretBindings);
    const allUserSecretDeclarations = await targetDb.select().from(userSecretDeclarations);
    const allSkillStars = await targetDb.select().from(companySkillStars);
    const allIssues = await targetDb.select().from(issues);
    const allProjects = await targetDb.select().from(projects);
    const allGoals = await targetDb.select().from(goals);
    const allRoutines = await targetDb.select().from(routines);
    const allRoutineTriggers = await targetDb.select().from(routineTriggers);
    const allRoutineRuns = await targetDb.select().from(routineRuns);
    const allRoutineDeliveries = await targetDb.select().from(routineRunDeliveries);
    // Only portfolio runs can contribute to the retirement restore proof. A
    // full-row scan also pulls large log/context payloads for unrelated agents
    // and made each guarded cleanup needlessly expensive.
    const allHeartbeatRuns = await targetDb
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [...sourceIds, ...tombstoneIds]));
    const allApprovalExecutionClaims = await targetDb.select().from(approvalExecutionClaims);
    const allWorkspaceRuntimeStartClaims = await targetDb
      .select({
        row: {
          id: workspaceRuntimeStartClaims.id,
          companyId: workspaceRuntimeStartClaims.companyId,
          serviceKey: workspaceRuntimeStartClaims.serviceKey,
          claimId: workspaceRuntimeStartClaims.claimId,
          status: workspaceRuntimeStartClaims.status,
          runtimeServiceId: workspaceRuntimeStartClaims.runtimeServiceId,
          ownerAgentId: workspaceRuntimeStartClaims.ownerAgentId,
          failureCode: workspaceRuntimeStartClaims.failureCode,
          claimedAt: workspaceRuntimeStartClaims.claimedAt,
          expiresAt: workspaceRuntimeStartClaims.expiresAt,
          finalizedAt: workspaceRuntimeStartClaims.finalizedAt,
          updatedAt: workspaceRuntimeStartClaims.updatedAt,
        },
        runtimeServiceOwnerAgentId: workspaceRuntimeServices.ownerAgentId,
      })
      .from(workspaceRuntimeStartClaims)
      .leftJoin(
        workspaceRuntimeServices,
        eq(workspaceRuntimeServices.id, workspaceRuntimeStartClaims.runtimeServiceId),
      );
    const allWakeRequests = await targetDb.select().from(agentWakeupRequests);
    const allRuntimeServices = await targetDb.select().from(workspaceRuntimeServices);
    const allApprovals = await targetDb.select().from(approvals);
    const allTaskSessions = await targetDb.select().from(agentTaskSessions);
    const allIssueWatchdogs = await targetDb.select().from(issueWatchdogs);
    const allRecoveryActions = await targetDb.select().from(issueRecoveryActions);
    const allPipelineCases = await targetDb.select().from(pipelineCases);
    const allPipelines = await targetDb.select().from(pipelines);
    const allPipelineStages = await targetDb.select().from(pipelineStages);
    const allEnvironmentLeases = await targetDb.select().from(environmentLeases);
    const allWorkspaceOperations = await targetDb.select().from(workspaceOperations);
    if (allAgents.some((row) => !classifiedIds.has(row.id))) {
      throw new Error("Live retirement inventory contains an unclassified agent");
    }
    for (const tombstoneId of tombstoneIds) {
      const dependencies = await scanAgentOperationalDependencies(targetDb, tombstoneId);
      if (AGENT_OPERATIONAL_DEPENDENCY_KEYS.some((key) => dependencies.counts[key] > 0)) {
        throw new Error("Historical tombstone has an active or unknown operational dependency");
      }
    }
    const tombstoneRoutines = allRoutines.filter((row) => (
      row.assigneeAgentId !== null && tombstoneIds.has(row.assigneeAgentId)
    ));
    const tombstoneRoutineIds = new Set(tombstoneRoutines.map((row) => row.id));
    const tombstoneRoutineRunIds = new Set(allRoutineRuns
      .filter((row) => tombstoneRoutineIds.has(row.routineId))
      .map((row) => row.id));
    const tombstoneRunIds = new Set(allHeartbeatRuns
      .filter((row) => tombstoneIds.has(row.agentId))
      .map((row) => row.id));
    const historicalLiveDescendantIds = new Set(
      [...tombstoneIds].flatMap((tombstoneId) => listLiveAgentDescendants(tombstoneId, allAgents)),
    );
    const problematicPipelineAgentLeases = allPipelineCases.filter((row) => {
      const tombstoneReference = row.leaseAgentId !== null && tombstoneIds.has(row.leaseAgentId);
      const agentShaped = row.leaseOwnerType === "agent" || row.leaseAgentId !== null;
      const wellFormedAgent = row.leaseOwnerType === "agent" && row.leaseAgentId !== null
        && row.leaseUserId === null && row.leaseToken !== null && row.leaseExpiresAt !== null;
      return tombstoneReference || (agentShaped && !wellFormedAgent);
    });
    assertHistoricalTombstoneWorkInertness({
      tombstoneIds: [...tombstoneIds],
      issues: allIssues
        .filter((row) => row.assigneeAgentId !== null && tombstoneIds.has(row.assigneeAgentId))
        .map((row) => ({ id: row.id, assigneeAgentId: row.assigneeAgentId, status: row.status })),
      routines: tombstoneRoutines.map((row) => ({
        id: row.id,
        assigneeAgentId: row.assigneeAgentId,
        status: row.status,
      })),
      routineTriggers: allRoutineTriggers
        .filter((row) => tombstoneRoutineIds.has(row.routineId))
        .map((row) => ({ id: row.id, routineId: row.routineId, enabled: row.enabled })),
      heartbeatRuns: allHeartbeatRuns
        .filter((row) => tombstoneIds.has(row.agentId))
        .map((row) => ({ id: row.id, agentId: row.agentId, status: row.status })),
      wakeRequests: allWakeRequests
        .filter((row) => tombstoneIds.has(row.agentId))
        .map((row) => ({ id: row.id, agentId: row.agentId, status: row.status })),
      projects: allProjects
        .filter((row) => row.leadAgentId !== null && tombstoneIds.has(row.leadAgentId))
        .map((row) => ({ id: row.id, leadAgentId: row.leadAgentId, archivedAt: row.archivedAt })),
      goals: allGoals
        .filter((row) => row.ownerAgentId !== null && tombstoneIds.has(row.ownerAgentId))
        .map((row) => ({ id: row.id, ownerAgentId: row.ownerAgentId, status: row.status })),
      runtimeServices: allRuntimeServices
        .filter((row) => row.ownerAgentId !== null && tombstoneIds.has(row.ownerAgentId))
        .map((row) => ({ id: row.id, ownerAgentId: row.ownerAgentId, status: row.status })),
      approvals: allApprovals
        .filter((row) => row.requestedByAgentId !== null && tombstoneIds.has(row.requestedByAgentId))
        .map((row) => ({ id: row.id, requestedByAgentId: row.requestedByAgentId, status: row.status })),
      taskSessions: allTaskSessions
        .filter((row) => tombstoneIds.has(row.agentId))
        .map((row) => ({ id: row.id, agentId: row.agentId, lastRunId: row.lastRunId })),
      activeIssueWatchdogs: allIssueWatchdogs
        .filter((row) => row.status === "active" && tombstoneIds.has(row.watchdogAgentId))
        .map((row) => ({ id: row.id, watchdogAgentId: row.watchdogAgentId, status: row.status })),
      activeRecoveryActions: allRecoveryActions
        .filter((row) => (
          row.ownerAgentId !== null
          && tombstoneIds.has(row.ownerAgentId)
          && ["active", "escalated"].includes(row.status)
        ))
        .map((row) => ({ id: row.id, ownerAgentId: row.ownerAgentId!, status: row.status })),
      pipelineAgentLeaseRows: problematicPipelineAgentLeases.map((row) => ({
        id: row.id,
        leaseOwnerType: row.leaseOwnerType,
        leaseAgentId: row.leaseAgentId,
        leaseUserId: row.leaseUserId,
        leaseToken: row.leaseToken,
        leaseExpiresAt: row.leaseExpiresAt,
      })),
    });
    const activePipelineIds = new Set(allPipelines.filter((row) => row.archivedAt === null).map((row) => row.id));
    const activePipelineApproverStages = allPipelineStages.filter((row) => {
      if (!activePipelineIds.has(row.pipelineId)) return false;
      const approver = row.config?.approver;
      const automation = asRecord(row.config?.automation);
      const isApprover = row.config?.requireApproval === true
        && approver !== null
        && typeof approver === "object"
        && !Array.isArray(approver)
        && (approver as UnknownRecord).kind === "agent"
        && typeof (approver as UnknownRecord).id === "string"
        && tombstoneIds.has(normalizeAgentRetirementId(String((approver as UnknownRecord).id)) ?? "");
      const isAutomationAssignee = typeof automation.assigneeAgentId === "string"
        && tombstoneIds.has(normalizeAgentRetirementId(automation.assigneeAgentId) ?? "");
      return isApprover || isAutomationAssignee;
    });
    const activeHireApprovalReferences = allApprovals.filter((row) => {
      if (row.type !== "hire_agent" || !isActiveRetirementHireApprovalStatus(row.status)) return false;
      const payload = asRecord(row.payload);
      return [payload.agentId, payload.reportsTo].some((value) => (
        typeof value === "string" && tombstoneIds.has(normalizeAgentRetirementId(value) ?? "")
      ));
    });
    const historicalEnvironmentLeases = allEnvironmentLeases.filter((row) => (
      (row.heartbeatRunId !== null && tombstoneRunIds.has(row.heartbeatRunId))
      || (() => {
        const metadata = asRecord(row.metadata);
        const reusable = asRecord(metadata.reusableSandboxLease);
        return [metadata.agentId, reusable.agentId].some((value) => (
          typeof value === "string"
          && tombstoneIds.has(normalizeAgentRetirementId(value) ?? "")
        ));
      })()
    ));
    const outstandingEnvironmentLeases = historicalEnvironmentLeases.filter((row) => {
      return !isTerminalRetirementEnvironmentLease({
        leasePolicy: row.leasePolicy,
        status: row.status,
        cleanupStatus: row.cleanupStatus,
      });
    });
    const historicalWorkspaceOperations = allWorkspaceOperations.filter((row) => (
      row.heartbeatRunId !== null && tombstoneRunIds.has(row.heartbeatRunId)
    ));
    const portfolioAgentIds = new Set([...sourceIds, ...tombstoneIds]);
    const runOwnerById = new Map(allHeartbeatRuns
      .filter((row) => portfolioAgentIds.has(row.agentId))
      .map((row) => [row.id, row.agentId]));
    const portfolioApprovalExecutionClaims = allApprovalExecutionClaims.flatMap((row) => {
      const portfolioAgentId = [
        row.agentId,
        runOwnerById.get(row.originRunId) ?? null,
        runOwnerById.get(row.executorRunId) ?? null,
      ].find((candidate): candidate is string => candidate !== null && portfolioAgentIds.has(candidate));
      return portfolioAgentId ? [{ row, portfolioAgentId }] : [];
    });
    const portfolioWorkspaceRuntimeStartClaims = allWorkspaceRuntimeStartClaims.flatMap((entry) => {
      const portfolioAgentId = [entry.row.ownerAgentId, entry.runtimeServiceOwnerAgentId]
        .find((candidate): candidate is string => candidate !== null && portfolioAgentIds.has(candidate));
      return portfolioAgentId ? [{
        row: entry.row,
        portfolioAgentId,
        runtimeServiceOwnerAgentId: entry.runtimeServiceOwnerAgentId,
      }] : [];
    });
    return createRetirementRestoreInventory({
      sourceAgents: allAgents.filter((row) => sourceIds.has(row.id)),
      retainedAgents: allAgents.filter((row) => retainedIds.has(row.id)),
      historicalTombstones: allAgents.filter((row) => tombstoneIds.has(row.id)),
      companies: allCompanies,
      activeApiKeys: allApiKeys.filter((row) => row.revokedAt === null && sourceIds.has(row.agentId)),
      principalPermissionGrants: allGrants.filter((row) => (
        row.principalType === "agent"
        && sourceIds.has(normalizeAgentRetirementId(row.principalId) ?? "")
      )),
      activeCompanyMemberships: allCompanyMemberships.filter((row) => (
        row.principalType === "agent"
        && row.status === "active"
        && sourceIds.has(normalizeAgentRetirementId(row.principalId) ?? "")
      )),
      nonLeftAgentMemberships: allAgentMemberships.filter((row) => (
        row.state !== "left" && sourceIds.has(row.agentId)
      )),
      agentSecretBindings: allSecretBindings.filter((row) => (
        row.targetType === "agent"
        && sourceIds.has(normalizeAgentRetirementId(row.targetId) ?? "")
      )),
      agentUserSecretDeclarations: allUserSecretDeclarations.filter((row) => (
        row.targetType === "agent"
        && sourceIds.has(normalizeAgentRetirementId(row.targetId) ?? "")
      )),
      agentSkillStars: allSkillStars.filter((row) => row.agentId !== null && sourceIds.has(row.agentId)),
      historicalActiveApiKeys: allApiKeys.filter((row) => (
        row.revokedAt === null && tombstoneIds.has(row.agentId)
      )),
      historicalPrincipalPermissionGrants: allGrants.filter((row) => (
        row.principalType === "agent"
        && tombstoneIds.has(normalizeAgentRetirementId(row.principalId) ?? "")
      )),
      historicalActiveCompanyMemberships: allCompanyMemberships.filter((row) => (
        row.principalType === "agent"
        && row.status === "active"
        && tombstoneIds.has(normalizeAgentRetirementId(row.principalId) ?? "")
      )),
      historicalNonLeftAgentMemberships: allAgentMemberships.filter((row) => (
        row.state !== "left" && tombstoneIds.has(row.agentId)
      )),
      historicalAgentSecretBindings: allSecretBindings.filter((row) => (
        row.targetType === "agent"
        && tombstoneIds.has(normalizeAgentRetirementId(row.targetId) ?? "")
      )),
      historicalAgentUserSecretDeclarations: allUserSecretDeclarations.filter((row) => (
        row.targetType === "agent"
        && tombstoneIds.has(normalizeAgentRetirementId(row.targetId) ?? "")
      )),
      historicalAgentSkillStars: allSkillStars.filter((row) => (
        row.agentId !== null && tombstoneIds.has(row.agentId)
      )),
      historicalActiveProjectLeads: allProjects.filter((row) => (
        row.leadAgentId !== null
        && tombstoneIds.has(row.leadAgentId)
        && row.archivedAt === null
      )),
      historicalOperativeGoalOwnerships: allGoals.filter((row) => (
        row.ownerAgentId !== null
        && tombstoneIds.has(row.ownerAgentId)
        && isOperativeRetirementGoalStatus(row.status)
      )),
      historicalHeartbeatRuns: allHeartbeatRuns.filter((row) => tombstoneIds.has(row.agentId)),
      historicalWorkspaceRuntimeServices: allRuntimeServices.filter((row) => (
        row.ownerAgentId !== null && tombstoneIds.has(row.ownerAgentId)
      )),
      historicalApprovals: allApprovals.filter((row) => (
        row.requestedByAgentId !== null && tombstoneIds.has(row.requestedByAgentId)
      )),
      historicalTaskSessions: allTaskSessions.filter((row) => tombstoneIds.has(row.agentId)),
      historicalIssues: allIssues.filter((row) => (
        row.assigneeAgentId !== null && tombstoneIds.has(row.assigneeAgentId)
      )),
      historicalRoutines: tombstoneRoutines,
      historicalRoutineTriggers: allRoutineTriggers.filter((row) => tombstoneRoutineIds.has(row.routineId)),
      historicalRoutineRuns: allRoutineRuns.filter((row) => tombstoneRoutineIds.has(row.routineId)),
      historicalRoutineDeliveries: allRoutineDeliveries.filter((row) => (
        tombstoneRoutineRunIds.has(row.routineRunId)
      )),
      approvalExecutionClaims: portfolioApprovalExecutionClaims,
      workspaceRuntimeStartClaims: portfolioWorkspaceRuntimeStartClaims,
      historicalWakeRequests: allWakeRequests.filter((row) => tombstoneIds.has(row.agentId)),
      historicalActiveIssueWatchdogs: allIssueWatchdogs.filter((row) => (
        isActiveRetirementIssueWatchdogStatus(row.status) && tombstoneIds.has(row.watchdogAgentId)
      )),
      historicalActiveRecoveryActions: allRecoveryActions.filter((row) => (
        row.ownerAgentId !== null
        && tombstoneIds.has(row.ownerAgentId)
        && isActiveRetirementRecoveryActionStatus(row.status)
      )),
      historicalPipelineAgentLeases: problematicPipelineAgentLeases,
      historicalActiveReportees: allAgents.filter((row) => historicalLiveDescendantIds.has(row.id)),
      historicalActivePipelineApprovers: activePipelineApproverStages,
      historicalActiveHireApprovalReferences: activeHireApprovalReferences,
      historicalEnvironmentLeases,
      historicalOutstandingEnvironmentLeases: outstandingEnvironmentLeases,
      historicalWorkspaceOperations,
      historicalRunningWorkspaceOperations: historicalWorkspaceOperations.filter((row) => (
        !isTerminalRetirementWorkspaceOperation(row.status)
      )),
      companySecrets: allSecrets,
      companySecretVersions: allSecretVersions,
      companySecretBindings: allSecretBindings,
    }, partition);
  }

  async function assertLiveRetirementInventoryForCleanup(
    targetDb: Db,
    sourceId: string,
    expected: RetirementRestoreInventoryProof,
  ) {
    const fail = (): never => {
      throw conflict("Live state drifted from the exact pre-cleanup restore inventory", {
        code: "retirement_backup_live_inventory_mismatch",
      });
    };
    let live: RetirementRestoreInventoryProof;
    try {
      live = await createLiveRetirementRestoreInventory(targetDb, expected);
    } catch {
      return fail();
    }
    for (const section of [
      "retainedAgents",
      "historicalTombstones",
      "lifecycleContractAgents",
      "companies",
      "historicalActiveApiKeys",
      "historicalPrincipalPermissionGrants",
      "historicalActiveCompanyMemberships",
      "historicalNonLeftAgentMemberships",
      "historicalAgentSecretBindings",
      "historicalAgentUserSecretDeclarations",
      "historicalAgentSkillStars",
      "historicalActiveProjectLeads",
      "historicalOperativeGoalOwnerships",
      "historicalHeartbeatRuns",
      "historicalWorkspaceRuntimeServices",
      "historicalApprovals",
      "historicalTaskSessions",
      "historicalIssues",
      "historicalRoutines",
      "historicalRoutineTriggers",
      "historicalRoutineRuns",
      "historicalRoutineDeliveries",
      "approvalExecutionClaims",
      "workspaceRuntimeStartClaims",
      "historicalWakeRequests",
      "historicalActiveIssueWatchdogs",
      "historicalActiveRecoveryActions",
      "historicalPipelineAgentLeases",
      "historicalActiveReportees",
      "historicalActivePipelineApprovers",
      "historicalActiveHireApprovalReferences",
      "historicalEnvironmentLeases",
      "historicalOutstandingEnvironmentLeases",
      "historicalWorkspaceOperations",
      "historicalRunningWorkspaceOperations",
      "companySecrets",
      "companySecretVersions",
      "companySecretBindings",
    ] as const) {
      if (stableStringify(live[section]) !== stableStringify(expected[section])) fail();
    }

    const executionRows = await targetDb.select().from(agentRetirementExecutionClaims);
    const executionBySource = new Map(executionRows.map((row) => [row.sourceAgentId, row]));
    const planRows = await targetDb.select().from(agentRetirementPlanClaims);
    const planById = new Map(planRows.map((row) => [row.id, row]));
    const recoveryRows = await targetDb.select().from(agentRetirementExecutionRecoveries);
    const recoveryAuditRows = await targetDb
      .select({
        companyId: activityLog.companyId,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.retirement_execution_recovered"),
        eq(activityLog.entityType, "agent"),
      ));
    const cleanupAuditRows = await targetDb
      .select({
        companyId: activityLog.companyId,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.retirement_cleanup"),
        eq(activityLog.entityType, "agent"),
      ));
    const cleanupCandidatesBySource = new Map<string, AgentRetirementCleanupResponse[]>();
    const cleanupCandidateKeys = new Set<string>();
    const addCleanupCandidate = (
      candidateSourceId: string,
      response: AgentRetirementCleanupResponse,
    ) => {
      const key = `${candidateSourceId}:${response.receiptId}`;
      if (cleanupCandidateKeys.has(key)) return;
      cleanupCandidateKeys.add(key);
      cleanupCandidatesBySource.set(candidateSourceId, [
        ...(cleanupCandidatesBySource.get(candidateSourceId) ?? []),
        response,
      ]);
    };
    const validateCleanupCandidate = (
      candidateSourceId: string,
      companyId: string,
      cleanupReceiptId: string,
      executionClaimReceiptId: string,
      planClaimReceiptId: string,
      evidence: AgentRetirementEvidence,
      initialPreflightFingerprint: string | null,
    ) => {
      const matchingRows = cleanupAuditRows.filter((row) => (
        row.entityId === candidateSourceId
        && readCleanupReceipt(row.details)?.receiptId === cleanupReceiptId
      ));
      if (matchingRows.length !== 1) fail();
      const row = matchingRows[0]!;
      const details = asRecord(row.details);
      const response = readCleanupReceipt(details);
      const exactResponse = response ?? fail();
      let cleanupInput: AgentRetirementCleanup;
      try {
        cleanupInput = parseCleanup({
          ...evidence,
          preflightFingerprint: exactResponse.preflightFingerprint,
        });
      } catch {
        return fail();
      }
      const expectedCleanupReceiptId = fingerprint({
        kind: "agent_retirement_cleanup",
        sourceId: candidateSourceId,
        input: cleanupInput,
        planClaimReceiptId,
        executionClaimReceiptId,
      });
      if (
        row.companyId !== companyId
        || row.agentId !== candidateSourceId
        || exactResponse.agentId !== candidateSourceId
        || exactResponse.companyId !== companyId
        || exactResponse.receiptId !== expectedCleanupReceiptId
        || exactResponse.executionClaimReceiptId !== executionClaimReceiptId
        || (initialPreflightFingerprint !== null
          && exactResponse.preflightFingerprint !== initialPreflightFingerprint)
        || details.planClaimReceiptId !== planClaimReceiptId
        || details.executionClaimReceiptId !== executionClaimReceiptId
        || details.evidenceFingerprint !== evidenceFingerprint(evidence)
      ) fail();
      addCleanupCandidate(candidateSourceId, exactResponse);
    };

    for (const execution of executionRows) {
      const planRow = planById.get(execution.planClaimId);
      if (!planRow || execution.companyId !== getAgentRetirementSource(execution.sourceAgentId)?.companyId) {
        fail();
      }
      const exactPlanRow = planRow!;
      const registration = await findPlanRegistration(targetDb, exactPlanRow);
      const registeredEvidence = registration.evidenceBySourceId[execution.sourceAgentId] ?? fail();
      const sourceRecoveries = recoveryRows.filter((row) => (
        row.sourceAgentId === execution.sourceAgentId
      ));
      if (sourceRecoveries.some((row) => (
        row.executionClaimId !== execution.id || row.planClaimId !== execution.planClaimId
      ))) fail();
      const recoveryByNewReceipt = new Map(sourceRecoveries.map((row) => (
        [row.newExecutionClaimReceiptId, row] as const
      )));
      if (recoveryByNewReceipt.size !== sourceRecoveries.length) fail();
      const versionByReceipt = new Map<string, {
        evidence: AgentRetirementEvidence;
        initialPreflightFingerprint: string | null;
      }>();
      let cursor: string | null = execution.receiptId;
      const consumedRecoveryIds = new Set<string>();
      while (cursor !== null) {
        const recovery = recoveryByNewReceipt.get(cursor);
        if (!recovery) break;
        if (consumedRecoveryIds.has(recovery.id)) fail();
        consumedRecoveryIds.add(recovery.id);
        const parsedEvidence = agentRetirementEvidenceSchema.safeParse(recovery.evidence);
        const allowlisted = getAgentRetirementSource(execution.sourceAgentId);
        const exactEvidence = parsedEvidence.success ? parsedEvidence.data : fail();
        const exactAllowlisted = allowlisted ?? fail();
        let sourceArtifactReceipt: RetirementSourceArtifactReceipt;
        let commonArtifactReceipt: RetirementCommonArtifactReceipt;
        try {
          sourceArtifactReceipt = assertRetirementSourceArtifactReceipt(exactEvidence, {
            sourceId: execution.sourceAgentId,
            companyId: exactAllowlisted.companyId,
            sourceName: exactAllowlisted.sourceName,
            expectedUpdatedAt: exactEvidence.expectedUpdatedAt,
          }, recovery.sourceArtifactReceipt);
          commonArtifactReceipt = assertRetirementCommonArtifactReceipt(
            exactEvidence,
            recovery.commonArtifactReceipt,
          );
        } catch {
          return fail();
        }
        const expectedRequestReceiptId = executionRecoveryRequestReceiptId({
          planClaimReceiptId: exactPlanRow.receiptId,
          sourceId: execution.sourceAgentId,
          previousExecutionClaimReceiptId: recovery.previousExecutionClaimReceiptId,
          evidence: exactEvidence,
        });
        const expectedRecoveryReceiptId = executionRecoveryReceiptId({
          requestReceiptId: recovery.requestReceiptId,
          planClaimReceiptId: exactPlanRow.receiptId,
          sourceId: execution.sourceAgentId,
          previousExecutionClaimReceiptId: recovery.previousExecutionClaimReceiptId,
          previousPhase: recovery.previousPhase,
          previousCleanupReceiptId: recovery.previousCleanupReceiptId,
          evidenceFingerprint: evidenceFingerprint(exactEvidence),
          sourceArtifactReceiptId: sourceArtifactReceipt.receiptId,
          commonArtifactReceiptId: commonArtifactReceipt.receiptId,
          originalSourceArtifactReceiptId:
            registration.sourceArtifactReceiptsBySourceId[execution.sourceAgentId]!.receiptId,
          originalCommonArtifactReceiptId: registration.commonArtifactReceipt.receiptId,
          initialPreflightFingerprint: recovery.initialPreflightFingerprint,
          recoveredAt: recovery.recoveredAt.toISOString(),
          expiresAt: recovery.expiresAt.toISOString(),
        });
        const expectedNewExecutionReceiptId = recoveredExecutionReceiptId(
          expectedRecoveryReceiptId,
        );
        const matchingAudits = recoveryAuditRows.filter((row) => (
          row.entityId === execution.sourceAgentId
          && asRecord(row.details).recoveryReceiptId === recovery.recoveryReceiptId
        ));
        const audit = asRecord(matchingAudits[0]?.details);
        const previousPhaseNeedsCleanup = recovery.previousPhase === "cleaned"
          || recovery.previousPhase === "termination_ready";
        if (
          matchingAudits.length !== 1
          || matchingAudits[0]!.companyId !== execution.companyId
          || recovery.requestReceiptId !== expectedRequestReceiptId
          || recovery.recoveryReceiptId !== expectedRecoveryReceiptId
          || recovery.newExecutionClaimReceiptId !== expectedNewExecutionReceiptId
          || (recovery.previousPhase === "unstarted")
            !== (recovery.previousExecutionClaimReceiptId === null)
          || previousPhaseNeedsCleanup !== (recovery.previousCleanupReceiptId !== null)
          || audit.schemaVersion !== "1.0.0"
          || audit.sourceAgentId !== execution.sourceAgentId
          || audit.planClaimReceiptId !== exactPlanRow.receiptId
          || audit.requestReceiptId !== recovery.requestReceiptId
          || audit.recoveryReceiptId !== recovery.recoveryReceiptId
          || audit.previousExecutionClaimReceiptId !== recovery.previousExecutionClaimReceiptId
          || audit.previousPhase !== recovery.previousPhase
          || audit.previousCleanupReceiptId !== recovery.previousCleanupReceiptId
          || audit.newExecutionClaimReceiptId !== recovery.newExecutionClaimReceiptId
          || audit.originalSourceArtifactReceiptId
            !== registration.sourceArtifactReceiptsBySourceId[execution.sourceAgentId]!.receiptId
          || audit.originalCommonArtifactReceiptId !== registration.commonArtifactReceipt.receiptId
          || audit.recoveredAt !== recovery.recoveredAt.toISOString()
          || audit.expiresAt !== recovery.expiresAt.toISOString()
          || "evidence" in audit
          || "sourceArtifactReceipt" in audit
          || "commonArtifactReceipt" in audit
        ) fail();
        versionByReceipt.set(recovery.newExecutionClaimReceiptId, {
          evidence: exactEvidence,
          initialPreflightFingerprint: recovery.initialPreflightFingerprint,
        });
        if (recovery.newExecutionClaimReceiptId === execution.receiptId && (
          execution.evidenceFingerprint !== evidenceFingerprint(exactEvidence)
          || execution.initialPreflightFingerprint !== recovery.initialPreflightFingerprint
          || execution.startedAt.toISOString() !== recovery.recoveredAt.toISOString()
          || execution.expiresAt.toISOString() !== recovery.expiresAt.toISOString()
        )) fail();
        cursor = recovery.previousExecutionClaimReceiptId;
      }
      if (consumedRecoveryIds.size !== sourceRecoveries.length) fail();
      if (sourceRecoveries.length === 0) {
        const expectedExecutionReceiptId = fingerprint({
          kind: "server_retirement_execution_claim",
          planClaimReceiptId: exactPlanRow.receiptId,
          sourceId: execution.sourceAgentId,
          evidenceFingerprint: evidenceFingerprint(registeredEvidence),
          initialPreflightFingerprint: execution.initialPreflightFingerprint,
          startedAt: execution.startedAt.toISOString(),
          expiresAt: execution.expiresAt.toISOString(),
        });
        if (
          execution.receiptId !== expectedExecutionReceiptId
          || execution.evidenceFingerprint !== evidenceFingerprint(registeredEvidence)
        ) fail();
        versionByReceipt.set(execution.receiptId, {
          evidence: registeredEvidence,
          initialPreflightFingerprint: execution.initialPreflightFingerprint,
        });
      } else if (cursor !== null) {
        versionByReceipt.set(cursor, {
          evidence: registeredEvidence,
          initialPreflightFingerprint: null,
        });
      }

      for (const recovery of sourceRecoveries) {
        if (!recovery.previousCleanupReceiptId || !recovery.previousExecutionClaimReceiptId) continue;
        const previousVersion = versionByReceipt.get(recovery.previousExecutionClaimReceiptId);
        if (!previousVersion) fail();
        validateCleanupCandidate(
          execution.sourceAgentId,
          execution.companyId,
          recovery.previousCleanupReceiptId,
          recovery.previousExecutionClaimReceiptId,
          exactPlanRow.receiptId,
          previousVersion!.evidence,
          previousVersion!.initialPreflightFingerprint,
        );
      }
      const processed = new Set(["cleaned", "termination_ready", "terminated"])
        .has(execution.phase);
      if (processed !== (execution.cleanupReceiptId !== null)) fail();
      if (execution.cleanupReceiptId) {
        const currentVersion = versionByReceipt.get(execution.receiptId);
        if (!currentVersion) fail();
        validateCleanupCandidate(
          execution.sourceAgentId,
          execution.companyId,
          execution.cleanupReceiptId,
          execution.receiptId,
          exactPlanRow.receiptId,
          currentVersion!.evidence,
          currentVersion!.initialPreflightFingerprint,
        );
      }
    }
    if (recoveryRows.some((row) => !executionBySource.has(row.sourceAgentId))) fail();

    const accessSections = [
      ["activeApiKeys", "revokedKeyCount"],
      ["principalPermissionGrants", "deletedGrantCount"],
      ["activeCompanyMemberships", "deactivatedCompanyMembershipCount"],
      ["nonLeftAgentMemberships", "deletedAgentMembershipCount"],
      ["agentSecretBindings", "deletedSecretBindingCount"],
      ["agentUserSecretDeclarations", "deletedUserSecretDeclarationCount"],
      ["agentSkillStars", "deletedSkillStarCount"],
    ] as const;
    for (const [section, responseCountField] of accessSections) {
      const expectedRows = expected[section].rows;
      const liveRows = live[section].rows;
      const expectedById = new Map(expectedRows.map((row) => [row.id, row]));
      for (const row of liveRows) {
        const expectedRow = expectedById.get(row.id);
        if (!expectedRow || stableStringify(row) !== stableStringify(expectedRow)) fail();
      }
      const liveIds = new Set(liveRows.map((row) => row.id));
      for (const canonicalSourceId of canonicalRetirementSourceIds()) {
        const expectedSourceRows = expectedRows.filter((row) => (
          row.sourceAgentId === canonicalSourceId
        ));
        const liveSourceRows = liveRows.filter((row) => row.sourceAgentId === canonicalSourceId);
        const missingExpectedCount = expectedSourceRows.filter((row) => !liveIds.has(row.id)).length;
        if (missingExpectedCount === 0) continue;
        if (
          liveSourceRows.length !== 0
          || !(cleanupCandidatesBySource.get(canonicalSourceId) ?? [])
            .some((cleanup) => cleanup[responseCountField] === missingExpectedCount)
        ) fail();
      }
    }

    const expectedSources = new Map(expected.sourceAgents.rows.map((row) => [row.id, row]));
    const liveSources = new Map(live.sourceAgents.rows.map((row) => [row.id, row]));
    const rawSourceRows = await targetDb.select().from(agents);
    const rawSourceById = new Map(rawSourceRows.map((row) => [row.id, row]));
    const terminationActivities = await targetDb
      .select({ id: activityLog.id, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.terminated"),
        eq(activityLog.entityType, "agent"),
      ));
    for (const [expectedSourceId, expectedRow] of expectedSources) {
      const liveRow = liveSources.get(expectedSourceId);
      if (!liveRow) fail();
      if (liveRow!.rowSha256 === expectedRow.rowSha256) continue;
      if (expectedSourceId === sourceId) fail();
      const execution = executionBySource.get(expectedSourceId);
      const planRow = execution ? planById.get(execution.planClaimId) : null;
      const rawSource = rawSourceById.get(expectedSourceId);
      const matchingActivities = terminationActivities.filter((activity) => {
        if (!execution || !planRow || activity.entityId !== expectedSourceId) return false;
        const details = asRecord(activity.details);
        const receipt = readTerminationReceipt(details);
        return Boolean(
          receipt
          && receipt.activityId === activity.id
          && receipt.agentId === expectedSourceId
          && receipt.companyId === liveRow!.companyId
          && receipt.status === "terminated"
          && receipt.cleanupReceiptId === execution.cleanupReceiptId
          && receipt.preflightFingerprint === execution.finalPreflightFingerprint
          && receipt.tombstone.id === expectedSourceId
          && receipt.tombstone.companyId === liveRow!.companyId
          && receipt.tombstone.name === liveRow!.name
          && receipt.tombstone.status === liveRow!.status
          && receipt.tombstone.updatedAt === liveRow!.updatedAt
          && receipt.terminatedAt === liveRow!.updatedAt
          && details.source === "retirement_gated"
          && details.cleanupReceiptId === execution.cleanupReceiptId
          && details.preflightFingerprint === execution.finalPreflightFingerprint
          && details.planClaimReceiptId === planRow.receiptId
          && details.executionClaimReceiptId === execution.receiptId
        );
      });
      if (
        execution?.phase !== "terminated"
        || !(cleanupCandidatesBySource.get(expectedSourceId)?.length)
        || liveRow!.status !== "terminated"
        || liveRow!.immutableRowSha256 !== expectedRow.immutableRowSha256
        || rawSource?.pauseReason !== null
        || rawSource.pausedAt !== null
        || rawSource.errorReason !== null
        || matchingActivities.length !== 1
      ) fail();
    }
    if (liveSources.size !== expectedSources.size) fail();
  }

  async function registerPlanClaim(
    targetDb: Db,
    sourceId: string,
    plan: AgentRetirementPlan,
    evidenceBySourceId: AgentRetirementEvidenceBySourceId,
    actor: { actorUserId?: string },
  ) {
    if (
      plan.evidenceSha256 !== evidenceBundleSha256(evidenceBySourceId)
      || evidenceBySourceId[sourceId]?.source.sourceAgentId !== sourceId
    ) {
      throw conflict("Retirement plan evidence bundle does not match its receipt", {
        code: "retirement_plan_evidence_mismatch",
      });
    }
    const selectedEvidence = evidenceBySourceId[sourceId]!;
    validateClientPlan(plan, selectedEvidence, now());
    const approvalClaims = await targetDb
      .select({
        approvalCommentId: agentRetirementPlanClaims.approvalCommentId,
        approvalNonce: agentRetirementPlanClaims.approvalNonce,
        approvalFingerprint: agentRetirementPlanClaims.approvalFingerprint,
      })
      .from(agentRetirementPlanClaims);
    if (approvalClaims.some((claim) => (
      claim.approvalCommentId === plan.approvalCommentId
      || claim.approvalNonce === selectedEvidence.humanGate.approvalNonce
      || claim.approvalFingerprint === plan.approvalFingerprint
    ))) {
      throw conflict("Retirement human approval was already consumed by another plan", {
        code: "retirement_approval_already_consumed",
      });
    }
    const selectedInventory = await buildInventory(targetDb, sourceId, selectedEvidence);
    if (!selectedInventory.response.cleanupEligible) {
      return { planRow: null, registration: null, inventory: selectedInventory };
    }
    if (!selectedInventory.sourceArtifactReceipt || !selectedInventory.commonArtifactReceipt) {
      throw conflict("Retirement registration artifact receipts were not captured", {
        code: "retirement_artifact_receipt_missing",
      });
    }
    const sourceArtifactReceiptsBySourceId: Record<string, RetirementSourceArtifactReceipt> = {};
    const referenceGate = selectedEvidence.humanGate;
    const referenceBackup = selectedEvidence.backupRestore;
    const nowMs = now().getTime();
    for (const sourceIdEntry of canonicalRetirementSourceIds()) {
      const allowlisted = getAgentRetirementSource(sourceIdEntry)!;
      const evidence = evidenceBySourceId[sourceIdEntry]!;
      if (
        evidence.source.sourceAgentId !== sourceIdEntry
        || evidence.source.companyId !== allowlisted.companyId
        || evidence.source.decision !== "terminate"
        || evidence.source.physicalDelete !== false
        || evidence.humanGate.issueId !== allowlisted.decisionIssueId
        || evidence.replacement.replacementAgentId !== allowlisted.replacementAgentId
        || evidence.replacement.replacementSystemRef !== allowlisted.replacementSystemRef
        || evidence.replacement.canaryAgentId !== allowlisted.canaryAgentId
        || stableStringify(evidence.humanGate) !== stableStringify(referenceGate)
        || stableStringify(evidence.backupRestore) !== stableStringify(referenceBackup)
        || !timestampFresh(evidence.sourceExport.capturedAt, nowMs)
        || !timestampFresh(evidence.humanGate.approvedAt, nowMs)
      ) {
        throw conflict("Retirement plan evidence bundle is not canonical and fresh", {
          code: "retirement_plan_evidence_mismatch",
          sourceId: sourceIdEntry,
        });
      }
      if (sourceIdEntry === sourceId) {
        sourceArtifactReceiptsBySourceId[sourceIdEntry] = selectedInventory.sourceArtifactReceipt;
      } else {
        const sourceInventory = await buildInventory(
          targetDb,
          sourceIdEntry,
          evidence,
          { trustedCommonArtifactReceipt: selectedInventory.commonArtifactReceipt },
        );
        if (
          !sourceInventory.response.cleanupEligible
          || !sourceInventory.sourceArtifactReceipt
          || !sourceInventory.commonArtifactReceipt
        ) {
          const blockerCodes = sourceInventory.response.blockers.map((blocker) => blocker.code);
          throw conflict(`A retirement plan source failed live registration review: ${blockerCodes.join(",")}`, {
            code: "retirement_plan_source_blocked",
            sourceId: sourceIdEntry,
            blockerCodes,
          });
        }
        sourceArtifactReceiptsBySourceId[sourceIdEntry] = sourceInventory.sourceArtifactReceipt;
        if (
          sourceInventory.commonArtifactReceipt.receiptId
            !== selectedInventory.commonArtifactReceipt.receiptId
        ) {
          throw conflict("Retirement plan sources do not share one exact restore artifact", {
            code: "retirement_plan_artifact_mismatch",
            sourceId: sourceIdEntry,
          });
        }
      }
      assertRetirementCommonArtifactReceipt(evidence, selectedInventory.commonArtifactReceipt);
    }
    let liveRestoreInventory;
    try {
      liveRestoreInventory = await createLiveRetirementRestoreInventory(
        targetDb,
        selectedInventory.commonArtifactReceipt.inventory.retirementInventory,
      );
    } catch {
      throw conflict("Live retirement inventory could not be proven against the restore artifact", {
        code: "retirement_backup_live_inventory_mismatch",
      });
    }
    if (
      liveRestoreInventory.inventorySha256
        !== selectedInventory.commonArtifactReceipt.inventory.retirementInventory.inventorySha256
      || stableStringify(liveRestoreInventory)
        !== stableStringify(selectedInventory.commonArtifactReceipt.inventory.retirementInventory)
    ) {
      throw conflict("Live retirement inventory drifted from the restore artifact", {
        code: "retirement_backup_live_inventory_mismatch",
      });
    }
    if (
      selectedInventory.commonArtifactReceipt.commonArtifactFingerprint
        !== plan.commonArtifactFingerprint
    ) {
      throw conflict("Client and server common artifact receipts disagree", {
        code: "retirement_plan_artifact_mismatch",
      });
    }
    const registrationReceipt = registrationReceiptId({
      plan,
      evidenceBySourceId,
      sourceArtifactReceiptsBySourceId,
      commonArtifactReceipt: selectedInventory.commonArtifactReceipt,
    });
    const receiptId = serverPlanReceiptId(plan, registrationReceipt);
    const evidenceExpiresAt = new Date(Math.min(...Object.values(evidenceBySourceId)
      .map((entry) => evidenceFreshUntil(entry).getTime())));
    const planRow = await targetDb.insert(agentRetirementPlanClaims).values({
      clientPlanReceiptId: plan.receiptId,
      receiptId,
      approvalCommentId: plan.approvalCommentId,
      approvalNonce: selectedEvidence.humanGate.approvalNonce,
      approvalFingerprint: plan.approvalFingerprint,
      plan,
      commonArtifactReceipt: selectedInventory.commonArtifactReceipt,
      issuedByUserId: actor.actorUserId ?? "board",
      evidenceExpiresAt,
      executionExpiresAt: new Date(plan.expiresAt),
      issuedAt: now(),
    }).returning().then((rows) => rows[0]!);
    await targetDb.insert(agentRetirementPlanEvidenceBundles).values({
      planClaimId: planRow.id,
      registrationReceiptId: registrationReceipt,
      evidenceBySourceId,
      sourceArtifactReceiptsBySourceId,
    });
    await targetDb.insert(activityLog).values({
      companyId: selectedInventory.source.companyId,
      actorType: "user",
      actorId: actor.actorUserId ?? "board",
      action: "agent.retirement_plan_registered",
      entityType: "retirement_plan",
      entityId: planRow.id,
      details: {
        schemaVersion: "1.0.0",
        sourceCount: canonicalRetirementSourceIds().length,
        clientPlanReceiptId: plan.receiptId,
        planClaimReceiptId: receiptId,
        registrationReceiptId: registrationReceipt,
      },
    });
    return {
      planRow,
      registration: {
        registrationReceiptId: registrationReceipt,
        evidenceBySourceId,
        sourceArtifactReceiptsBySourceId,
        commonArtifactReceipt: selectedInventory.commonArtifactReceipt,
      } satisfies PlanRegistration,
      inventory: selectedInventory,
    };
  }

  function assertPlanClaimExact(
    row: typeof agentRetirementPlanClaims.$inferSelect,
    plan: AgentRetirementPlan,
    evidence: AgentRetirementEvidence,
    registration: PlanRegistration,
  ) {
    validateClientPlan(plan, evidence, now());
    const common = assertRetirementCommonArtifactReceipt(evidence, registration.commonArtifactReceipt);
    const expectedReceiptId = serverPlanReceiptId(plan, registration.registrationReceiptId);
    if (
      row.clientPlanReceiptId !== plan.receiptId
      || row.receiptId !== expectedReceiptId
      || stableStringify(row.plan) !== stableStringify(plan)
      || stableStringify(row.commonArtifactReceipt) !== stableStringify(registration.commonArtifactReceipt)
      || common.commonArtifactFingerprint !== plan.commonArtifactFingerprint
      || row.executionExpiresAt.toISOString() !== plan.expiresAt
    ) {
      throw conflict("Stored retirement plan claim drifted", { code: "retirement_plan_claim_drift" });
    }
    return common;
  }

  function claimState(phase: string): AgentRetirementPreflightResponse["claimState"] {
    if (phase === "started" || phase === "cleaned" || phase === "termination_ready" || phase === "terminated") {
      return phase;
    }
    throw conflict("Retirement execution claim phase is invalid", {
      code: "retirement_execution_claim_drift",
    });
  }

  function executionRecoveryReceiptId(input: {
    requestReceiptId: string;
    planClaimReceiptId: string;
    sourceId: string;
    previousExecutionClaimReceiptId: string | null;
    previousPhase: string;
    previousCleanupReceiptId: string | null;
    evidenceFingerprint: string;
    sourceArtifactReceiptId: string;
    commonArtifactReceiptId: string;
    originalSourceArtifactReceiptId: string;
    originalCommonArtifactReceiptId: string;
    initialPreflightFingerprint: string;
    recoveredAt: string;
    expiresAt: string;
  }) {
    return fingerprint({ kind: "agent_retirement_execution_recovery", ...input });
  }

  function executionRecoveryRequestReceiptId(input: {
    planClaimReceiptId: string;
    sourceId: string;
    previousExecutionClaimReceiptId: string | null;
    evidence: AgentRetirementEvidence;
  }) {
    return fingerprint({
      kind: "agent_retirement_execution_recovery_request",
      planClaimReceiptId: input.planClaimReceiptId,
      sourceId: input.sourceId,
      previousExecutionClaimReceiptId: input.previousExecutionClaimReceiptId,
      evidenceFingerprint: evidenceFingerprint(input.evidence),
    });
  }

  function recoveredExecutionReceiptId(recoveryReceiptId: string) {
    return fingerprint({
      kind: "server_retirement_execution_recovery_claim",
      recoveryReceiptId,
    });
  }

  async function findExecutionRecovery(
    targetDb: Db,
    sourceId: string,
    execution: typeof agentRetirementExecutionClaims.$inferSelect,
    planRow: typeof agentRetirementPlanClaims.$inferSelect,
    evidence: AgentRetirementEvidence,
  ): Promise<ClaimedArtifacts | null> {
    const rows = await targetDb
      .select()
      .from(agentRetirementExecutionRecoveries)
      .where(and(
        eq(agentRetirementExecutionRecoveries.executionClaimId, execution.id),
        eq(agentRetirementExecutionRecoveries.newExecutionClaimReceiptId, execution.receiptId),
      ));
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw conflict("Retirement execution recovery audit is ambiguous", {
        code: "retirement_execution_recovery_drift",
      });
    }
    const recovery = rows[0]!;
    const registration = await findPlanRegistration(targetDb, planRow);
    const recoveryEvidence = agentRetirementEvidenceSchema.safeParse(recovery.evidence);
    const allowlisted = getAgentRetirementSource(sourceId);
    if (
      !recoveryEvidence.success
      || !allowlisted
      || stableStringify(recoveryEvidence.data) !== stableStringify(evidence)
      || recovery.planClaimId !== planRow.id
      || recovery.sourceAgentId !== sourceId
      || recovery.initialPreflightFingerprint !== execution.initialPreflightFingerprint
      || recovery.recoveredAt.toISOString() !== execution.startedAt.toISOString()
      || recovery.expiresAt.toISOString() !== execution.expiresAt.toISOString()
    ) {
      throw conflict("Retirement execution recovery evidence drifted", {
        code: "retirement_execution_recovery_drift",
      });
    }
    const sourceArtifactReceipt = assertRetirementSourceArtifactReceipt(evidence, {
      sourceId,
      companyId: allowlisted.companyId,
      sourceName: allowlisted.sourceName,
      expectedUpdatedAt: evidence.expectedUpdatedAt,
    }, recovery.sourceArtifactReceipt);
    const commonArtifactReceipt = assertRetirementCommonArtifactReceipt(
      evidence,
      recovery.commonArtifactReceipt,
    );
    const expectedRecoveryReceiptId = executionRecoveryReceiptId({
      requestReceiptId: recovery.requestReceiptId,
      planClaimReceiptId: planRow.receiptId,
      sourceId,
      previousExecutionClaimReceiptId: recovery.previousExecutionClaimReceiptId,
      previousPhase: recovery.previousPhase,
      previousCleanupReceiptId: recovery.previousCleanupReceiptId,
      evidenceFingerprint: evidenceFingerprint(evidence),
      sourceArtifactReceiptId: sourceArtifactReceipt.receiptId,
      commonArtifactReceiptId: commonArtifactReceipt.receiptId,
      originalSourceArtifactReceiptId:
        registration.sourceArtifactReceiptsBySourceId[sourceId]!.receiptId,
      originalCommonArtifactReceiptId: registration.commonArtifactReceipt.receiptId,
      initialPreflightFingerprint: recovery.initialPreflightFingerprint,
      recoveredAt: recovery.recoveredAt.toISOString(),
      expiresAt: recovery.expiresAt.toISOString(),
    });
    const auditRows = await targetDb
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.retirement_execution_recovered"),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, sourceId),
      ));
    const matchingAuditRows = auditRows.filter((row) => (
      asRecord(row.details).recoveryReceiptId === recovery.recoveryReceiptId
    ));
    const details = asRecord(matchingAuditRows[0]?.details);
    if (
      matchingAuditRows.length !== 1
      || recovery.recoveryReceiptId !== expectedRecoveryReceiptId
      || execution.receiptId !== recoveredExecutionReceiptId(expectedRecoveryReceiptId)
      || recovery.newExecutionClaimReceiptId !== execution.receiptId
      || details.schemaVersion !== "1.0.0"
      || details.sourceAgentId !== sourceId
      || details.planClaimReceiptId !== planRow.receiptId
      || details.requestReceiptId !== recovery.requestReceiptId
      || details.recoveryReceiptId !== recovery.recoveryReceiptId
      || details.previousExecutionClaimReceiptId !== recovery.previousExecutionClaimReceiptId
      || details.previousPhase !== recovery.previousPhase
      || details.previousCleanupReceiptId !== recovery.previousCleanupReceiptId
      || details.newExecutionClaimReceiptId !== execution.receiptId
      || details.originalSourceArtifactReceiptId
        !== registration.sourceArtifactReceiptsBySourceId[sourceId]!.receiptId
      || details.originalCommonArtifactReceiptId !== registration.commonArtifactReceipt.receiptId
      || details.recoveredAt !== recovery.recoveredAt.toISOString()
      || details.expiresAt !== recovery.expiresAt.toISOString()
      || "evidence" in details
      || "sourceArtifactReceipt" in details
      || "commonArtifactReceipt" in details
    ) {
      throw conflict("Retirement execution recovery audit drifted", {
        code: "retirement_execution_recovery_drift",
      });
    }
    return { sourceArtifactReceipt, commonArtifactReceipt };
  }

  async function loadExecutionAuthorization(
    targetDb: Db,
    sourceId: string,
    evidence: AgentRetirementEvidence,
    input: { planClaimReceiptId: string; executionClaimReceiptId: string },
    plan?: AgentRetirementPlan,
  ) {
    const execution = await findExecutionClaim(targetDb, sourceId);
    const planRow = await findPlanClaimByReceipt(targetDb, input.planClaimReceiptId);
    if (
      !execution
      || !planRow
      || execution.planClaimId !== planRow.id
      || execution.receiptId !== input.executionClaimReceiptId
      || execution.evidenceFingerprint !== evidenceFingerprint(evidence)
    ) {
      throw conflict("Retirement execution claim is missing or does not match", {
        code: "retirement_execution_claim_missing",
      });
    }
    const allowlisted = getAgentRetirementSource(sourceId);
    const storedPlan = agentRetirementPlanSchema.safeParse(planRow.plan);
    const registration = await findPlanRegistration(targetDb, planRow);
    if (
      !allowlisted
      || execution.companyId !== allowlisted.companyId
      || !storedPlan.success
      || (plan && stableStringify(plan) !== stableStringify(storedPlan.data))
    ) {
      throw conflict("Retirement execution claim drifted from its plan", {
        code: "retirement_execution_claim_drift",
      });
    }
    const registeredEvidence = registration.evidenceBySourceId[sourceId]!;
    assertPlanClaimExact(planRow, storedPlan.data, registeredEvidence, registration);
    const recoveredArtifacts = await findExecutionRecovery(
      targetDb,
      sourceId,
      execution,
      planRow,
      evidence,
    );
    let artifacts: ClaimedArtifacts;
    if (recoveredArtifacts) {
      await revalidateRetirementClaimArtifacts(
        registeredEvidence,
        {
          sourceId,
          companyId: allowlisted.companyId,
          sourceName: allowlisted.sourceName,
          expectedUpdatedAt: registeredEvidence.expectedUpdatedAt,
        },
        {
          sourceArtifactReceipt: registration.sourceArtifactReceiptsBySourceId[sourceId],
          commonArtifactReceipt: registration.commonArtifactReceipt,
        },
        artifactOptions(),
      );
      artifacts = recoveredArtifacts;
    } else {
      if (stableStringify(evidence) !== stableStringify(registeredEvidence)) {
        throw conflict("Retirement execution claim evidence drifted from its plan", {
          code: "retirement_execution_claim_drift",
        });
      }
      const sourceArtifactReceipt = assertRetirementSourceArtifactReceipt(evidence, {
        sourceId,
        companyId: allowlisted.companyId,
        sourceName: allowlisted.sourceName,
        expectedUpdatedAt: evidence.expectedUpdatedAt,
      }, execution.sourceArtifactReceipt);
      const registeredSourceReceipt = registration.sourceArtifactReceiptsBySourceId[sourceId];
      const expectedExecutionReceipt = fingerprint({
        kind: "server_retirement_execution_claim",
        planClaimReceiptId: planRow.receiptId,
        sourceId,
        evidenceFingerprint: evidenceFingerprint(evidence),
        initialPreflightFingerprint: execution.initialPreflightFingerprint,
        startedAt: execution.startedAt.toISOString(),
        expiresAt: execution.expiresAt.toISOString(),
      });
      if (
        sourceArtifactReceipt.receiptId !== registeredSourceReceipt?.receiptId
        || execution.receiptId !== expectedExecutionReceipt
      ) {
        throw conflict("Retirement execution claim receipt drifted", {
          code: "retirement_execution_claim_drift",
        });
      }
      artifacts = {
        sourceArtifactReceipt,
        commonArtifactReceipt: assertRetirementCommonArtifactReceipt(
          evidence,
          registration.commonArtifactReceipt,
        ),
      };
    }
    if (now().getTime() > execution.expiresAt.getTime()) {
      throw conflict("Started retirement execution claim expired", {
        code: "retirement_started_execution_expired",
      });
    }
    return { execution, planRow, artifacts };
  }

  async function loadPrivateExecutionEvidence(
    targetDb: Db,
    sourceId: string,
    input: { planClaimReceiptId: string; executionClaimReceiptId: string },
  ): Promise<AgentRetirementEvidence> {
    const execution = await findExecutionClaim(targetDb, sourceId);
    const planRow = await findPlanClaimByReceipt(targetDb, input.planClaimReceiptId);
    if (
      !execution
      || !planRow
      || execution.planClaimId !== planRow.id
      || execution.receiptId !== input.executionClaimReceiptId
    ) {
      throw conflict("Retirement execution claim is missing or does not match", {
        code: "retirement_execution_claim_missing",
      });
    }
    const recoveryRows = await targetDb
      .select({ evidence: agentRetirementExecutionRecoveries.evidence })
      .from(agentRetirementExecutionRecoveries)
      .where(and(
        eq(agentRetirementExecutionRecoveries.executionClaimId, execution.id),
        eq(agentRetirementExecutionRecoveries.newExecutionClaimReceiptId, execution.receiptId),
      ));
    const rawEvidence = recoveryRows.length === 1
      ? recoveryRows[0]!.evidence
      : recoveryRows.length === 0
        ? (await findPlanRegistration(targetDb, planRow)).evidenceBySourceId[sourceId]
        : null;
    const parsed = agentRetirementEvidenceSchema.safeParse(rawEvidence);
    if (
      !parsed.success
      || execution.evidenceFingerprint !== evidenceFingerprint(parsed.data)
    ) {
      throw conflict("Private retirement execution evidence drifted", {
        code: "retirement_execution_claim_drift",
      });
    }
    return parsed.data;
  }

  async function preflightWithExecutionRecovery(
    sourceId: string,
    request: AgentRetirementExecutionRecoveryRequest,
    actor: { actorUserId?: string } = {},
  ) {
    const evidence = request.evidence;
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.select({ id: agents.id }).from(agents).where(eq(agents.id, sourceId)).for("update");
      await txDb.execute(sql.raw(
        "LOCK TABLE agent_retirement_plan_claims, agent_retirement_plan_evidence_bundles, agent_retirement_execution_claims, agent_retirement_execution_recoveries IN SHARE ROW EXCLUSIVE MODE",
      ));
      const planRow = await findPlanClaimByReceipt(txDb, request.planClaimReceiptId);
      if (!planRow) {
        throw conflict("Retirement recovery plan claim is missing", {
          code: "retirement_plan_claim_missing",
        });
      }
      const storedPlan = agentRetirementPlanSchema.safeParse(planRow.plan);
      const registration = await findPlanRegistration(txDb, planRow);
      const registeredEvidence = registration.evidenceBySourceId[sourceId];
      if (!storedPlan.success || !registeredEvidence) {
        throw conflict("Retirement recovery plan claim drifted", {
          code: "retirement_plan_claim_drift",
        });
      }
      assertPlanClaimExact(planRow, storedPlan.data, registeredEvidence, registration);
      const allowlisted = getAgentRetirementSource(sourceId)!;
      const originalArtifacts = await revalidateRetirementClaimArtifacts(
        registeredEvidence,
        {
          sourceId,
          companyId: allowlisted.companyId,
          sourceName: allowlisted.sourceName,
          expectedUpdatedAt: registeredEvidence.expectedUpdatedAt,
        },
        {
          sourceArtifactReceipt: registration.sourceArtifactReceiptsBySourceId[sourceId],
          commonArtifactReceipt: registration.commonArtifactReceipt,
        },
        artifactOptions(),
      );
      const existingExecution = await findExecutionClaim(txDb, sourceId);

      if (!request.recoverExecution) {
        if (!existingExecution || request.executionClaimReceiptId === null) {
          throw conflict("Retirement recovered execution claim is missing", {
            code: "retirement_execution_claim_missing",
          });
        }
        const authorization = await loadExecutionAuthorization(txDb, sourceId, evidence, {
          planClaimReceiptId: request.planClaimReceiptId,
          executionClaimReceiptId: request.executionClaimReceiptId,
        });
        const recovery = await findExecutionRecovery(
          txDb,
          sourceId,
          authorization.execution,
          planRow,
          evidence,
        );
        if (!recovery) {
          throw conflict("Execution is not backed by a reviewed recovery", {
            code: "retirement_execution_recovery_missing",
          });
        }
        const inventory = await buildInventory(txDb, sourceId, evidence, {
          claimedArtifacts: authorization.artifacts,
        });
        let phase = authorization.execution.phase;
        if (
          (phase === "cleaned" || phase === "termination_ready")
          && inventory.response.ok
          && Object.values(inventory.response.dependencyCounts).every((count) => count === 0)
        ) {
          phase = "termination_ready";
          await txDb.update(agentRetirementExecutionClaims).set({
            phase,
            finalPreflightFingerprint: inventory.response.fingerprint,
            updatedAt: now(),
          }).where(eq(agentRetirementExecutionClaims.id, authorization.execution.id));
        }
        return {
          ...inventory.response,
          ...claimProjection({
            state: claimState(phase),
            planReceiptId: planRow.receiptId,
            executionReceiptId: authorization.execution.receiptId,
            startedAt: authorization.execution.startedAt,
            expiresAt: authorization.execution.expiresAt,
          }),
        };
      }

      const observedAt = now();
      const expectedRequestReceiptId = executionRecoveryRequestReceiptId({
        planClaimReceiptId: planRow.receiptId,
        sourceId,
        previousExecutionClaimReceiptId: request.executionClaimReceiptId,
        evidence,
      });
      if (request.recoveryRequestReceiptId !== expectedRequestReceiptId) {
        throw conflict("Retirement execution recovery request receipt is invalid", {
          code: "retirement_execution_recovery_request_invalid",
        });
      }
      const priorRequestRows = await txDb
        .select()
        .from(agentRetirementExecutionRecoveries)
        .where(eq(
          agentRetirementExecutionRecoveries.requestReceiptId,
          expectedRequestReceiptId,
        ));
      if (priorRequestRows.length > 0) {
        const prior = priorRequestRows[0]!;
        const priorEvidence = agentRetirementEvidenceSchema.safeParse(prior.evidence);
        if (
          priorRequestRows.length !== 1
          || !priorEvidence.success
          || stableStringify(priorEvidence.data) !== stableStringify(evidence)
          || prior.planClaimId !== planRow.id
          || prior.sourceAgentId !== sourceId
          || prior.previousExecutionClaimReceiptId !== request.executionClaimReceiptId
          || !existingExecution
          || existingExecution.id !== prior.executionClaimId
          || existingExecution.receiptId !== prior.newExecutionClaimReceiptId
          || existingExecution.phase !== "started"
        ) {
          throw conflict("Retirement execution recovery retry drifted", {
            code: "retirement_execution_recovery_drift",
          });
        }
        const authorization = await loadExecutionAuthorization(txDb, sourceId, evidence, {
          planClaimReceiptId: planRow.receiptId,
          executionClaimReceiptId: existingExecution.receiptId,
        });
        const inventory = await buildInventory(txDb, sourceId, evidence, {
          claimedArtifacts: authorization.artifacts,
        });
        return {
          ...inventory.response,
          ...claimProjection({
            state: "started",
            planReceiptId: planRow.receiptId,
            executionReceiptId: existingExecution.receiptId,
            startedAt: existingExecution.startedAt,
            expiresAt: existingExecution.expiresAt,
          }),
        };
      }
      let previousExecutionClaimReceiptId: string | null = null;
      let previousPhase = "unstarted";
      let previousCleanupReceiptId: string | null = null;
      if (existingExecution) {
        if (
          request.executionClaimReceiptId === null
          || request.executionClaimReceiptId !== existingExecution.receiptId
          || existingExecution.planClaimId !== planRow.id
        ) {
          throw conflict("Retirement recovery receipt does not match the current execution", {
            code: "retirement_execution_recovery_receipt_mismatch",
          });
        }
        if (existingExecution.phase === "terminated") {
          throw conflict("A terminated retirement execution cannot be recovered", {
            code: "retirement_execution_recovery_phase_invalid",
          });
        }
        if (observedAt.getTime() <= existingExecution.expiresAt.getTime()) {
          throw conflict("Retirement execution is still within its bounded lease", {
            code: "retirement_execution_recovery_not_expired",
          });
        }
        previousExecutionClaimReceiptId = existingExecution.receiptId;
        previousPhase = existingExecution.phase;
        previousCleanupReceiptId = existingExecution.cleanupReceiptId;
      } else {
        if (request.executionClaimReceiptId !== null) {
          throw conflict("Unstarted retirement recovery cannot name an execution receipt", {
            code: "retirement_execution_recovery_receipt_mismatch",
          });
        }
        if (observedAt.getTime() <= planRow.executionExpiresAt.getTime()) {
          throw conflict("Registered retirement plan is still available for a normal start", {
            code: "retirement_execution_recovery_not_expired",
          });
        }
      }

      const inventory = await buildInventory(txDb, sourceId, evidence);
      const zeroDependencies = Object.values(inventory.response.dependencyCounts)
        .every((count) => count === 0);
      const recoveryStateEligible = previousPhase === "started" || previousPhase === "unstarted"
        ? inventory.response.cleanupEligible
        : inventory.response.ok && zeroDependencies;
      if (
        !inventory.sourceArtifactReceipt
        || !inventory.commonArtifactReceipt
        || !recoveryStateEligible
      ) {
        const blockerCodes = inventory.response.blockers.map((blocker) => blocker.code);
        throw conflict(
          `Fresh retirement execution recovery review is blocked: ${blockerCodes.join(",")}`,
          {
          code: "retirement_execution_recovery_blocked",
          blockerCodes,
          },
        );
      }
      if (previousPhase === "cleaned" || previousPhase === "termination_ready") {
        if (!previousCleanupReceiptId || !previousExecutionClaimReceiptId) {
          throw conflict("Recovered cleanup phase is missing its exact prior receipt", {
            code: "retirement_execution_recovery_cleanup_missing",
          });
        }
        const storedCleanup = await findStoredCleanup(
          txDb,
          sourceId,
          previousCleanupReceiptId,
        );
        if (
          !storedCleanup
          || storedCleanup.details.planClaimReceiptId !== planRow.receiptId
          || storedCleanup.details.executionClaimReceiptId !== previousExecutionClaimReceiptId
          || storedCleanup.response.executionClaimReceiptId !== previousExecutionClaimReceiptId
        ) {
          throw conflict("Recovered cleanup phase is not bound to its prior audit receipt", {
            code: "retirement_execution_recovery_cleanup_drift",
          });
        }
      }

      const startedAt = observedAt;
      const expiresAt = new Date(startedAt.getTime() + EXECUTION_MAX_AGE_MS);
      const recoveryReceiptId = executionRecoveryReceiptId({
        requestReceiptId: expectedRequestReceiptId,
        planClaimReceiptId: planRow.receiptId,
        sourceId,
        previousExecutionClaimReceiptId,
        previousPhase,
        previousCleanupReceiptId,
        evidenceFingerprint: evidenceFingerprint(evidence),
        sourceArtifactReceiptId: inventory.sourceArtifactReceipt.receiptId,
        commonArtifactReceiptId: inventory.commonArtifactReceipt.receiptId,
        originalSourceArtifactReceiptId: originalArtifacts.sourceArtifactReceipt.receiptId,
        originalCommonArtifactReceiptId: originalArtifacts.commonArtifactReceipt.receiptId,
        initialPreflightFingerprint: inventory.response.fingerprint,
        recoveredAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      const newExecutionClaimReceiptId = recoveredExecutionReceiptId(recoveryReceiptId);
      const execution = existingExecution
        ? await txDb.update(agentRetirementExecutionClaims).set({
            receiptId: newExecutionClaimReceiptId,
            evidenceFingerprint: evidenceFingerprint(evidence),
            sourceArtifactReceipt: inventory.sourceArtifactReceipt,
            initialPreflightFingerprint: inventory.response.fingerprint,
            phase: "started",
            cleanupReceiptId: null,
            finalPreflightFingerprint: null,
            startedAt,
            expiresAt,
            updatedAt: startedAt,
          }).where(eq(agentRetirementExecutionClaims.id, existingExecution.id))
            .returning().then((rows) => rows[0]!)
        : await txDb.insert(agentRetirementExecutionClaims).values({
            planClaimId: planRow.id,
            companyId: inventory.source.companyId,
            sourceAgentId: sourceId,
            receiptId: newExecutionClaimReceiptId,
            evidenceFingerprint: evidenceFingerprint(evidence),
            sourceArtifactReceipt: inventory.sourceArtifactReceipt,
            initialPreflightFingerprint: inventory.response.fingerprint,
            phase: "started",
            startedAt,
            expiresAt,
            updatedAt: startedAt,
          }).returning().then((rows) => rows[0]!);
      await txDb.insert(agentRetirementExecutionRecoveries).values({
        executionClaimId: execution.id,
        planClaimId: planRow.id,
        sourceAgentId: sourceId,
        requestReceiptId: expectedRequestReceiptId,
        recoveryReceiptId,
        previousExecutionClaimReceiptId,
        newExecutionClaimReceiptId,
        previousPhase,
        previousCleanupReceiptId,
        evidence,
        sourceArtifactReceipt: inventory.sourceArtifactReceipt,
        commonArtifactReceipt: inventory.commonArtifactReceipt,
        initialPreflightFingerprint: inventory.response.fingerprint,
        recoveredAt: startedAt,
        expiresAt,
      });
      await txDb.insert(activityLog).values({
        companyId: inventory.source.companyId,
        actorType: "user",
        actorId: actor.actorUserId ?? "board",
        action: "agent.retirement_execution_recovered",
        entityType: "agent",
        entityId: sourceId,
        details: {
          schemaVersion: "1.0.0",
          sourceAgentId: sourceId,
          planClaimReceiptId: planRow.receiptId,
          requestReceiptId: expectedRequestReceiptId,
          recoveryReceiptId,
          previousExecutionClaimReceiptId,
          previousPhase,
          previousCleanupReceiptId,
          newExecutionClaimReceiptId,
          originalSourceArtifactReceiptId: originalArtifacts.sourceArtifactReceipt.receiptId,
          originalCommonArtifactReceiptId: originalArtifacts.commonArtifactReceipt.receiptId,
          recoveredAt: startedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      return {
        ...inventory.response,
        ...claimProjection({
          state: "started",
          planReceiptId: planRow.receiptId,
          executionReceiptId: execution.receiptId,
          startedAt: execution.startedAt,
          expiresAt: execution.expiresAt,
        }),
      };
    }, { isolationLevel: "serializable" });
  }

  async function preflightWithClaim(
    sourceId: string,
    request: AgentRetirementPreflightRequest,
    actor: { actorUserId?: string } = {},
  ) {
    const evidence = request.evidence;
    const plan = validateClientPlan(request.plan, evidence, now());
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.select({ id: agents.id }).from(agents).where(eq(agents.id, sourceId)).for("update");
      await txDb.execute(sql.raw("LOCK TABLE agent_retirement_plan_claims, agent_retirement_execution_claims IN SHARE ROW EXCLUSIVE MODE"));
      const existingExecution = await findExecutionClaim(txDb, sourceId);
      let planRow = await findPlanClaimByClientReceipt(txDb, plan.receiptId);
      let registration: PlanRegistration;
      if (!planRow) {
        if (!existingExecution && now().getTime() > evidenceFreshUntil(evidence).getTime()) {
          const inventory = await buildInventory(txDb, sourceId, evidence);
          const blocker: AgentRetirementBlocker = {
            code: "retirement_plan_unstarted_expired",
            path: "/plan",
            count: 1,
            cleanupEligible: false,
          };
          const blockers = [...inventory.response.blockers, blocker]
            .sort((left, right) => `${left.code}:${left.path}`.localeCompare(`${right.code}:${right.path}`));
          return {
            ...inventory.response,
            ok: false,
            cleanupEligible: false,
            blockers,
            fingerprint: fingerprint({
              kind: "agent_retirement_unstarted_expired",
              inventoryFingerprint: inventory.response.fingerprint,
              blocker,
            }),
            ...claimProjection({ state: "unstarted_expired" }),
          };
        }
        if (
          !request.claimExecution
          || request.executionClaimReceiptId !== null
          || request.evidenceBySourceId === null
          || stableStringify(request.evidenceBySourceId[sourceId]) !== stableStringify(evidence)
        ) {
          throw conflict("Retirement plan must be atomically registered before execution", {
            code: "retirement_plan_registration_required",
          });
        }
        const registered = await registerPlanClaim(
          txDb,
          sourceId,
          plan,
          request.evidenceBySourceId,
          actor,
        );
        if (!registered.planRow || !registered.registration) return registered.inventory.response;
        planRow = registered.planRow;
        registration = registered.registration;
      } else {
        registration = await findPlanRegistration(txDb, planRow);
        if (
          (request.evidenceBySourceId !== null
            && stableStringify(request.evidenceBySourceId) !== stableStringify(registration.evidenceBySourceId))
          || stableStringify(registration.evidenceBySourceId[sourceId]) !== stableStringify(evidence)
        ) {
          throw conflict("Retirement request drifted from its registered evidence bundle", {
            code: "retirement_plan_evidence_mismatch",
          });
        }
      }
      const commonArtifactReceipt = assertPlanClaimExact(planRow, plan, evidence, registration);
      const allowlisted = getAgentRetirementSource(sourceId)!;
      const registeredSourceArtifactReceipt = assertRetirementSourceArtifactReceipt(evidence, {
        sourceId,
        companyId: allowlisted.companyId,
        sourceName: allowlisted.sourceName,
        expectedUpdatedAt: evidence.expectedUpdatedAt,
      }, registration.sourceArtifactReceiptsBySourceId[sourceId]);
      if (existingExecution) {
        if (existingExecution.planClaimId !== planRow.id) {
          throw conflict("Retirement execution claim points at a different plan", {
            code: "retirement_execution_claim_drift",
          });
        }
        if (
          request.executionClaimReceiptId !== null
          && request.executionClaimReceiptId !== existingExecution.receiptId
        ) {
          throw conflict("Retirement execution claim receipt changed", {
            code: "retirement_execution_claim_drift",
          });
        }
        const sourceArtifactReceipt = assertRetirementSourceArtifactReceipt(evidence, {
          sourceId,
          companyId: allowlisted.companyId,
          sourceName: allowlisted.sourceName,
          expectedUpdatedAt: evidence.expectedUpdatedAt,
        }, existingExecution.sourceArtifactReceipt);
        if (now().getTime() > existingExecution.expiresAt.getTime()) {
          throw conflict("Started retirement execution claim expired", {
            code: "retirement_started_execution_expired",
          });
        }
        const inventory = await buildInventory(txDb, sourceId, evidence, {
          claimedArtifacts: { sourceArtifactReceipt, commonArtifactReceipt },
        });
        let phase = existingExecution.phase;
        if (
          (phase === "cleaned" || phase === "termination_ready")
          && inventory.response.ok
          && Object.values(inventory.response.dependencyCounts).every((count) => count === 0)
        ) {
          phase = "termination_ready";
          await txDb.update(agentRetirementExecutionClaims).set({
            phase,
            finalPreflightFingerprint: inventory.response.fingerprint,
            updatedAt: now(),
          }).where(eq(agentRetirementExecutionClaims.id, existingExecution.id));
        }
        return {
          ...inventory.response,
          ...claimProjection({
            state: claimState(phase),
            planReceiptId: planRow.receiptId,
            executionReceiptId: existingExecution.receiptId,
            startedAt: existingExecution.startedAt,
            expiresAt: existingExecution.expiresAt,
          }),
        };
      }
      if (!request.claimExecution || request.executionClaimReceiptId !== null) {
        throw conflict("Retirement execution claim does not exist", {
          code: "retirement_execution_claim_missing",
        });
      }
      if (now().getTime() > planRow.executionExpiresAt.getTime()) {
        throw conflict("Registered retirement plan execution window expired", {
          code: "retirement_plan_execution_expired",
        });
      }
      const inventory = await buildInventory(txDb, sourceId, evidence, {
        claimedArtifacts: {
          sourceArtifactReceipt: registeredSourceArtifactReceipt,
          commonArtifactReceipt,
        },
        requireFreshCanary: true,
      });
      if (!inventory.response.cleanupEligible) return inventory.response;
      const startedAt = now();
      const executionExpiresAt = new Date(startedAt.getTime() + EXECUTION_MAX_AGE_MS);
      const executionReceiptId = fingerprint({
        kind: "server_retirement_execution_claim",
        planClaimReceiptId: planRow.receiptId,
        sourceId,
        evidenceFingerprint: evidenceFingerprint(evidence),
        initialPreflightFingerprint: inventory.response.fingerprint,
        startedAt: startedAt.toISOString(),
        expiresAt: executionExpiresAt.toISOString(),
      });
      const execution = await txDb.insert(agentRetirementExecutionClaims).values({
        planClaimId: planRow.id,
        companyId: inventory.source.companyId,
        sourceAgentId: sourceId,
        receiptId: executionReceiptId,
        evidenceFingerprint: evidenceFingerprint(evidence),
        sourceArtifactReceipt: registeredSourceArtifactReceipt,
        initialPreflightFingerprint: inventory.response.fingerprint,
        phase: "started",
        startedAt,
        expiresAt: executionExpiresAt,
        updatedAt: startedAt,
      }).returning().then((rows) => rows[0]!);
      return {
        ...inventory.response,
        ...claimProjection({
          state: "started",
          planReceiptId: planRow.receiptId,
          executionReceiptId: execution.receiptId,
          startedAt: execution.startedAt,
          expiresAt: execution.expiresAt,
        }),
      };
    }, { isolationLevel: "serializable" });
  }

  async function findStoredCleanup(targetDb: Db, sourceId: string, receiptId: string) {
    const rows = await targetDb
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.retirement_cleanup"),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, sourceId),
      ));
    for (const row of rows) {
      const response = readCleanupReceipt(row.details);
      if (response?.receiptId === receiptId) return { response, details: asRecord(row.details) };
    }
    return null;
  }

  async function findStoredTermination(
    targetDb: Db,
    sourceId: string,
    input: AgentRetirementTermination,
  ) {
    const rows = await targetDb
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, "agent.terminated"),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, sourceId),
      ));
    for (const row of rows) {
      const details = asRecord(row.details);
      const receipt = readTerminationReceipt(details);
      if (
        receipt
        && receipt.activityId === row.id
        && receipt.agentId === sourceId
        && receipt.cleanupReceiptId === input.cleanupReceiptId
        && receipt.preflightFingerprint === input.preflightFingerprint
        && details.source === "retirement_gated"
        && details.cleanupReceiptId === input.cleanupReceiptId
        && details.preflightFingerprint === input.preflightFingerprint
        && details.planClaimReceiptId === input.planClaimReceiptId
        && details.executionClaimReceiptId === input.executionClaimReceiptId
      ) return receipt;
    }
    return null;
  }

  async function postcheckTermination(
    targetDb: Db,
    sourceId: string,
    rawInput: AgentRetirementTermination,
  ) {
    const input = parseTermination(rawInput);
    const source = await targetDb
      .select()
      .from(agents)
      .where(eq(agents.id, sourceId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Agent not found");
    const receipt = await findStoredTermination(targetDb, sourceId, input);
    if (
      source.status !== "terminated"
      || !receipt
      || receipt.companyId !== source.companyId
      || receipt.tombstone.id !== source.id
      || receipt.tombstone.companyId !== source.companyId
      || receipt.tombstone.name !== source.name
      || receipt.tombstone.status !== source.status
      || receipt.tombstone.updatedAt !== source.updatedAt.toISOString()
    ) {
      throw conflict("Retirement tombstone is missing its required audit receipt", {
        code: "retirement_termination_audit_missing",
      });
    }
    return receipt;
  }

  async function authorizeTermination(
    targetDb: Db,
    sourceId: string,
    rawInput: AgentRetirementTermination,
  ) {
    const input = parseTermination(rawInput);
    const stored = await findStoredCleanup(targetDb, sourceId, input.cleanupReceiptId);
    if (!stored) {
      throw conflict("Retirement cleanup receipt is missing", { code: "retirement_cleanup_receipt_missing" });
    }
    if (!input.planClaimReceiptId || !input.executionClaimReceiptId) {
      throw conflict("Retirement termination requires its durable execution claim", {
        code: "retirement_execution_claim_missing",
      });
    }
    const evidence = await loadPrivateExecutionEvidence(targetDb, sourceId, {
      planClaimReceiptId: input.planClaimReceiptId,
      executionClaimReceiptId: input.executionClaimReceiptId,
    });
    if (
      input.expectedUpdatedAt !== evidence.expectedUpdatedAt
      || stableStringify(input.humanGate) !== stableStringify(evidence.humanGate)
      || stored.details.evidenceFingerprint !== evidenceFingerprint(evidence)
    ) {
      throw conflict("Retirement termination evidence does not match cleanup", { code: "retirement_cleanup_receipt_mismatch" });
    }
    const authorization = await loadExecutionAuthorization(
      targetDb,
      sourceId,
      evidence,
      {
        planClaimReceiptId: input.planClaimReceiptId,
        executionClaimReceiptId: input.executionClaimReceiptId,
      },
    );
    if (
      authorization.execution.phase !== "termination_ready"
      || authorization.execution.cleanupReceiptId !== input.cleanupReceiptId
      || authorization.execution.finalPreflightFingerprint !== input.preflightFingerprint
      || stored.details.planClaimReceiptId !== input.planClaimReceiptId
      || stored.details.executionClaimReceiptId !== input.executionClaimReceiptId
    ) {
      throw conflict("Retirement termination claim is not final-preflight ready", {
        code: "retirement_execution_claim_phase_invalid",
      });
    }
    const inventory = await buildInventory(
      targetDb,
      sourceId,
      evidence,
      { claimedArtifacts: authorization.artifacts },
    );
    if (!inventory.response.ok || inventory.response.fingerprint !== input.preflightFingerprint) {
      throw conflict("Retirement final preflight is stale or blocked", {
        code: "retirement_final_preflight_invalid",
        blockerCodes: inventory.response.blockers.map((blocker) => blocker.code),
      });
    }
    return {
      agentId: sourceId,
      companyId: inventory.source.companyId,
      cleanupReceiptId: input.cleanupReceiptId,
      preflightFingerprint: input.preflightFingerprint,
      planClaimId: authorization.planRow.id,
      executionClaimId: authorization.execution.id,
    };
  }

  return {
    preflight: async (
      sourceId: string,
      input: AgentRetirementEvidence | AgentRetirementPreflightRequest | AgentRetirementExecutionRecoveryRequest,
      actor: { actorUserId?: string } = {},
    ) => {
      sourceId = canonicalRetirementAgentId(sourceId);
      const recovery = parseExecutionRecoveryRequest(input);
      if (recovery) {
        assertHistoricalAgentTombstoneMutable(sourceId);
        return preflightWithExecutionRecovery(sourceId, recovery, actor);
      }
      const claimed = parsePreflightRequest(input);
      if (claimed) {
        assertHistoricalAgentTombstoneMutable(sourceId);
        return preflightWithClaim(sourceId, claimed, actor);
      }
      return (await buildInventory(db, sourceId, parseEvidence(input))).response;
    },

    cleanup: async (
      sourceId: string,
      rawInput: AgentRetirementCleanupRequest,
      actor: { actorUserId?: string } = {},
    ) => {
      sourceId = canonicalRetirementAgentId(sourceId);
      assertHistoricalAgentTombstoneMutable(sourceId);
      const claimedRequest = parseCleanupRequest(rawInput);
      if (!claimedRequest) {
        throw badRequest("Retirement cleanup requires a durable execution claim", {
          code: "retirement_cleanup_invalid",
        });
      }
      const input = parseCleanup({
        ...claimedRequest.evidence,
        preflightFingerprint: claimedRequest.preflightFingerprint,
      });
      const receiptId = fingerprint({
        kind: "agent_retirement_cleanup",
        sourceId,
        input,
        planClaimReceiptId: claimedRequest.planClaimReceiptId,
        executionClaimReceiptId: claimedRequest.executionClaimReceiptId,
      });
      return withAgentStartLock(sourceId, async () => {
        const stored = await findStoredCleanup(db, sourceId, receiptId);
        if (stored) return stored.response;

        return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await txDb
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, sourceId))
          .for("update");
        const transactionStored = await findStoredCleanup(txDb, sourceId, receiptId);
        if (transactionStored) return transactionStored.response;
        const authorization = await loadExecutionAuthorization(
          txDb,
          sourceId,
          claimedRequest.evidence,
          claimedRequest,
        );
        if (!new Set(["started", "cleaned"]).has(authorization.execution.phase)) {
          throw conflict("Retirement cleanup claim phase is invalid", {
            code: "retirement_execution_claim_phase_invalid",
          });
        }
        if (
          authorization.execution.initialPreflightFingerprint !== input.preflightFingerprint
        ) {
          throw conflict("Retirement cleanup preflight does not match the started claim", {
            code: "retirement_preflight_drift",
          });
        }
        const inventory = await buildInventory(
          txDb,
          sourceId,
          extractCleanupEvidence(input),
          { claimedArtifacts: authorization.artifacts },
        );
        if (inventory.response.fingerprint !== input.preflightFingerprint) {
          throw conflict("Retirement preflight fingerprint changed", { code: "retirement_preflight_drift" });
        }
        if (!inventory.response.cleanupEligible) {
          throw conflict("Retirement cleanup is blocked by domain dependencies", {
            code: "retirement_cleanup_blocked",
            blockerCodes: inventory.response.blockers.map((blocker) => blocker.code),
          });
        }
        await assertLiveRetirementInventoryForCleanup(
          txDb,
          sourceId,
          authorization.artifacts.commonArtifactReceipt.inventory.retirementInventory,
        );
        const cleanedAt = now();
        const revokedKeys = await txDb
          .update(agentApiKeys)
          .set({ revokedAt: cleanedAt })
          .where(and(eq(agentApiKeys.agentId, sourceId), isNull(agentApiKeys.revokedAt)))
          .returning({ id: agentApiKeys.id });
        const deletedGrants = await txDb
          .delete(principalPermissionGrants)
          .where(and(
            eq(principalPermissionGrants.principalType, "agent"),
            sql`lower(${principalPermissionGrants.principalId}) = ${sourceId}`,
          ))
          .returning({ id: principalPermissionGrants.id });
        const deletedCompanyMemberships = await txDb
          .delete(companyMemberships)
          .where(and(
            eq(companyMemberships.principalType, "agent"),
            sql`lower(${companyMemberships.principalId}) = ${sourceId}`,
            eq(companyMemberships.status, "active"),
          ))
          .returning({ id: companyMemberships.id });
        const deletedAgentMemberships = await txDb
          .delete(agentMemberships)
          .where(and(eq(agentMemberships.agentId, sourceId), ne(agentMemberships.state, "left")))
          .returning({ id: agentMemberships.id });
        const deletedSecretBindings = await txDb
          .delete(companySecretBindings)
          .where(and(
            eq(companySecretBindings.targetType, "agent"),
            sql`lower(${companySecretBindings.targetId}) = ${sourceId}`,
          ))
          .returning({ id: companySecretBindings.id });
        const deletedUserSecretDeclarations = await txDb
          .delete(userSecretDeclarations)
          .where(and(
            eq(userSecretDeclarations.targetType, "agent"),
            sql`lower(${userSecretDeclarations.targetId}) = ${sourceId}`,
          ))
          .returning({ id: userSecretDeclarations.id });
        const deletedSkillStars = await txDb
          .delete(companySkillStars)
          .where(eq(companySkillStars.agentId, sourceId))
          .returning({ id: companySkillStars.id });
        const response: AgentRetirementCleanupResponse = {
          schemaVersion: "1.0.0",
          ok: true,
          agentId: inventory.source.id,
          companyId: inventory.source.companyId,
          receiptId,
          preflightFingerprint: input.preflightFingerprint,
          revokedKeyCount: revokedKeys.length,
          deletedGrantCount: deletedGrants.length,
          deactivatedCompanyMembershipCount: deletedCompanyMemberships.length,
          deletedAgentMembershipCount: deletedAgentMemberships.length,
          deletedSecretBindingCount: deletedSecretBindings.length,
          deletedUserSecretDeclarationCount: deletedUserSecretDeclarations.length,
          deletedSkillStarCount: deletedSkillStars.length,
          cleanedAt: cleanedAt.toISOString(),
          executionClaimReceiptId: claimedRequest.executionClaimReceiptId,
        };
        await txDb.update(agentRetirementExecutionClaims).set({
          phase: "cleaned",
          cleanupReceiptId: receiptId,
          updatedAt: cleanedAt,
        }).where(eq(agentRetirementExecutionClaims.id, authorization.execution.id));
        await txDb.insert(activityLog).values({
          companyId: inventory.source.companyId,
          actorType: "user",
          actorId: actor.actorUserId ?? "board",
          action: "agent.retirement_cleanup",
          entityType: "agent",
          entityId: inventory.source.id,
          agentId: inventory.source.id,
          details: {
            response,
            planClaimReceiptId: claimedRequest.planClaimReceiptId,
            executionClaimReceiptId: claimedRequest.executionClaimReceiptId,
            evidenceFingerprint: evidenceFingerprint(claimedRequest.evidence),
          },
        });
        return response;
        }, { isolationLevel: "serializable" });
      });
    },

    assertTerminationAuthorized: async (sourceId: string, rawInput: AgentRetirementTermination) => (
      authorizeTermination(db, canonicalRetirementAgentId(sourceId), rawInput)
    ),

    postcheck: async (sourceId: string, rawInput: AgentRetirementTermination) => (
      postcheckTermination(db, canonicalRetirementAgentId(sourceId), rawInput)
    ),

    terminateAuthorized: async (
      sourceId: string,
      rawInput: AgentRetirementTermination,
      actor: { actorUserId?: string } = {},
    ) => {
      sourceId = canonicalRetirementAgentId(sourceId);
      return withAgentStartLock(sourceId, () => db.transaction(async (tx) => {
      assertHistoricalAgentTombstoneMutable(sourceId);
      const txDb = tx as unknown as Db;
      await txDb
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, sourceId))
        .for("update");
      const input = parseTermination(rawInput);
      const current = await txDb
        .select()
        .from(agents)
        .where(eq(agents.id, sourceId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Agent not found");
      if (current.status === "terminated") {
        const receipt = await postcheckTermination(txDb, sourceId, input);
        return { agent: current, receipt };
      }
      const authorization = await authorizeTermination(txDb, sourceId, input);
      const terminatedAt = now();
      const agent = await txDb
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: terminatedAt,
        })
        .where(eq(agents.id, sourceId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      await txDb
        .update(agentApiKeys)
        .set({ revokedAt: terminatedAt })
        .where(and(eq(agentApiKeys.agentId, sourceId), isNull(agentApiKeys.revokedAt)));
      await txDb
        .update(agentRetirementExecutionClaims)
        .set({ phase: "terminated", updatedAt: terminatedAt })
        .where(eq(agentRetirementExecutionClaims.id, authorization.executionClaimId));
      const activityId = randomUUID();
      const receipt: AgentRetirementTerminationReceipt = {
        schemaVersion: "1.0.0",
        ok: true,
        agentId: agent.id,
        companyId: agent.companyId,
        status: "terminated",
        cleanupReceiptId: input.cleanupReceiptId,
        preflightFingerprint: input.preflightFingerprint,
        activityId,
        terminatedAt: terminatedAt.toISOString(),
        tombstone: {
          id: agent.id,
          companyId: agent.companyId,
          name: agent.name,
          status: "terminated",
          updatedAt: agent.updatedAt.toISOString(),
        },
      };
      await txDb.insert(activityLog).values({
        id: activityId,
        companyId: agent.companyId,
        actorType: "user",
        actorId: actor.actorUserId ?? "board",
        action: "agent.terminated",
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        details: {
          source: "retirement_gated",
          cleanupReceiptId: input.cleanupReceiptId,
          preflightFingerprint: input.preflightFingerprint,
          planClaimReceiptId: input.planClaimReceiptId,
          executionClaimReceiptId: input.executionClaimReceiptId,
          receipt,
        },
      });
      return { agent, receipt };
      }, { isolationLevel: "serializable" }));
    },
  };
}

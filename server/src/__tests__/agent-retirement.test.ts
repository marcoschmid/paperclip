import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agentConfigRevisions,
  agentMemberships,
  agentRetirementExecutionClaims,
  agentRetirementExecutionRecoveries,
  agentRetirementPlanEvidenceBundles,
  agentRetirementPlanClaims,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  goals,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueWatchdogs,
  issues,
  pipelineStages,
  pipelines,
  principalPermissionGrants,
  projects,
  routineTriggers,
  routines,
  workspaceRuntimeStartClaims,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  AGENT_RETIREMENT_ALLOWLIST_ENTRIES,
  AGENT_RETIREMENT_HISTORICAL_TOMBSTONES,
  AGENT_RETIREMENT_RETAINED_AGENTS,
  AGENT_RETIREMENT_WAVES,
  type AgentRetirementEvidence,
} from "@paperclipai/shared";
import {
  agentRetirementService as createAgentRetirementService,
  resolveRetirementWaves,
  retirementWaveManifestFingerprint,
} from "../services/agent-retirement.js";
import {
  RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION,
  RETIREMENT_RESTORE_FULL_COLUMNS,
  assertRetirementRestoreInventory,
  createRetirementRestoreInventory,
  isActiveRetirementHireApprovalStatus,
  isActiveRetirementIssueWatchdogStatus,
  isActiveRetirementRecoveryActionStatus,
  isOperativeRetirementGoalStatus,
  isTerminalRetirementEnvironmentLease,
  isTerminalRetirementWorkspaceOperation,
  retirementRestoreStableSha256,
} from "../services/agent-retirement-restore-inventory.js";
import { agentService } from "../services/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The legacy suite exercises one atomic plan over all 27 sources, the shape of
// the July wave. Wave-specific behavior is covered separately below.
const LEGACY_SINGLE_WAVE = [AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => entry.sourceAgentId)];
const LEGACY_APPROVAL_SCOPE = "wave1_27_allowlisted_sources_tombstone_only";
const JULY_PLAN_MANIFEST_FINGERPRINT =
  "v1:sha256:1af843078e37f5ac61e4a41679dbfa354767160ecdc001a50a66936adf4a8b13";

function agentRetirementService(
  targetDb: Parameters<typeof createAgentRetirementService>[0],
  options: Parameters<typeof createAgentRetirementService>[1] = {},
) {
  return createAgentRetirementService(targetDb, { retirementWaves: LEGACY_SINGLE_WAVE, ...options });
}

const SOURCE_ID = "007bcd1f-0462-4c9e-b58a-c6c546393f41";
const COMPANY_ID = "51eb52b7-49ed-461a-bd67-7384158374e6";
const REPLACEMENT_ID = "c41d7f42-d424-4615-ad71-0f4c5b9762fa";
const DECISION_ISSUE_ID = "50d6efd7-85c7-4ce0-aceb-ff6a94127200";
const HUMAN_COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const RECOVERY_COMMENT_ID = "88888888-8888-4888-8888-888888888888";
const CANARY_ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const CANARY_RUN_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_UPDATED_AT = "2026-07-13T10:00:00.000Z";
const NOW = new Date("2026-07-13T10:10:00.000Z");
// The shared lifecycle schema checks reviewAt and lastCanaryAt against the wall clock, so the
// service tests pin Date inside the fixtures' validity window (after the 16:15 recovery canaries,
// before the 2026-08-12 review deadline). Services still read time from the injected `now`.
const FIXTURE_WALL_CLOCK = new Date("2026-07-20T12:00:00.000Z");
const CONFIG_FINGERPRINT = `v1:sha256:${"d".repeat(64)}`;
const APPROVAL_NONCE = "c".repeat(64);
const APPROVED_AT = "2026-07-13T10:04:00.000Z";
const CANONICAL_RETIREMENT_MANIFEST = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => ({
  sourceAgentId: entry.sourceAgentId,
  companyId: entry.companyId,
  sourceName: entry.sourceName,
  decision: "terminate",
  physicalDelete: false,
  replacementAgentId: entry.replacementAgentId,
  replacementSystemRef: entry.replacementSystemRef,
  decisionIssueId: entry.decisionIssueId,
})).sort((left, right) => left.sourceAgentId.localeCompare(right.sourceAgentId));
const MANIFEST_SHA256 = stableSha256(CANONICAL_RETIREMENT_MANIFEST);
const HERMES_SOURCE_ID = "3f406d3a-9b98-4687-9a89-61a3f927cbf5";
const HERMES_SOURCE_COMPANY_ID = "0d49d45f-63d7-4dd3-9b1e-90992eb45226";
const HERMES_REPLACEMENT_ID = "7f84a9d1-5751-4427-853f-b85851f945d1";
const TECHOPS_COMPANY_ID = "f5ba56a6-afcd-43ad-8db7-fe6219139c4a";
const BARISTA_SOURCE_ID = "0e989281-9933-47b9-87e5-b6da87d4d0a9";
const HOME_OPS_ID = "2f430983-3c02-4e58-90e3-821ae00f80c2";
const BARISTA_SYSTEM_REF = "workspace:projects/kaffee";
const BARISTA_SYSTEM_CANARY_MARKER = `[retirement-system-canary:v1 source=${BARISTA_SOURCE_ID} replacement=${BARISTA_SYSTEM_REF} scenario=workspace-project-binding]`;
const BARISTA_PROJECT_CONTENT = [
  "---",
  "slug: kaffee",
  "status: active",
  "code_path: ~/Code/kaffee",
  "---",
  "# Kaffee",
  "",
  "Operational replacement project for the retired Home Barista agent.",
  "",
].join("\n");

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, stableNormalize((value as Record<string, unknown>)[key])]));
}

function stableSha256(value: unknown) {
  return sha256(JSON.stringify(stableNormalize(value)));
}

const RETIREMENT_FULL_ROW_TIME = "2026-07-13T10:00:00.000Z";
const RETIREMENT_FULL_COLUMNS = {
  agents: [
    ["id", "id"], ["company_id", "companyId"], ["name", "name"], ["role", "role"],
    ["title", "title"], ["icon", "icon"], ["status", "status"], ["reports_to", "reportsTo"],
    ["capabilities", "capabilities"], ["adapter_type", "adapterType"],
    ["adapter_config", "adapterConfig"], ["runtime_config", "runtimeConfig"],
    ["default_environment_id", "defaultEnvironmentId"],
    ["budget_monthly_cents", "budgetMonthlyCents"], ["spent_monthly_cents", "spentMonthlyCents"],
    ["pause_reason", "pauseReason"], ["paused_at", "pausedAt"], ["error_reason", "errorReason"],
    ["permissions", "permissions"], ["last_heartbeat_at", "lastHeartbeatAt"],
    ["metadata", "metadata"], ["created_at", "createdAt"], ["updated_at", "updatedAt"],
  ],
  agent_api_keys: [
    ["id", "id"], ["agent_id", "agentId"], ["company_id", "companyId"], ["name", "name"],
    ["key_hash", "keyHash"], ["responsible_user_id", "responsibleUserId"],
    ["scope_config", "scopeConfig"], ["last_used_at", "lastUsedAt"], ["revoked_at", "revokedAt"],
    ["created_at", "createdAt"],
  ],
  principal_permission_grants: [
    ["id", "id"], ["company_id", "companyId"], ["principal_type", "principalType"],
    ["principal_id", "principalId"], ["permission_key", "permissionKey"], ["scope", "scope"],
    ["granted_by_user_id", "grantedByUserId"], ["created_at", "createdAt"], ["updated_at", "updatedAt"],
  ],
  company_memberships: [
    ["id", "id"], ["company_id", "companyId"], ["principal_type", "principalType"],
    ["principal_id", "principalId"], ["status", "status"], ["membership_role", "membershipRole"],
    ["created_at", "createdAt"], ["updated_at", "updatedAt"],
  ],
  agent_memberships: [
    ["id", "id"], ["company_id", "companyId"], ["agent_id", "agentId"], ["user_id", "userId"],
    ["state", "state"], ["starred_at", "starredAt"], ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
  ],
  projects: RETIREMENT_RESTORE_FULL_COLUMNS.projects!.map((name) => [name, name] as const),
  goals: RETIREMENT_RESTORE_FULL_COLUMNS.goals!.map((name) => [name, name] as const),
  heartbeat_runs: RETIREMENT_RESTORE_FULL_COLUMNS.heartbeat_runs!.map((name) => [name, name] as const),
  workspace_runtime_services: RETIREMENT_RESTORE_FULL_COLUMNS.workspace_runtime_services!
    .map((name) => [name, name] as const),
  workspace_runtime_start_claims: RETIREMENT_RESTORE_FULL_COLUMNS.workspace_runtime_start_claims!
    .map((name) => [name, name] as const),
  approvals: RETIREMENT_RESTORE_FULL_COLUMNS.approvals!.map((name) => [name, name] as const),
  agent_task_sessions: RETIREMENT_RESTORE_FULL_COLUMNS.agent_task_sessions!
    .map((name) => [name, name] as const),
  agent_wakeup_requests: RETIREMENT_RESTORE_FULL_COLUMNS.agent_wakeup_requests!
    .map((name) => [name, name] as const),
  issues: RETIREMENT_RESTORE_FULL_COLUMNS.issues!.map((name) => [name, name] as const),
  routines: RETIREMENT_RESTORE_FULL_COLUMNS.routines!.map((name) => [name, name] as const),
  routine_triggers: RETIREMENT_RESTORE_FULL_COLUMNS.routine_triggers!
    .map((name) => [name, name] as const),
  issue_watchdogs: RETIREMENT_RESTORE_FULL_COLUMNS.issue_watchdogs!
    .map((name) => [name, name] as const),
  issue_recovery_actions: RETIREMENT_RESTORE_FULL_COLUMNS.issue_recovery_actions!
    .map((name) => [name, name] as const),
  pipelines: RETIREMENT_RESTORE_FULL_COLUMNS.pipelines!.map((name) => [name, name] as const),
  pipeline_stages: RETIREMENT_RESTORE_FULL_COLUMNS.pipeline_stages!
    .map((name) => [name, name] as const),
  pipeline_cases: RETIREMENT_RESTORE_FULL_COLUMNS.pipeline_cases!
    .map((name) => [name, name] as const),
  environment_leases: RETIREMENT_RESTORE_FULL_COLUMNS.environment_leases!
    .map((name) => [name, name] as const),
  workspace_operations: RETIREMENT_RESTORE_FULL_COLUMNS.workspace_operations!
    .map((name) => [name, name] as const),
  companies: [
    ["id", "id"], ["name", "name"], ["description", "description"], ["status", "status"],
    ["pause_reason", "pauseReason"], ["paused_at", "pausedAt"], ["issue_prefix", "issuePrefix"],
    ["issue_counter", "issueCounter"], ["budget_monthly_cents", "budgetMonthlyCents"],
    ["spent_monthly_cents", "spentMonthlyCents"],
    ["default_responsible_user_id", "defaultResponsibleUserId"],
    ["require_board_approval_for_new_agents", "requireBoardApprovalForNewAgents"],
    ["feedback_data_sharing_enabled", "feedbackDataSharingEnabled"],
    ["feedback_data_sharing_consent_at", "feedbackDataSharingConsentAt"],
    ["feedback_data_sharing_consent_by_user_id", "feedbackDataSharingConsentByUserId"],
    ["feedback_data_sharing_terms_version", "feedbackDataSharingTermsVersion"],
    ["created_at", "createdAt"], ["updated_at", "updatedAt"],
    ["interaction_resolver_governance", "interactionResolverGovernance"],
  ],
  company_secrets: [
    ["id", "id"], ["company_id", "companyId"], ["scope", "scope"], ["owner_user_id", "ownerUserId"],
    ["user_secret_definition_id", "userSecretDefinitionId"], ["key", "key"], ["name", "name"],
    ["provider", "provider"], ["status", "status"], ["managed_mode", "managedMode"],
    ["external_ref", "externalRef"], ["provider_config_id", "providerConfigId"],
    ["provider_metadata", "providerMetadata"], ["latest_version", "latestVersion"],
    ["description", "description"], ["last_resolved_at", "lastResolvedAt"],
    ["last_rotated_at", "lastRotatedAt"], ["deleted_at", "deletedAt"],
    ["created_by_agent_id", "createdByAgentId"], ["created_by_user_id", "createdByUserId"],
    ["created_at", "createdAt"], ["updated_at", "updatedAt"],
  ],
  company_secret_versions: [
    ["id", "id"], ["secret_id", "secretId"], ["version", "version"], ["material", "material"],
    ["value_sha256", "valueSha256"], ["provider_version_ref", "providerVersionRef"],
    ["status", "status"], ["fingerprint_sha256", "fingerprintSha256"],
    ["rotation_job_id", "rotationJobId"], ["created_by_agent_id", "createdByAgentId"],
    ["created_by_user_id", "createdByUserId"], ["created_at", "createdAt"], ["revoked_at", "revokedAt"],
  ],
  company_secret_bindings: [
    ["id", "id"], ["company_id", "companyId"], ["secret_id", "secretId"],
    ["target_type", "targetType"], ["target_id", "targetId"], ["config_path", "configPath"],
    ["version_selector", "versionSelector"], ["required", "required"], ["label", "label"],
    ["created_at", "createdAt"], ["updated_at", "updatedAt"],
    ["projection_class", "projectionClass"], ["projection_allowlist_key", "projectionAllowlistKey"],
  ],
  approval_execution_claims: RETIREMENT_RESTORE_FULL_COLUMNS.approval_execution_claims
    .map((name) => [name, name] as const),
  routine_runs: RETIREMENT_RESTORE_FULL_COLUMNS.routine_runs.map((name) => [name, name] as const),
  routine_run_deliveries: RETIREMENT_RESTORE_FULL_COLUMNS.routine_run_deliveries
    .map((name) => [name, name] as const),
  user_secret_declarations: RETIREMENT_RESTORE_FULL_COLUMNS.user_secret_declarations
    .map((name) => [name, name] as const),
  company_skill_stars: RETIREMENT_RESTORE_FULL_COLUMNS.company_skill_stars
    .map((name) => [name, name] as const),
} as const;

function retirementFullSourceRows() {
  return AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => ({
    id: entry.sourceAgentId,
    companyId: entry.companyId,
    name: entry.sourceName,
    role: "general",
    title: null,
    icon: null,
    status: "paused",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: "portfolio consolidation",
    pausedAt: RETIREMENT_FULL_ROW_TIME,
    errorReason: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: { retirementReviewed: true },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: RETIREMENT_FULL_ROW_TIME,
  }));
}

function retirementFullRetainedRows(options: { freshRecoveryReview?: boolean } = {}) {
  return AGENT_RETIREMENT_RETAINED_AGENTS.map((retained, index) => {
    const id = retained.agentId;
    const canaryEntry = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => entry.canaryAgentId === id);
    const contract = canaryEntry ? portfolioCanaryContract(id) : null;
    const metadata = contract ? {
      lifecycle: { ...lifecycle(), canaryIssueId: contract.issueId },
      lifecycleGate: { ...lifecycleGate(), lastSatisfiedRunId: contract.runId },
    } : { lifecycle: { state: "active", index } };
    if (options.freshRecoveryReview && id === REPLACEMENT_ID && "lifecycleGate" in metadata) {
      metadata.lifecycle = { ...metadata.lifecycle, lastCanaryAt: "2026-07-13T16:15:00.000Z" };
      metadata.lifecycleGate = {
        ...metadata.lifecycleGate,
        validatedAt: "2026-07-13T16:15:00.000Z",
        expiresAt: "2026-07-13T16:45:00.000Z",
      };
    }
    return ({
    ...retirementFullSourceRows()[0],
    id,
    companyId: retained.companyId,
    name: retained.name,
    status: "idle",
    pauseReason: null,
    pausedAt: null,
    metadata,
    });
  });
}

function retirementFullHistoricalTombstoneRows() {
  return AGENT_RETIREMENT_HISTORICAL_TOMBSTONES.map((entry) => ({
    ...retirementFullSourceRows()[0],
    id: entry.agentId,
    companyId: entry.companyId,
    name: entry.name,
    status: "terminated",
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    metadata: { historicalTombstone: true },
  }));
}

function retirementAgentPartition(retainedRows = retirementFullRetainedRows()) {
  return {
    sources: AGENT_RETIREMENT_ALLOWLIST_ENTRIES,
    retainedAgents: retainedRows.map((row) => ({
      agentId: row.id,
      companyId: row.companyId,
      name: row.name,
    })),
    historicalTombstones: AGENT_RETIREMENT_HISTORICAL_TOMBSTONES,
  };
}

function portfolioCanaryContract(agentId: string) {
  const ids = [...new Set(AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => entry.canaryAgentId))];
  const index = ids.indexOf(agentId);
  if (index < 0) throw new Error(`Unknown portfolio canary ${agentId}`);
  return agentId === REPLACEMENT_ID
    ? { issueId: CANARY_ISSUE_ID, runId: CANARY_RUN_ID }
    : {
        issueId: `a1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        runId: `a2000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      };
}

function retirementFullCompanyRows() {
  return [...new Set(AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => entry.companyId))]
    .sort()
    .map((id, index) => ({
      id, name: `Company ${index + 1}`, description: null, status: "active", pauseReason: null,
      pausedAt: null, issuePrefix: `T${index + 1}`, issueCounter: 0, budgetMonthlyCents: 0,
      spentMonthlyCents: 0, defaultResponsibleUserId: null,
      requireBoardApprovalForNewAgents: false, feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null, feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null, interactionResolverGovernance: {},
      createdAt: "2026-07-01T10:00:00.000Z", updatedAt: RETIREMENT_FULL_ROW_TIME,
    }));
}

function retirementEmptyRestoreRaw() {
  return {
    sourceAgents: retirementFullSourceRows(),
    retainedAgents: retirementFullRetainedRows(),
    historicalTombstones: retirementFullHistoricalTombstoneRows(),
    companies: retirementFullCompanyRows(),
    activeApiKeys: [],
    principalPermissionGrants: [],
    activeCompanyMemberships: [],
    nonLeftAgentMemberships: [],
    agentSecretBindings: [],
    agentUserSecretDeclarations: [],
    agentSkillStars: [],
    historicalActiveApiKeys: [],
    historicalPrincipalPermissionGrants: [],
    historicalActiveCompanyMemberships: [],
    historicalNonLeftAgentMemberships: [],
    historicalAgentSecretBindings: [],
    historicalAgentUserSecretDeclarations: [],
    historicalAgentSkillStars: [],
    historicalActiveProjectLeads: [],
    historicalOperativeGoalOwnerships: [],
    historicalHeartbeatRuns: [],
    historicalWorkspaceRuntimeServices: [],
    historicalApprovals: [],
    historicalTaskSessions: [],
    historicalIssues: [],
    historicalRoutines: [],
    historicalRoutineTriggers: [],
    historicalRoutineRuns: [],
    approvalExecutionClaims: [],
    historicalWakeRequests: [],
    historicalActiveIssueWatchdogs: [],
    historicalActiveRecoveryActions: [],
    historicalPipelineAgentLeases: [],
    historicalActiveReportees: [],
    historicalActivePipelineApprovers: [],
    historicalActiveHireApprovalReferences: [],
    historicalEnvironmentLeases: [] as Record<string, unknown>[],
    historicalOutstandingEnvironmentLeases: [],
    historicalWorkspaceOperations: [],
    historicalRunningWorkspaceOperations: [],
    companySecrets: [],
    companySecretVersions: [],
    companySecretBindings: [],
  };
}

function retirementHistoricalEnvironmentLease(overrides: Record<string, unknown> = {}) {
  const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
  return {
    id: "86000000-0000-4000-8000-000000000001",
    companyId: tombstone.companyId,
    environmentId: "86000000-0000-4000-8000-000000000002",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "released",
    leasePolicy: "ephemeral",
    provider: null,
    providerLeaseId: null,
    acquiredAt: "2026-07-13T09:00:00.000Z",
    lastUsedAt: "2026-07-13T09:01:00.000Z",
    expiresAt: null,
    releasedAt: "2026-07-13T09:02:00.000Z",
    failureReason: null,
    cleanupStatus: null,
    metadata: { agentId: tombstone.agentId },
    createdAt: "2026-07-13T09:00:00.000Z",
    updatedAt: "2026-07-13T09:02:00.000Z",
    ...overrides,
  };
}

function retirementCopyField(value: unknown) {
  if (value === null) return "\\N";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function retirementCopySection(
  table: string,
  columns: readonly (readonly [string, string])[],
  rows: Record<string, unknown>[],
) {
  return [
    `CREATE TABLE ${table} (${columns.map(([name]) => `${name} text`).join(",")});`,
    `COPY ${table} (${columns.map(([name]) => name).join(",")}) FROM stdin;`,
    ...rows.map((row) => columns.map(([snake, camel]) =>
      retirementCopyField(Object.hasOwn(row, camel) ? row[camel] : row[snake])).join("\t")),
    "\\.",
  ].join("\n");
}

function approvalText(binding: {
  approvalNonce: string;
  manifestSha256: string;
  backupSha256: string;
  restoreReceiptSha256: string;
}, scope = LEGACY_APPROVAL_SCOPE) {
  return [
    "PAPERCLIP_RETIREMENT_APPROVAL_V1",
    "issue=TEC-355",
    `scope=${scope}`,
    `approvalNonce=${binding.approvalNonce}`,
    `manifestSha256=${binding.manifestSha256}`,
    `backupSha256=${binding.backupSha256}`,
    `restoreReceiptSha256=${binding.restoreReceiptSha256}`,
  ].join("\n");
}

function baristaSystemReceipt(input: { runId?: string; issueId?: string } = {}) {
  return {
    schemaVersion: "1.0.0",
    sourceAgentId: BARISTA_SOURCE_ID,
    replacementSystemRef: BARISTA_SYSTEM_REF,
    scenario: "workspace-project-binding",
    runId: input.runId ?? CANARY_RUN_ID,
    canaryIssueId: input.issueId ?? CANARY_ISSUE_ID,
    configFingerprint: CONFIG_FINGERPRINT,
    nonce: "a".repeat(32),
    observedRef: "workspace:projects/kaffee:PROJECT.md",
    observedSha256: sha256(BARISTA_PROJECT_CONTENT),
  };
}

function lifecycle() {
  return {
    schemaVersion: "1.0.0",
    owner: { ownerType: "board_user", ownerUserId: "better-auth:marco" },
    purpose: "Own the retained replacement queue.",
    acceptedTaskTypes: ["bounded replacement work"],
    rejectedTaskTypes: ["unreviewed retirement"],
    taskSources: ["paperclip:issues"],
    operatingMode: "issue_routed",
    serviceLevel: {
      availabilityClass: "business_hours",
      triageTargetMinutes: 120,
      completionTargetMinutes: 1_440,
      targetExceptionReason: null,
    },
    canaryIssueId: CANARY_ISSUE_ID,
    lastCanaryAt: "2026-07-13T10:05:00.000Z",
    lastCanaryResult: "passed",
    canaryFreshnessDays: 30,
    reviewAt: "2026-08-12T12:00:00.000Z",
    retirementCriterion: "Retire only after reviewed replacement evidence.",
    decisionIssueId: DECISION_ISSUE_ID,
  };
}

function lifecycleGate() {
  return {
    schemaVersion: "1.0.0",
    configFingerprint: CONFIG_FINGERPRINT,
    validatedAt: "2026-07-13T10:04:00.000Z",
    expiresAt: "2026-07-13T10:40:00.000Z",
    findingCount: 0,
    receiptHash: `v1:sha256:${"e".repeat(64)}`,
    freshSessionRequired: false,
    lastSatisfiedRunId: CANARY_RUN_ID,
  };
}

describe("agent retirement restore inventory", () => {
  it("keeps reusable environment leases outstanding until destroy is proven", () => {
    expect(isTerminalRetirementEnvironmentLease({
      leasePolicy: "reuse_by_environment",
      status: "released",
      cleanupStatus: "success",
    })).toBe(false);
    expect(isTerminalRetirementEnvironmentLease({
      leasePolicy: "reuse_by_environment",
      status: "expired",
      cleanupStatus: "success",
    })).toBe(true);
    expect(isTerminalRetirementEnvironmentLease({
      leasePolicy: "ephemeral",
      status: "released",
      cleanupStatus: null,
    })).toBe(true);
  });

  it("accepts only declared terminal workspace-operation statuses", () => {
    expect(isTerminalRetirementWorkspaceOperation("succeeded")).toBe(true);
    expect(isTerminalRetirementWorkspaceOperation("failed")).toBe(true);
    expect(isTerminalRetirementWorkspaceOperation("skipped")).toBe(true);
    expect(isTerminalRetirementWorkspaceOperation("running")).toBe(false);
    expect(isTerminalRetirementWorkspaceOperation("legacy_unknown")).toBe(false);
  });

  it("treats every unknown tombstone reference status as operative fail-closed state", () => {
    expect(isOperativeRetirementGoalStatus("legacy_unknown")).toBe(true);
    expect(isActiveRetirementIssueWatchdogStatus("legacy_unknown")).toBe(true);
    expect(isActiveRetirementRecoveryActionStatus("legacy_unknown")).toBe(true);
    expect(isActiveRetirementHireApprovalStatus("legacy_unknown")).toBe(true);
    expect(isOperativeRetirementGoalStatus("achieved")).toBe(false);
    expect(isActiveRetirementIssueWatchdogStatus("disabled")).toBe(false);
    expect(isActiveRetirementRecoveryActionStatus("resolved")).toBe(false);
    expect(isActiveRetirementHireApprovalStatus("approved")).toBe(false);
  });

  it("requires every historical environment lease owner source to name the same tombstone", () => {
    const first = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    const second = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[1]!;
    const consistent = retirementEmptyRestoreRaw();
    consistent.historicalEnvironmentLeases = [retirementHistoricalEnvironmentLease({
      metadata: {
        agentId: first.agentId.toUpperCase(),
        reusableSandboxLease: { agentId: first.agentId },
      },
    })];
    expect(createRetirementRestoreInventory(
      consistent,
      retirementAgentPartition(consistent.retainedAgents),
    ).historicalEnvironmentLeases.count).toBe(1);

    const conflicting = retirementEmptyRestoreRaw();
    conflicting.historicalEnvironmentLeases = [retirementHistoricalEnvironmentLease({
      metadata: {
        agentId: first.agentId,
        reusableSandboxLease: { agentId: second.agentId },
      },
    })];
    expect(() => createRetirementRestoreInventory(
      conflicting,
      retirementAgentPartition(conflicting.retainedAgents),
    )).toThrow(/environment lease.*malformed|outside tombstone/i);

    const missingRun = retirementEmptyRestoreRaw();
    missingRun.historicalEnvironmentLeases = [retirementHistoricalEnvironmentLease({
      heartbeatRunId: "86000000-0000-4000-8000-000000000003",
    })];
    expect(() => createRetirementRestoreInventory(
      missingRun,
      retirementAgentPartition(missingRun.retainedAgents),
    )).toThrow(/environment lease.*malformed|outside tombstone/i);
  });

  it("rejects every present malformed reusable sandbox lease owner scope", () => {
    const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    const malformedScopes: unknown[] = [null, "not-an-object", [], {}];

    for (const reusableSandboxLease of malformedScopes) {
      const raw = retirementEmptyRestoreRaw();
      raw.historicalEnvironmentLeases = [retirementHistoricalEnvironmentLease({
        metadata: {
          agentId: tombstone.agentId,
          reusableSandboxLease,
        },
      })];

      expect(() => createRetirementRestoreInventory(
        raw,
        retirementAgentPartition(raw.retainedAgents),
      ), JSON.stringify(reusableSandboxLease)).toThrow(/environment lease.*malformed|outside tombstone/i);
    }
  });

  it("binds every source field except the five legitimate termination delta fields", () => {
    const retainedRows = retirementFullRetainedRows();
    const makeInventory = (sourceAgents: Record<string, unknown>[]) => createRetirementRestoreInventory({
      sourceAgents,
      retainedAgents: retainedRows,
      historicalTombstones: retirementFullHistoricalTombstoneRows(),
      companies: retirementFullCompanyRows(),
      activeApiKeys: [],
      principalPermissionGrants: [],
      activeCompanyMemberships: [],
      nonLeftAgentMemberships: [],
      agentSecretBindings: [],
      agentUserSecretDeclarations: [],
      agentSkillStars: [],
      historicalActiveApiKeys: [],
      historicalPrincipalPermissionGrants: [],
      historicalActiveCompanyMemberships: [],
      historicalNonLeftAgentMemberships: [],
      historicalAgentSecretBindings: [],
      historicalAgentUserSecretDeclarations: [],
      historicalAgentSkillStars: [],
      historicalActiveProjectLeads: [],
      historicalOperativeGoalOwnerships: [],
      historicalHeartbeatRuns: [],
      historicalWorkspaceRuntimeServices: [],
      historicalApprovals: [],
      historicalTaskSessions: [],
      historicalIssues: [],
      historicalRoutines: [],
      historicalRoutineTriggers: [],
      historicalRoutineRuns: [],
      approvalExecutionClaims: [],
      historicalWakeRequests: [],
      historicalActiveIssueWatchdogs: [],
      historicalActiveRecoveryActions: [],
      historicalPipelineAgentLeases: [],
      historicalActiveReportees: [],
      historicalActivePipelineApprovers: [],
      historicalActiveHireApprovalReferences: [],
      historicalEnvironmentLeases: [],
      historicalOutstandingEnvironmentLeases: [],
      historicalWorkspaceOperations: [],
      historicalRunningWorkspaceOperations: [],
      companySecrets: [],
      companySecretVersions: [],
      companySecretBindings: [],
    }, retirementAgentPartition(retainedRows));
    const originalRows = retirementFullSourceRows();
    const baseline = makeInventory(originalRows);

    const changedAdapter = structuredClone(originalRows);
    changedAdapter[0].adapterConfig = { cwd: "/unexpected" };
    const adapterProof = makeInventory(changedAdapter);
    expect(adapterProof.sourceAgents.rows[0].rowSha256)
      .not.toBe(baseline.sourceAgents.rows[0].rowSha256);
    expect(adapterProof.sourceAgents.rows[0].immutableRowSha256)
      .not.toBe(baseline.sourceAgents.rows[0].immutableRowSha256);

    const terminationDeltas: [string, unknown][] = [
      ["status", "terminated"],
      ["pauseReason", "termination receipt"],
      ["pausedAt", "2026-07-13T11:00:00.000Z"],
      ["errorReason", "terminal audit marker"],
      ["updatedAt", "2026-07-13T12:00:00.000Z"],
    ];
    for (const [field, value] of terminationDeltas) {
      const changedRows = structuredClone(originalRows);
      changedRows[0][field] = value;
      const proof = makeInventory(changedRows);
      expect(proof.sourceAgents.rows[0].rowSha256, field)
        .not.toBe(baseline.sourceAgents.rows[0].rowSha256);
      expect(proof.sourceAgents.rows[0].immutableRowSha256, field)
        .toBe(baseline.sourceAgents.rows[0].immutableRowSha256);
    }
  });

  it("binds the exact terminated historical partition and requires access inertness", () => {
    const retainedRows = retirementFullRetainedRows();
    const raw = {
      sourceAgents: retirementFullSourceRows(),
      retainedAgents: retainedRows,
      historicalTombstones: retirementFullHistoricalTombstoneRows(),
      companies: retirementFullCompanyRows(),
      activeApiKeys: [],
      principalPermissionGrants: [],
      activeCompanyMemberships: [],
      nonLeftAgentMemberships: [],
      agentSecretBindings: [],
      agentUserSecretDeclarations: [],
      agentSkillStars: [],
      historicalActiveApiKeys: [],
      historicalPrincipalPermissionGrants: [],
      historicalActiveCompanyMemberships: [],
      historicalNonLeftAgentMemberships: [],
      historicalAgentSecretBindings: [],
      historicalAgentUserSecretDeclarations: [],
      historicalAgentSkillStars: [],
      historicalActiveProjectLeads: [],
      historicalOperativeGoalOwnerships: [],
      historicalHeartbeatRuns: [],
      historicalWorkspaceRuntimeServices: [],
      historicalApprovals: [],
      historicalTaskSessions: [],
      historicalIssues: [],
      historicalRoutines: [],
      historicalRoutineTriggers: [],
      historicalRoutineRuns: [],
      approvalExecutionClaims: [],
      historicalWakeRequests: [],
      historicalActiveIssueWatchdogs: [],
      historicalActiveRecoveryActions: [],
      historicalPipelineAgentLeases: [],
      historicalActiveReportees: [],
      historicalActivePipelineApprovers: [],
      historicalActiveHireApprovalReferences: [],
      historicalEnvironmentLeases: [],
      historicalOutstandingEnvironmentLeases: [],
      historicalWorkspaceOperations: [],
      historicalRunningWorkspaceOperations: [],
      companySecrets: [],
      companySecretVersions: [],
      companySecretBindings: [],
    };
    const partition = retirementAgentPartition(retainedRows);
    const inventory = createRetirementRestoreInventory(raw, partition);
    expect(inventory).toMatchObject({
      schemaVersion: "3.0.0",
      historicalTombstones: {
        count: 2,
        rows: AGENT_RETIREMENT_HISTORICAL_TOMBSTONES.map((entry) => ({
          id: entry.agentId,
          companyId: entry.companyId,
          name: entry.name,
          status: "terminated",
        })).sort((left, right) => left.id.localeCompare(right.id)),
      },
      historicalActiveApiKeys: { count: 0, rows: [] },
    });

    const wrongStatus = structuredClone(raw);
    wrongStatus.historicalTombstones[0]!.status = "idle";
    expect(() => createRetirementRestoreInventory(wrongStatus, partition))
      .toThrow(/terminated partition/);

    const activeAccess = structuredClone(raw);
    activeAccess.historicalActiveApiKeys = [{ id: randomUUID() }];
    expect(() => createRetirementRestoreInventory(activeAccess, partition))
      .toThrow(/not access-inert/);
  });

  it("rejects self-signed substituted, missing, and duplicate retained identity proofs", () => {
    const baseline = createRetirementRestoreInventory({
      sourceAgents: retirementFullSourceRows(),
      retainedAgents: retirementFullRetainedRows(),
      historicalTombstones: retirementFullHistoricalTombstoneRows(),
      companies: retirementFullCompanyRows(),
      activeApiKeys: [],
      principalPermissionGrants: [],
      activeCompanyMemberships: [],
      nonLeftAgentMemberships: [],
      agentSecretBindings: [],
      agentUserSecretDeclarations: [],
      agentSkillStars: [],
      historicalActiveApiKeys: [],
      historicalPrincipalPermissionGrants: [],
      historicalActiveCompanyMemberships: [],
      historicalNonLeftAgentMemberships: [],
      historicalAgentSecretBindings: [],
      historicalAgentUserSecretDeclarations: [],
      historicalAgentSkillStars: [],
      historicalActiveProjectLeads: [],
      historicalOperativeGoalOwnerships: [],
      historicalHeartbeatRuns: [],
      historicalWorkspaceRuntimeServices: [],
      historicalApprovals: [],
      historicalTaskSessions: [],
      historicalIssues: [],
      historicalRoutines: [],
      historicalRoutineTriggers: [],
      historicalRoutineRuns: [],
      approvalExecutionClaims: [],
      historicalWakeRequests: [],
      historicalActiveIssueWatchdogs: [],
      historicalActiveRecoveryActions: [],
      historicalPipelineAgentLeases: [],
      historicalActiveReportees: [],
      historicalActivePipelineApprovers: [],
      historicalActiveHireApprovalReferences: [],
      historicalEnvironmentLeases: [],
      historicalOutstandingEnvironmentLeases: [],
      historicalWorkspaceOperations: [],
      historicalRunningWorkspaceOperations: [],
      companySecrets: [],
      companySecretVersions: [],
      companySecretBindings: [],
    }, RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION);
    const resign = (rows: typeof baseline.retainedAgents.rows) => {
      const forged = structuredClone(baseline);
      forged.retainedAgents = {
        count: rows.length,
        rowsSha256: retirementRestoreStableSha256(rows),
        rows,
      };
      const { inventorySha256: _oldFingerprint, ...core } = forged;
      forged.inventorySha256 = retirementRestoreStableSha256(core);
      return forged;
    };
    const canonicalRows = baseline.retainedAgents.rows;
    const substituted = structuredClone(canonicalRows);
    substituted[0] = {
      ...substituted[0]!,
      id: "91000000-0000-4000-8000-000000000001",
      name: "Substituted Retained Agent",
    };
    const missing = structuredClone(canonicalRows.slice(1));
    const duplicate = structuredClone(canonicalRows);
    duplicate[0] = structuredClone(duplicate[1]!);

    for (const rows of [substituted, missing, duplicate]) {
      expect(() => assertRetirementRestoreInventory(
        resign(rows),
        RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION,
      )).toThrow(/retained|canonical|exact unique/i);
    }
  });
});

describe("agent retirement waves", () => {
  it("binds wave 1 to the exact July plan manifest and schedules Authentik as the current wave", () => {
    const registry = resolveRetirementWaves();
    expect(registry.waves).toBe(AGENT_RETIREMENT_WAVES);
    expect(registry.waves.map((wave) => wave.sourceIds.length)).toEqual([26, 1]);
    expect(retirementWaveManifestFingerprint(registry.waves[0]!)).toBe(JULY_PLAN_MANIFEST_FINGERPRINT);
    expect(registry.current).toEqual({ wave: 2, sourceIds: ["04c5ffc3-7eb8-428f-8225-0c50063667e9"] });
    expect(retirementWaveManifestFingerprint(resolveRetirementWaves(LEGACY_SINGLE_WAVE).current))
      .toBe(`v1:sha256:${MANIFEST_SHA256}`);
  });

  it("rejects wave overrides with unknown, repeated, or missing sources", () => {
    const [first, second] = LEGACY_SINGLE_WAVE[0]!;
    expect(resolveRetirementWaves([[first!], [second!]]).current).toEqual({ wave: 2, sourceIds: [second] });
    for (const invalid of [
      [],
      [[]],
      [[first!], []],
      [[first!], [first!]],
      [[first!, first!]],
      [["91000000-0000-4000-8000-000000000001"]],
      [[first!.toUpperCase()]],
    ]) {
      expect(() => resolveRetirementWaves(invalid), JSON.stringify(invalid)).toThrow();
    }
  });
});

describeEmbeddedPostgres("agent retirement service", { timeout: 15_000 }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let artifactRoot = "";
  let backupRoot = "";
  let retirementEvidenceRoot = "";
  let workspaceRoot = "";
  let retirementAccessRows: {
    activeApiKeys: Record<string, unknown>[];
    principalPermissionGrants: Record<string, unknown>[];
    activeCompanyMemberships: Record<string, unknown>[];
    nonLeftAgentMemberships: Record<string, unknown>[];
  } = {
    activeApiKeys: [],
    principalPermissionGrants: [],
    activeCompanyMemberships: [],
    nonLeftAgentMemberships: [],
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-retirement-");
    db = createDb(tempDb.connectionString);
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-agent-retirement-artifacts-"));
    backupRoot = path.join(artifactRoot, "backups");
    retirementEvidenceRoot = path.join(artifactRoot, "retirement");
    workspaceRoot = path.join(artifactRoot, "workspace");
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(retirementEvidenceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workspaceRoot, "projects/kaffee"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspaceRoot, "projects/kaffee/PROJECT.md"), BARISTA_PROJECT_CONTENT, { mode: 0o600 });
  }, 30_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: FIXTURE_WALL_CLOCK, shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    retirementAccessRows = {
      activeApiKeys: [],
      principalPermissionGrants: [],
      activeCompanyMemberships: [],
      nonLeftAgentMemberships: [],
      agentSecretBindings: [],
      agentUserSecretDeclarations: [],
      agentSkillStars: [],
    };
    fs.writeFileSync(path.join(workspaceRoot, "projects/kaffee/PROJECT.md"), BARISTA_PROJECT_CONTENT, { mode: 0o600 });
    await db.delete(activityLog);
    await db.delete(agentRetirementExecutionRecoveries);
    await db.delete(agentRetirementExecutionClaims);
    await db.delete(agentRetirementPlanEvidenceBundles);
    await db.delete(agentRetirementPlanClaims);
    await db.delete(costEvents);
    await db.delete(agentConfigRevisions);
    await db.delete(agentTaskSessions);
    await db.delete(agentMemberships);
    await db.delete(companyMemberships);
    await db.delete(principalPermissionGrants);
    await db.delete(agentApiKeys);
    await db.delete(workspaceRuntimeStartClaims);
    await db.delete(workspaceRuntimeServices);
    await db.delete(approvals);
    await db.delete(issueWatchdogs);
    await db.delete(issueRecoveryActions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  });

  function writePrivateArtifact(target: string, bytes: string | Buffer, capturedAt: string) {
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const timestamp = new Date(capturedAt);
    fs.utimesSync(target, timestamp, timestamp);
    const stat = fs.statSync(target);
    return {
      path: target,
      sha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      sizeBytes: stat.size,
      capturedAt: stat.mtime.toISOString(),
    };
  }

  function artifactEvidence(
    sourceAgentId = SOURCE_ID,
    companyId = COMPANY_ID,
    sourceName = "Calendar und Events Butler",
    timestamps: {
      sourceExportCapturedAt?: string;
      masterKeyCapturedAt?: string;
      dumpCapturedAt?: string;
      restoreVerifiedAt?: string;
      omitRetirementRows?: boolean;
      omitRetainedRows?: boolean;
      substituteRetainedAgent?: boolean;
      pathSuffix?: string;
      freshRecoveryReview?: boolean;
      sourceRowOverrides?: Record<string, Record<string, unknown>>;
    } = {},
  ) {
    const suffix = `${sourceAgentId}${timestamps.pathSuffix ?? ""}`;
    const sourceExportCapturedAt = timestamps.sourceExportCapturedAt ?? "2026-07-13T10:01:00.000Z";
    const masterKeyCapturedAt = timestamps.masterKeyCapturedAt ?? "2026-07-13T10:01:30.000Z";
    const dumpCapturedAt = timestamps.dumpCapturedAt ?? "2026-07-13T10:02:00.000Z";
    const restoreVerifiedAt = timestamps.restoreVerifiedAt ?? "2026-07-13T10:03:00.000Z";
    const sourceExport = writePrivateArtifact(
      path.join(retirementEvidenceRoot, `source-${suffix}.json`),
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        sourceAgentId,
        companyId,
        sourceName,
        expectedUpdatedAt: SOURCE_UPDATED_AT,
        capturedAt: sourceExportCapturedAt,
      })}\n`,
      sourceExportCapturedAt,
    );
    const fullSourceRows = retirementFullSourceRows().map((row) => ({
      ...row,
      ...(timestamps.sourceRowOverrides?.[row.id] ?? {}),
    }));
    const canonicalRetainedRows = retirementFullRetainedRows({
      freshRecoveryReview: timestamps.freshRecoveryReview,
    });
    const fullRetainedRows = timestamps.substituteRetainedAgent
      ? canonicalRetainedRows.map((row, index) => index === 0 ? {
          ...row,
          id: "91000000-0000-4000-8000-000000000001",
          name: "Substituted Retained Agent",
        } : row)
      : canonicalRetainedRows;
    const fullHistoricalTombstoneRows = retirementFullHistoricalTombstoneRows();
    const fullCompanyRows = retirementFullCompanyRows();
    const dumpSourceRows = timestamps.omitRetirementRows ? [] : fullSourceRows;
    const dumpSql = [
      retirementCopySection("agents", RETIREMENT_FULL_COLUMNS.agents, [
        ...dumpSourceRows,
        ...(timestamps.omitRetainedRows ? [] : fullRetainedRows),
        ...fullHistoricalTombstoneRows,
      ]),
      retirementCopySection("agent_api_keys", RETIREMENT_FULL_COLUMNS.agent_api_keys, retirementAccessRows.activeApiKeys),
      retirementCopySection(
        "principal_permission_grants",
        RETIREMENT_FULL_COLUMNS.principal_permission_grants,
        retirementAccessRows.principalPermissionGrants,
      ),
      retirementCopySection("company_memberships", RETIREMENT_FULL_COLUMNS.company_memberships, retirementAccessRows.activeCompanyMemberships),
      retirementCopySection("agent_memberships", RETIREMENT_FULL_COLUMNS.agent_memberships, retirementAccessRows.nonLeftAgentMemberships),
      retirementCopySection("projects", RETIREMENT_FULL_COLUMNS.projects, []),
      retirementCopySection("goals", RETIREMENT_FULL_COLUMNS.goals, []),
      retirementCopySection("heartbeat_runs", RETIREMENT_FULL_COLUMNS.heartbeat_runs, []),
      retirementCopySection("workspace_runtime_services", RETIREMENT_FULL_COLUMNS.workspace_runtime_services, []),
      retirementCopySection("workspace_runtime_start_claims", RETIREMENT_FULL_COLUMNS.workspace_runtime_start_claims, []),
      retirementCopySection("approvals", RETIREMENT_FULL_COLUMNS.approvals, []),
      retirementCopySection("approval_execution_claims", RETIREMENT_FULL_COLUMNS.approval_execution_claims, []),
      retirementCopySection("agent_task_sessions", RETIREMENT_FULL_COLUMNS.agent_task_sessions, []),
      retirementCopySection("agent_wakeup_requests", RETIREMENT_FULL_COLUMNS.agent_wakeup_requests, []),
      retirementCopySection("issues", RETIREMENT_FULL_COLUMNS.issues, []),
      retirementCopySection("routines", RETIREMENT_FULL_COLUMNS.routines, []),
      retirementCopySection("routine_triggers", RETIREMENT_FULL_COLUMNS.routine_triggers, []),
      retirementCopySection("routine_runs", RETIREMENT_FULL_COLUMNS.routine_runs, []),
      retirementCopySection("routine_run_deliveries", RETIREMENT_FULL_COLUMNS.routine_run_deliveries, []),
      retirementCopySection("issue_watchdogs", RETIREMENT_FULL_COLUMNS.issue_watchdogs, []),
      retirementCopySection("issue_recovery_actions", RETIREMENT_FULL_COLUMNS.issue_recovery_actions, []),
      retirementCopySection("pipelines", RETIREMENT_FULL_COLUMNS.pipelines, []),
      retirementCopySection("pipeline_stages", RETIREMENT_FULL_COLUMNS.pipeline_stages, []),
      retirementCopySection("pipeline_cases", RETIREMENT_FULL_COLUMNS.pipeline_cases, []),
      retirementCopySection("environment_leases", RETIREMENT_FULL_COLUMNS.environment_leases, []),
      retirementCopySection("workspace_operations", RETIREMENT_FULL_COLUMNS.workspace_operations, []),
      retirementCopySection("companies", RETIREMENT_FULL_COLUMNS.companies, fullCompanyRows),
      retirementCopySection("company_secrets", RETIREMENT_FULL_COLUMNS.company_secrets, []),
      retirementCopySection("company_secret_versions", RETIREMENT_FULL_COLUMNS.company_secret_versions, []),
      retirementCopySection("company_secret_bindings", RETIREMENT_FULL_COLUMNS.company_secret_bindings, []),
      retirementCopySection("user_secret_declarations", RETIREMENT_FULL_COLUMNS.user_secret_declarations, []),
      retirementCopySection("company_skill_stars", RETIREMENT_FULL_COLUMNS.company_skill_stars, []),
      "",
    ].join("\n");
    const dump = writePrivateArtifact(
      path.join(backupRoot, `paperclip-${suffix}.sql.gz`),
      gzipSync(dumpSql),
      dumpCapturedAt,
    );
    const masterKeyBytes = Buffer.from("11".repeat(32), "hex");
    const masterKey = writePrivateArtifact(
      path.join(backupRoot, `master-${suffix}.key`),
      `${masterKeyBytes.toString("hex")}\n`,
      masterKeyCapturedAt,
    );
    const masterKeyFingerprintSha256 = createHash("sha256").update(masterKeyBytes).digest("hex");
    const tableNames = [
      "agent_api_keys",
      "agent_memberships",
      "agent_task_sessions",
      "agent_wakeup_requests",
      "agents",
      "approval_execution_claims",
      "approvals",
      "companies",
      "company_memberships",
      "company_secret_bindings",
      "company_secret_versions",
      "company_secrets",
      "company_skill_stars",
      "environment_leases",
      "goals",
      "heartbeat_runs",
      "issue_recovery_actions",
      "issue_watchdogs",
      "issues",
      "pipeline_cases",
      "pipeline_stages",
      "pipelines",
      "principal_permission_grants",
      "projects",
      "routine_run_deliveries",
      "routine_runs",
      "routine_triggers",
      "routines",
      "user_secret_declarations",
      "workspace_operations",
      "workspace_runtime_services",
      "workspace_runtime_start_claims",
    ];
    const retirementInventory = createRetirementRestoreInventory({
      sourceAgents: fullSourceRows,
      retainedAgents: fullRetainedRows,
      historicalTombstones: fullHistoricalTombstoneRows,
      companies: fullCompanyRows,
      activeApiKeys: retirementAccessRows.activeApiKeys,
      principalPermissionGrants: retirementAccessRows.principalPermissionGrants,
      activeCompanyMemberships: retirementAccessRows.activeCompanyMemberships,
      nonLeftAgentMemberships: retirementAccessRows.nonLeftAgentMemberships,
      agentSecretBindings: [],
      agentUserSecretDeclarations: [],
      agentSkillStars: [],
      historicalActiveApiKeys: [],
      historicalPrincipalPermissionGrants: [],
      historicalActiveCompanyMemberships: [],
      historicalNonLeftAgentMemberships: [],
      historicalAgentSecretBindings: [],
      historicalAgentUserSecretDeclarations: [],
      historicalAgentSkillStars: [],
      historicalActiveProjectLeads: [],
      historicalOperativeGoalOwnerships: [],
      historicalHeartbeatRuns: [],
      historicalWorkspaceRuntimeServices: [],
      historicalApprovals: [],
      historicalTaskSessions: [],
      historicalIssues: [],
      historicalRoutines: [],
      historicalRoutineTriggers: [],
      historicalRoutineRuns: [],
      approvalExecutionClaims: [],
      historicalWakeRequests: [],
      historicalActiveIssueWatchdogs: [],
      historicalActiveRecoveryActions: [],
      historicalPipelineAgentLeases: [],
      historicalActiveReportees: [],
      historicalActivePipelineApprovers: [],
      historicalActiveHireApprovalReferences: [],
      historicalEnvironmentLeases: [],
      historicalOutstandingEnvironmentLeases: [],
      historicalWorkspaceOperations: [],
      historicalRunningWorkspaceOperations: [],
      companySecrets: [],
      companySecretVersions: [],
      companySecretBindings: [],
    }, retirementAgentPartition(fullRetainedRows));
    const scratchState = {
      reviewedPrestateSha256: "9".repeat(64),
      companyCount: 4,
      retainedAgentCount: 33,
      historicalTombstoneCount: 2,
      lifecycleContractCount: 33,
      tableCount: tableNames.length,
      tableNamesSha256: stableSha256(tableNames),
      copiedTableCount: tableNames.length,
      copiedTableNamesSha256: stableSha256(tableNames),
      secretCount: 0,
      secretVersionCount: 0,
      secretBindingCount: 0,
      localEncryptedSecretCount: 0,
      localEncryptedVersionCount: 0,
      localEncryptedVersionProofCount: 0,
      localEncryptedVersionProofSha256: stableSha256({ versions: [] }),
      retirementInventory,
      masterKeyFingerprintSha256,
    };
    const restoreStateSha256 = stableSha256(scratchState);
    const restoreEvidenceValue = {
      schemaVersion: "1.0.0",
      strategy: "database_restore",
      issue: "TEC-355",
      restoreVerified: true,
      backup: {
        path: dump.path,
        sha256: dump.sha256,
        capturedAt: dump.capturedAt,
      },
      masterKeyBackup: {
        path: masterKey.path,
        sha256: masterKey.sha256,
        fingerprintSha256: masterKeyFingerprintSha256,
        capturedAt: masterKey.capturedAt,
      },
      reviewedPrestate: {
        capturedAt: sourceExport.capturedAt,
        sha256: scratchState.reviewedPrestateSha256,
        retainedAgentCount: scratchState.retainedAgentCount,
      },
      scratchRestore: {
        verifiedAt: restoreVerifiedAt,
        companyCount: scratchState.companyCount,
        retainedAgentCount: scratchState.retainedAgentCount,
        historicalTombstoneCount: scratchState.historicalTombstoneCount,
        lifecycleContractCount: scratchState.lifecycleContractCount,
        tableCount: scratchState.tableCount,
        tableNamesSha256: scratchState.tableNamesSha256,
        copiedTableCount: scratchState.copiedTableCount,
        copiedTableNamesSha256: scratchState.copiedTableNamesSha256,
        secretCount: scratchState.secretCount,
        secretVersionCount: scratchState.secretVersionCount,
        secretBindingCount: scratchState.secretBindingCount,
        masterKeyFingerprintSha256,
        localEncryptedSecretCount: scratchState.localEncryptedSecretCount,
        localEncryptedVersionCount: scratchState.localEncryptedVersionCount,
        localEncryptedVersionProofCount: scratchState.localEncryptedVersionProofCount,
        localEncryptedVersionProofSha256: scratchState.localEncryptedVersionProofSha256,
        retirementInventory,
        stateSha256: restoreStateSha256,
      },
    };
    const restoreEvidence = writePrivateArtifact(
      path.join(retirementEvidenceRoot, `restore-${suffix}.json`),
      `${JSON.stringify(restoreEvidenceValue)}\n`,
      restoreVerifiedAt,
    );
    return {
      sourceExport: {
        sourceAgentId,
        path: sourceExport.path,
        sha256: sourceExport.sha256,
        sizeBytes: sourceExport.sizeBytes,
        capturedAt: sourceExport.capturedAt,
      },
      backupRestore: {
        dumpPath: dump.path,
        dumpSha256: dump.sha256,
        dumpSizeBytes: dump.sizeBytes,
        dumpCapturedAt: dump.capturedAt,
        masterKeyBackupPath: masterKey.path,
        masterKeyBackupSha256: masterKey.sha256,
        masterKeyBackupSizeBytes: masterKey.sizeBytes,
        masterKeyFingerprintSha256,
        masterKeyCapturedAt: masterKey.capturedAt,
        restoreEvidencePath: restoreEvidence.path,
        restoreEvidenceSha256: restoreEvidence.sha256,
        restoreEvidenceSizeBytes: restoreEvidence.sizeBytes,
        restoreVerifiedAt,
        restoreStateSha256,
      },
    };
  }

  function evidence(overrides: Partial<AgentRetirementEvidence> = {}): AgentRetirementEvidence {
    const artifacts = artifactEvidence();
    const approvalBinding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: artifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: artifacts.backupRestore.restoreEvidenceSha256,
    };
    return {
      schemaVersion: "1.0.0",
      source: {
        sourceAgentId: SOURCE_ID,
        companyId: COMPANY_ID,
        decision: "terminate",
        physicalDelete: false,
      },
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      sourceExport: artifacts.sourceExport,
      backupRestore: artifacts.backupRestore,
      replacement: {
        replacementAgentId: REPLACEMENT_ID,
        replacementSystemRef: null,
        canaryAgentId: REPLACEMENT_ID,
        canaryIssueId: CANARY_ISSUE_ID,
        canaryRunId: CANARY_RUN_ID,
        configFingerprint: CONFIG_FINGERPRINT,
      },
      humanGate: {
        issueIdentifier: "TEC-355",
        issueId: DECISION_ISSUE_ID,
        commentId: HUMAN_COMMENT_ID,
        approvedAt: APPROVED_AT,
        ...approvalBinding,
        approvedTextSha256: sha256(approvalText(approvalBinding)),
      },
      ...overrides,
    };
  }

  function recoveryEvidence(base: AgentRetirementEvidence): AgentRetirementEvidence {
    const artifacts = artifactEvidence(SOURCE_ID, COMPANY_ID, "Calendar und Events Butler", {
      sourceExportCapturedAt: "2026-07-13T16:11:00.000Z",
      masterKeyCapturedAt: "2026-07-13T16:11:30.000Z",
      dumpCapturedAt: "2026-07-13T16:12:00.000Z",
      restoreVerifiedAt: "2026-07-13T16:13:00.000Z",
      pathSuffix: "-recovery",
      freshRecoveryReview: true,
    });
    const approvalBinding = {
      approvalNonce: "d".repeat(64),
      manifestSha256: MANIFEST_SHA256,
      backupSha256: artifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: artifacts.backupRestore.restoreEvidenceSha256,
    };
    return {
      ...base,
      sourceExport: artifacts.sourceExport,
      backupRestore: artifacts.backupRestore,
      humanGate: {
        issueIdentifier: "TEC-355",
        issueId: DECISION_ISSUE_ID,
        commentId: RECOVERY_COMMENT_ID,
        approvedAt: "2026-07-13T16:14:00.000Z",
        ...approvalBinding,
        approvedTextSha256: sha256(approvalText(approvalBinding)),
      },
    };
  }

  function fullPlanEvidence(
    primary: AgentRetirementEvidence,
    sourceIds: readonly string[] = LEGACY_SINGLE_WAVE[0]!,
  ) {
    return Object.fromEntries(AGENT_RETIREMENT_ALLOWLIST_ENTRIES
      .filter((entry) => sourceIds.includes(entry.sourceAgentId))
      .map((entry) => {
        if (entry.sourceAgentId === primary.source.sourceAgentId) {
          return [entry.sourceAgentId, structuredClone(primary)];
        }
        const sourceArtifacts = artifactEvidence(
          entry.sourceAgentId,
          entry.companyId,
          entry.sourceName,
          {
            sourceExportCapturedAt: primary.sourceExport.capturedAt,
            masterKeyCapturedAt: primary.backupRestore.masterKeyCapturedAt,
            dumpCapturedAt: primary.backupRestore.dumpCapturedAt,
            restoreVerifiedAt: primary.backupRestore.restoreVerifiedAt,
          },
        );
        const canary = portfolioCanaryContract(entry.canaryAgentId);
        return [entry.sourceAgentId, {
          ...structuredClone(primary),
          source: {
            sourceAgentId: entry.sourceAgentId,
            companyId: entry.companyId,
            decision: "terminate" as const,
            physicalDelete: false as const,
          },
          sourceExport: sourceArtifacts.sourceExport,
          backupRestore: structuredClone(primary.backupRestore),
          replacement: {
            replacementAgentId: entry.replacementAgentId,
            replacementSystemRef: entry.replacementSystemRef,
            canaryAgentId: entry.canaryAgentId,
            canaryIssueId: canary.issueId,
            canaryRunId: canary.runId,
            configFingerprint: CONFIG_FINGERPRINT,
            ...(entry.replacementSystemRef !== null
              ? { systemCanaryReceiptSha256: stableSha256(baristaSystemReceipt({
                  runId: canary.runId,
                  issueId: canary.issueId,
                })) }
              : {}),
          },
        } satisfies AgentRetirementEvidence];
      }));
  }

  async function seedFreshRecoveryReview(input: AgentRetirementEvidence) {
    await db.insert(issueComments).values({
      id: RECOVERY_COMMENT_ID,
      companyId: COMPANY_ID,
      issueId: DECISION_ISSUE_ID,
      authorUserId: "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B",
      authorType: "user",
      body: approvalText(input.humanGate),
      createdAt: new Date(input.humanGate.approvedAt),
    });
    await db.update(agents).set({
      metadata: {
        lifecycle: {
          ...lifecycle(),
          lastCanaryAt: "2026-07-13T16:15:00.000Z",
        },
        lifecycleGate: {
          ...lifecycleGate(),
          validatedAt: "2026-07-13T16:15:00.000Z",
          expiresAt: "2026-07-13T16:45:00.000Z",
        },
      },
    }).where(eq(agents.id, REPLACEMENT_ID));
  }

  async function seedReadyPortfolio() {
    const approvedEvidence = evidence();
    const companyRows = retirementFullCompanyRows();
    const sourceRows = retirementFullSourceRows();
    const retainedRows = retirementFullRetainedRows();
    const historicalTombstoneRows = retirementFullHistoricalTombstoneRows();
    await db.insert(companies).values(companyRows.map((row) => ({
      ...row,
      pausedAt: row.pausedAt ? new Date(row.pausedAt) : null,
      feedbackDataSharingConsentAt: row.feedbackDataSharingConsentAt
        ? new Date(row.feedbackDataSharingConsentAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    })));
    await db.insert(agents).values([...sourceRows, ...retainedRows, ...historicalTombstoneRows].map((row) => ({
      ...row,
      pausedAt: row.pausedAt ? new Date(row.pausedAt) : null,
      lastHeartbeatAt: row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    })));
    const canaryRows = retainedRows.filter((row) => (
      AGENT_RETIREMENT_ALLOWLIST_ENTRIES.some((entry) => entry.canaryAgentId === row.id)
    ));
    await db.insert(heartbeatRuns).values(canaryRows.map((row) => {
      const contract = portfolioCanaryContract(row.id);
      const systemEntry = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => (
        entry.canaryAgentId === row.id && entry.replacementSystemRef !== null
      ));
      return {
        id: contract.runId,
        companyId: row.companyId,
        agentId: row.id,
        status: "succeeded",
        invocationSource: "lifecycle_canary",
        contextSnapshot: {
          issueId: contract.issueId,
          taskId: contract.issueId,
          taskKey: `lifecycle-canary:${contract.issueId}`,
          lifecycleCanary: {
            agentId: row.id,
            companyId: row.companyId,
            canaryIssueId: contract.issueId,
            runId: contract.runId,
            configFingerprint: CONFIG_FINGERPRINT,
            receiptHash: lifecycleGate().receiptHash,
            ...(systemEntry ? { systemReplacementReceipt: baristaSystemReceipt({
              runId: contract.runId,
              issueId: contract.issueId,
            }) } : {}),
          },
        },
        startedAt: new Date("2026-07-13T10:04:00.000Z"),
        finishedAt: new Date("2026-07-13T10:05:00.000Z"),
      };
    }));
    await db.insert(issues).values([
      {
        id: DECISION_ISSUE_ID,
        companyId: COMPANY_ID,
        title: "Agent portfolio audit",
        identifier: "TEC-355",
        status: "in_progress",
      },
      ...canaryRows.map((row) => {
        const contract = portfolioCanaryContract(row.id);
        return {
          id: contract.issueId,
          companyId: row.companyId,
          title: `Replacement canary ${row.id}`,
          status: "done",
          assigneeAgentId: row.id,
          executionRunId: null,
        };
      }),
    ]);
    await db.insert(issueComments).values({
      id: HUMAN_COMMENT_ID,
      companyId: COMPANY_ID,
      issueId: DECISION_ISSUE_ID,
      authorUserId: "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B",
      authorType: "user",
      body: approvalText(approvedEvidence.humanGate),
      createdAt: new Date(APPROVED_AT),
    });
  }

  async function seedReadyVariant(input: {
    sourceId: string;
    sourceCompanyId: string;
    sourceCompanyName: string;
    sourceName: string;
    replacementId: string;
    replacementCompanyId: string;
    replacementCompanyName: string;
    replacementName: string;
    canaryDescription?: string;
  }) {
    const approvedEvidence = variantEvidence({
      sourceId: input.sourceId,
      sourceCompanyId: input.sourceCompanyId,
      sourceName: input.sourceName,
      replacementAgentId: input.replacementId,
      replacementSystemRef: null,
      canaryAgentId: input.replacementId,
    });
    await db.insert(companies).values([
      {
        id: input.sourceCompanyId,
        name: input.sourceCompanyName,
        issuePrefix: "SRC",
        requireBoardApprovalForNewAgents: false,
      },
      ...(input.replacementCompanyId === input.sourceCompanyId ? [] : [{
        id: input.replacementCompanyId,
        name: input.replacementCompanyName,
        issuePrefix: "RPL",
        requireBoardApprovalForNewAgents: false,
      }]),
    ]);
    await db.insert(agents).values([
      {
        id: input.sourceId,
        companyId: input.sourceCompanyId,
        name: input.sourceName,
        role: "general",
        status: "paused",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        updatedAt: new Date(SOURCE_UPDATED_AT),
      },
      {
        id: input.replacementId,
        companyId: input.replacementCompanyId,
        name: input.replacementName,
        role: "general",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: { lifecycle: lifecycle(), lifecycleGate: lifecycleGate() },
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: CANARY_RUN_ID,
      companyId: input.replacementCompanyId,
      agentId: input.replacementId,
      status: "succeeded",
      invocationSource: "lifecycle_canary",
      contextSnapshot: {
        issueId: CANARY_ISSUE_ID,
        taskId: CANARY_ISSUE_ID,
        taskKey: `lifecycle-canary:${CANARY_ISSUE_ID}`,
        lifecycleCanary: {
          agentId: input.replacementId,
          companyId: input.replacementCompanyId,
          canaryIssueId: CANARY_ISSUE_ID,
          runId: CANARY_RUN_ID,
          configFingerprint: CONFIG_FINGERPRINT,
          receiptHash: lifecycleGate().receiptHash,
        },
      },
      startedAt: new Date("2026-07-13T10:04:00.000Z"),
      finishedAt: new Date("2026-07-13T10:05:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: DECISION_ISSUE_ID,
        companyId: input.sourceCompanyId,
        title: "Agent portfolio audit",
        identifier: "TEC-355",
        status: "in_progress",
      },
      {
        id: CANARY_ISSUE_ID,
        companyId: input.replacementCompanyId,
        title: "Replacement canary",
        description: input.canaryDescription ?? null,
        status: "done",
        assigneeAgentId: input.replacementId,
        executionRunId: null,
      },
    ]);
    await db.insert(issueComments).values({
      id: HUMAN_COMMENT_ID,
      companyId: input.sourceCompanyId,
      issueId: DECISION_ISSUE_ID,
      authorUserId: "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B",
      authorType: "user",
      body: approvalText(approvedEvidence.humanGate),
      createdAt: new Date(APPROVED_AT),
    });
  }

  function variantEvidence(input: {
    sourceId: string;
    sourceCompanyId: string;
    sourceName: string;
    replacementAgentId: string | null;
    replacementSystemRef: string | null;
    canaryAgentId: string;
  }): AgentRetirementEvidence {
    const artifacts = artifactEvidence(input.sourceId, input.sourceCompanyId, input.sourceName);
    const approvalBinding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: artifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: artifacts.backupRestore.restoreEvidenceSha256,
    };
    return evidence({
      source: {
        sourceAgentId: input.sourceId,
        companyId: input.sourceCompanyId,
        decision: "terminate",
        physicalDelete: false,
      },
      sourceExport: artifacts.sourceExport,
      backupRestore: artifacts.backupRestore,
      humanGate: {
        issueIdentifier: "TEC-355",
        issueId: DECISION_ISSUE_ID,
        commentId: HUMAN_COMMENT_ID,
        approvedAt: APPROVED_AT,
        ...approvalBinding,
        approvedTextSha256: sha256(approvalText(approvalBinding)),
      },
      replacement: {
        ...evidence().replacement,
        replacementAgentId: input.replacementAgentId,
        replacementSystemRef: input.replacementSystemRef,
        canaryAgentId: input.canaryAgentId,
        systemCanaryReceiptSha256: input.replacementSystemRef
          ? stableSha256(baristaSystemReceipt())
          : undefined,
      },
    });
  }

  function service() {
    return agentRetirementService(db, {
      now: () => new Date(NOW),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
    });
  }

  function retirementPlan(
    input: AgentRetirementEvidence,
    validatedAt = NOW,
    evidenceBySourceId = fullPlanEvidence(input),
    planScope: { sourceIds: readonly string[]; manifestSha256: string } = {
      sourceIds: LEGACY_SINGLE_WAVE[0]!,
      manifestSha256: MANIFEST_SHA256,
    },
  ) {
    const restoreReceipt = JSON.parse(fs.readFileSync(input.backupRestore.restoreEvidencePath, "utf8"));
    const scratch = restoreReceipt.scratchRestore;
    const inventory = {
      tableCount: scratch.tableCount,
      tableNamesSha256: scratch.tableNamesSha256,
      copiedTableCount: scratch.copiedTableCount,
      copiedTableNamesSha256: scratch.copiedTableNamesSha256,
      retirementInventory: scratch.retirementInventory,
    };
    const core = {
      schemaVersion: "1.0.0",
      kind: "paperclip_retirement_plan",
      manifestFingerprint: `v1:sha256:${planScope.manifestSha256}`,
      sourceIds: [...planScope.sourceIds].sort(),
      evidenceSha256: stableSha256(evidenceBySourceId),
      approvalCommentId: input.humanGate.commentId,
      approvalFingerprint: `v1:sha256:${stableSha256(input.humanGate)}`,
      validatedAt: validatedAt.toISOString(),
      expiresAt: new Date(validatedAt.getTime() + 6 * 60 * 60 * 1_000).toISOString(),
      commonArtifactFingerprint: `v1:sha256:${stableSha256({
        schemaVersion: "1.0.0",
        binding: input.backupRestore,
        inventory,
        restoredStateSha256: input.backupRestore.restoreStateSha256,
      })}`,
    };
    return { ...core, receiptId: `v1:sha256:${stableSha256(core)}` };
  }

  function claimPreflight(input: AgentRetirementEvidence, executionClaimReceiptId: string | null = null) {
    const evidenceBySourceId = executionClaimReceiptId === null ? fullPlanEvidence(input) : null;
    return {
      evidence: input,
      plan: retirementPlan(input, NOW, evidenceBySourceId ?? fullPlanEvidence(input)),
      evidenceBySourceId,
      claimExecution: executionClaimReceiptId === null,
      executionClaimReceiptId,
    };
  }

  function claimedCleanup(
    input: AgentRetirementEvidence,
    initial: Record<string, any>,
  ) {
    return {
      evidence: input,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: initial.executionClaimReceiptId,
      preflightFingerprint: initial.fingerprint,
    };
  }

  function recoveryRequestReceipt(
    planClaimReceiptId: string,
    executionClaimReceiptId: string | null,
    input: AgentRetirementEvidence,
  ) {
    const evidenceReceipt = `v1:sha256:${stableSha256({
      kind: "agent_retirement_evidence",
      evidence: input,
    })}`;
    return `v1:sha256:${stableSha256({
      kind: "agent_retirement_execution_recovery_request",
      planClaimReceiptId,
      sourceId: SOURCE_ID,
      previousExecutionClaimReceiptId: executionClaimReceiptId,
      evidenceFingerprint: evidenceReceipt,
    })}`;
  }

  it("returns a stable zero-blocker read-only preflight", async () => {
    await seedReadyPortfolio();
    const before = await db.select().from(agents).where(eq(agents.id, SOURCE_ID));
    const first = await service().preflight(SOURCE_ID, evidence());
    const second = await service().preflight(SOURCE_ID, evidence());
    const uppercase = await service().preflight(SOURCE_ID.toUpperCase(), evidence());

    expect(first).toEqual(second);
    expect(uppercase).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      cleanupEligible: true,
      blockers: [],
      dependencyCounts: {
        nonterminalIssues: 0,
        activeRuns: 0,
        activeWakeups: 0,
        activeRoutines: 0,
        enabledTriggers: 0,
        activeProjectLeads: 0,
        operativeGoals: 0,
        activeRuntimeServices: 0,
        pendingApprovals: 0,
        activeIssueWatchdogs: 0,
        activeRecoveryActions: 0,
        unclearedPipelineAgentLeases: 0,
        activePipelineApprovers: 0,
        activeHireApprovalReferences: 0,
        outstandingEnvironmentLeases: 0,
        runningWorkspaceOperations: 0,
        liveDescendants: 0,
        activeApiKeys: 0,
        principalPermissionGrants: 0,
        companyMemberships: 0,
        agentMemberships: 0,
      },
    });
    expect(first.fingerprint).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(await db.select().from(agents).where(eq(agents.id, SOURCE_ID))).toEqual(before);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("accepts the exact cross-company Hermes replacement canary in the replacement company", async () => {
    await seedReadyVariant({
      sourceId: HERMES_SOURCE_ID,
      sourceCompanyId: HERMES_SOURCE_COMPANY_ID,
      sourceCompanyName: "HAPPYGANG",
      sourceName: "Hermes",
      replacementId: HERMES_REPLACEMENT_ID,
      replacementCompanyId: TECHOPS_COMPANY_ID,
      replacementCompanyName: "TechOps",
      replacementName: "Hermes OpenClaw Maintainer",
    });
    const response = await service().preflight(HERMES_SOURCE_ID, variantEvidence({
      sourceId: HERMES_SOURCE_ID,
      sourceCompanyId: HERMES_SOURCE_COMPANY_ID,
      sourceName: "Hermes",
      replacementAgentId: HERMES_REPLACEMENT_ID,
      replacementSystemRef: null,
      canaryAgentId: HERMES_REPLACEMENT_ID,
    }));

    expect(response.ok).toBe(true);
    expect(response.blockers).toEqual([]);
  });

  it("binds the Home Barista system replacement to the explicit Chief of Home Ops canary", async () => {
    await seedReadyPortfolio();
    const expected = fullPlanEvidence(evidence())[BARISTA_SOURCE_ID]!;
    const canary = portfolioCanaryContract(HOME_OPS_ID);
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId: canary.issueId,
        taskId: canary.issueId,
        taskKey: `lifecycle-canary:${canary.issueId}`,
        lifecycleCanary: {
          agentId: HOME_OPS_ID,
          companyId: COMPANY_ID,
          canaryIssueId: canary.issueId,
          runId: canary.runId,
          configFingerprint: CONFIG_FINGERPRINT,
          receiptHash: lifecycleGate().receiptHash,
        },
      },
    }).where(eq(heartbeatRuns.id, canary.runId));
    const wrong = {
      ...expected,
      replacement: { ...expected.replacement, canaryAgentId: REPLACEMENT_ID },
    };

    expect((await service().preflight(BARISTA_SOURCE_ID, wrong)).blockers.map((blocker) => blocker.code))
      .toContain("source_not_allowlisted");
    expect((await service().preflight(BARISTA_SOURCE_ID, expected)).blockers.map((blocker) => blocker.code))
      .toContain("replacement_system_canary_invalid");

    await db.update(issues).set({
      description: `${BARISTA_SYSTEM_CANARY_MARKER}\nRead-only verification of the workspace coffee project binding.`,
    }).where(eq(issues.id, canary.issueId));
    expect((await service().preflight(BARISTA_SOURCE_ID, expected)).blockers.map((blocker) => blocker.code))
      .toContain("replacement_system_canary_invalid");
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId: canary.issueId,
        taskId: canary.issueId,
        taskKey: `lifecycle-canary:${canary.issueId}`,
        lifecycleCanary: {
          agentId: HOME_OPS_ID,
          companyId: COMPANY_ID,
          canaryIssueId: canary.issueId,
          runId: canary.runId,
          configFingerprint: CONFIG_FINGERPRINT,
          receiptHash: lifecycleGate().receiptHash,
          systemReplacementReceipt: baristaSystemReceipt({
            runId: canary.runId,
            issueId: canary.issueId,
          }),
        },
      },
    }).where(eq(heartbeatRuns.id, canary.runId));
    expect(await service().preflight(BARISTA_SOURCE_ID, expected)).toMatchObject({ ok: true, blockers: [] });

    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
    });
    const initialRequest = claimPreflight(expected);
    const initial = await claimed.preflight(BARISTA_SOURCE_ID, initialRequest as any);
    expect(initial).toMatchObject({ ok: true, claimState: "started" });
    clock = new Date(NOW.getTime() + 50 * 60 * 1_000);
    const cleanup = await claimed.cleanup(BARISTA_SOURCE_ID, claimedCleanup(expected, initial) as any);
    const final = await claimed.preflight(
      BARISTA_SOURCE_ID,
      {
        ...initialRequest,
        evidenceBySourceId: null,
        claimExecution: false,
        executionClaimReceiptId: initial.executionClaimReceiptId,
      } as any,
    );
    expect(final.blockers).toEqual([]);
    expect(final).toMatchObject({ ok: true, claimState: "termination_ready" });
    await expect(claimed.terminateAuthorized(BARISTA_SOURCE_ID, {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: final.fingerprint,
      expectedUpdatedAt: expected.expectedUpdatedAt,
      humanGate: expected.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId!,
      executionClaimReceiptId: initial.executionClaimReceiptId!,
    })).resolves.toMatchObject({ agent: { id: BARISTA_SOURCE_ID, status: "terminated" } });
  });

  const dependencyCases: Array<[string, (db: ReturnType<typeof createDb>) => Promise<void>]> = [
    ["nonterminal_issue", async (target) => {
      await target.insert(issues).values({ companyId: COMPANY_ID, title: "Open", status: "todo", assigneeAgentId: SOURCE_ID });
    }],
    ["active_run", async (target) => {
      await target.insert(heartbeatRuns).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, status: "scheduled_retry", invocationSource: "retry" });
    }],
    ["active_run", async (target) => {
      await target.insert(heartbeatRuns).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, status: "orphan_process", invocationSource: "orphan" });
    }],
    ["active_wakeup", async (target) => {
      await target.insert(agentWakeupRequests).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, source: "test", status: "deferred_issue_execution" });
    }],
    ["active_routine", async (target) => {
      await target.insert(routines).values({ companyId: COMPANY_ID, title: "Active", status: "active", assigneeAgentId: SOURCE_ID });
    }],
    ["enabled_trigger", async (target) => {
      const routineId = randomUUID();
      await target.insert(routines).values({ id: routineId, companyId: COMPANY_ID, title: "Archived", status: "archived", assigneeAgentId: SOURCE_ID });
      await target.insert(routineTriggers).values({ companyId: COMPANY_ID, routineId, kind: "schedule", enabled: true });
    }],
    ["active_project_lead", async (target) => {
      await target.insert(projects).values({ companyId: COMPANY_ID, name: "Owned", status: "active", leadAgentId: SOURCE_ID });
    }],
    ["operative_goal_owner", async (target) => {
      await target.insert(goals).values({ companyId: COMPANY_ID, title: "Operative", status: "active", ownerAgentId: SOURCE_ID });
    }],
    ["active_runtime_service_owner", async (target) => {
      await target.insert(workspaceRuntimeServices).values({
        id: randomUUID(),
        companyId: COMPANY_ID,
        scopeType: "company",
        serviceName: "source-owned-service",
        status: "running",
        lifecycle: "ephemeral",
        provider: "local_process",
        ownerAgentId: SOURCE_ID,
      });
    }],
    ["pending_approval_requester", async (target) => {
      await target.insert(approvals).values({
        companyId: COMPANY_ID,
        type: "test",
        requestedByAgentId: SOURCE_ID,
        status: "pending",
        payload: {},
      });
    }],
    ["active_issue_watchdog", async (target) => {
      const issueId = randomUUID();
      await target.insert(issues).values({ id: issueId, companyId: COMPANY_ID, title: "Watched", status: "done" });
      await target.insert(issueWatchdogs).values({
        companyId: COMPANY_ID,
        issueId,
        watchdogAgentId: SOURCE_ID,
        status: "active",
      });
    }],
    ["active_recovery_action_owner", async (target) => {
      const issueId = randomUUID();
      await target.insert(issues).values({ id: issueId, companyId: COMPANY_ID, title: "Recover", status: "done" });
      await target.insert(issueRecoveryActions).values({
        companyId: COMPANY_ID,
        sourceIssueId: issueId,
        kind: "reassign",
        status: "active",
        ownerAgentId: SOURCE_ID,
        cause: "test",
        fingerprint: "test-fingerprint",
        nextAction: "review",
      });
    }],
    ["active_pipeline_approver", async (target) => {
      const [pipeline] = await target.insert(pipelines).values({
        companyId: TECHOPS_COMPANY_ID,
        key: `cross-company-${randomUUID()}`,
        name: "Cross-company approval",
      }).returning();
      await target.insert(pipelineStages).values({
        pipelineId: pipeline!.id,
        key: "review",
        name: "Review",
        kind: "review",
        position: 1,
        config: { requireApproval: true, approver: { kind: "agent", id: SOURCE_ID.toUpperCase() } },
      });
    }],
    ["active_hire_approval_reference", async (target) => {
      await target.insert(approvals).values({
        companyId: TECHOPS_COMPANY_ID,
        type: "hire_agent",
        status: "pending",
        payload: { reportsTo: SOURCE_ID.toUpperCase() },
      });
    }],
    ["live_descendant", async (target) => {
      await target.insert(agents).values({ companyId: COMPANY_ID, name: "Child", role: "general", status: "idle", reportsTo: SOURCE_ID, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    }],
    ["active_api_key", async (target) => {
      await target.insert(agentApiKeys).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, name: "live", keyHash: sha256("key") });
    }],
    ["principal_permission_grant", async (target) => {
      await target.insert(principalPermissionGrants).values({ companyId: COMPANY_ID, principalType: "agent", principalId: SOURCE_ID, permissionKey: "tasks:assign" });
    }],
    ["company_membership", async (target) => {
      await target.insert(companyMemberships).values({ companyId: COMPANY_ID, principalType: "agent", principalId: SOURCE_ID, status: "active" });
    }],
    ["agent_membership", async (target) => {
      await target.insert(agentMemberships).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, userId: "better-auth:marco", state: "joined" });
    }],
  ];

  for (const [code, seed] of dependencyCases) {
    it(`reports ${code} without mutating it`, async () => {
      await seedReadyPortfolio();
      await seed(db);
      const response = await service().preflight(SOURCE_ID, evidence());
      expect(response.blockers.map((blocker) => blocker.code)).toContain(code);
      expect(response.ok).toBe(false);
    });
  }

  it("finds a cross-company live descendant through a terminated intermediary", async () => {
    await seedReadyPortfolio();
    const intermediaryId = randomUUID();
    await db.insert(agents).values({
      id: intermediaryId,
      companyId: COMPANY_ID,
      name: "Terminated intermediary",
      role: "general",
      status: "terminated",
      reportsTo: SOURCE_ID,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      companyId: TECHOPS_COMPANY_ID,
      name: "Cross-company live descendant",
      role: "general",
      status: "idle",
      reportsTo: intermediaryId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const response = await service().preflight(SOURCE_ID, evidence());
    expect(response.blockers.map((blocker) => blocker.code)).toContain("live_descendant");
    expect(response.dependencyCounts.liveDescendants).toBe(1);
  });

  it("blocks cleanup on any domain dependency and leaves access artifacts live", async () => {
    await seedReadyPortfolio();
    await db.insert(issues).values({ companyId: COMPANY_ID, title: "Open", status: "todo", assigneeAgentId: SOURCE_ID });
    await db.insert(agentApiKeys).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, name: "live", keyHash: sha256("key") });
    const input = evidence();
    const preflight = await service().preflight(SOURCE_ID, claimPreflight(input) as any);

    await expect(service().cleanup(SOURCE_ID, {
      evidence: input,
      planClaimReceiptId: `v1:sha256:${"1".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"2".repeat(64)}`,
      preflightFingerprint: preflight.fingerprint,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_execution_claim_missing" },
    });
    expect((await db.select().from(agentApiKeys))[0]?.revokedAt).toBeNull();
  });

  async function seedAccessArtifacts(options: { uppercaseTextRefs?: boolean } = {}) {
    const textPrincipalId = options.uppercaseTextRefs ? SOURCE_ID.toUpperCase() : SOURCE_ID;
    retirementAccessRows = {
      activeApiKeys: [{
        id: "b1000000-0000-4000-8000-000000000001", agentId: SOURCE_ID,
        companyId: COMPANY_ID, name: "live", keyHash: sha256("key"), responsibleUserId: null,
        scopeConfig: null, lastUsedAt: null, revokedAt: null, createdAt: RETIREMENT_FULL_ROW_TIME,
      }],
      principalPermissionGrants: [{
        id: "b2000000-0000-4000-8000-000000000001", companyId: COMPANY_ID,
        principalType: "agent", principalId: textPrincipalId, permissionKey: "tasks:assign",
        scope: null, grantedByUserId: null, createdAt: RETIREMENT_FULL_ROW_TIME,
        updatedAt: RETIREMENT_FULL_ROW_TIME,
      }],
      activeCompanyMemberships: [{
        id: "b3000000-0000-4000-8000-000000000001", companyId: COMPANY_ID,
        principalType: "agent", principalId: textPrincipalId, status: "active", membershipRole: null,
        createdAt: RETIREMENT_FULL_ROW_TIME, updatedAt: RETIREMENT_FULL_ROW_TIME,
      }],
      nonLeftAgentMemberships: [{
        id: "b4000000-0000-4000-8000-000000000001", companyId: COMPANY_ID,
        agentId: SOURCE_ID, userId: "better-auth:marco", state: "joined", starredAt: null,
        createdAt: RETIREMENT_FULL_ROW_TIME, updatedAt: RETIREMENT_FULL_ROW_TIME,
      }],
    };
    const key = retirementAccessRows.activeApiKeys[0]!;
    const grant = retirementAccessRows.principalPermissionGrants[0]!;
    const companyMembership = retirementAccessRows.activeCompanyMemberships[0]!;
    const agentMembership = retirementAccessRows.nonLeftAgentMemberships[0]!;
    await db.insert(agentApiKeys).values({
      ...(key as any), createdAt: new Date(String(key.createdAt)),
    });
    await db.insert(principalPermissionGrants).values({
      ...(grant as any), createdAt: new Date(String(grant.createdAt)),
      updatedAt: new Date(String(grant.updatedAt)),
    });
    await db.insert(companyMemberships).values({
      ...(companyMembership as any), createdAt: new Date(String(companyMembership.createdAt)),
      updatedAt: new Date(String(companyMembership.updatedAt)),
    });
    await db.insert(agentMemberships).values({
      ...(agentMembership as any), createdAt: new Date(String(agentMembership.createdAt)),
      updatedAt: new Date(String(agentMembership.updatedAt)),
    });
    const rebound = evidence();
    await db.update(issueComments).set({
      body: approvalText(rebound.humanGate),
    }).where(eq(issueComments.id, HUMAN_COMMENT_ID));
  }

  async function seedHistoricalAttribution() {
    const issueId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: COMPANY_ID, title: "Historical", status: "done", assigneeAgentId: SOURCE_ID, createdByAgentId: SOURCE_ID });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: COMPANY_ID, agentId: SOURCE_ID, source: "historical", status: "timed_out" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: COMPANY_ID, agentId: SOURCE_ID, status: "succeeded", invocationSource: "historical", wakeupRequestId: wakeId });
    await db.insert(agentTaskSessions).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, adapterType: "codex_local", taskKey: "historical", lastRunId: runId });
    await db.insert(issueComments).values({ companyId: COMPANY_ID, issueId, authorAgentId: SOURCE_ID, authorType: "agent", body: "Historical comment" });
    await db.insert(costEvents).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, issueId, heartbeatRunId: runId, provider: "openai", model: "gpt-test", costCents: 1, occurredAt: new Date("2026-07-12T10:00:00.000Z") });
    await db.insert(agentConfigRevisions).values({ companyId: COMPANY_ID, agentId: SOURCE_ID, source: "historical", changedKeys: ["name"], beforeConfig: { name: "Before" }, afterConfig: { name: "After" } });
    await db.insert(activityLog).values({ companyId: COMPANY_ID, actorType: "agent", actorId: SOURCE_ID, action: "historical.action", entityType: "agent", entityId: SOURCE_ID, agentId: SOURCE_ID, details: { preserved: true } });
  }

  it("cleanup changes only live access artifacts and preserves historical attribution plus the source row", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    await seedHistoricalAttribution();
    const sourceBefore = (await db.select().from(agents).where(eq(agents.id, SOURCE_ID)))[0];
    const historyBefore = {
      issues: await db.select().from(issues).where(eq(issues.assigneeAgentId, SOURCE_ID)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, SOURCE_ID)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, SOURCE_ID)),
      sessions: await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, SOURCE_ID)),
      comments: await db.select().from(issueComments).where(eq(issueComments.authorAgentId, SOURCE_ID)),
      costs: await db.select().from(costEvents).where(eq(costEvents.agentId, SOURCE_ID)),
      revisions: await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, SOURCE_ID)),
    };
    const input = evidence();
    const preflight = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    expect(preflight.blockers.map((blocker) => blocker.code).sort()).toEqual([
      "active_api_key", "agent_membership", "company_membership", "principal_permission_grant",
    ]);
    expect(preflight.cleanupEligible).toBe(true);
    expect(preflight.blockers.every((blocker) => blocker.cleanupEligible)).toBe(true);

    const receipt = await service().cleanup(SOURCE_ID, claimedCleanup(input, preflight) as any);
    expect(receipt).toMatchObject({
      ok: true,
      revokedKeyCount: 1,
      deletedGrantCount: 1,
      deactivatedCompanyMembershipCount: 1,
      deletedAgentMembershipCount: 1,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
    });
    expect(receipt.receiptId).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect((await db.select().from(agentApiKeys))[0]?.revokedAt).toBeInstanceOf(Date);
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    expect(await db.select().from(agentMemberships)).toHaveLength(0);
    expect((await db.select().from(agents).where(eq(agents.id, SOURCE_ID)))[0]).toEqual(sourceBefore);
    expect(await db.select().from(issues).where(eq(issues.assigneeAgentId, SOURCE_ID))).toEqual(historyBefore.issues);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, SOURCE_ID))).toEqual(historyBefore.runs);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, SOURCE_ID))).toEqual(historyBefore.wakes);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, SOURCE_ID))).toEqual(historyBefore.sessions);
    expect(await db.select().from(issueComments).where(eq(issueComments.authorAgentId, SOURCE_ID))).toEqual(historyBefore.comments);
    expect(await db.select().from(costEvents).where(eq(costEvents.agentId, SOURCE_ID))).toEqual(historyBefore.costs);
    expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, SOURCE_ID))).toEqual(historyBefore.revisions);
  });

  it("round-trips and cleans uppercase text UUID grants and memberships", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts({ uppercaseTextRefs: true });
    const input = evidence();
    const preflight = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    expect(preflight.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "principal_permission_grant",
      "company_membership",
    ]));

    await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, preflight) as any))
      .resolves.toMatchObject({
        deletedGrantCount: 1,
        deactivatedCompanyMembershipCount: 1,
      });
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
  });

  it("rejects same-count access-row identity drift inside the atomic cleanup gate", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const input = evidence();
    const request = claimPreflight(input);
    const initial = await service().preflight(SOURCE_ID, request as any);

    await db.update(principalPermissionGrants).set({
      permissionKey: "agents:create",
    }).where(eq(
      principalPermissionGrants.id,
      retirementAccessRows.principalPermissionGrants[0]!.id as string,
    ));

    await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
    expect((await db.select().from(agentApiKeys))[0]?.revokedAt).toBeNull();
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.retirement_cleanup",
    ))).toHaveLength(0);
  });

  it.each([
    { label: "direct stopped", status: "stopped", indirect: false },
    { label: "runtime-service-owned failed", status: "failed", indirect: true },
  ] as const)(
    "rejects unexpected $label workspace runtime start-claim evidence before destructive cleanup",
    async ({ status, indirect }) => {
      await seedReadyPortfolio();
      const input = evidence();
      const initial = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
      const runtimeServiceId = indirect ? randomUUID() : null;
      if (runtimeServiceId) {
        await db.insert(workspaceRuntimeServices).values({
          id: runtimeServiceId,
          companyId: COMPANY_ID,
          scopeType: "agent",
          scopeId: SOURCE_ID,
          serviceName: "retirement-runtime-claim-owner",
          status: "stopped",
          lifecycle: "ephemeral",
          provider: "local_process",
          ownerAgentId: SOURCE_ID,
          stoppedAt: new Date("2026-07-13T10:06:00.000Z"),
        });
      }
      await db.insert(workspaceRuntimeStartClaims).values({
        companyId: COMPANY_ID,
        serviceKey: `workspace-runtime:retirement-drift:${status}`,
        claimId: randomUUID(),
        status,
        runtimeServiceId,
        ownerAgentId: indirect ? null : SOURCE_ID,
        failureCode: status === "failed" ? "spawn_failed" : null,
        expiresAt: new Date("2026-07-13T10:05:00.000Z"),
        finalizedAt: new Date("2026-07-13T10:06:00.000Z"),
      });

      await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_backup_live_inventory_mismatch" },
        });
      expect(await db.select().from(activityLog).where(eq(
        activityLog.action,
        "agent.retirement_cleanup",
      ))).toHaveLength(0);
    },
  );

  it("rejects unrelated retained-agent drift before destructive cleanup", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    const retainedId = retirementFullRetainedRows().find((row) => (
      !AGENT_RETIREMENT_ALLOWLIST_ENTRIES.some((entry) => entry.canaryAgentId === row.id)
    ))!.id;
    await db.update(agents).set({ name: "Drifted retained agent" }).where(eq(agents.id, retainedId));

    await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.retirement_cleanup",
    ))).toHaveLength(0);
  });

  it("rejects historical tombstone row drift before destructive cleanup", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    await db.update(agents).set({ name: "Drifted historical tombstone" })
      .where(eq(agents.id, tombstone.agentId));

    await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.retirement_cleanup",
    ))).toHaveLength(0);
  });

  it("rejects historical tombstone access before destructive cleanup", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    await db.insert(agentApiKeys).values({
      companyId: tombstone.companyId,
      agentId: tombstone.agentId,
      name: "unexpected historical access",
      keyHash: sha256("historical-key"),
    });

    await expect(service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
    expect((await db.select().from(agentApiKeys))[0]?.revokedAt).toBeNull();
  });

  it("rejects nonterminal work assigned to a historical tombstone during registration", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    await db.insert(issues).values({
      companyId: tombstone.companyId,
      title: "Unexpected historical work",
      status: "todo",
      assigneeAgentId: tombstone.agentId,
    });

    await expect(service().preflight(SOURCE_ID, claimPreflight(input) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
  });

  it.each([
    ["active project leadership", async (tombstone: (typeof AGENT_RETIREMENT_HISTORICAL_TOMBSTONES)[number]) => {
      await db.insert(projects).values({
        companyId: tombstone.companyId,
        name: "Unexpected active historical project",
        status: "in_progress",
        leadAgentId: tombstone.agentId,
        archivedAt: null,
      });
    }],
    ["operative goal ownership", async (tombstone: (typeof AGENT_RETIREMENT_HISTORICAL_TOMBSTONES)[number]) => {
      await db.insert(goals).values({
        companyId: tombstone.companyId,
        title: "Unexpected active historical goal",
        level: "company",
        status: "planned",
        ownerAgentId: tombstone.agentId,
      });
    }],
    ["running runtime-service ownership", async (tombstone: (typeof AGENT_RETIREMENT_HISTORICAL_TOMBSTONES)[number]) => {
      await db.insert(workspaceRuntimeServices).values({
        id: randomUUID(),
        companyId: tombstone.companyId,
        scopeType: "project",
        serviceName: "unexpected-historical-runtime",
        status: "running",
        lifecycle: "persistent",
        provider: "local_process",
        ownerAgentId: tombstone.agentId,
      });
    }],
    ["pending approval ownership", async (tombstone: (typeof AGENT_RETIREMENT_HISTORICAL_TOMBSTONES)[number]) => {
      await db.insert(approvals).values({
        companyId: tombstone.companyId,
        type: "request_board_approval",
        requestedByAgentId: tombstone.agentId,
        status: "pending",
        payload: {},
      });
    }],
    ["cross-agent task-session run", async (tombstone: (typeof AGENT_RETIREMENT_HISTORICAL_TOMBSTONES)[number]) => {
      const other = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES.find((entry) => entry.agentId !== tombstone.agentId)!;
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: other.companyId,
        agentId: other.agentId,
        invocationSource: "historical",
        status: "succeeded",
      });
      await db.insert(agentTaskSessions).values({
        companyId: tombstone.companyId,
        agentId: tombstone.agentId,
        adapterType: "codex_local",
        taskKey: "unexpected-cross-agent-session",
        lastRunId: runId,
      });
    }],
  ])("rejects historical tombstone %s during registration", async (_label, seedInvalidState) => {
    await seedReadyPortfolio();
    const input = evidence();
    const tombstone = AGENT_RETIREMENT_HISTORICAL_TOMBSTONES[0]!;
    await seedInvalidState(tombstone);

    await expect(service().preflight(SOURCE_ID, claimPreflight(input) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_backup_live_inventory_mismatch" },
      });
  });

  it("reconciles an audited first-source termination before cleaning a second source from the same plan", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const firstEvidence = evidence();
    const firstRequest = claimPreflight(firstEvidence);
    const claimed = service();
    const first = await claimed.preflight(SOURCE_ID, firstRequest as any);
    const firstCleanup = await claimed.cleanup(
      SOURCE_ID,
      claimedCleanup(firstEvidence, first) as any,
    );
    const firstFinal = await claimed.preflight(SOURCE_ID, {
      ...firstRequest,
      evidenceBySourceId: null,
      claimExecution: false,
      executionClaimReceiptId: first.executionClaimReceiptId,
    } as any);
    await claimed.terminateAuthorized(SOURCE_ID, {
      cleanupReceiptId: firstCleanup.receiptId,
      preflightFingerprint: firstFinal.fingerprint,
      expectedUpdatedAt: firstEvidence.expectedUpdatedAt,
      humanGate: firstEvidence.humanGate,
      planClaimReceiptId: first.planClaimReceiptId!,
      executionClaimReceiptId: first.executionClaimReceiptId!,
    });

    const secondEntry = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => (
      entry.sourceAgentId !== SOURCE_ID
    ))!;
    const secondEvidence = firstRequest.evidenceBySourceId![secondEntry.sourceAgentId]!;
    const second = await claimed.preflight(secondEntry.sourceAgentId, {
      evidence: secondEvidence,
      plan: firstRequest.plan,
      evidenceBySourceId: null,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any);
    await expect(claimed.cleanup(
      secondEntry.sourceAgentId,
      claimedCleanup(secondEvidence, second) as any,
    )).resolves.toMatchObject({
      ok: true,
      agentId: secondEntry.sourceAgentId,
      revokedKeyCount: 0,
      deletedGrantCount: 0,
      deactivatedCompanyMembershipCount: 0,
      deletedAgentMembershipCount: 0,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
    });
  });

  it("walks previousCleanupReceipt recovery lineage before a second-source cleanup from the original plan", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const refreshedCanary = retirementFullRetainedRows({ freshRecoveryReview: true })
      .find((row) => row.id === REPLACEMENT_ID)!;
    await db.update(agents).set({ metadata: refreshedCanary.metadata })
      .where(eq(agents.id, REPLACEMENT_ID));
    const originalBase = evidence();
    const originalArtifacts = artifactEvidence(
      SOURCE_ID,
      COMPANY_ID,
      "Calendar und Events Butler",
      { pathSuffix: "-lineage-original", freshRecoveryReview: true },
    );
    const originalApprovalBinding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: originalArtifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: originalArtifacts.backupRestore.restoreEvidenceSha256,
    };
    const originalEvidence: AgentRetirementEvidence = {
      ...originalBase,
      sourceExport: originalArtifacts.sourceExport,
      backupRestore: originalArtifacts.backupRestore,
      humanGate: {
        ...originalBase.humanGate,
        ...originalApprovalBinding,
        approvedTextSha256: sha256(approvalText(originalApprovalBinding)),
      },
    };
    await db.update(issueComments).set({ body: approvalText(originalEvidence.humanGate) })
      .where(eq(issueComments.id, HUMAN_COMMENT_ID));

    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const originalRequest = claimPreflight(originalEvidence);
    const first = await claimed.preflight(SOURCE_ID, originalRequest as any);
    const firstCleanup = await claimed.cleanup(
      SOURCE_ID,
      claimedCleanup(originalEvidence, first) as any,
    );
    expect(firstCleanup).toMatchObject({
      revokedKeyCount: 1,
      deletedGrantCount: 1,
      deactivatedCompanyMembershipCount: 1,
      deletedAgentMembershipCount: 1,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
    });

    const secondEntry = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => (
      entry.sourceAgentId !== SOURCE_ID && entry.canaryAgentId === REPLACEMENT_ID
    ))!;
    const secondEvidence = originalRequest.evidenceBySourceId![secondEntry.sourceAgentId]!;
    clock = new Date(NOW.getTime() + 20 * 60 * 1_000);
    const second = await claimed.preflight(secondEntry.sourceAgentId, {
      evidence: secondEvidence,
      plan: originalRequest.plan,
      evidenceBySourceId: null,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any);

    const freshEvidence = recoveryEvidence(originalEvidence);
    await seedFreshRecoveryReview(freshEvidence);
    clock = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000 + 10 * 60 * 1_000);
    const recovered = await claimed.preflight(SOURCE_ID, {
      evidence: freshEvidence,
      planClaimReceiptId: first.planClaimReceiptId,
      executionClaimReceiptId: first.executionClaimReceiptId,
      recoveryRequestReceiptId: recoveryRequestReceipt(
        first.planClaimReceiptId,
        first.executionClaimReceiptId,
        freshEvidence,
      ),
      recoverExecution: true,
    } as any);
    const recoveredCleanup = await claimed.cleanup(
      SOURCE_ID,
      claimedCleanup(freshEvidence, recovered) as any,
    );
    expect(recoveredCleanup).toMatchObject({
      revokedKeyCount: 0,
      deletedGrantCount: 0,
      deactivatedCompanyMembershipCount: 0,
      deletedAgentMembershipCount: 0,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
    });
    const recoveredFinal = await claimed.preflight(SOURCE_ID, {
      evidence: freshEvidence,
      planClaimReceiptId: recovered.planClaimReceiptId,
      executionClaimReceiptId: recovered.executionClaimReceiptId,
      recoveryRequestReceiptId: null,
      recoverExecution: false,
    } as any);
    await claimed.terminateAuthorized(SOURCE_ID, {
      cleanupReceiptId: recoveredCleanup.receiptId,
      preflightFingerprint: recoveredFinal.fingerprint,
      expectedUpdatedAt: freshEvidence.expectedUpdatedAt,
      humanGate: freshEvidence.humanGate,
      planClaimReceiptId: recovered.planClaimReceiptId!,
      executionClaimReceiptId: recovered.executionClaimReceiptId!,
    });

    const recoveryRows = await db.select().from(agentRetirementExecutionRecoveries)
      .where(eq(agentRetirementExecutionRecoveries.sourceAgentId, SOURCE_ID));
    expect(recoveryRows).toHaveLength(1);
    expect(recoveryRows[0]).toMatchObject({
      previousCleanupReceiptId: firstCleanup.receiptId,
      previousPhase: "cleaned",
    });
    await db.update(agentRetirementExecutionRecoveries).set({
      previousCleanupReceiptId: `v1:sha256:${"f".repeat(64)}`,
    }).where(eq(agentRetirementExecutionRecoveries.id, recoveryRows[0]!.id));
    await expect(claimed.cleanup(
      secondEntry.sourceAgentId,
      claimedCleanup(secondEvidence, second) as any,
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_backup_live_inventory_mismatch" },
    });
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.action, "agent.retirement_cleanup"),
      eq(activityLog.entityId, secondEntry.sourceAgentId),
    ))).toHaveLength(0);
    expect((await db.select().from(agentRetirementExecutionClaims).where(eq(
      agentRetirementExecutionClaims.sourceAgentId,
      secondEntry.sourceAgentId,
    )))[0]?.phase).toBe("started");
    await db.update(agentRetirementExecutionRecoveries).set({
      previousCleanupReceiptId: firstCleanup.receiptId,
    }).where(eq(agentRetirementExecutionRecoveries.id, recoveryRows[0]!.id));

    await expect(claimed.cleanup(
      secondEntry.sourceAgentId,
      claimedCleanup(secondEvidence, second) as any,
    )).resolves.toMatchObject({
      ok: true,
      agentId: secondEntry.sourceAgentId,
      revokedKeyCount: 0,
      deletedGrantCount: 0,
      deactivatedCompanyMembershipCount: 0,
      deletedAgentMembershipCount: 0,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
    });
  });

  it("recovers the exact cleanup receipt idempotently after response loss", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const evidenceInput = evidence();
    const preflight = await service().preflight(SOURCE_ID, claimPreflight(evidenceInput) as any);
    const input = claimedCleanup(evidenceInput, preflight);
    const first = await service().cleanup(SOURCE_ID, input as any);
    const second = await service().cleanup(SOURCE_ID, input as any);

    expect(second).toEqual(first);
    const cleanupActivities = await db.select().from(activityLog).where(eq(activityLog.action, "agent.retirement_cleanup"));
    expect(cleanupActivities).toHaveLength(1);
    expect(cleanupActivities[0]?.details).toEqual({
      response: first,
      planClaimReceiptId: preflight.planClaimReceiptId,
      executionClaimReceiptId: preflight.executionClaimReceiptId,
      evidenceFingerprint: `v1:sha256:${stableSha256({
        kind: "agent_retirement_evidence",
        evidence: evidenceInput,
      })}`,
    });
    expect(JSON.stringify(cleanupActivities[0]?.details)).not.toContain(backupRoot);
    expect(JSON.stringify(cleanupActivities[0]?.details)).not.toContain(retirementEvidenceRoot);
    expect(JSON.stringify(cleanupActivities[0]?.details)).not.toContain(APPROVAL_NONCE);
  });

  it("requires fresh restore evidence, the exact human comment, current updatedAt, and final canary", async () => {
    await seedReadyPortfolio();
    const forgedDump = evidence();
    forgedDump.backupRestore.dumpSha256 = "b".repeat(64);
    forgedDump.humanGate.backupSha256 = forgedDump.backupRestore.dumpSha256;
    forgedDump.humanGate.approvedTextSha256 = sha256(approvalText(forgedDump.humanGate));
    const cases: Array<[string, AgentRetirementEvidence]> = [
      ["backup_restore_evidence_invalid", evidence({ backupRestore: { ...evidence().backupRestore, restoreVerifiedAt: "2026-07-13T09:00:00.000Z" } })],
      ["backup_restore_evidence_invalid", forgedDump],
      ["backup_restore_evidence_invalid", evidence({ backupRestore: { ...evidence().backupRestore, restoreStateSha256: "c".repeat(64) } })],
      ["backup_restore_evidence_invalid", evidence({ backupRestore: { ...evidence().backupRestore, masterKeyFingerprintSha256: "d".repeat(64) } })],
      ["human_gate_invalid", evidence({ humanGate: { ...evidence().humanGate, approvedTextSha256: "f".repeat(64) } })],
      ["source_state_stale", evidence({ expectedUpdatedAt: "2026-07-13T09:59:59.000Z" })],
      ["replacement_canary_invalid", evidence({ replacement: { ...evidence().replacement, configFingerprint: `v1:sha256:${"9".repeat(64)}` } })],
    ];
    for (const [code, input] of cases) {
      const response = await service().preflight(SOURCE_ID, input);
      expect(response.blockers.map((blocker) => blocker.code), code).toContain(code);
      expect(response.cleanupEligible).toBe(false);
    }
    await db.update(issueComments).set({ authorUserId: "another-board-user" })
      .where(eq(issueComments.id, HUMAN_COMMENT_ID));
    expect((await service().preflight(SOURCE_ID, evidence())).blockers.map((blocker) => blocker.code))
      .toContain("human_gate_invalid");
  });

  it("requires one unique structured approval nonce and the exact post-restore comment timestamp", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    expect(await service().preflight(SOURCE_ID, input)).toMatchObject({ ok: true, blockers: [] });

    await db.insert(issueComments).values({
      id: "77777777-7777-4777-8777-777777777777",
      companyId: COMPANY_ID,
      issueId: DECISION_ISSUE_ID,
      authorUserId: "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B",
      authorType: "user",
      body: approvalText(input.humanGate),
      createdAt: new Date("2026-07-13T10:04:30.000Z"),
    });
    expect((await service().preflight(SOURCE_ID, input)).blockers.map((blocker) => blocker.code))
      .toContain("human_gate_invalid");

    await db.delete(issueComments).where(eq(
      issueComments.id,
      "77777777-7777-4777-8777-777777777777",
    ));
    await db.update(issueComments).set({ createdAt: new Date("2026-07-13T10:03:00.000Z") })
      .where(eq(issueComments.id, HUMAN_COMMENT_ID));
    expect((await service().preflight(SOURCE_ID, input)).blockers.map((blocker) => blocker.code))
      .toContain("human_gate_invalid");
  });

  it("rejects a valid Marco approval comment for any non-canonical manifest hash", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const wrongManifestSha256 = MANIFEST_SHA256 === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64);
    input.humanGate.manifestSha256 = wrongManifestSha256;
    input.humanGate.approvedTextSha256 = sha256(approvalText(input.humanGate));
    await db.update(issueComments).set({
      body: approvalText(input.humanGate),
    }).where(eq(issueComments.id, HUMAN_COMMENT_ID));

    const response = await service().preflight(SOURCE_ID, input);
    expect(response.blockers.map((blocker) => blocker.code)).toContain("human_gate_invalid");
    expect(response.cleanupEligible).toBe(false);
  });

  it("rejects source exports that are invented, non-private, or no longer the described artifact", async () => {
    await seedReadyPortfolio();
    const forged = evidence();
    forged.sourceExport.sha256 = "a".repeat(64);
    expect((await service().preflight(SOURCE_ID, forged)).blockers.map((blocker) => blocker.code))
      .toContain("source_export_evidence_invalid");

    const publicFile = evidence();
    fs.chmodSync(publicFile.sourceExport.path, 0o644);
    expect((await service().preflight(SOURCE_ID, publicFile)).blockers.map((blocker) => blocker.code))
      .toContain("source_export_evidence_invalid");
  });

  it("rejects hardlinked and opened-file TOCTOU-mutated artifacts", async () => {
    await seedReadyPortfolio();
    const hardlinked = evidence();
    const hardlinkPath = `${hardlinked.sourceExport.path}.hardlink`;
    fs.linkSync(hardlinked.sourceExport.path, hardlinkPath);
    try {
      expect((await service().preflight(SOURCE_ID, hardlinked)).blockers.map((blocker) => blocker.code))
        .toContain("source_export_evidence_invalid");
    } finally {
      fs.unlinkSync(hardlinkPath);
    }

    const changedAfterOpen = evidence();
    const guarded = agentRetirementService(db, {
      now: () => new Date(NOW),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
      onArtifactOpened: async (kind, artifactPath) => {
        if (kind !== "source_export") return;
        fs.chmodSync(artifactPath, 0o400);
        fs.chmodSync(artifactPath, 0o600);
      },
    });
    expect((await guarded.preflight(SOURCE_ID, changedAfterOpen)).blockers.map((blocker) => blocker.code))
      .toContain("source_export_evidence_invalid");

    const directoryChanged = evidence();
    const markerPath = path.join(retirementEvidenceRoot, "opened-directory-mutation");
    const directoryGuarded = agentRetirementService(db, {
      now: () => new Date(NOW),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
      onArtifactOpened: async (kind) => {
        if (kind === "source_export") fs.writeFileSync(markerPath, "mutation", { mode: 0o600 });
      },
    });
    try {
      expect((await directoryGuarded.preflight(SOURCE_ID, directoryChanged)).blockers
        .map((blocker) => blocker.code)).toContain("source_export_evidence_invalid");
    } finally {
      fs.rmSync(markerPath, { force: true });
    }

    const symlinked = evidence();
    const parentLink = path.join(retirementEvidenceRoot, "parent-link");
    fs.symlinkSync(retirementEvidenceRoot, parentLink, "dir");
    symlinked.sourceExport.path = path.join(
      parentLink,
      path.basename(symlinked.sourceExport.path),
    );
    try {
      expect((await service().preflight(SOURCE_ID, symlinked)).blockers
        .map((blocker) => blocker.code)).toContain("source_export_evidence_invalid");
    } finally {
      fs.unlinkSync(parentLink);
    }
  });

  it("streams artifact content and binds root, parent, opened and after identities", async () => {
    const implementation = await import("node:fs/promises").then((fsPromises) => fsPromises.readFile(
      new URL("../services/agent-retirement-artifacts.ts", import.meta.url),
      "utf8",
    ));
    expect(implementation).not.toMatch(/\breadFile(?:Sync)?\b|\bgunzipSync\b/);
    for (const invariant of [
      "rootIdentity", "parentIdentity", "openedIdentity", "nlink", "ctimeMs",
      "assertDirectoryUnchanged", "createReadStream", "createGunzip",
      "MAX_SQL_COMPRESSED_BYTES", "MAX_SQL_DECOMPRESSED_BYTES", "MAX_SQL_LINES",
      "decodedMasterKey?.fill(0)", "master.bytes.fill(0)",
    ]) expect(implementation).toContain(invariant);
  });

  it("exports fail-closed physical revalidation for claimed source and common artifacts", async () => {
    const artifactModule = await import("../services/agent-retirement-artifacts.js") as Record<string, unknown>;
    expect(typeof artifactModule.revalidateRetirementClaimArtifacts).toBe("function");
  });

  it("revalidates claimed artifacts past 30 minutes, tolerates sibling churn, and rejects identical-byte replacement", async () => {
    const artifactModule = await import("../services/agent-retirement-artifacts.js");
    const expected = {
      sourceId: SOURCE_ID,
      companyId: COMPANY_ID,
      sourceName: "Calendar und Events Butler",
      expectedUpdatedAt: SOURCE_UPDATED_AT,
    };
    const initialOptions = {
      backupRoot,
      retirementEvidenceRoot,
      now: new Date(NOW),
      maxAgeMs: 30 * 60_000,
      futureSkewMs: 60_000,
    };
    const claimedOptions = { ...initialOptions, now: new Date("2026-07-13T10:51:00.000Z") };

    for (const target of ["source", "dump", "masterKey", "restoreEvidence"] as const) {
      const input = evidence();
      const sourceArtifactReceipt = await artifactModule.verifyRetirementSourceExport(input, expected, initialOptions);
      const commonArtifactReceipt = await artifactModule.verifyRetirementBackupRestore(input, initialOptions);
      const sibling = path.join(
        target === "source" || target === "restoreEvidence" ? retirementEvidenceRoot : backupRoot,
        `benign-sibling-${target}`,
      );
      fs.writeFileSync(sibling, "benign", { mode: 0o600 });
      fs.rmSync(sibling);
      await expect(artifactModule.revalidateRetirementClaimArtifacts(
        input,
        expected,
        { sourceArtifactReceipt, commonArtifactReceipt },
        claimedOptions,
      )).resolves.toEqual({ sourceArtifactReceipt, commonArtifactReceipt });

      const targetPath = target === "source"
        ? input.sourceExport.path
        : target === "dump"
          ? input.backupRestore.dumpPath
          : target === "masterKey"
            ? input.backupRestore.masterKeyBackupPath
            : input.backupRestore.restoreEvidencePath;
      const bytes = fs.readFileSync(targetPath);
      const mtime = fs.statSync(targetPath).mtime;
      fs.unlinkSync(targetPath);
      fs.writeFileSync(targetPath, bytes, { mode: 0o600 });
      fs.chmodSync(targetPath, 0o600);
      fs.utimesSync(targetPath, mtime, mtime);

      await expect(artifactModule.revalidateRetirementClaimArtifacts(
        input,
        expected,
        { sourceArtifactReceipt, commonArtifactReceipt },
        claimedOptions,
      )).rejects.toThrow(/physical identity changed/i);
    }
  });

  it("rejects table-only empty COPY sections as restore-grade retirement proof", async () => {
    await seedReadyPortfolio();
    const invalidArtifacts = artifactEvidence(SOURCE_ID, COMPANY_ID, "Calendar und Events Butler", {
      omitRetirementRows: true,
    });
    const input = evidence();
    input.sourceExport = invalidArtifacts.sourceExport;
    input.backupRestore = invalidArtifacts.backupRestore;
    const binding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: invalidArtifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: invalidArtifacts.backupRestore.restoreEvidenceSha256,
    };
    input.humanGate = {
      ...input.humanGate,
      ...binding,
      approvedTextSha256: sha256(approvalText(binding)),
    };
    const result = await service().preflight(SOURCE_ID, input);
    expect(result.blockers.map((blocker) => blocker.code))
      .toContain("backup_restore_evidence_invalid");
  });

  it("rejects a dump that omits the retained portfolio while scratch self-asserts retained counts", async () => {
    await seedReadyPortfolio();
    const invalidArtifacts = artifactEvidence(SOURCE_ID, COMPANY_ID, "Calendar und Events Butler", {
      omitRetainedRows: true,
    });
    const input = evidence();
    input.sourceExport = invalidArtifacts.sourceExport;
    input.backupRestore = invalidArtifacts.backupRestore;
    const binding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: invalidArtifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: invalidArtifacts.backupRestore.restoreEvidenceSha256,
    };
    input.humanGate = { ...input.humanGate, ...binding, approvedTextSha256: sha256(approvalText(binding)) };
    const result = await service().preflight(SOURCE_ID, input);
    expect(result.blockers.map((blocker) => blocker.code)).toContain("backup_restore_evidence_invalid");
  });

  it("rejects a self-consistent receipt and dump with one substituted retained identity", async () => {
    await seedReadyPortfolio();
    const invalidArtifacts = artifactEvidence(SOURCE_ID, COMPANY_ID, "Calendar und Events Butler", {
      substituteRetainedAgent: true,
      pathSuffix: "-substituted-retained",
    });
    const input = evidence();
    input.sourceExport = invalidArtifacts.sourceExport;
    input.backupRestore = invalidArtifacts.backupRestore;
    const binding = {
      approvalNonce: APPROVAL_NONCE,
      manifestSha256: MANIFEST_SHA256,
      backupSha256: invalidArtifacts.backupRestore.dumpSha256,
      restoreReceiptSha256: invalidArtifacts.backupRestore.restoreEvidenceSha256,
    };
    input.humanGate = {
      ...input.humanGate,
      ...binding,
      approvedTextSha256: sha256(approvalText(binding)),
    };
    await db.update(issueComments).set({
      body: approvalText(binding),
    }).where(eq(issueComments.id, HUMAN_COMMENT_ID));

    const result = await service().preflight(SOURCE_ID, input);
    expect(result.blockers.map((blocker) => blocker.code)).toContain("backup_restore_evidence_invalid");
  });

  it("authorizes termination only after cleanup and a fresh zero-blocker fingerprint", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const input = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(input) as any);
    const cleanup = await service().cleanup(SOURCE_ID, claimedCleanup(input, initial) as any);
    const finalOne = await service().preflight(SOURCE_ID, claimPreflight(input, initial.executionClaimReceiptId) as any);
    const finalTwo = await service().preflight(SOURCE_ID, claimPreflight(input, initial.executionClaimReceiptId) as any);
    expect(finalOne).toEqual(finalTwo);
    expect(finalTwo.blockers).toEqual([]);

    await expect(service().assertTerminationAuthorized(SOURCE_ID, {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: finalTwo.fingerprint,
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      humanGate: input.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId!,
      executionClaimReceiptId: initial.executionClaimReceiptId!,
    })).resolves.toMatchObject({ agentId: SOURCE_ID, cleanupReceiptId: cleanup.receiptId });

    await db.update(agents).set({ updatedAt: new Date("2026-07-13T10:11:00.000Z") }).where(eq(agents.id, SOURCE_ID));
    await expect(service().assertTerminationAuthorized(SOURCE_ID, {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: finalTwo.fingerprint,
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      humanGate: input.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId!,
      executionClaimReceiptId: initial.executionClaimReceiptId!,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("blocks generic termination for protected sources before hire-rejection or other callers can bypass retirement", async () => {
    await seedReadyPortfolio();

    await expect(agentService(db).terminate(SOURCE_ID)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_gated_termination_required" },
    });
    await expect(agentService(db).update(SOURCE_ID, { status: "terminated" })).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_gated_termination_required" },
    });
    expect((await db.select().from(agents).where(eq(agents.id, SOURCE_ID)))[0]?.status).toBe("paused");
  });

  it("atomically writes the authorized tombstone and required audit receipt in one serializable transaction", async () => {
    await seedReadyPortfolio();
    const evidenceInput = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(evidenceInput) as any);
    const cleanup = await service().cleanup(SOURCE_ID, claimedCleanup(evidenceInput, initial) as any);
    const final = await service().preflight(SOURCE_ID, claimPreflight(evidenceInput, initial.executionClaimReceiptId) as any);
    const input = {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: final.fingerprint,
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      humanGate: evidenceInput.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId!,
      executionClaimReceiptId: initial.executionClaimReceiptId!,
    };
    const result = await service().terminateAuthorized(SOURCE_ID, input, {
      actorUserId: "better-auth:marco",
    });

    expect(result).toMatchObject({
      agent: { id: SOURCE_ID, status: "terminated" },
      receipt: {
        ok: true,
        agentId: SOURCE_ID,
        companyId: COMPANY_ID,
        cleanupReceiptId: cleanup.receiptId,
        preflightFingerprint: final.fingerprint,
      },
    });
    expect((await db.select().from(agents).where(eq(agents.id, SOURCE_ID)))[0]?.status).toBe("terminated");
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "agent.terminated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({
      source: "retirement_gated",
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: final.fingerprint,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: initial.executionClaimReceiptId,
    });
    await expect(service().postcheck(SOURCE_ID, input)).resolves.toEqual(result.receipt);
  });

  it("rolls back the tombstone when the required audit activity cannot be written", async () => {
    await seedReadyPortfolio();
    const evidenceInput = evidence();
    const initial = await service().preflight(SOURCE_ID, claimPreflight(evidenceInput) as any);
    const cleanup = await service().cleanup(SOURCE_ID, claimedCleanup(evidenceInput, initial) as any);
    const final = await service().preflight(SOURCE_ID, claimPreflight(evidenceInput, initial.executionClaimReceiptId) as any);
    const input = {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: final.fingerprint,
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      humanGate: evidenceInput.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId!,
      executionClaimReceiptId: initial.executionClaimReceiptId!,
    };
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION reject_retirement_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'agent.terminated' THEN
          RAISE EXCEPTION 'audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_retirement_audit_insert
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_retirement_audit();
    `));
    try {
      await expect(service().terminateAuthorized(SOURCE_ID, input, {
        actorUserId: "better-auth:marco",
      })).rejects.toBeDefined();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS reject_retirement_audit_insert ON activity_log;
        DROP FUNCTION IF EXISTS reject_retirement_audit();
      `));
    }
    expect((await db.select().from(agents).where(eq(agents.id, SOURCE_ID)))[0]?.status).toBe("paused");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.terminated"))).toHaveLength(0);
  });

  it("does not accept a protected tombstone as completed when its bound audit receipt is absent", async () => {
    await seedReadyPortfolio();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, SOURCE_ID));
    await expect(service().postcheck(SOURCE_ID, {
      cleanupReceiptId: `v1:sha256:${"1".repeat(64)}`,
      preflightFingerprint: `v1:sha256:${"2".repeat(64)}`,
      expectedUpdatedAt: SOURCE_UPDATED_AT,
      humanGate: evidence().humanGate,
      planClaimReceiptId: `v1:sha256:${"3".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"4".repeat(64)}`,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_termination_audit_missing" },
    });
  });

  it("never exposes a physical-delete code path", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../services/agent-retirement.ts", import.meta.url),
      "utf8",
    ));
    expect(source).not.toMatch(/\.delete\(agents\)|hard[-_]?delete|physicalDelete\s*:\s*true/i);
    expect(source).not.toContain("db.delete(issues)");
    expect(source).not.toContain("db.delete(heartbeatRuns)");
    expect(source).not.toContain("db.delete(issueComments)");
    expect(source).not.toContain("db.delete(costEvents)");
    expect(source).not.toContain("db.delete(agentConfigRevisions)");
  });

  it("resumes a durable cleanup_intent claim after the original 30-minute evidence window", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(input) as any);
    expect(initial).toMatchObject({ claimState: "started" });
    expect(initial.planClaimReceiptId).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(initial.executionClaimReceiptId).toMatch(/^v1:sha256:[a-f0-9]{64}$/);

    clock = new Date(NOW.getTime() + 50 * 60 * 1_000);
    await expect(claimed.cleanup(SOURCE_ID, claimedCleanup(input, initial) as any))
      .resolves.toMatchObject({ ok: true, executionClaimReceiptId: initial.executionClaimReceiptId });
  });

  it("atomically registers all 27 evidence receipts and refuses a newly claimed source after its canary expires", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const evidenceBySourceId = fullPlanEvidence(input);
    const plan = retirementPlan(input, NOW, evidenceBySourceId);
    let clock = new Date(NOW);
    const artifactOpens: string[] = [];
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
      onArtifactOpened: async (kind) => { artifactOpens.push(kind); },
    });

    const initial = await claimed.preflight(SOURCE_ID, {
      evidence: input,
      plan,
      evidenceBySourceId,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any);
    expect(initial).toMatchObject({ claimState: "started" });
    const registrations = await db.select().from(activityLog)
      .where(eq(activityLog.action, "agent.retirement_plan_registered"));
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.details).toMatchObject({
      sourceCount: 27,
      clientPlanReceiptId: plan.receiptId,
    });
    expect(registrations[0]?.details).not.toHaveProperty("evidenceBySourceId");
    expect(registrations[0]?.details).not.toHaveProperty("sourceArtifactReceiptsBySourceId");
    expect(await db.select().from(agentRetirementPlanEvidenceBundles)).toHaveLength(1);

    await db.delete(agentRetirementExecutionClaims);
    const openedAtRegistration = artifactOpens.length;
    clock = new Date(NOW.getTime() + 31 * 60 * 1_000);
    const delayed = await claimed.preflight(SOURCE_ID, {
      evidence: input,
      plan,
      evidenceBySourceId: null,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any);
    expect(delayed).toMatchObject({ claimState: "unclaimed", ok: false });
    expect(delayed.blockers.map((blocker) => blocker.code)).toContain("replacement_canary_invalid");
    expect(delayed.executionClaimReceiptId).toBeNull();
    expect(artifactOpens.slice(openedAtRegistration)).toEqual([
      "source_export", "master_key_backup", "restore_evidence", "database_dump",
    ]);
  });

  it("rejects the entire 27-source registration when a non-selected source canary is expired", async () => {
    await seedReadyPortfolio();
    const target = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => (
      entry.sourceAgentId !== SOURCE_ID && entry.canaryAgentId !== REPLACEMENT_ID
    ))!;
    const canary = portfolioCanaryContract(target.canaryAgentId);
    await db.update(agents).set({
      metadata: {
        lifecycle: {
          ...lifecycle(),
          canaryIssueId: canary.issueId,
          lastCanaryAt: "2026-07-01T10:00:00.000Z",
        },
        lifecycleGate: {
          ...lifecycleGate(),
          lastSatisfiedRunId: canary.runId,
          expiresAt: "2026-07-13T10:09:59.000Z",
        },
      },
    }).where(eq(agents.id, target.canaryAgentId));
    const input = evidence();
    const evidenceBySourceId = fullPlanEvidence(input);
    await expect(service().preflight(SOURCE_ID, {
      evidence: input,
      plan: retirementPlan(input, NOW, evidenceBySourceId),
      evidenceBySourceId,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "retirement_plan_source_blocked",
        blockerCodes: expect.arrayContaining(["replacement_canary_invalid"]),
      },
    });
    expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(0);
  });

  it("consumes one human approval exactly once even when a second plan changes validatedAt", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const evidenceBySourceId = fullPlanEvidence(input);
    const claimed = service();
    await claimed.preflight(SOURCE_ID, {
      evidence: input,
      plan: retirementPlan(input, NOW, evidenceBySourceId),
      evidenceBySourceId,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any);

    const replayValidatedAt = new Date(NOW.getTime() + 60 * 1_000);
    await expect(claimed.preflight(SOURCE_ID, {
      evidence: input,
      plan: retirementPlan(input, replayValidatedAt, evidenceBySourceId),
      evidenceBySourceId,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_approval_already_consumed" },
    });
    expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(1);
  });

  it("requires explicit fresh recovery to start a registered but unclaimed source after plan expiry", async () => {
    await seedReadyPortfolio();
    const originalEvidence = evidence();
    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(originalEvidence) as any);
    await db.delete(agentRetirementExecutionClaims);

    clock = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000 + 10 * 60 * 1_000);
    await expect(claimed.preflight(SOURCE_ID, {
      evidence: originalEvidence,
      plan: retirementPlan(originalEvidence),
      evidenceBySourceId: null,
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_plan_execution_expired" },
    });

    const freshEvidence = recoveryEvidence(originalEvidence);
    await seedFreshRecoveryReview(freshEvidence);
    const recovered = await claimed.preflight(SOURCE_ID, {
      evidence: freshEvidence,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: null,
      recoveryRequestReceiptId: recoveryRequestReceipt(
        initial.planClaimReceiptId,
        null,
        freshEvidence,
      ),
      recoverExecution: true,
    } as any);
    expect(recovered).toMatchObject({ claimState: "started" });
    expect(recovered.executionExpiresAt).toBe(
      new Date(clock.getTime() + 6 * 60 * 60 * 1_000).toISOString(),
    );
  });

  it("atomically reclaims an expired started claim, idempotently recovers its response, and rejects old mutations", async () => {
    await seedReadyPortfolio();
    const originalEvidence = evidence();
    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(originalEvidence) as any);

    const freshEvidence = recoveryEvidence(originalEvidence);
    await seedFreshRecoveryReview(freshEvidence);
    clock = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000 + 10 * 60 * 1_000);
    const requestReceiptId = recoveryRequestReceipt(
      initial.planClaimReceiptId,
      initial.executionClaimReceiptId,
      freshEvidence,
    );
    const recoveryRequest = {
      evidence: freshEvidence,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: initial.executionClaimReceiptId,
      recoveryRequestReceiptId: requestReceiptId,
      recoverExecution: true,
    } as const;
    const recovered = await claimed.preflight(SOURCE_ID, recoveryRequest as any);

    expect(recovered).toMatchObject({ claimState: "started" });
    expect(recovered.planClaimReceiptId).toBe(initial.planClaimReceiptId);
    expect(recovered.executionClaimReceiptId).not.toBe(initial.executionClaimReceiptId);
    expect(recovered.executionExpiresAt).toBe(
      new Date(clock.getTime() + 6 * 60 * 60 * 1_000).toISOString(),
    );
    const recoveryAudits = await db.select().from(activityLog)
      .where(eq(activityLog.action, "agent.retirement_execution_recovered"));
    expect(recoveryAudits).toHaveLength(1);
    expect(recoveryAudits[0]?.details).toMatchObject({
      sourceAgentId: SOURCE_ID,
      previousExecutionClaimReceiptId: initial.executionClaimReceiptId,
      previousPhase: "started",
      newExecutionClaimReceiptId: recovered.executionClaimReceiptId,
    });
    await expect(claimed.cleanup(SOURCE_ID, claimedCleanup(originalEvidence, initial) as any))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_execution_claim_missing" },
      });
    await expect(claimed.preflight(SOURCE_ID, recoveryRequest as any)).resolves.toEqual(recovered);
    await expect(claimed.preflight(SOURCE_ID, {
      ...recoveryRequest,
      recoveryRequestReceiptId: `v1:sha256:${"f".repeat(64)}`,
    } as any)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_execution_recovery_request_invalid" },
    });
  });

  for (const recoverFromPhase of ["cleaned", "termination_ready"] as const) {
    it(`recovers an expired ${recoverFromPhase} claim only after fresh zero-dependency review`, async () => {
      await seedReadyPortfolio();
      await seedAccessArtifacts();
      const originalEvidence = evidence();
      let clock = new Date(NOW);
      const claimed = agentRetirementService(db, {
        now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
      });
      const initial = await claimed.preflight(SOURCE_ID, claimPreflight(originalEvidence) as any);
      const originalCleanup = await claimed.cleanup(
        SOURCE_ID,
        claimedCleanup(originalEvidence, initial) as any,
      );
      if (recoverFromPhase === "termination_ready") {
        await claimed.preflight(SOURCE_ID, claimPreflight(
          originalEvidence,
          initial.executionClaimReceiptId,
        ) as any);
      }

      const freshEvidence = recoveryEvidence(originalEvidence);
      await seedFreshRecoveryReview(freshEvidence);
      clock = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000 + 10 * 60 * 1_000);
      const recovered = await claimed.preflight(SOURCE_ID, {
        evidence: freshEvidence,
        planClaimReceiptId: initial.planClaimReceiptId,
        executionClaimReceiptId: initial.executionClaimReceiptId,
        recoveryRequestReceiptId: recoveryRequestReceipt(
          initial.planClaimReceiptId,
          initial.executionClaimReceiptId,
          freshEvidence,
        ),
        recoverExecution: true,
      } as any);
      expect(recovered).toMatchObject({ claimState: "started", blockers: [], ok: true });

      const freshCleanup = await claimed.cleanup(
        SOURCE_ID,
        claimedCleanup(freshEvidence, recovered) as any,
      );
      expect(freshCleanup.receiptId).not.toBe(originalCleanup.receiptId);
      expect(freshCleanup).toMatchObject({
        revokedKeyCount: 0,
        deletedGrantCount: 0,
        deactivatedCompanyMembershipCount: 0,
        deletedAgentMembershipCount: 0,
        deletedSecretBindingCount: 0,
        deletedUserSecretDeclarationCount: 0,
        deletedSkillStarCount: 0,
      });
      const final = await claimed.preflight(SOURCE_ID, {
        evidence: freshEvidence,
        planClaimReceiptId: recovered.planClaimReceiptId,
        executionClaimReceiptId: recovered.executionClaimReceiptId,
        recoveryRequestReceiptId: null,
        recoverExecution: false,
      } as any);
      expect(final).toMatchObject({ claimState: "termination_ready", blockers: [], ok: true });
      expect(await db.select().from(activityLog).where(eq(
        activityLog.action,
        "agent.retirement_cleanup",
      ))).toHaveLength(2);
    });
  }

  it("fails closed when the original pre-cleanup dump disappears after a cleaned recovery", async () => {
    await seedReadyPortfolio();
    await seedAccessArtifacts();
    const originalEvidence = evidence();
    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(originalEvidence) as any);
    await claimed.cleanup(SOURCE_ID, claimedCleanup(originalEvidence, initial) as any);
    const freshEvidence = recoveryEvidence(originalEvidence);
    await seedFreshRecoveryReview(freshEvidence);
    clock = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000 + 10 * 60 * 1_000);
    const recovered = await claimed.preflight(SOURCE_ID, {
      evidence: freshEvidence,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: initial.executionClaimReceiptId,
      recoveryRequestReceiptId: recoveryRequestReceipt(
        initial.planClaimReceiptId,
        initial.executionClaimReceiptId,
        freshEvidence,
      ),
      recoverExecution: true,
    } as any);
    fs.rmSync(originalEvidence.backupRestore.dumpPath);
    await expect(claimed.cleanup(
      SOURCE_ID,
      claimedCleanup(freshEvidence, recovered) as any,
    )).rejects.toThrow();
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.retirement_cleanup",
    ))).toHaveLength(1);
  });

  it("resumes a durable cleanup_complete claim with final preflights after 50 minutes", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    let clock = new Date(NOW);
    const artifactOpens: string[] = [];
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock),
      backupRoot,
      retirementEvidenceRoot,
      workspaceRoot,
      onArtifactOpened: async (kind) => { artifactOpens.push(kind); },
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(input) as any);
    expect(artifactOpens).toEqual([
      "source_export", "master_key_backup", "restore_evidence", "database_dump",
      ...Array.from({ length: AGENT_RETIREMENT_ALLOWLIST_ENTRIES.length - 1 }, () => "source_export"),
      "source_export", "master_key_backup", "restore_evidence", "database_dump",
    ]);
    await claimed.cleanup(SOURCE_ID, claimedCleanup(input, initial) as any);
    clock = new Date(NOW.getTime() + 50 * 60 * 1_000);

    const final = await claimed.preflight(SOURCE_ID, claimPreflight(
      input,
      initial.executionClaimReceiptId,
    ) as any);
    expect(final).toMatchObject({ ok: true, blockers: [], claimState: "termination_ready" });
    expect(final.planClaimReceiptId).toBe(initial.planClaimReceiptId);
    expect(artifactOpens).toEqual([
      "source_export", "master_key_backup", "restore_evidence", "database_dump",
      ...Array.from({ length: AGENT_RETIREMENT_ALLOWLIST_ENTRIES.length - 1 }, () => "source_export"),
      ...Array.from({ length: 3 }, () => [
        "source_export", "master_key_backup", "restore_evidence", "database_dump",
      ]).flat(),
    ]);
  });

  it("resumes a durable termination_intent claim after 50 minutes", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    let clock = new Date(NOW);
    const claimed = agentRetirementService(db, {
      now: () => new Date(clock), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const initial = await claimed.preflight(SOURCE_ID, claimPreflight(input) as any);
    const cleanup = await claimed.cleanup(SOURCE_ID, claimedCleanup(input, initial) as any);
    const final = await claimed.preflight(SOURCE_ID, claimPreflight(
      input,
      initial.executionClaimReceiptId,
    ) as any);
    clock = new Date(NOW.getTime() + 50 * 60 * 1_000);
    await expect(claimed.terminateAuthorized(SOURCE_ID, {
      cleanupReceiptId: cleanup.receiptId,
      preflightFingerprint: final.fingerprint,
      expectedUpdatedAt: input.expectedUpdatedAt,
      humanGate: input.humanGate,
      planClaimReceiptId: initial.planClaimReceiptId,
      executionClaimReceiptId: initial.executionClaimReceiptId,
    } as any)).resolves.toMatchObject({ agent: { status: "terminated" } });
  });

  it("distinguishes an unstarted expired source from a previously started execution claim", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const claimed = agentRetirementService(db, {
      now: () => new Date(NOW.getTime() + 50 * 60 * 1_000), backupRoot, retirementEvidenceRoot, workspaceRoot,
    });
    const response = await claimed.preflight(SOURCE_ID, claimPreflight(input) as any);
    expect(response.claimState).toBe("unstarted_expired");
    expect(response.planClaimReceiptId).toBeNull();
    expect(response.executionClaimReceiptId).toBeNull();
    expect(response.blockers.map((blocker) => blocker.code)).toContain("retirement_plan_unstarted_expired");
  });

  it("rejects a future-dated client plan instead of minting an extended execution lease", async () => {
    await seedReadyPortfolio();
    const input = evidence();
    const base = retirementPlan(input);
    const { receiptId: _receiptId, ...futureCore } = {
      ...base,
      validatedAt: "2026-07-14T10:10:00.000Z",
      expiresAt: "2026-07-14T16:10:00.000Z",
    };
    const future = { ...futureCore, receiptId: `v1:sha256:${stableSha256(futureCore)}` };
    await expect(service().preflight(SOURCE_ID, {
      evidence: input,
      plan: future,
      evidenceBySourceId: fullPlanEvidence(input),
      claimExecution: true,
      executionClaimReceiptId: null,
    } as any)).rejects.toMatchObject({
      status: 409,
      details: { code: "retirement_plan_invalid" },
    });
  });

  describe("retirement waves", () => {
    const WAVE_TWO_ENTRY = AGENT_RETIREMENT_ALLOWLIST_ENTRIES.find((entry) => (
      entry.sourceAgentId !== SOURCE_ID && entry.canaryAgentId === REPLACEMENT_ID
    ))!;
    const WAVE_ONE = [SOURCE_ID];
    const WAVE_TWO = [WAVE_TWO_ENTRY.sourceAgentId];
    const WAVE_TWO_CLOCK = new Date("2026-07-13T10:25:00.000Z");
    const WAVE_TWO_COMMENT_ID = "99999999-9999-4999-8999-999999999999";
    const WAVE_TWO_NONCE = "e".repeat(64);

    function waveScope(wave: number, sourceIds: readonly string[]) {
      return `wave${wave}_${sourceIds.length}_allowlisted_sources_tombstone_only`;
    }

    function waveManifestSha256(sourceIds: readonly string[]) {
      return stableSha256(CANONICAL_RETIREMENT_MANIFEST.filter((entry) => (
        sourceIds.includes(entry.sourceAgentId)
      )));
    }

    function waveService(retirementWaves: readonly (readonly string[])[], now: Date) {
      return createAgentRetirementService(db, {
        now: () => new Date(now),
        backupRoot,
        retirementEvidenceRoot,
        workspaceRoot,
        retirementWaves,
      });
    }

    function withWaveApproval(
      base: Omit<AgentRetirementEvidence, "humanGate">,
      gate: {
        commentId: string;
        nonce: string;
        approvedAt: string;
        wave: number;
        sourceIds: readonly string[];
        scope?: string;
      },
    ): AgentRetirementEvidence {
      const binding = {
        approvalNonce: gate.nonce,
        manifestSha256: waveManifestSha256(gate.sourceIds),
        backupSha256: base.backupRestore.dumpSha256,
        restoreReceiptSha256: base.backupRestore.restoreEvidenceSha256,
      };
      return {
        ...base,
        humanGate: {
          issueIdentifier: "TEC-355",
          issueId: DECISION_ISSUE_ID,
          commentId: gate.commentId,
          approvedAt: gate.approvedAt,
          ...binding,
          approvedTextSha256: sha256(approvalText(binding, gate.scope ?? waveScope(gate.wave, gate.sourceIds))),
        },
      };
    }

    async function postApproval(input: AgentRetirementEvidence, scope: string) {
      await db.delete(issueComments).where(eq(issueComments.id, input.humanGate.commentId));
      await db.insert(issueComments).values({
        id: input.humanGate.commentId,
        companyId: COMPANY_ID,
        issueId: DECISION_ISSUE_ID,
        authorUserId: "iYvM2oV6FdHMFF6UhD5RQU21dekyfX7B",
        authorType: "user",
        body: approvalText(input.humanGate, scope),
        createdAt: new Date(input.humanGate.approvedAt),
      });
    }

    function wavePlanRequest(
      input: AgentRetirementEvidence,
      sourceIds: readonly string[],
      validatedAt: Date,
      evidenceBySourceId: Record<string, AgentRetirementEvidence> = { [input.source.sourceAgentId]: input },
    ) {
      return {
        evidence: input,
        plan: retirementPlan(input, validatedAt, evidenceBySourceId, {
          sourceIds,
          manifestSha256: waveManifestSha256(sourceIds),
        }),
        evidenceBySourceId,
        claimExecution: true,
        executionClaimReceiptId: null,
      };
    }

    async function retireThroughTermination(
      retirement: ReturnType<typeof createAgentRetirementService>,
      sourceId: string,
      input: AgentRetirementEvidence,
      request: ReturnType<typeof wavePlanRequest>,
    ) {
      const started = await retirement.preflight(sourceId, request as any);
      expect(started).toMatchObject({ claimState: "started" });
      const cleanup = await retirement.cleanup(sourceId, claimedCleanup(input, started) as any);
      const final = await retirement.preflight(sourceId, {
        ...request,
        evidenceBySourceId: null,
        claimExecution: false,
        executionClaimReceiptId: started.executionClaimReceiptId,
      } as any);
      expect(final).toMatchObject({ ok: true, claimState: "termination_ready" });
      return retirement.terminateAuthorized(sourceId, {
        cleanupReceiptId: cleanup.receiptId,
        preflightFingerprint: final.fingerprint,
        expectedUpdatedAt: input.expectedUpdatedAt,
        humanGate: input.humanGate,
        planClaimReceiptId: started.planClaimReceiptId!,
        executionClaimReceiptId: started.executionClaimReceiptId!,
      });
    }

    async function retireWaveOne() {
      const { humanGate: _legacyGate, ...base } = evidence();
      const input = withWaveApproval(base, {
        commentId: HUMAN_COMMENT_ID,
        nonce: APPROVAL_NONCE,
        approvedAt: APPROVED_AT,
        wave: 1,
        sourceIds: WAVE_ONE,
      });
      await postApproval(input, waveScope(1, WAVE_ONE));
      return retireThroughTermination(
        waveService([WAVE_ONE], NOW),
        SOURCE_ID,
        input,
        wavePlanRequest(input, WAVE_ONE, NOW),
      );
    }

    function waveTwoEvidence(options: {
      waveOneTerminatedAt?: string | null;
      commentId?: string;
      nonce?: string;
      wave?: number;
      sourceIds?: readonly string[];
      scope?: string;
    } = {}) {
      const waveOneTerminatedAt = options.waveOneTerminatedAt === undefined
        ? NOW.toISOString()
        : options.waveOneTerminatedAt;
      const artifacts = artifactEvidence(
        WAVE_TWO_ENTRY.sourceAgentId,
        WAVE_TWO_ENTRY.companyId,
        WAVE_TWO_ENTRY.sourceName,
        {
          sourceExportCapturedAt: "2026-07-13T10:15:00.000Z",
          masterKeyCapturedAt: "2026-07-13T10:15:30.000Z",
          dumpCapturedAt: "2026-07-13T10:16:00.000Z",
          restoreVerifiedAt: "2026-07-13T10:17:00.000Z",
          pathSuffix: "-wave2",
          sourceRowOverrides: waveOneTerminatedAt === null ? {} : {
            [SOURCE_ID]: {
              status: "terminated",
              pauseReason: null,
              pausedAt: null,
              errorReason: null,
              updatedAt: waveOneTerminatedAt,
            },
          },
        },
      );
      const canary = portfolioCanaryContract(WAVE_TWO_ENTRY.canaryAgentId);
      return withWaveApproval({
        schemaVersion: "1.0.0",
        source: {
          sourceAgentId: WAVE_TWO_ENTRY.sourceAgentId,
          companyId: WAVE_TWO_ENTRY.companyId,
          decision: "terminate",
          physicalDelete: false,
        },
        expectedUpdatedAt: SOURCE_UPDATED_AT,
        sourceExport: artifacts.sourceExport,
        backupRestore: artifacts.backupRestore,
        replacement: {
          replacementAgentId: WAVE_TWO_ENTRY.replacementAgentId,
          replacementSystemRef: null,
          canaryAgentId: WAVE_TWO_ENTRY.canaryAgentId,
          canaryIssueId: canary.issueId,
          canaryRunId: canary.runId,
          configFingerprint: CONFIG_FINGERPRINT,
        },
      }, {
        commentId: options.commentId ?? WAVE_TWO_COMMENT_ID,
        nonce: options.nonce ?? WAVE_TWO_NONCE,
        approvedAt: "2026-07-13T10:18:00.000Z",
        wave: options.wave ?? 2,
        sourceIds: options.sourceIds ?? WAVE_TWO,
        scope: options.scope,
      });
    }

    async function preparedWaveTwo(options: Parameters<typeof waveTwoEvidence>[0] = {}) {
      const input = waveTwoEvidence(options);
      await postApproval(input, options.scope ?? waveScope(options.wave ?? 2, options.sourceIds ?? WAVE_TWO));
      return { input, request: wavePlanRequest(input, WAVE_TWO, WAVE_TWO_CLOCK) };
    }

    it("registers, cleans, and terminates a later wave after the earlier wave is terminated", async () => {
      await seedReadyPortfolio();
      const waveOne = await retireWaveOne();
      expect(waveOne.receipt).toMatchObject({ status: "terminated", agentId: SOURCE_ID });

      const { input, request } = await preparedWaveTwo();
      const retirement = waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK);
      const terminated = await retireThroughTermination(
        retirement,
        WAVE_TWO_ENTRY.sourceAgentId,
        input,
        request,
      );
      expect(terminated.receipt).toMatchObject({
        status: "terminated",
        agentId: WAVE_TWO_ENTRY.sourceAgentId,
      });
      const registrations = await db.select().from(activityLog)
        .where(eq(activityLog.action, "agent.retirement_plan_registered"));
      expect(registrations.map((row) => (row.details as Record<string, unknown>).sourceCount).sort())
        .toEqual([1, 1]);
      expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(2);
      await expect(retirement.postcheck(SOURCE_ID, {
        cleanupReceiptId: waveOne.receipt.cleanupReceiptId,
        preflightFingerprint: waveOne.receipt.preflightFingerprint,
        expectedUpdatedAt: SOURCE_UPDATED_AT,
        humanGate: withWaveApproval(evidence(), {
          commentId: HUMAN_COMMENT_ID,
          nonce: APPROVAL_NONCE,
          approvedAt: APPROVED_AT,
          wave: 1,
          sourceIds: WAVE_ONE,
        }).humanGate,
        planClaimReceiptId: (await db.select().from(agentRetirementPlanClaims)
          .where(eq(agentRetirementPlanClaims.approvalCommentId, HUMAN_COMMENT_ID)))[0]!.receiptId,
        executionClaimReceiptId: (await db.select().from(agentRetirementExecutionClaims)
          .where(eq(agentRetirementExecutionClaims.sourceAgentId, SOURCE_ID)))[0]!.receiptId,
      })).resolves.toMatchObject({ agentId: SOURCE_ID, status: "terminated" });
    });

    it("reports earlier-wave readiness read-only before and after the earlier wave terminates", async () => {
      await seedReadyPortfolio();
      const readiness = waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK);
      await expect(readiness.assertEarlierWavesTerminated()).rejects.toMatchObject({
        status: 409,
        details: { code: "retirement_earlier_wave_incomplete", sourceId: SOURCE_ID },
      });
      await retireWaveOne();
      await expect(readiness.assertEarlierWavesTerminated()).resolves.toBeUndefined();
      await expect(waveService([WAVE_ONE], NOW).assertEarlierWavesTerminated()).resolves.toBeUndefined();
    });

    it("refuses a later wave while an earlier wave source is still live", async () => {
      await seedReadyPortfolio();
      const { request } = await preparedWaveTwo({ waveOneTerminatedAt: null });
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_earlier_wave_incomplete", sourceId: SOURCE_ID },
        });
      expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(0);
    });

    it("refuses a later wave when an earlier source was terminated outside the audited plan", async () => {
      await seedReadyPortfolio();
      await db.update(agents).set({
        status: "terminated",
        pauseReason: null,
        pausedAt: null,
        updatedAt: NOW,
      }).where(eq(agents.id, SOURCE_ID));
      const { request } = await preparedWaveTwo();
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_earlier_wave_incomplete", sourceId: SOURCE_ID },
        });
    });

    it.each([
      ["a receipt for another company", (receipt: Record<string, any>) => ({
        ...receipt,
        companyId: WAVE_TWO_ENTRY.companyId === COMPANY_ID ? TECHOPS_COMPANY_ID : COMPANY_ID,
      })],
      ["a receipt for another cleanup", (receipt: Record<string, any>) => ({
        ...receipt,
        cleanupReceiptId: `v1:sha256:${"0".repeat(64)}`,
      })],
      ["a receipt dated after the tombstone row", (receipt: Record<string, any>) => ({
        ...receipt,
        terminatedAt: "2026-07-13T10:11:00.000Z",
        tombstone: { ...receipt.tombstone, updatedAt: "2026-07-13T10:11:00.000Z" },
      })],
    ])("refuses a later wave when the earlier termination has %s", async (_label, mutate) => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const [activity] = await db.select().from(activityLog).where(and(
        eq(activityLog.action, "agent.terminated"),
        eq(activityLog.entityId, SOURCE_ID),
      ));
      const details = activity!.details as Record<string, any>;
      await db.update(activityLog).set({
        details: { ...details, receipt: mutate(details.receipt) },
      }).where(eq(activityLog.id, activity!.id));
      const { request } = await preparedWaveTwo();
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_earlier_wave_incomplete", sourceId: SOURCE_ID },
        });
    });

    it("refuses a later wave when the earlier termination activity row belongs to another company", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      await db.update(activityLog).set({ companyId: TECHOPS_COMPANY_ID }).where(and(
        eq(activityLog.action, "agent.terminated"),
        eq(activityLog.entityId, SOURCE_ID),
      ));
      const { request } = await preparedWaveTwo();
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_earlier_wave_incomplete", sourceId: SOURCE_ID },
        });
    });

    it("ignores an unreceipted historical termination entry next to the one audited receipt", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      await db.insert(activityLog).values({
        companyId: COMPANY_ID,
        actorType: "user",
        actorId: "board",
        action: "agent.terminated",
        entityType: "agent",
        entityId: SOURCE_ID,
        agentId: SOURCE_ID,
        details: { source: "manual" },
        createdAt: new Date("2026-04-30T03:59:51.000Z"),
      });
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK).assertEarlierWavesTerminated())
        .resolves.toBeUndefined();
    });

    it("refuses cleanup and recovery of an earlier-wave source once a later wave is current", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const { humanGate: _legacyGate, ...base } = evidence();
      const input = withWaveApproval(base, {
        commentId: HUMAN_COMMENT_ID,
        nonce: APPROVAL_NONCE,
        approvedAt: APPROVED_AT,
        wave: 1,
        sourceIds: WAVE_ONE,
      });
      const [planClaim] = await db.select().from(agentRetirementPlanClaims);
      const [execution] = await db.select().from(agentRetirementExecutionClaims)
        .where(eq(agentRetirementExecutionClaims.sourceAgentId, SOURCE_ID));
      const activityCount = (await db.select().from(activityLog)).length;
      const retirement = waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK);
      const cleanupRequest = {
        evidence: input,
        planClaimReceiptId: planClaim!.receiptId,
        executionClaimReceiptId: execution!.receiptId,
        preflightFingerprint: execution!.initialPreflightFingerprint,
      };
      // Replaying the exact stored cleanup only returns its audit receipt.
      await expect(retirement.cleanup(SOURCE_ID, cleanupRequest as any))
        .resolves.toMatchObject({ receiptId: execution!.cleanupReceiptId });
      await expect(retirement.cleanup(SOURCE_ID, {
        ...cleanupRequest,
        preflightFingerprint: `v1:sha256:${"7".repeat(64)}`,
      } as any)).rejects.toMatchObject({ status: 409, details: { code: "retirement_plan_invalid" } });
      await expect(retirement.preflight(SOURCE_ID, {
        evidence: input,
        planClaimReceiptId: planClaim!.receiptId,
        executionClaimReceiptId: execution!.receiptId,
        recoveryRequestReceiptId: recoveryRequestReceipt(planClaim!.receiptId, execution!.receiptId, input),
        recoverExecution: true,
      } as any)).rejects.toMatchObject({ status: 409, details: { code: "retirement_plan_invalid" } });
      expect((await db.select().from(activityLog)).length).toBe(activityCount);
      expect((await db.select().from(agentRetirementExecutionClaims)
        .where(eq(agentRetirementExecutionClaims.sourceAgentId, SOURCE_ID)))[0]).toEqual(execution);
    });

    it("accepts an earlier tombstone whose row was touched after its audited termination", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const touchedAt = "2026-07-13T10:12:00.000Z";
      await db.update(agents).set({ updatedAt: new Date(touchedAt) }).where(eq(agents.id, SOURCE_ID));
      const { request } = await preparedWaveTwo({ waveOneTerminatedAt: touchedAt });
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .resolves.toMatchObject({ claimState: "started" });
    });

    it("rejects reuse of the earlier wave approval for the next wave", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const reused = waveTwoEvidence({ commentId: HUMAN_COMMENT_ID, nonce: APPROVAL_NONCE });
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, wavePlanRequest(reused, WAVE_TWO, WAVE_TWO_CLOCK) as any))
        .rejects.toMatchObject({
          status: 409,
          details: { code: "retirement_approval_already_consumed" },
        });
    });

    it.each([
      "27_allowlisted_sources_tombstone_only",
      "26_allowlisted_sources_tombstone_only",
      "wave1_1_allowlisted_sources_tombstone_only",
    ])("rejects a fresh approval comment whose text carries scope %s", async (scope) => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const { request } = await preparedWaveTwo({ scope });
      const response = await waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any);
      expect(response).toMatchObject({ ok: false, claimState: "unclaimed" });
      expect(response.blockers.map((blocker) => blocker.code)).toContain("human_gate_invalid");
      expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(1);
    });

    it.each([
      ["the earlier wave", { wave: 1, sourceIds: [SOURCE_ID] }],
      ["the full legacy allowlist", { wave: 1, sourceIds: LEGACY_SINGLE_WAVE[0]! }],
    ])("rejects a fresh approval bound to the manifest of %s", async (_label, gate) => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const { request } = await preparedWaveTwo(gate);
      await expect(waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK)
        .preflight(WAVE_TWO_ENTRY.sourceAgentId, request as any))
        .rejects.toMatchObject({ status: 409, details: { code: "retirement_plan_invalid" } });
      expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(1);
    });

    it("rejects plans and bundles that reach beyond the current wave", async () => {
      await seedReadyPortfolio();
      await retireWaveOne();
      const { input, request } = await preparedWaveTwo();
      const retirement = waveService([WAVE_ONE, WAVE_TWO], WAVE_TWO_CLOCK);
      const widerSourceIds = [...WAVE_ONE, ...WAVE_TWO];
      const widerBundle = { ...fullPlanEvidence(input, widerSourceIds), [input.source.sourceAgentId]: input };
      await expect(retirement.preflight(
        WAVE_TWO_ENTRY.sourceAgentId,
        {
          ...request,
          evidenceBySourceId: widerBundle,
          plan: retirementPlan(input, WAVE_TWO_CLOCK, widerBundle, {
            sourceIds: widerSourceIds,
            manifestSha256: waveManifestSha256(widerSourceIds),
          }),
        } as any,
      )).rejects.toMatchObject({ status: 409, details: { code: "retirement_plan_invalid" } });
      await expect(retirement.preflight(
        WAVE_TWO_ENTRY.sourceAgentId,
        {
          ...request,
          evidenceBySourceId: widerBundle,
          plan: retirementPlan(input, WAVE_TWO_CLOCK, widerBundle, {
            sourceIds: WAVE_TWO,
            manifestSha256: waveManifestSha256(WAVE_TWO),
          }),
        } as any,
      )).rejects.toMatchObject({ status: 409, details: { code: "retirement_plan_evidence_mismatch" } });
      expect(await db.select().from(agentRetirementPlanClaims)).toHaveLength(1);
    });

    it("blocks preflight for sources outside the current wave", async () => {
      await seedReadyPortfolio();
      const response = await waveService([WAVE_ONE, WAVE_TWO], NOW).preflight(SOURCE_ID, evidence());
      expect(response.ok).toBe(false);
      expect(response.blockers.map((blocker) => blocker.code)).toContain("source_not_allowlisted");
    });
  });
});

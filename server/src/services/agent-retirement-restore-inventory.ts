import { createHash } from "node:crypto";
import {
  AGENT_RETIREMENT_ALLOWLIST_ENTRIES,
  AGENT_RETIREMENT_HISTORICAL_TOMBSTONES,
  AGENT_RETIREMENT_RETAINED_AGENTS,
  type AgentRetirementAllowlistEntry,
  type AgentRetirementHistoricalTombstone,
  type AgentRetirementRetainedAgent,
} from "@paperclipai/shared";

export const RETIREMENT_RESTORE_REQUIRED_TABLES = [
  "agent_api_keys",
  "agent_memberships",
  "agent_task_sessions",
  "agent_wakeup_requests",
  "agents",
  "approvals",
  "approval_execution_claims",
  "companies",
  "company_memberships",
  "company_skill_stars",
  "company_secret_bindings",
  "company_secret_versions",
  "company_secrets",
  "goals",
  "heartbeat_runs",
  "environment_leases",
  "issue_recovery_actions",
  "issue_watchdogs",
  "issues",
  "pipeline_cases",
  "pipeline_stages",
  "pipelines",
  "principal_permission_grants",
  "projects",
  "routine_triggers",
  "routine_runs",
  "routine_run_deliveries",
  "routines",
  "user_secret_declarations",
  "workspace_runtime_services",
  "workspace_runtime_start_claims",
  "workspace_operations",
] as const;

type UnknownRecord = Record<string, unknown>;
type ColumnType = "uuid" | "integer" | "bigint" | "timestamp" | "json" | "text" | "boolean";
type RowSpec = readonly [snakeName: string, camelName: string, type: ColumnType, nullable: boolean];
type CanonicalSource = { sourceAgentId: string; companyId: string; sourceName: string };
type CanonicalRetainedAgent = AgentRetirementRetainedAgent;
export type RetirementRestoreAgentPartition = {
  sources: readonly AgentRetirementAllowlistEntry[] | readonly CanonicalSource[];
  retainedAgents: readonly CanonicalRetainedAgent[];
  historicalTombstones: readonly AgentRetirementHistoricalTombstone[];
};
export const RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION: RetirementRestoreAgentPartition =
  Object.freeze({
    sources: AGENT_RETIREMENT_ALLOWLIST_ENTRIES,
    retainedAgents: AGENT_RETIREMENT_RETAINED_AGENTS,
    historicalTombstones: AGENT_RETIREMENT_HISTORICAL_TOMBSTONES,
  });
export type RetirementRestoreSourceRowProof = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  updatedAt: string;
  rowSha256: string;
  immutableRowSha256: string;
};
export type RetirementRestoreAccessRowProof = {
  id: string;
  sourceAgentId: string;
  companyId: string;
  rowSha256: string;
};
export type RetirementRestoreRetainedAgentRowProof = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  updatedAt: string;
  hasLifecycleContract: boolean;
  rowSha256: string;
};
export type RetirementRestoreHistoricalTombstoneRowProof = {
  id: string;
  companyId: string;
  name: string;
  status: "terminated";
  updatedAt: string;
  rowSha256: string;
};
export type RetirementRestoreHistoricalStatusRowProof = {
  id: string;
  agentId: string;
  companyId: string;
  status: string;
  rowSha256: string;
};
export type RetirementRestoreHistoricalTaskSessionRowProof = {
  id: string;
  agentId: string;
  companyId: string;
  lastRunId: string | null;
  rowSha256: string;
};
export type RetirementRestoreHistoricalRoutineTriggerRowProof = {
  id: string;
  routineId: string;
  companyId: string;
  enabled: false;
  rowSha256: string;
};
export type RetirementRestoreHistoricalRoutineRunRowProof = {
  id: string;
  routineId: string;
  agentId: string;
  companyId: string;
  status: string;
  rowSha256: string;
};
export type RetirementRestoreHistoricalRoutineDeliveryRowProof = {
  id: string;
  routineRunId: string;
  agentId: string;
  companyId: string;
  status: "delivered" | "failed";
  rowSha256: string;
};
export type RetirementRestoreApprovalExecutionClaimRowProof = {
  id: string;
  portfolioAgentId: string;
  claimAgentId: string;
  companyId: string;
  originRunId: string;
  executorRunId: string;
  rowSha256: string;
};
export type RetirementRestoreWorkspaceRuntimeStartClaimRowProof = {
  id: string;
  portfolioAgentId: string;
  companyId: string;
  serviceKey: string;
  claimId: string;
  status: "stopped" | "failed";
  runtimeServiceId: string | null;
  runtimeServiceOwnerAgentId: string | null;
  ownerAgentId: string | null;
  failureCode: string | null;
  claimedAt: string;
  expiresAt: string;
  finalizedAt: string | null;
  updatedAt: string;
  rowSha256: string;
};
export type RetirementRestoreHistoricalRunLinkedRowProof = {
  id: string;
  runId: string;
  agentId: string;
  companyId: string;
  status: string;
  rowSha256: string;
};
export type RetirementRestoreHistoricalEnvironmentLeaseRowProof = Omit<RetirementRestoreHistoricalRunLinkedRowProof, "runId"> & {
  runId: string | null;
  leasePolicy: string;
  cleanupStatus: string | null;
};
export type RetirementRestoreLifecycleRowProof = {
  id: string;
  companyId: string;
  rowSha256: string;
};
export type RetirementRestoreCompanyRowProof = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  rowSha256: string;
};
export type RetirementRestoreSecretRowProof = {
  id: string;
  companyId: string;
  provider: string;
  status: string;
  rowSha256: string;
};
export type RetirementRestoreSecretVersionRowProof = {
  id: string;
  secretId: string;
  version: number;
  status: string;
  rowSha256: string;
};
export type RetirementRestoreSecretBindingRowProof = {
  id: string;
  companyId: string;
  secretId: string;
  rowSha256: string;
};
type ProofSection<T> = { count: number; rowsSha256: string; rows: T[] };
export type RetirementRestoreInventoryProof = {
  schemaVersion: "3.0.0";
  sourceAgents: ProofSection<RetirementRestoreSourceRowProof>;
  retainedAgents: ProofSection<RetirementRestoreRetainedAgentRowProof>;
  historicalTombstones: ProofSection<RetirementRestoreHistoricalTombstoneRowProof>;
  lifecycleContractAgents: ProofSection<RetirementRestoreLifecycleRowProof>;
  companies: ProofSection<RetirementRestoreCompanyRowProof>;
  activeApiKeys: ProofSection<RetirementRestoreAccessRowProof>;
  principalPermissionGrants: ProofSection<RetirementRestoreAccessRowProof>;
  activeCompanyMemberships: ProofSection<RetirementRestoreAccessRowProof>;
  nonLeftAgentMemberships: ProofSection<RetirementRestoreAccessRowProof>;
  agentSecretBindings: ProofSection<RetirementRestoreAccessRowProof>;
  agentUserSecretDeclarations: ProofSection<RetirementRestoreAccessRowProof>;
  agentSkillStars: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveApiKeys: ProofSection<RetirementRestoreAccessRowProof>;
  historicalPrincipalPermissionGrants: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveCompanyMemberships: ProofSection<RetirementRestoreAccessRowProof>;
  historicalNonLeftAgentMemberships: ProofSection<RetirementRestoreAccessRowProof>;
  historicalAgentSecretBindings: ProofSection<RetirementRestoreAccessRowProof>;
  historicalAgentUserSecretDeclarations: ProofSection<RetirementRestoreAccessRowProof>;
  historicalAgentSkillStars: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveProjectLeads: ProofSection<RetirementRestoreAccessRowProof>;
  historicalOperativeGoalOwnerships: ProofSection<RetirementRestoreAccessRowProof>;
  historicalHeartbeatRuns: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalWorkspaceRuntimeServices: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalApprovals: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalTaskSessions: ProofSection<RetirementRestoreHistoricalTaskSessionRowProof>;
  historicalIssues: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalRoutines: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalRoutineTriggers: ProofSection<RetirementRestoreHistoricalRoutineTriggerRowProof>;
  historicalRoutineRuns: ProofSection<RetirementRestoreHistoricalRoutineRunRowProof>;
  historicalRoutineDeliveries: ProofSection<RetirementRestoreHistoricalRoutineDeliveryRowProof>;
  approvalExecutionClaims: ProofSection<RetirementRestoreApprovalExecutionClaimRowProof>;
  workspaceRuntimeStartClaims: ProofSection<RetirementRestoreWorkspaceRuntimeStartClaimRowProof>;
  historicalWakeRequests: ProofSection<RetirementRestoreHistoricalStatusRowProof>;
  historicalActiveIssueWatchdogs: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveRecoveryActions: ProofSection<RetirementRestoreAccessRowProof>;
  historicalPipelineAgentLeases: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveReportees: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActivePipelineApprovers: ProofSection<RetirementRestoreAccessRowProof>;
  historicalActiveHireApprovalReferences: ProofSection<RetirementRestoreAccessRowProof>;
  historicalEnvironmentLeases: ProofSection<RetirementRestoreHistoricalEnvironmentLeaseRowProof>;
  historicalOutstandingEnvironmentLeases: ProofSection<RetirementRestoreAccessRowProof>;
  historicalWorkspaceOperations: ProofSection<RetirementRestoreHistoricalRunLinkedRowProof>;
  historicalRunningWorkspaceOperations: ProofSection<RetirementRestoreAccessRowProof>;
  companySecrets: ProofSection<RetirementRestoreSecretRowProof>;
  companySecretVersions: ProofSection<RetirementRestoreSecretVersionRowProof>;
  companySecretBindings: ProofSection<RetirementRestoreSecretBindingRowProof>;
  inventorySha256: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COUNT = 27;
const RETAINED_COUNT = 33;
const HISTORICAL_TOMBSTONE_COUNT = 2;
const MAX_TRACKED_ROWS = 100_000;
const MAX_DUMP_TABLES = 2_048;
const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_RUNTIME_SERVICE_STATUSES = new Set(["stopped", "failed"]);
const TERMINAL_RUNTIME_START_CLAIM_STATUSES = new Set(["stopped", "failed"]);
const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "rejected", "cancelled"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const TERMINAL_GOAL_STATUSES = new Set(["achieved", "cancelled"]);
const TERMINAL_WATCHDOG_STATUSES = new Set(["disabled"]);
const TERMINAL_RECOVERY_ACTION_STATUSES = new Set(["resolved", "cancelled"]);
const INACTIVE_ROUTINE_STATUSES = new Set(["paused", "archived"]);
const TERMINAL_WAKE_REQUEST_STATUSES = new Set([
  "coalesced", "skipped", "completed", "failed", "cancelled", "timed_out",
]);
const TERMINAL_ROUTINE_RUN_STATUSES = new Set(["coalesced", "skipped", "issue_created", "completed", "failed"]);
const TERMINAL_ROUTINE_DELIVERY_STATUSES = new Set(["delivered", "failed"]);
const TERMINAL_WORKSPACE_OPERATION_STATUSES = new Set(["succeeded", "failed", "skipped"]);
export function isOperativeRetirementGoalStatus(status: string) {
  return !TERMINAL_GOAL_STATUSES.has(status);
}
export function isActiveRetirementIssueWatchdogStatus(status: string) {
  return !TERMINAL_WATCHDOG_STATUSES.has(status);
}
export function isActiveRetirementRecoveryActionStatus(status: string) {
  return !TERMINAL_RECOVERY_ACTION_STATUSES.has(status);
}
export function isActiveRetirementHireApprovalStatus(status: string) {
  return !TERMINAL_APPROVAL_STATUSES.has(status);
}
export function isTerminalRetirementWorkspaceOperation(status: string) {
  return TERMINAL_WORKSPACE_OPERATION_STATUSES.has(status);
}
export function isTerminalRetirementEnvironmentLease(input: {
  leasePolicy: string;
  status: string;
  cleanupStatus: string | null;
}) {
  if (input.leasePolicy === "reuse_by_environment") {
    return input.status === "expired" && input.cleanupStatus === "success";
  }
  return (["released", "expired"].includes(input.status) && [null, "success"].includes(input.cleanupStatus))
    || (input.status === "failed" && input.cleanupStatus === "success");
}
const SECTION_NAMES = [
  "sourceAgents",
  "retainedAgents",
  "historicalTombstones",
  "lifecycleContractAgents",
  "companies",
  "activeApiKeys",
  "principalPermissionGrants",
  "activeCompanyMemberships",
  "nonLeftAgentMemberships",
  "agentSecretBindings",
  "agentUserSecretDeclarations",
  "agentSkillStars",
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
] as const;

const ROW_SCHEMAS: Record<string, readonly RowSpec[]> = {
  agents: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["name", "name", "text", false],
    ["role", "role", "text", false],
    ["title", "title", "text", true],
    ["icon", "icon", "text", true],
    ["status", "status", "text", false],
    ["reports_to", "reportsTo", "uuid", true],
    ["capabilities", "capabilities", "text", true],
    ["adapter_type", "adapterType", "text", false],
    ["adapter_config", "adapterConfig", "json", false],
    ["runtime_config", "runtimeConfig", "json", false],
    ["default_environment_id", "defaultEnvironmentId", "uuid", true],
    ["budget_monthly_cents", "budgetMonthlyCents", "integer", false],
    ["spent_monthly_cents", "spentMonthlyCents", "integer", false],
    ["pause_reason", "pauseReason", "text", true],
    ["paused_at", "pausedAt", "timestamp", true],
    ["error_reason", "errorReason", "text", true],
    ["permissions", "permissions", "json", false],
    ["last_heartbeat_at", "lastHeartbeatAt", "timestamp", true],
    ["metadata", "metadata", "json", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  agent_api_keys: [
    ["id", "id", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["name", "name", "text", false],
    ["key_hash", "keyHash", "text", false],
    ["responsible_user_id", "responsibleUserId", "text", true],
    ["scope_config", "scopeConfig", "json", true],
    ["last_used_at", "lastUsedAt", "timestamp", true],
    ["revoked_at", "revokedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
  ],
  principal_permission_grants: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["principal_type", "principalType", "text", false],
    ["principal_id", "principalId", "text", false],
    ["permission_key", "permissionKey", "text", false],
    ["scope", "scope", "json", true],
    ["granted_by_user_id", "grantedByUserId", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  company_memberships: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["principal_type", "principalType", "text", false],
    ["principal_id", "principalId", "text", false],
    ["status", "status", "text", false],
    ["membership_role", "membershipRole", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  agent_memberships: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["user_id", "userId", "text", false],
    ["state", "state", "text", false],
    ["starred_at", "starredAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  projects: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["goal_id", "goalId", "uuid", true],
    ["name", "name", "text", false],
    ["description", "description", "text", true],
    ["status", "status", "text", false],
    ["lead_agent_id", "leadAgentId", "uuid", true],
    ["target_date", "targetDate", "text", true],
    ["color", "color", "text", true],
    ["icon", "icon", "text", true],
    ["env", "env", "json", true],
    ["pause_reason", "pauseReason", "text", true],
    ["paused_at", "pausedAt", "timestamp", true],
    ["execution_workspace_policy", "executionWorkspacePolicy", "json", true],
    ["archived_at", "archivedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  goals: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["title", "title", "text", false],
    ["description", "description", "text", true],
    ["level", "level", "text", false],
    ["status", "status", "text", false],
    ["parent_id", "parentId", "uuid", true],
    ["owner_agent_id", "ownerAgentId", "uuid", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  workspace_runtime_services: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["project_id", "projectId", "uuid", true],
    ["project_workspace_id", "projectWorkspaceId", "uuid", true],
    ["execution_workspace_id", "executionWorkspaceId", "uuid", true],
    ["issue_id", "issueId", "uuid", true],
    ["scope_type", "scopeType", "text", false],
    ["scope_id", "scopeId", "text", true],
    ["service_name", "serviceName", "text", false],
    ["status", "status", "text", false],
    ["lifecycle", "lifecycle", "text", false],
    ["reuse_key", "reuseKey", "text", true],
    ["command", "command", "text", true],
    ["cwd", "cwd", "text", true],
    ["port", "port", "integer", true],
    ["url", "url", "text", true],
    ["provider", "provider", "text", false],
    ["provider_ref", "providerRef", "text", true],
    ["owner_agent_id", "ownerAgentId", "uuid", true],
    ["started_by_run_id", "startedByRunId", "uuid", true],
    ["last_used_at", "lastUsedAt", "timestamp", false],
    ["started_at", "startedAt", "timestamp", false],
    ["stopped_at", "stoppedAt", "timestamp", true],
    ["stop_policy", "stopPolicy", "json", true],
    ["health_status", "healthStatus", "text", false],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["exposure", "exposure", "json", true],
    ["exposure_handle", "exposureHandle", "text", true],
    ["backend_url", "backendUrl", "text", true],
  ],
  workspace_runtime_start_claims: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["service_key", "serviceKey", "text", false],
    ["claim_id", "claimId", "uuid", false],
    ["status", "status", "text", false],
    ["runtime_service_id", "runtimeServiceId", "uuid", true],
    ["owner_agent_id", "ownerAgentId", "uuid", true],
    ["failure_code", "failureCode", "text", true],
    ["claimed_at", "claimedAt", "timestamp", false],
    ["expires_at", "expiresAt", "timestamp", false],
    ["finalized_at", "finalizedAt", "timestamp", true],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  approvals: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["type", "type", "text", false],
    ["requested_by_agent_id", "requestedByAgentId", "uuid", true],
    ["requested_by_user_id", "requestedByUserId", "text", true],
    ["status", "status", "text", false],
    ["payload", "payload", "json", false],
    ["decision_note", "decisionNote", "text", true],
    ["decided_by_user_id", "decidedByUserId", "text", true],
    ["decided_at", "decidedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  approval_execution_claims: [
    ["id", "id", "uuid", false],
    ["approval_id", "approvalId", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["issue_id", "issueId", "uuid", false],
    ["origin_run_id", "originRunId", "uuid", false],
    ["executor_run_id", "executorRunId", "uuid", false],
    ["execution_run_id", "executionRunId", "text", false],
    ["approval_payload_sha256", "approvalPayloadSha256", "text", false],
    ["call_fingerprint_sha256", "callFingerprintSha256", "text", false],
    ["receipt_sha256", "receiptSha256", "text", false],
    ["status", "status", "text", false],
    ["claimed_at", "claimedAt", "timestamp", false],
    ["expires_at", "expiresAt", "timestamp", false],
    ["execution_started_at", "executionStartedAt", "timestamp", true],
    ["execution_expires_at", "executionExpiresAt", "timestamp", true],
    ["execution_receipt_sha256", "executionReceiptSha256", "text", true],
    ["finished_at", "finishedAt", "timestamp", true],
    ["failure_code", "failureCode", "text", true],
    ["finalization_receipt_sha256", "finalizationReceiptSha256", "text", true],
    ["revoked_at", "revokedAt", "timestamp", true],
    ["revocation_reason", "revocationReason", "text", true],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  agent_task_sessions: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["adapter_type", "adapterType", "text", false],
    ["task_key", "taskKey", "text", false],
    ["session_params_json", "sessionParamsJson", "json", true],
    ["session_display_id", "sessionDisplayId", "text", true],
    ["last_run_id", "lastRunId", "uuid", true],
    ["last_error", "lastError", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  heartbeat_runs: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["invocation_source", "invocationSource", "text", false],
    ["trigger_detail", "triggerDetail", "text", true],
    ["status", "status", "text", false],
    ["responsible_user_id", "responsibleUserId", "text", true],
    ["started_at", "startedAt", "timestamp", true],
    ["finished_at", "finishedAt", "timestamp", true],
    ["error", "error", "text", true],
    ["wakeup_request_id", "wakeupRequestId", "uuid", true],
    ["exit_code", "exitCode", "integer", true],
    ["signal", "signal", "text", true],
    ["usage_json", "usageJson", "json", true],
    ["result_json", "resultJson", "json", true],
    ["session_id_before", "sessionIdBefore", "text", true],
    ["session_id_after", "sessionIdAfter", "text", true],
    ["log_store", "logStore", "text", true],
    ["log_ref", "logRef", "text", true],
    ["log_bytes", "logBytes", "bigint", true],
    ["log_sha256", "logSha256", "text", true],
    ["log_compressed", "logCompressed", "boolean", false],
    ["stdout_excerpt", "stdoutExcerpt", "text", true],
    ["stderr_excerpt", "stderrExcerpt", "text", true],
    ["error_code", "errorCode", "text", true],
    ["external_run_id", "externalRunId", "text", true],
    ["process_pid", "processPid", "integer", true],
    ["process_group_id", "processGroupId", "integer", true],
    ["process_started_at", "processStartedAt", "timestamp", true],
    ["process_executable", "processExecutable", "text", true],
    ["process_command_sha256", "processCommandSha256", "text", true],
    ["last_output_at", "lastOutputAt", "timestamp", true],
    ["last_output_seq", "lastOutputSeq", "integer", false],
    ["last_output_stream", "lastOutputStream", "text", true],
    ["last_output_bytes", "lastOutputBytes", "bigint", true],
    ["retry_of_run_id", "retryOfRunId", "uuid", true],
    ["process_loss_retry_count", "processLossRetryCount", "integer", false],
    ["scheduled_retry_at", "scheduledRetryAt", "timestamp", true],
    ["scheduled_retry_attempt", "scheduledRetryAttempt", "integer", false],
    ["scheduled_retry_reason", "scheduledRetryReason", "text", true],
    ["issue_comment_status", "issueCommentStatus", "text", false],
    ["issue_comment_satisfied_by_comment_id", "issueCommentSatisfiedByCommentId", "uuid", true],
    ["issue_comment_retry_queued_at", "issueCommentRetryQueuedAt", "timestamp", true],
    ["liveness_state", "livenessState", "text", true],
    ["liveness_reason", "livenessReason", "text", true],
    ["continuation_attempt", "continuationAttempt", "integer", false],
    ["last_useful_action_at", "lastUsefulActionAt", "timestamp", true],
    ["next_action", "nextAction", "text", true],
    ["context_snapshot", "contextSnapshot", "json", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["runtime_mode", "runtimeMode", "text", false],
    ["runtime_mode_resolver_version", "runtimeModeResolverVersion", "text", true],
    ["runtime_mode_reason", "runtimeModeReason", "text", true],
    ["runtime_mode_resolved_at", "runtimeModeResolvedAt", "timestamp", true],
    ["runner_profile_json", "runnerProfileJson", "json", true],
    ["runner_instance_id", "runnerInstanceId", "uuid", true],
    ["native_session_id", "nativeSessionId", "uuid", true],
    ["native_issue_id", "nativeIssueId", "uuid", true],
    ["driver_kind", "driverKind", "text", true],
    ["driver_version", "driverVersion", "text", true],
    ["completion_contract_id", "completionContractId", "uuid", true],
    ["completion_contract_sha256", "completionContractSha256", "text", true],
    ["next_event_seq", "nextEventSeq", "bigint", false],
    ["native_phase", "nativePhase", "text", true],
    ["native_phase_updated_at", "nativePhaseUpdatedAt", "timestamp", true],
  ],
  issues: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["project_id", "projectId", "uuid", true],
    ["project_workspace_id", "projectWorkspaceId", "uuid", true],
    ["goal_id", "goalId", "uuid", true],
    ["parent_id", "parentId", "uuid", true],
    ["title", "title", "text", false],
    ["description", "description", "text", true],
    ["status", "status", "text", false],
    ["work_mode", "workMode", "text", false],
    ["priority", "priority", "text", false],
    ["assignee_agent_id", "assigneeAgentId", "uuid", true],
    ["assignee_user_id", "assigneeUserId", "text", true],
    ["checkout_run_id", "checkoutRunId", "uuid", true],
    ["execution_run_id", "executionRunId", "uuid", true],
    ["execution_agent_name_key", "executionAgentNameKey", "text", true],
    ["execution_locked_at", "executionLockedAt", "timestamp", true],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["responsible_user_id", "responsibleUserId", "text", true],
    ["issue_number", "issueNumber", "integer", true],
    ["identifier", "identifier", "text", true],
    ["origin_kind", "originKind", "text", false],
    ["origin_id", "originId", "text", true],
    ["origin_run_id", "originRunId", "text", true],
    ["origin_fingerprint", "originFingerprint", "text", false],
    ["request_depth", "requestDepth", "integer", false],
    ["billing_code", "billingCode", "text", true],
    ["assignee_adapter_overrides", "assigneeAdapterOverrides", "json", true],
    ["execution_policy", "executionPolicy", "json", true],
    ["execution_state", "executionState", "json", true],
    ["monitor_next_check_at", "monitorNextCheckAt", "timestamp", true],
    ["monitor_wake_requested_at", "monitorWakeRequestedAt", "timestamp", true],
    ["monitor_last_triggered_at", "monitorLastTriggeredAt", "timestamp", true],
    ["monitor_attempt_count", "monitorAttemptCount", "integer", false],
    ["monitor_notes", "monitorNotes", "text", true],
    ["monitor_scheduled_by", "monitorScheduledBy", "text", true],
    ["execution_workspace_id", "executionWorkspaceId", "uuid", true],
    ["execution_workspace_preference", "executionWorkspacePreference", "text", true],
    ["execution_workspace_settings", "executionWorkspaceSettings", "json", true],
    ["source_trust", "sourceTrust", "json", true],
    ["started_at", "startedAt", "timestamp", true],
    ["completed_at", "completedAt", "timestamp", true],
    ["cancelled_at", "cancelledAt", "timestamp", true],
    ["hidden_at", "hiddenAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["harness_kind", "harnessKind", "text", true],
    ["unblock_descriptor", "unblockDescriptor", "json", true],
    ["blocked_transition_at", "blockedTransitionAt", "timestamp", true],
    ["blocked_owner_notified_at", "blockedOwnerNotifiedAt", "timestamp", true],
    ["review_policy", "reviewPolicy", "text", true],
    ["status_version", "statusVersion", "bigint", false],
    ["last_status_decision_id", "lastStatusDecisionId", "uuid", true],
  ],
  routines: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["project_id", "projectId", "uuid", true],
    ["goal_id", "goalId", "uuid", true],
    ["parent_issue_id", "parentIssueId", "uuid", true],
    ["title", "title", "text", false],
    ["description", "description", "text", true],
    ["assignee_agent_id", "assigneeAgentId", "uuid", true],
    ["priority", "priority", "text", false],
    ["status", "status", "text", false],
    ["concurrency_policy", "concurrencyPolicy", "text", false],
    ["catch_up_policy", "catchUpPolicy", "text", false],
    ["origin_kind", "originKind", "text", false],
    ["origin_id", "originId", "text", true],
    ["variables", "variables", "json", false],
    ["env", "env", "json", true],
    ["latest_revision_id", "latestRevisionId", "uuid", true],
    ["latest_revision_number", "latestRevisionNumber", "integer", false],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["responsible_user_id", "responsibleUserId", "text", true],
    ["updated_by_agent_id", "updatedByAgentId", "uuid", true],
    ["updated_by_user_id", "updatedByUserId", "text", true],
    ["last_triggered_at", "lastTriggeredAt", "timestamp", true],
    ["last_enqueued_at", "lastEnqueuedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["activity_gate_policy", "activityGatePolicy", "text", false],
    ["activity_gate_scope", "activityGateScope", "text", false],
    ["folder_id", "folderId", "uuid", true],
  ],
  routine_triggers: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["routine_id", "routineId", "uuid", false],
    ["kind", "kind", "text", false],
    ["label", "label", "text", true],
    ["enabled", "enabled", "boolean", false],
    ["cron_expression", "cronExpression", "text", true],
    ["timezone", "timezone", "text", true],
    ["next_run_at", "nextRunAt", "timestamp", true],
    ["last_fired_at", "lastFiredAt", "timestamp", true],
    ["public_id", "publicId", "text", true],
    ["secret_id", "secretId", "uuid", true],
    ["signing_mode", "signingMode", "text", true],
    ["replay_window_sec", "replayWindowSec", "integer", true],
    ["last_rotated_at", "lastRotatedAt", "timestamp", true],
    ["last_result", "lastResult", "text", true],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["updated_by_agent_id", "updatedByAgentId", "uuid", true],
    ["updated_by_user_id", "updatedByUserId", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  routine_runs: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["routine_id", "routineId", "uuid", false],
    ["trigger_id", "triggerId", "uuid", true],
    ["source", "source", "text", false],
    ["status", "status", "text", false],
    ["triggered_at", "triggeredAt", "timestamp", false],
    ["routine_revision_id", "routineRevisionId", "uuid", true],
    ["responsible_user_id", "responsibleUserId", "text", true],
    ["idempotency_key", "idempotencyKey", "text", true],
    ["trigger_payload", "triggerPayload", "json", true],
    ["dispatch_fingerprint", "dispatchFingerprint", "text", true],
    ["linked_issue_id", "linkedIssueId", "uuid", true],
    ["coalesced_into_run_id", "coalescedIntoRunId", "uuid", true],
    ["failure_reason", "failureReason", "text", true],
    ["completed_at", "completedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  routine_run_deliveries: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["routine_run_id", "routineRunId", "uuid", false],
    ["issue_id", "issueId", "uuid", true],
    ["assignee_agent_id", "assigneeAgentId", "uuid", true],
    ["status", "status", "text", false],
    ["wakeup_idempotency_key", "wakeupIdempotencyKey", "text", false],
    ["claim_token", "claimToken", "uuid", true],
    ["claimed_at", "claimedAt", "timestamp", true],
    ["claim_expires_at", "claimExpiresAt", "timestamp", true],
    ["attempt_count", "attemptCount", "integer", false],
    ["available_at", "availableAt", "timestamp", false],
    ["last_error", "lastError", "text", true],
    ["delivered_wakeup_request_id", "deliveredWakeupRequestId", "uuid", true],
    ["delivered_heartbeat_run_id", "deliveredHeartbeatRunId", "uuid", true],
    ["delivered_at", "deliveredAt", "timestamp", true],
    ["failed_at", "failedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  agent_wakeup_requests: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["agent_id", "agentId", "uuid", false],
    ["source", "source", "text", false],
    ["trigger_detail", "triggerDetail", "text", true],
    ["reason", "reason", "text", true],
    ["payload", "payload", "json", true],
    ["status", "status", "text", false],
    ["coalesced_count", "coalescedCount", "integer", false],
    ["requested_by_actor_type", "requestedByActorType", "text", true],
    ["requested_by_actor_id", "requestedByActorId", "text", true],
    ["idempotency_key", "idempotencyKey", "text", true],
    ["run_id", "runId", "uuid", true],
    ["requested_at", "requestedAt", "timestamp", false],
    ["claimed_at", "claimedAt", "timestamp", true],
    ["finished_at", "finishedAt", "timestamp", true],
    ["error", "error", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  environment_leases: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["environment_id", "environmentId", "uuid", true],
    ["execution_workspace_id", "executionWorkspaceId", "uuid", true],
    ["issue_id", "issueId", "uuid", true],
    ["heartbeat_run_id", "heartbeatRunId", "uuid", true],
    ["status", "status", "text", false],
    ["lease_policy", "leasePolicy", "text", false],
    ["provider", "provider", "text", true],
    ["provider_lease_id", "providerLeaseId", "text", true],
    ["acquired_at", "acquiredAt", "timestamp", false],
    ["last_used_at", "lastUsedAt", "timestamp", false],
    ["expires_at", "expiresAt", "timestamp", true],
    ["released_at", "releasedAt", "timestamp", true],
    ["failure_reason", "failureReason", "text", true],
    ["cleanup_status", "cleanupStatus", "text", true],
    ["metadata", "metadata", "json", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  workspace_operations: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["execution_workspace_id", "executionWorkspaceId", "uuid", true],
    ["heartbeat_run_id", "heartbeatRunId", "uuid", true],
    ["issue_id", "issueId", "uuid", true],
    ["phase", "phase", "text", false],
    ["command", "command", "text", true],
    ["cwd", "cwd", "text", true],
    ["status", "status", "text", false],
    ["exit_code", "exitCode", "integer", true],
    ["log_store", "logStore", "text", true],
    ["log_ref", "logRef", "text", true],
    ["log_bytes", "logBytes", "bigint", true],
    ["log_sha256", "logSha256", "text", true],
    ["log_compressed", "logCompressed", "boolean", false],
    ["stdout_excerpt", "stdoutExcerpt", "text", true],
    ["stderr_excerpt", "stderrExcerpt", "text", true],
    ["metadata", "metadata", "json", true],
    ["started_at", "startedAt", "timestamp", false],
    ["finished_at", "finishedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  issue_watchdogs: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["issue_id", "issueId", "uuid", false],
    ["watchdog_agent_id", "watchdogAgentId", "uuid", false],
    ["instructions", "instructions", "text", true],
    ["status", "status", "text", false],
    ["watchdog_issue_id", "watchdogIssueId", "uuid", true],
    ["last_observed_fingerprint", "lastObservedFingerprint", "text", true],
    ["last_reviewed_fingerprint", "lastReviewedFingerprint", "text", true],
    ["last_triggered_at", "lastTriggeredAt", "timestamp", true],
    ["last_completed_at", "lastCompletedAt", "timestamp", true],
    ["trigger_count", "triggerCount", "integer", false],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["created_by_run_id", "createdByRunId", "uuid", true],
    ["updated_by_agent_id", "updatedByAgentId", "uuid", true],
    ["updated_by_user_id", "updatedByUserId", "text", true],
    ["updated_by_run_id", "updatedByRunId", "uuid", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["last_observed_stop_snapshot", "lastObservedStopSnapshot", "json", true],
    ["last_reviewed_stop_snapshot", "lastReviewedStopSnapshot", "json", true],
  ],
  issue_recovery_actions: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["source_issue_id", "sourceIssueId", "uuid", false],
    ["recovery_issue_id", "recoveryIssueId", "uuid", true],
    ["kind", "kind", "text", false],
    ["status", "status", "text", false],
    ["owner_type", "ownerType", "text", false],
    ["owner_agent_id", "ownerAgentId", "uuid", true],
    ["owner_user_id", "ownerUserId", "text", true],
    ["previous_owner_agent_id", "previousOwnerAgentId", "uuid", true],
    ["return_owner_agent_id", "returnOwnerAgentId", "uuid", true],
    ["cause", "cause", "text", false],
    ["fingerprint", "fingerprint", "text", false],
    ["evidence", "evidence", "json", false],
    ["next_action", "nextAction", "text", false],
    ["wake_policy", "wakePolicy", "json", true],
    ["monitor_policy", "monitorPolicy", "json", true],
    ["attempt_count", "attemptCount", "integer", false],
    ["max_attempts", "maxAttempts", "integer", true],
    ["timeout_at", "timeoutAt", "timestamp", true],
    ["last_attempt_at", "lastAttemptAt", "timestamp", true],
    ["outcome", "outcome", "text", true],
    ["resolution_note", "resolutionNote", "text", true],
    ["resolved_at", "resolvedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  pipelines: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["project_id", "projectId", "uuid", true],
    ["key", "key", "text", false],
    ["name", "name", "text", false],
    ["description", "description", "text", true],
    ["enforce_transitions", "enforceTransitions", "boolean", false],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["archived_at", "archivedAt", "timestamp", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  pipeline_stages: [
    ["id", "id", "uuid", false],
    ["pipeline_id", "pipelineId", "uuid", false],
    ["key", "key", "text", false],
    ["name", "name", "text", false],
    ["kind", "kind", "text", false],
    ["position", "position", "integer", false],
    ["config", "config", "json", false],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  pipeline_cases: [
    ["id", "id", "uuid", false],
    ["company_id", "companyId", "uuid", false],
    ["pipeline_id", "pipelineId", "uuid", false],
    ["stage_id", "stageId", "uuid", false],
    ["case_key", "caseKey", "text", false],
    ["title", "title", "text", false],
    ["summary", "summary", "text", true],
    ["fields", "fields", "json", false],
    ["workspace_ref", "workspaceRef", "json", true],
    ["parent_case_id", "parentCaseId", "uuid", true],
    ["parent_case_version", "parentCaseVersion", "integer", true],
    ["request_key", "requestKey", "text", true],
    ["automation_attempt_id", "automationAttemptId", "uuid", true],
    ["version", "version", "integer", false],
    ["pending_suggestion", "pendingSuggestion", "json", true],
    ["lease_owner_type", "leaseOwnerType", "text", true],
    ["lease_agent_id", "leaseAgentId", "uuid", true],
    ["lease_user_id", "leaseUserId", "text", true],
    ["lease_token", "leaseToken", "uuid", true],
    ["lease_expires_at", "leaseExpiresAt", "timestamp", true],
    ["terminal_kind", "terminalKind", "text", true],
    ["terminal_at", "terminalAt", "timestamp", true],
    ["retired_at", "retiredAt", "timestamp", true],
    ["retired_by_attempt_id", "retiredByAttemptId", "uuid", true],
    ["retired_reason", "retiredReason", "text", true],
    ["hidden_from_board_at", "hiddenFromBoardAt", "timestamp", true],
    ["child_count", "childCount", "integer", false],
    ["terminal_child_count", "terminalChildCount", "integer", false],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["origin_run_id", "originRunId", "uuid", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  companies: [
    ["id", "id", "uuid", false], ["name", "name", "text", false],
    ["description", "description", "text", true], ["status", "status", "text", false],
    ["pause_reason", "pauseReason", "text", true], ["paused_at", "pausedAt", "timestamp", true],
    ["issue_prefix", "issuePrefix", "text", false], ["issue_counter", "issueCounter", "integer", false],
    ["budget_monthly_cents", "budgetMonthlyCents", "integer", false],
    ["spent_monthly_cents", "spentMonthlyCents", "integer", false],
    ["default_responsible_user_id", "defaultResponsibleUserId", "text", true],
    ["require_board_approval_for_new_agents", "requireBoardApprovalForNewAgents", "boolean", false],
    ["feedback_data_sharing_enabled", "feedbackDataSharingEnabled", "boolean", false],
    ["feedback_data_sharing_consent_at", "feedbackDataSharingConsentAt", "timestamp", true],
    ["feedback_data_sharing_consent_by_user_id", "feedbackDataSharingConsentByUserId", "text", true],
    ["feedback_data_sharing_terms_version", "feedbackDataSharingTermsVersion", "text", true],
    ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["interaction_resolver_governance", "interactionResolverGovernance", "json", false],
  ],
  company_secrets: [
    ["id", "id", "uuid", false], ["company_id", "companyId", "uuid", false],
    ["scope", "scope", "text", false], ["owner_user_id", "ownerUserId", "text", true],
    ["user_secret_definition_id", "userSecretDefinitionId", "uuid", true], ["key", "key", "text", false],
    ["name", "name", "text", false], ["provider", "provider", "text", false],
    ["status", "status", "text", false], ["managed_mode", "managedMode", "text", false],
    ["external_ref", "externalRef", "text", true], ["provider_config_id", "providerConfigId", "uuid", true],
    ["provider_metadata", "providerMetadata", "json", true], ["latest_version", "latestVersion", "integer", false],
    ["description", "description", "text", true], ["last_resolved_at", "lastResolvedAt", "timestamp", true],
    ["last_rotated_at", "lastRotatedAt", "timestamp", true], ["deleted_at", "deletedAt", "timestamp", true],
    ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["created_at", "createdAt", "timestamp", false], ["updated_at", "updatedAt", "timestamp", false],
  ],
  company_secret_versions: [
    ["id", "id", "uuid", false], ["secret_id", "secretId", "uuid", false],
    ["version", "version", "integer", false], ["material", "material", "json", false],
    ["value_sha256", "valueSha256", "text", false],
    ["provider_version_ref", "providerVersionRef", "text", true], ["status", "status", "text", false],
    ["fingerprint_sha256", "fingerprintSha256", "text", false],
    ["rotation_job_id", "rotationJobId", "text", true], ["created_by_agent_id", "createdByAgentId", "uuid", true],
    ["created_by_user_id", "createdByUserId", "text", true],
    ["created_at", "createdAt", "timestamp", false], ["revoked_at", "revokedAt", "timestamp", true],
  ],
  company_secret_bindings: [
    ["id", "id", "uuid", false], ["company_id", "companyId", "uuid", false],
    ["secret_id", "secretId", "uuid", false], ["target_type", "targetType", "text", false],
    ["target_id", "targetId", "text", false], ["config_path", "configPath", "text", false],
    ["version_selector", "versionSelector", "text", false], ["required", "required", "boolean", false],
    ["label", "label", "text", true], ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
    ["projection_class", "projectionClass", "text", false],
    ["projection_allowlist_key", "projectionAllowlistKey", "text", true],
  ],
  user_secret_declarations: [
    ["id", "id", "uuid", false], ["company_id", "companyId", "uuid", false],
    ["user_secret_definition_id", "userSecretDefinitionId", "uuid", false],
    ["target_type", "targetType", "text", false], ["target_id", "targetId", "text", false],
    ["config_path", "configPath", "text", false], ["env_key", "envKey", "text", false],
    ["version_selector", "versionSelector", "text", false], ["required", "required", "boolean", false],
    ["allow_missing_override", "allowMissingOverride", "boolean", false],
    ["label", "label", "text", true], ["created_at", "createdAt", "timestamp", false],
    ["updated_at", "updatedAt", "timestamp", false],
  ],
  company_skill_stars: [
    ["id", "id", "uuid", false], ["company_id", "companyId", "uuid", false],
    ["company_skill_id", "companySkillId", "uuid", false], ["agent_id", "agentId", "uuid", true],
    ["user_id", "userId", "text", true], ["created_at", "createdAt", "timestamp", false],
  ],
};

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Retirement restore full row is malformed");
  }
  return value as UnknownRecord;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const record = value as UnknownRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
}

export function retirementRestoreStableSha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function exactKeys(value: unknown, expected: readonly string[], label: string) {
  const record = asRecord(value);
  if (Object.keys(record).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} has an invalid shape`);
  }
  return record;
}

function canonicalSources(
  rawSources: readonly AgentRetirementAllowlistEntry[] | readonly CanonicalSource[],
) {
  if (!Array.isArray(rawSources) || rawSources.length !== SOURCE_COUNT) {
    throw new Error("Retirement inventory requires exactly 27 canonical sources");
  }
  const rows = rawSources.map((raw) => {
    const row = asRecord(raw);
    if (
      !UUID_PATTERN.test(String(row.sourceAgentId ?? ""))
      || !UUID_PATTERN.test(String(row.companyId ?? ""))
      || typeof row.sourceName !== "string"
      || row.sourceName.length === 0
    ) throw new Error("Retirement inventory source allowlist is malformed");
    return {
      sourceAgentId: String(row.sourceAgentId).toLowerCase(),
      companyId: String(row.companyId).toLowerCase(),
      sourceName: row.sourceName,
    };
  }).sort((left, right) => left.sourceAgentId.localeCompare(right.sourceAgentId));
  if (new Set(rows.map((row) => row.sourceAgentId)).size !== SOURCE_COUNT) {
    throw new Error("Retirement inventory source allowlist contains duplicates");
  }
  return rows;
}

function canonicalAgentIdentities(
  rawRows: readonly unknown[],
  label: string,
  options: { tombstone?: boolean } = {},
) {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error(`${label} partition is malformed or exceeds the fixed bound`);
  }
  const rows = rawRows.map((raw) => {
    const row = asRecord(raw);
    const agentId = String(row.agentId ?? row.id ?? "");
    const companyId = String(row.companyId ?? "");
    if (
      !UUID_PATTERN.test(agentId)
      || !UUID_PATTERN.test(companyId)
      || typeof row.name !== "string"
      || row.name.length === 0
      || (options.tombstone && (
        row.expectedStatus !== "terminated"
        || row.disposition !== "preserve_tombstone"
        || row.physicalDelete !== false
      ))
    ) throw new Error(`${label} partition is malformed or violates its disposition`);
    return {
      agentId: agentId.toLowerCase(),
      companyId: companyId.toLowerCase(),
      name: row.name,
      ...(options.tombstone ? {
        expectedStatus: "terminated" as const,
        disposition: "preserve_tombstone" as const,
        physicalDelete: false as const,
      } : {}),
    };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (new Set(rows.map((row) => row.agentId)).size !== rows.length) {
    throw new Error(`${label} partition contains duplicate agents`);
  }
  return rows;
}

function canonicalPartition(rawPartition: RetirementRestoreAgentPartition) {
  const partition = exactKeys(
    rawPartition,
    ["sources", "retainedAgents", "historicalTombstones"],
    "Retirement agent partition",
  );
  const sources = canonicalSources(partition.sources as RetirementRestoreAgentPartition["sources"]);
  const retainedAgents = canonicalAgentIdentities(
    partition.retainedAgents as readonly unknown[],
    "Retained agent",
  );
  const historicalTombstones = canonicalAgentIdentities(
    partition.historicalTombstones as readonly unknown[],
    "Historical tombstone",
    { tombstone: true },
  );
  if (retainedAgents.length !== RETAINED_COUNT) {
    throw new Error("Retirement agent partition requires exactly 33 retained agents");
  }
  if (historicalTombstones.length !== HISTORICAL_TOMBSTONE_COUNT) {
    throw new Error("Retirement agent partition requires exactly 2 historical tombstones");
  }
  const seen = new Set<string>();
  for (const id of [
    ...sources.map((row) => row.sourceAgentId),
    ...retainedAgents.map((row) => row.agentId),
    ...historicalTombstones.map((row) => row.agentId),
  ]) {
    if (seen.has(id)) throw new Error("Retirement agent partition sets must be disjoint");
    seen.add(id);
  }
  if (seen.size !== SOURCE_COUNT + RETAINED_COUNT + HISTORICAL_TOMBSTONE_COUNT) {
    throw new Error("Retirement agent partition must contain exactly 62 unique agents");
  }
  return { sources, retainedAgents, historicalTombstones };
}

function normalizeTimestamp(value: unknown, label: string) {
  if (!(typeof value === "string" || value instanceof Date)) throw new Error(`${label} timestamp is malformed`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} timestamp is malformed`);
  return parsed.toISOString();
}

function normalizeColumn(value: unknown, type: ColumnType, nullable: boolean, label: string): unknown {
  if (value === null) {
    if (!nullable) throw new Error(`${label} must not be null`);
    return null;
  }
  if (value === undefined) throw new Error(`${label} is missing from the full-row proof`);
  if (type === "uuid") {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} UUID is malformed`);
    return value.toLowerCase();
  }
  if (type === "integer") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${label} integer is malformed`);
    return number;
  }
  if (type === "bigint") {
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
        !/^-?\d+$/.test(String(value))) {
      throw new Error(`${label} bigint is malformed`);
    }
    return BigInt(value).toString();
  }
  if (type === "boolean") {
    if (value === true || value === "true" || value === "t") return true;
    if (value === false || value === "false" || value === "f") return false;
    throw new Error(`${label} boolean is malformed`);
  }
  if (type === "timestamp") return normalizeTimestamp(value, label);
  if (type === "json") {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${label} JSON is malformed`);
      }
    }
    if (!parsed || typeof parsed !== "object") throw new Error(`${label} JSON is malformed`);
    return stable(parsed);
  }
  if (typeof value !== "string") throw new Error(`${label} text is malformed`);
  return value;
}

function normalizeFullRow(raw: unknown, table: string) {
  const row = asRecord(raw);
  const projection: UnknownRecord = {};
  const schema = ROW_SCHEMAS[table];
  if (!schema) throw new Error(`Unknown retirement restore table ${table}`);
  for (const [snakeName, camelName, type, nullable] of schema) {
    const value = Object.hasOwn(row, snakeName) ? row[snakeName] : row[camelName];
    projection[snakeName] = normalizeColumn(value, type, nullable, `${table}.${snakeName}`);
  }
  return projection;
}

function proofSection<T>(rows: T[]): ProofSection<T> {
  return { count: rows.length, rowsSha256: retirementRestoreStableSha256(rows), rows };
}

function sourceProof(rawRows: unknown, sources: CanonicalSource[]): RetirementRestoreSourceRowProof[] {
  if (!Array.isArray(rawRows)) throw new Error("Retirement source rows must be an array");
  const expected = new Map(sources.map((row) => [row.sourceAgentId, row]));
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "agents");
    const id = String(full.id);
    const companyId = String(full.company_id);
    const expectedRow = expected.get(id);
    if (
      !expectedRow
      || expectedRow.companyId !== companyId
      || expectedRow.sourceName !== full.name
      || typeof full.status !== "string"
    ) throw new Error("Retirement source rows do not match the canonical 27-source allowlist");
    const immutable = {
      ...full,
      status: null,
      pause_reason: null,
      paused_at: null,
      error_reason: null,
      updated_at: null,
    };
    return {
      id,
      companyId,
      name: String(full.name),
      status: full.status,
      updatedAt: String(full.updated_at),
      rowSha256: retirementRestoreStableSha256(full),
      immutableRowSha256: retirementRestoreStableSha256(immutable),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (
    rows.length !== SOURCE_COUNT
    || new Set(rows.map((row) => row.id)).size !== SOURCE_COUNT
    || rows.some((row, index) => row.id !== sources[index]?.sourceAgentId)
  ) throw new Error("Retirement restore does not contain the exact 27 source-agent rows");
  return rows;
}

function accessProof(input: {
  rawRows: unknown;
  sources: CanonicalSource[];
  label: string;
  table: string;
  sourceColumn: string;
}): RetirementRestoreAccessRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error(`${input.label} rows are malformed or exceed the fixed bound`);
  }
  const expected = new Map(input.sources.map((row) => [row.sourceAgentId, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, input.table);
    const id = String(full.id);
    const sourceAgentId = String(full[input.sourceColumn]).toLowerCase();
    const companyId = String(full.company_id);
    if (!expected.has(sourceAgentId) || expected.get(sourceAgentId)?.companyId !== companyId) {
      throw new Error(`${input.label} row is not bound to a canonical retirement source`);
    }
    return { id, sourceAgentId, companyId, rowSha256: retirementRestoreStableSha256(full) };
  }).sort((left, right) =>
    left.sourceAgentId.localeCompare(right.sourceAgentId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error(`${input.label} contains duplicate access IDs`);
  }
  return rows;
}

function retainedAgentProof(
  rawRows: unknown,
  retainedPartition: CanonicalRetainedAgent[],
): RetirementRestoreRetainedAgentRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Retained agent rows are malformed or exceed the fixed bound");
  }
  const expected = new Map(retainedPartition.map((row) => [row.agentId, row]));
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "agents");
    const id = String(full.id);
    const expectedRow = expected.get(id);
    if (
      !expectedRow
      || expectedRow.companyId !== full.company_id
      || expectedRow.name !== full.name
    ) throw new Error("Retained agent inventory does not match the exact retained partition");
    const metadata = full.metadata as UnknownRecord | null;
    return {
      id,
      companyId: String(full.company_id),
      name: String(full.name),
      status: String(full.status),
      updatedAt: String(full.updated_at),
      hasLifecycleContract: Boolean(metadata && Object.hasOwn(metadata, "lifecycle")),
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Retained agent inventory contains duplicate agents");
  }
  if (
    rows.length !== retainedPartition.length
    || rows.some((row, index) => row.id !== retainedPartition[index]?.agentId)
  ) throw new Error("Retained agent inventory does not contain the exact retained partition");
  return rows;
}

function historicalTombstoneProof(
  rawRows: unknown,
  tombstonePartition: AgentRetirementHistoricalTombstone[],
): RetirementRestoreHistoricalTombstoneRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical tombstone rows are malformed or exceed the fixed bound");
  }
  const expected = new Map(tombstonePartition.map((row) => [row.agentId, row]));
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "agents");
    const id = String(full.id);
    const expectedRow = expected.get(id);
    if (
      !expectedRow
      || expectedRow.companyId !== full.company_id
      || expectedRow.name !== full.name
      || full.status !== "terminated"
    ) throw new Error("Historical tombstone inventory must match the exact preserved terminated partition");
    return {
      id,
      companyId: String(full.company_id),
      name: String(full.name),
      status: "terminated" as const,
      updatedAt: String(full.updated_at),
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length
    || rows.length !== tombstonePartition.length
    || rows.some((row, index) => row.id !== tombstonePartition[index]?.agentId)
  ) throw new Error("Historical tombstone inventory does not contain the exact preserved terminated partition");
  return rows;
}

function historicalAccessInertness(rawRows: unknown, label: string): RetirementRestoreAccessRowProof[] {
  if (!Array.isArray(rawRows)) throw new Error(`${label} tombstone access rows are malformed`);
  if (rawRows.length !== 0) throw new Error(`${label} proves a historical tombstone is not access-inert`);
  return [];
}

function historicalActiveReferenceInertness(rawRows: unknown, label: string): RetirementRestoreAccessRowProof[] {
  if (!Array.isArray(rawRows)) throw new Error(`${label} tombstone reference rows are malformed`);
  if (rawRows.length !== 0) throw new Error(`${label} proves a historical tombstone is not work-inert`);
  return [];
}

function historicalStatusProof(input: {
  rawRows: unknown;
  tombstones: AgentRetirementHistoricalTombstone[];
  table: "heartbeat_runs" | "workspace_runtime_services" | "approvals" | "issues" | "routines" | "agent_wakeup_requests";
  agentColumn: "agent_id" | "owner_agent_id" | "requested_by_agent_id" | "assignee_agent_id";
  label: string;
  terminalStatuses: ReadonlySet<string>;
}): RetirementRestoreHistoricalStatusRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error(`${input.label} rows are malformed or exceed the fixed bound`);
  }
  const expected = new Map(input.tombstones.map((row) => [row.agentId, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, input.table);
    const id = String(full.id);
    const agentId = String(full[input.agentColumn]);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const expectedAgent = expected.get(agentId);
    if (!expectedAgent || expectedAgent.companyId !== companyId || !input.terminalStatuses.has(status)) {
      throw new Error(`${input.label} is not terminal tombstone history`);
    }
    return { id, agentId, companyId, status, rowSha256: retirementRestoreStableSha256(full) };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error(`${input.label} contains duplicate IDs`);
  }
  return rows;
}

function historicalRoutineTriggerProof(input: {
  rawRows: unknown;
  historicalRoutines: RetirementRestoreHistoricalStatusRowProof[];
}): RetirementRestoreHistoricalRoutineTriggerRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical routine trigger rows are malformed or exceed the fixed bound");
  }
  const routines = new Map(input.historicalRoutines.map((row) => [row.id, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "routine_triggers");
    const id = String(full.id);
    const routineId = String(full.routine_id);
    const companyId = String(full.company_id);
    const routine = routines.get(routineId);
    if (!routine || routine.companyId !== companyId || full.enabled !== false) {
      throw new Error("Historical routine trigger is enabled or outside tombstone routine history");
    }
    return {
      id,
      routineId,
      companyId,
      enabled: false as const,
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.routineId.localeCompare(right.routineId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical routine trigger inventory contains duplicate IDs");
  }
  return rows;
}

function historicalRoutineRunProof(input: {
  rawRows: unknown;
  historicalRoutines: RetirementRestoreHistoricalStatusRowProof[];
}): RetirementRestoreHistoricalRoutineRunRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical routine run rows are malformed or exceed the fixed bound");
  }
  const routines = new Map(input.historicalRoutines.map((row) => [row.id, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "routine_runs");
    const id = String(full.id);
    const routineId = String(full.routine_id);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const routine = routines.get(routineId);
    if (!routine || routine.companyId !== companyId || !TERMINAL_ROUTINE_RUN_STATUSES.has(status)) {
      throw new Error("Historical routine run is active, unknown, or outside tombstone routine history");
    }
    return {
      id,
      routineId,
      agentId: routine.agentId,
      companyId,
      status,
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.routineId.localeCompare(right.routineId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical routine run inventory contains duplicate IDs");
  }
  return rows;
}

function historicalRoutineDeliveryProof(input: {
  rawRows: unknown;
  historicalRoutineRuns: RetirementRestoreHistoricalRoutineRunRowProof[];
}): RetirementRestoreHistoricalRoutineDeliveryRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical routine delivery rows are malformed or exceed the fixed bound");
  }
  const runs = new Map(input.historicalRoutineRuns.map((row) => [row.id, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "routine_run_deliveries");
    const id = String(full.id);
    const routineRunId = String(full.routine_run_id);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const run = runs.get(routineRunId);
    if (!run || run.companyId !== companyId || !TERMINAL_ROUTINE_DELIVERY_STATUSES.has(status)) {
      throw new Error("Historical routine delivery is active, unknown, or outside tombstone routine run history");
    }
    return {
      id,
      routineRunId,
      agentId: run.agentId,
      companyId,
      status: status as "delivered" | "failed",
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.routineRunId.localeCompare(right.routineRunId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical routine delivery inventory contains duplicate IDs");
  }
  return rows;
}

function approvalExecutionClaimProof(input: {
  rawRows: unknown;
  portfolioAgents: Array<{ agentId: string; companyId: string }>;
}): RetirementRestoreApprovalExecutionClaimRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Approval execution claim rows are malformed or exceed the fixed bound");
  }
  const agentsById = new Map(input.portfolioAgents.map((row) => [row.agentId, row]));
  const rows = input.rawRows.map((raw) => {
    const wrapper = exactKeys(raw, ["row", "portfolioAgentId"], "Approval execution claim wrapper");
    const full = normalizeFullRow(wrapper.row, "approval_execution_claims");
    const portfolioAgentId = String(wrapper.portfolioAgentId).toLowerCase();
    const claimAgentId = String(full.agent_id);
    const companyId = String(full.company_id);
    const originRunId = String(full.origin_run_id);
    const executorRunId = String(full.executor_run_id);
    const portfolioAgent = agentsById.get(portfolioAgentId);
    if (
      !portfolioAgent
      || portfolioAgent.companyId !== companyId
      || !UUID_PATTERN.test(claimAgentId)
      || !UUID_PATTERN.test(originRunId)
      || !UUID_PATTERN.test(executorRunId)
    ) throw new Error("Approval execution claim is outside the canonical agent partition");
    return {
      id: String(full.id),
      portfolioAgentId,
      claimAgentId,
      companyId,
      originRunId,
      executorRunId,
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.portfolioAgentId.localeCompare(right.portfolioAgentId)
    || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Approval execution claim inventory contains duplicate IDs");
  }
  return rows;
}

function workspaceRuntimeStartClaimProof(input: {
  rawRows: unknown;
  portfolioAgents: Array<{ agentId: string; companyId: string }>;
}): RetirementRestoreWorkspaceRuntimeStartClaimRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Workspace runtime start claim rows are malformed or exceed the fixed bound");
  }
  const agentsById = new Map(input.portfolioAgents.map((row) => [row.agentId, row]));
  const rows = input.rawRows.map((raw) => {
    const wrapper = exactKeys(
      raw,
      ["row", "portfolioAgentId", "runtimeServiceOwnerAgentId"],
      "Workspace runtime start claim wrapper",
    );
    const full = normalizeFullRow(wrapper.row, "workspace_runtime_start_claims");
    const portfolioAgentId = String(wrapper.portfolioAgentId).toLowerCase();
    const runtimeServiceOwnerAgentId = wrapper.runtimeServiceOwnerAgentId === null
      ? null
      : String(wrapper.runtimeServiceOwnerAgentId).toLowerCase();
    const ownerAgentId = full.owner_agent_id === null ? null : String(full.owner_agent_id);
    const runtimeServiceId = full.runtime_service_id === null ? null : String(full.runtime_service_id);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const portfolioAgent = agentsById.get(portfolioAgentId);
    const directBinding = ownerAgentId === portfolioAgentId;
    const runtimeBinding = runtimeServiceId !== null && runtimeServiceOwnerAgentId === portfolioAgentId;
    if (
      !portfolioAgent
      || portfolioAgent.companyId !== companyId
      || (runtimeServiceOwnerAgentId !== null && !UUID_PATTERN.test(runtimeServiceOwnerAgentId))
      || (!directBinding && !runtimeBinding)
      || !TERMINAL_RUNTIME_START_CLAIM_STATUSES.has(status)
      || typeof full.service_key !== "string"
      || full.service_key.trim().length === 0
      || full.service_key.length > 300
    ) {
      throw new Error(
        "Workspace runtime start claim is active, malformed, or outside the canonical agent partition",
      );
    }
    return {
      id: String(full.id),
      portfolioAgentId,
      companyId,
      serviceKey: full.service_key,
      claimId: String(full.claim_id),
      status: status as "stopped" | "failed",
      runtimeServiceId,
      runtimeServiceOwnerAgentId,
      ownerAgentId,
      failureCode: full.failure_code === null ? null : String(full.failure_code),
      claimedAt: String(full.claimed_at),
      expiresAt: String(full.expires_at),
      finalizedAt: full.finalized_at === null ? null : String(full.finalized_at),
      updatedAt: String(full.updated_at),
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.portfolioAgentId.localeCompare(right.portfolioAgentId)
    || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Workspace runtime start claim inventory contains duplicate IDs");
  }
  return rows;
}

function historicalEnvironmentLeaseProof(input: {
  rawRows: unknown;
  terminalRuns: RetirementRestoreHistoricalStatusRowProof[];
  tombstones: AgentRetirementHistoricalTombstone[];
}): RetirementRestoreHistoricalEnvironmentLeaseRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical environment lease rows are malformed or exceed the fixed bound");
  }
  const runs = new Map(input.terminalRuns.map((row) => [row.id, row]));
  const tombstones = new Map(input.tombstones.map((row) => [row.agentId, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "environment_leases");
    const id = String(full.id);
    const runId = full.heartbeat_run_id === null ? null : String(full.heartbeat_run_id);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const leasePolicy = String(full.lease_policy);
    const cleanupStatus = full.cleanup_status === null ? null : String(full.cleanup_status);
    const run = runId === null ? null : runs.get(runId);
    const metadata = asRecord(full.metadata ?? {});
    const ownerIds: string[] = [];
    let malformedOwner = runId !== null && !run;
    if (run) ownerIds.push(run.agentId);
    let reusable: UnknownRecord | null = null;
    if (Object.hasOwn(metadata, "reusableSandboxLease")) {
      const scope = metadata.reusableSandboxLease;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)
        || !Object.hasOwn(scope, "agentId")) {
        malformedOwner = true;
      } else {
        reusable = scope as UnknownRecord;
      }
    }
    for (const [record, key] of [[metadata, "agentId"], [reusable, "agentId"]] as const) {
      if (!record) continue;
      if (!Object.hasOwn(record, key)) continue;
      const value = record[key];
      const normalized = typeof value === "string" ? value.toLowerCase() : null;
      if (!normalized || !tombstones.has(normalized)) {
        malformedOwner = true;
      } else {
        ownerIds.push(normalized);
      }
    }
    const agentId = new Set(ownerIds).size === 1 ? ownerIds[0] ?? null : null;
    const tombstone = agentId ? tombstones.get(agentId) : null;
    const terminal = isTerminalRetirementEnvironmentLease({ leasePolicy, status, cleanupStatus });
    if (malformedOwner || !agentId || !tombstone || tombstone.companyId !== companyId
      || (run && run.companyId !== companyId) || !terminal) {
      throw new Error("Historical environment lease is outstanding, malformed, or outside tombstone run history");
    }
    return {
      id,
      runId,
      agentId,
      companyId,
      status,
      leasePolicy,
      cleanupStatus,
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical environment lease inventory contains duplicate IDs");
  }
  return rows;
}

function historicalWorkspaceOperationProof(input: {
  rawRows: unknown;
  terminalRuns: RetirementRestoreHistoricalStatusRowProof[];
}): RetirementRestoreHistoricalRunLinkedRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical workspace operation rows are malformed or exceed the fixed bound");
  }
  const runs = new Map(input.terminalRuns.map((row) => [row.id, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "workspace_operations");
    const id = String(full.id);
    const runId = String(full.heartbeat_run_id);
    const companyId = String(full.company_id);
    const status = String(full.status);
    const run = runs.get(runId);
    if (!run || run.companyId !== companyId || !isTerminalRetirementWorkspaceOperation(status)) {
      throw new Error("Historical workspace operation is running, malformed, or outside tombstone run history");
    }
    return {
      id,
      runId,
      agentId: run.agentId,
      companyId,
      status,
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical workspace operation inventory contains duplicate IDs");
  }
  return rows;
}

function historicalTaskSessionProof(input: {
  rawRows: unknown;
  tombstones: AgentRetirementHistoricalTombstone[];
  terminalRuns: RetirementRestoreHistoricalStatusRowProof[];
}): RetirementRestoreHistoricalTaskSessionRowProof[] {
  if (!Array.isArray(input.rawRows) || input.rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Historical task session rows are malformed or exceed the fixed bound");
  }
  const expected = new Map(input.tombstones.map((row) => [row.agentId, row]));
  const terminalRuns = new Map(input.terminalRuns.map((row) => [row.id, row]));
  const rows = input.rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "agent_task_sessions");
    const id = String(full.id);
    const agentId = String(full.agent_id);
    const companyId = String(full.company_id);
    const lastRunId = full.last_run_id === null ? null : String(full.last_run_id);
    const expectedAgent = expected.get(agentId);
    if (!expectedAgent || expectedAgent.companyId !== companyId) {
      throw new Error("Historical task session is outside the exact tombstone partition");
    }
    if (lastRunId !== null) {
      const run = terminalRuns.get(lastRunId);
      if (!run || run.agentId !== agentId || run.companyId !== companyId) {
        throw new Error("Historical task session lastRunId is not its own terminal tombstone run");
      }
    }
    return { id, agentId, companyId, lastRunId, rowSha256: retirementRestoreStableSha256(full) };
  }).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Historical task session inventory contains duplicate IDs");
  }
  return rows;
}

function companyProof(rawRows: unknown): RetirementRestoreCompanyRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Company rows are malformed or exceed the fixed bound");
  }
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "companies");
    return {
      id: String(full.id), name: String(full.name), status: String(full.status),
      updatedAt: String(full.updated_at), rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Company inventory contains duplicates");
  return rows;
}

function secretProof(rawRows: unknown, companyIds: Set<string>): RetirementRestoreSecretRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Company secret rows are malformed or exceed the fixed bound");
  }
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "company_secrets");
    const companyId = String(full.company_id);
    if (!companyIds.has(companyId)) throw new Error("Company secret references a company outside the restore inventory");
    return {
      id: String(full.id), companyId, provider: String(full.provider), status: String(full.status),
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Company secret inventory contains duplicates");
  return rows;
}

function secretVersionProof(rawRows: unknown, secretIds: Set<string>): RetirementRestoreSecretVersionRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Company secret version rows are malformed or exceed the fixed bound");
  }
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "company_secret_versions");
    const secretId = String(full.secret_id);
    if (!secretIds.has(secretId)) throw new Error("Company secret version references a secret outside the restore inventory");
    return {
      id: String(full.id), secretId, version: Number(full.version), status: String(full.status),
      rowSha256: retirementRestoreStableSha256(full),
    };
  }).sort((left, right) =>
    left.secretId.localeCompare(right.secretId) || left.version - right.version || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Company secret version inventory contains duplicates");
  return rows;
}

function secretBindingProof(
  rawRows: unknown,
  secretIds: Set<string>,
  companyIds: Set<string>,
): RetirementRestoreSecretBindingRowProof[] {
  if (!Array.isArray(rawRows) || rawRows.length > MAX_TRACKED_ROWS) {
    throw new Error("Company secret binding rows are malformed or exceed the fixed bound");
  }
  const rows = rawRows.map((raw) => {
    const full = normalizeFullRow(raw, "company_secret_bindings");
    const companyId = String(full.company_id);
    const secretId = String(full.secret_id);
    if (!companyIds.has(companyId) || !secretIds.has(secretId)) {
      throw new Error("Company secret binding references state outside the restore inventory");
    }
    return { id: String(full.id), companyId, secretId, rowSha256: retirementRestoreStableSha256(full) };
  }).sort((left, right) =>
    left.companyId.localeCompare(right.companyId) || left.secretId.localeCompare(right.secretId)
      || left.id.localeCompare(right.id));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Company secret binding inventory contains duplicates");
  return rows;
}

export function createRetirementRestoreInventory(
  raw: {
    sourceAgents?: unknown;
    retirementSourceAgents?: unknown;
    retainedAgents?: unknown;
    historicalTombstones?: unknown;
    companies?: unknown;
    activeApiKeys?: unknown;
    principalPermissionGrants?: unknown;
    activeCompanyMemberships?: unknown;
    nonLeftAgentMemberships?: unknown;
    agentSecretBindings?: unknown;
    agentUserSecretDeclarations?: unknown;
    agentSkillStars?: unknown;
    historicalActiveApiKeys?: unknown;
    historicalPrincipalPermissionGrants?: unknown;
    historicalActiveCompanyMemberships?: unknown;
    historicalNonLeftAgentMemberships?: unknown;
    historicalAgentSecretBindings?: unknown;
    historicalAgentUserSecretDeclarations?: unknown;
    historicalAgentSkillStars?: unknown;
    historicalActiveProjectLeads?: unknown;
    historicalOperativeGoalOwnerships?: unknown;
    historicalHeartbeatRuns?: unknown;
    historicalWorkspaceRuntimeServices?: unknown;
    historicalApprovals?: unknown;
    historicalTaskSessions?: unknown;
    historicalIssues?: unknown;
    historicalRoutines?: unknown;
    historicalRoutineTriggers?: unknown;
    historicalRoutineRuns?: unknown;
    historicalRoutineDeliveries?: unknown;
    approvalExecutionClaims?: unknown;
    workspaceRuntimeStartClaims?: unknown;
    historicalWakeRequests?: unknown;
    historicalActiveIssueWatchdogs?: unknown;
    historicalActiveRecoveryActions?: unknown;
    historicalPipelineAgentLeases?: unknown;
    historicalActiveReportees?: unknown;
    historicalActivePipelineApprovers?: unknown;
    historicalActiveHireApprovalReferences?: unknown;
    historicalEnvironmentLeases?: unknown;
    historicalOutstandingEnvironmentLeases?: unknown;
    historicalWorkspaceOperations?: unknown;
    historicalRunningWorkspaceOperations?: unknown;
    companySecrets?: unknown;
    companySecretVersions?: unknown;
    companySecretBindings?: unknown;
  },
  rawPartition: RetirementRestoreAgentPartition,
): RetirementRestoreInventoryProof {
  const { sources, retainedAgents: retainedPartition, historicalTombstones: tombstonePartition } =
    canonicalPartition(rawPartition);
  const retainedAgents = retainedAgentProof(raw.retainedAgents, retainedPartition);
  const historicalTombstones = historicalTombstoneProof(
    raw.historicalTombstones,
    tombstonePartition as AgentRetirementHistoricalTombstone[],
  );
  const canonicalTombstones = tombstonePartition as AgentRetirementHistoricalTombstone[];
  const historicalHeartbeatRuns = historicalStatusProof({
    rawRows: raw.historicalHeartbeatRuns,
    tombstones: canonicalTombstones,
    table: "heartbeat_runs",
    agentColumn: "agent_id",
    label: "Historical heartbeat run",
    terminalStatuses: TERMINAL_HEARTBEAT_RUN_STATUSES,
  });
  const historicalWorkspaceRuntimeServices = historicalStatusProof({
    rawRows: raw.historicalWorkspaceRuntimeServices,
    tombstones: canonicalTombstones,
    table: "workspace_runtime_services",
    agentColumn: "owner_agent_id",
    label: "Historical workspace runtime service",
    terminalStatuses: TERMINAL_RUNTIME_SERVICE_STATUSES,
  });
  const historicalApprovals = historicalStatusProof({
    rawRows: raw.historicalApprovals,
    tombstones: canonicalTombstones,
    table: "approvals",
    agentColumn: "requested_by_agent_id",
    label: "Historical approval",
    terminalStatuses: TERMINAL_APPROVAL_STATUSES,
  });
  const historicalTaskSessions = historicalTaskSessionProof({
    rawRows: raw.historicalTaskSessions,
    tombstones: canonicalTombstones,
    terminalRuns: historicalHeartbeatRuns,
  });
  const historicalIssues = historicalStatusProof({
    rawRows: raw.historicalIssues,
    tombstones: canonicalTombstones,
    table: "issues",
    agentColumn: "assignee_agent_id",
    label: "Historical issue",
    terminalStatuses: TERMINAL_ISSUE_STATUSES,
  });
  const historicalRoutines = historicalStatusProof({
    rawRows: raw.historicalRoutines,
    tombstones: canonicalTombstones,
    table: "routines",
    agentColumn: "assignee_agent_id",
    label: "Historical routine",
    terminalStatuses: INACTIVE_ROUTINE_STATUSES,
  });
  const historicalRoutineTriggers = historicalRoutineTriggerProof({
    rawRows: raw.historicalRoutineTriggers,
    historicalRoutines,
  });
  const historicalRoutineRuns = historicalRoutineRunProof({
    rawRows: raw.historicalRoutineRuns,
    historicalRoutines,
  });
  const historicalRoutineDeliveries = historicalRoutineDeliveryProof({
    rawRows: raw.historicalRoutineDeliveries ?? [],
    historicalRoutineRuns,
  });
  const approvalExecutionClaims = approvalExecutionClaimProof({
    rawRows: raw.approvalExecutionClaims,
    portfolioAgents: [
      ...sources.map((row) => ({ agentId: row.sourceAgentId, companyId: row.companyId })),
      ...canonicalTombstones,
    ],
  });
  const workspaceRuntimeStartClaims = workspaceRuntimeStartClaimProof({
    rawRows: raw.workspaceRuntimeStartClaims ?? [],
    portfolioAgents: [
      ...sources.map((row) => ({ agentId: row.sourceAgentId, companyId: row.companyId })),
      ...canonicalTombstones,
    ],
  });
  const historicalWakeRequests = historicalStatusProof({
    rawRows: raw.historicalWakeRequests,
    tombstones: canonicalTombstones,
    table: "agent_wakeup_requests",
    agentColumn: "agent_id",
    label: "Historical wake request",
    terminalStatuses: TERMINAL_WAKE_REQUEST_STATUSES,
  });
  const historicalEnvironmentLeases = historicalEnvironmentLeaseProof({
    rawRows: raw.historicalEnvironmentLeases,
    terminalRuns: historicalHeartbeatRuns,
    tombstones: canonicalTombstones,
  });
  const historicalWorkspaceOperations = historicalWorkspaceOperationProof({
    rawRows: raw.historicalWorkspaceOperations,
    terminalRuns: historicalHeartbeatRuns,
  });
  const companies = companyProof(raw.companies);
  const companyIds = new Set(companies.map((row) => row.id));
  const companySecrets = secretProof(raw.companySecrets, companyIds);
  const secretIds = new Set(companySecrets.map((row) => row.id));
  const core = {
    schemaVersion: "3.0.0" as const,
    sourceAgents: proofSection(sourceProof(raw.sourceAgents ?? raw.retirementSourceAgents, sources)),
    retainedAgents: proofSection(retainedAgents),
    historicalTombstones: proofSection(historicalTombstones),
    lifecycleContractAgents: proofSection(retainedAgents
      .filter((row) => row.hasLifecycleContract)
      .map((row) => ({ id: row.id, companyId: row.companyId, rowSha256: row.rowSha256 }))),
    companies: proofSection(companies),
    activeApiKeys: proofSection(accessProof({
      rawRows: raw.activeApiKeys,
      sources,
      label: "Active API key",
      table: "agent_api_keys",
      sourceColumn: "agent_id",
    })),
    principalPermissionGrants: proofSection(accessProof({
      rawRows: raw.principalPermissionGrants,
      sources,
      label: "Principal permission grant",
      table: "principal_permission_grants",
      sourceColumn: "principal_id",
    })),
    activeCompanyMemberships: proofSection(accessProof({
      rawRows: raw.activeCompanyMemberships,
      sources,
      label: "Active company membership",
      table: "company_memberships",
      sourceColumn: "principal_id",
    })),
    nonLeftAgentMemberships: proofSection(accessProof({
      rawRows: raw.nonLeftAgentMemberships,
      sources,
      label: "Non-left agent membership",
      table: "agent_memberships",
      sourceColumn: "agent_id",
    })),
    agentSecretBindings: proofSection(accessProof({
      rawRows: raw.agentSecretBindings,
      sources,
      label: "Agent secret binding",
      table: "company_secret_bindings",
      sourceColumn: "target_id",
    })),
    agentUserSecretDeclarations: proofSection(accessProof({
      rawRows: raw.agentUserSecretDeclarations,
      sources,
      label: "Agent user secret declaration",
      table: "user_secret_declarations",
      sourceColumn: "target_id",
    })),
    agentSkillStars: proofSection(accessProof({
      rawRows: raw.agentSkillStars,
      sources,
      label: "Agent skill star",
      table: "company_skill_stars",
      sourceColumn: "agent_id",
    })),
    historicalActiveApiKeys: proofSection(historicalAccessInertness(
      raw.historicalActiveApiKeys,
      "Active API key",
    )),
    historicalPrincipalPermissionGrants: proofSection(historicalAccessInertness(
      raw.historicalPrincipalPermissionGrants,
      "Principal permission grant",
    )),
    historicalActiveCompanyMemberships: proofSection(historicalAccessInertness(
      raw.historicalActiveCompanyMemberships,
      "Active company membership",
    )),
    historicalNonLeftAgentMemberships: proofSection(historicalAccessInertness(
      raw.historicalNonLeftAgentMemberships,
      "Non-left agent membership",
    )),
    historicalAgentSecretBindings: proofSection(historicalAccessInertness(
      raw.historicalAgentSecretBindings,
      "Agent secret binding",
    )),
    historicalAgentUserSecretDeclarations: proofSection(historicalAccessInertness(
      raw.historicalAgentUserSecretDeclarations,
      "Agent user secret declaration",
    )),
    historicalAgentSkillStars: proofSection(historicalAccessInertness(
      raw.historicalAgentSkillStars,
      "Agent skill star",
    )),
    historicalActiveProjectLeads: proofSection(historicalActiveReferenceInertness(
      raw.historicalActiveProjectLeads,
      "Active project lead",
    )),
    historicalOperativeGoalOwnerships: proofSection(historicalActiveReferenceInertness(
      raw.historicalOperativeGoalOwnerships,
      "Operative goal ownership",
    )),
    historicalHeartbeatRuns: proofSection(historicalHeartbeatRuns),
    historicalWorkspaceRuntimeServices: proofSection(historicalWorkspaceRuntimeServices),
    historicalApprovals: proofSection(historicalApprovals),
    historicalTaskSessions: proofSection(historicalTaskSessions),
    historicalIssues: proofSection(historicalIssues),
    historicalRoutines: proofSection(historicalRoutines),
    historicalRoutineTriggers: proofSection(historicalRoutineTriggers),
    historicalRoutineRuns: proofSection(historicalRoutineRuns),
    historicalRoutineDeliveries: proofSection(historicalRoutineDeliveries),
    approvalExecutionClaims: proofSection(approvalExecutionClaims),
    workspaceRuntimeStartClaims: proofSection(workspaceRuntimeStartClaims),
    historicalWakeRequests: proofSection(historicalWakeRequests),
    historicalActiveIssueWatchdogs: proofSection(historicalActiveReferenceInertness(
      raw.historicalActiveIssueWatchdogs,
      "Active issue watchdog",
    )),
    historicalActiveRecoveryActions: proofSection(historicalActiveReferenceInertness(
      raw.historicalActiveRecoveryActions,
      "Active recovery action",
    )),
    historicalPipelineAgentLeases: proofSection(historicalActiveReferenceInertness(
      raw.historicalPipelineAgentLeases,
      "Pipeline agent lease",
    )),
    historicalActiveReportees: proofSection(historicalActiveReferenceInertness(
      raw.historicalActiveReportees,
      "Active reportee",
    )),
    historicalActivePipelineApprovers: proofSection(historicalActiveReferenceInertness(
      raw.historicalActivePipelineApprovers,
      "Active pipeline approver",
    )),
    historicalActiveHireApprovalReferences: proofSection(historicalActiveReferenceInertness(
      raw.historicalActiveHireApprovalReferences,
      "Active hire approval reference",
    )),
    historicalEnvironmentLeases: proofSection(historicalEnvironmentLeases),
    historicalOutstandingEnvironmentLeases: proofSection(historicalActiveReferenceInertness(
      raw.historicalOutstandingEnvironmentLeases,
      "Outstanding environment lease",
    )),
    historicalWorkspaceOperations: proofSection(historicalWorkspaceOperations),
    historicalRunningWorkspaceOperations: proofSection(historicalActiveReferenceInertness(
      raw.historicalRunningWorkspaceOperations,
      "Running workspace operation",
    )),
    companySecrets: proofSection(companySecrets),
    companySecretVersions: proofSection(secretVersionProof(raw.companySecretVersions, secretIds)),
    companySecretBindings: proofSection(secretBindingProof(raw.companySecretBindings, secretIds, companyIds)),
  };
  return { ...core, inventorySha256: retirementRestoreStableSha256(core) };
}

export function assertRetirementRestoreInventory(
  raw: unknown,
  rawPartition: RetirementRestoreAgentPartition,
): RetirementRestoreInventoryProof {
  const { sources, retainedAgents: retainedPartition, historicalTombstones: tombstonePartition } =
    canonicalPartition(rawPartition);
  const expected = new Map(sources.map((row) => [row.sourceAgentId, row]));
  const expectedRetained = new Map(retainedPartition.map((row) => [row.agentId, row]));
  const expectedTombstones = new Map(tombstonePartition.map((row) => [row.agentId, row]));
  const record = exactKeys(raw, ["schemaVersion", ...SECTION_NAMES, "inventorySha256"], "Retirement restore inventory");
  if (record.schemaVersion !== "3.0.0") throw new Error("Retirement restore inventory schema is invalid");
  const normalized: Record<string, ProofSection<UnknownRecord>> = {};
  for (const name of SECTION_NAMES) {
    const sectionRecord = exactKeys(record[name], ["count", "rowsSha256", "rows"], `Retirement restore inventory ${name}`);
    if (
      !Number.isInteger(sectionRecord.count)
      || Number(sectionRecord.count) < 0
      || !SHA256_PATTERN.test(String(sectionRecord.rowsSha256 ?? ""))
      || !Array.isArray(sectionRecord.rows)
    ) throw new Error(`Retirement restore inventory ${name} is malformed`);
    const rows = sectionRecord.rows.map((rawRow) => {
      const label = `Retirement restore inventory ${name} row`;
      const base = (keys: string[]) => {
        const row = exactKeys(rawRow, keys, label);
        if (!UUID_PATTERN.test(String(row.id ?? "")) || !SHA256_PATTERN.test(String(row.rowSha256 ?? ""))) {
          throw new Error(`${label} is malformed`);
        }
        return { row, id: String(row.id).toLowerCase(), rowSha256: String(row.rowSha256) };
      };
      if (name === "sourceAgents") {
        const value = base([
          "id", "companyId", "name", "status", "updatedAt", "rowSha256", "immutableRowSha256",
        ]);
        if (!SHA256_PATTERN.test(String(value.row.immutableRowSha256 ?? ""))) {
          throw new Error("Retirement restore immutable source proof is malformed");
        }
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const expectedRow = expected.get(value.id);
        if (!UUID_PATTERN.test(companyId) || !expectedRow || expectedRow.companyId !== companyId ||
            expectedRow.sourceName !== value.row.name || typeof value.row.status !== "string") {
          throw new Error("Retirement restore source proof is not canonical");
        }
        return { id: value.id, companyId, name: value.row.name, status: value.row.status,
          updatedAt: normalizeTimestamp(value.row.updatedAt, "Retirement source proof"),
          rowSha256: value.rowSha256,
          immutableRowSha256: String(value.row.immutableRowSha256),
        };
      }
      if (name === "retainedAgents") {
        const value = base(["id", "companyId", "name", "status", "updatedAt", "hasLifecycleContract", "rowSha256"]);
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const expectedRow = expectedRetained.get(value.id);
        if (!expectedRow || !UUID_PATTERN.test(companyId) || typeof value.row.name !== "string" ||
            typeof value.row.status !== "string" || typeof value.row.hasLifecycleContract !== "boolean" ||
            expectedRow.companyId !== companyId || expectedRow.name !== value.row.name) {
          throw new Error("Retained agent proof does not match the exact retained partition");
        }
        return { id: value.id, companyId, name: value.row.name, status: value.row.status,
          updatedAt: normalizeTimestamp(value.row.updatedAt, "Retained agent proof"),
          hasLifecycleContract: value.row.hasLifecycleContract, rowSha256: value.rowSha256 };
      }
      if (name === "historicalTombstones") {
        const value = base(["id", "companyId", "name", "status", "updatedAt", "rowSha256"]);
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const expectedRow = expectedTombstones.get(value.id);
        if (!UUID_PATTERN.test(companyId) || !expectedRow || expectedRow.companyId !== companyId ||
            expectedRow.name !== value.row.name || value.row.status !== "terminated") {
          throw new Error("Historical tombstone proof does not match the exact preserved terminated partition");
        }
        return { id: value.id, companyId, name: value.row.name, status: "terminated",
          updatedAt: normalizeTimestamp(value.row.updatedAt, "Historical tombstone proof"),
          rowSha256: value.rowSha256 };
      }
      if ([
        "historicalActiveApiKeys",
        "historicalPrincipalPermissionGrants",
        "historicalActiveCompanyMemberships",
        "historicalNonLeftAgentMemberships",
        "historicalAgentSecretBindings",
        "historicalAgentUserSecretDeclarations",
        "historicalAgentSkillStars",
        "historicalActiveProjectLeads",
        "historicalOperativeGoalOwnerships",
        "historicalActiveIssueWatchdogs",
        "historicalActiveRecoveryActions",
        "historicalPipelineAgentLeases",
        "historicalActiveReportees",
        "historicalActivePipelineApprovers",
        "historicalActiveHireApprovalReferences",
        "historicalOutstandingEnvironmentLeases",
        "historicalRunningWorkspaceOperations",
      ].includes(name)) {
        throw new Error(`Retirement restore inventory ${name} must be an empty inertness proof`);
      }
      if ([
        "historicalHeartbeatRuns",
        "historicalWorkspaceRuntimeServices",
        "historicalApprovals",
        "historicalIssues",
        "historicalRoutines",
        "historicalWakeRequests",
      ].includes(name)) {
        const value = base(["id", "agentId", "companyId", "status", "rowSha256"]);
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const status = value.row.status;
        const expectedRow = expectedTombstones.get(agentId);
        const terminalStatuses = name === "historicalHeartbeatRuns"
          ? TERMINAL_HEARTBEAT_RUN_STATUSES
          : name === "historicalWorkspaceRuntimeServices"
            ? TERMINAL_RUNTIME_SERVICE_STATUSES
            : name === "historicalApprovals"
              ? TERMINAL_APPROVAL_STATUSES
              : name === "historicalIssues"
                ? TERMINAL_ISSUE_STATUSES
                : name === "historicalRoutines"
                  ? INACTIVE_ROUTINE_STATUSES
                  : TERMINAL_WAKE_REQUEST_STATUSES;
        if (
          !UUID_PATTERN.test(agentId)
          || !UUID_PATTERN.test(companyId)
          || !expectedRow
          || expectedRow.companyId !== companyId
          || typeof status !== "string"
          || !terminalStatuses.has(status)
        ) throw new Error(`Retirement restore inventory ${name} is not terminal tombstone history`);
        return { id: value.id, agentId, companyId, status, rowSha256: value.rowSha256 };
      }
      if (name === "historicalRoutineTriggers") {
        const value = base(["id", "routineId", "companyId", "enabled", "rowSha256"]);
        const routineId = String(value.row.routineId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        if (!UUID_PATTERN.test(routineId) || !UUID_PATTERN.test(companyId) || value.row.enabled !== false) {
          throw new Error("Historical routine trigger proof is malformed or enabled");
        }
        return {
          id: value.id,
          routineId,
          companyId,
          enabled: false,
          rowSha256: value.rowSha256,
        };
      }
      if (name === "historicalRoutineRuns") {
        const value = base(["id", "routineId", "agentId", "companyId", "status", "rowSha256"]);
        const routineId = String(value.row.routineId ?? "").toLowerCase();
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const status = String(value.row.status ?? "");
        const expectedRow = expectedTombstones.get(agentId);
        if (!UUID_PATTERN.test(routineId) || !expectedRow || expectedRow.companyId !== companyId
            || !TERMINAL_ROUTINE_RUN_STATUSES.has(status)) {
          throw new Error("Historical routine run proof is active, unknown, or malformed");
        }
        return { id: value.id, routineId, agentId, companyId, status, rowSha256: value.rowSha256 };
      }
      if (name === "historicalRoutineDeliveries") {
        const value = base(["id", "routineRunId", "agentId", "companyId", "status", "rowSha256"]);
        const routineRunId = String(value.row.routineRunId ?? "").toLowerCase();
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const status = String(value.row.status ?? "");
        const expectedRow = expectedTombstones.get(agentId);
        if (!UUID_PATTERN.test(routineRunId) || !expectedRow || expectedRow.companyId !== companyId
            || !TERMINAL_ROUTINE_DELIVERY_STATUSES.has(status)) {
          throw new Error("Historical routine delivery proof is active, unknown, or malformed");
        }
        return { id: value.id, routineRunId, agentId, companyId, status, rowSha256: value.rowSha256 };
      }
      if (name === "approvalExecutionClaims") {
        const value = base([
          "id", "portfolioAgentId", "claimAgentId", "companyId", "originRunId", "executorRunId", "rowSha256",
        ]);
        const portfolioAgentId = String(value.row.portfolioAgentId ?? "").toLowerCase();
        const claimAgentId = String(value.row.claimAgentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const originRunId = String(value.row.originRunId ?? "").toLowerCase();
        const executorRunId = String(value.row.executorRunId ?? "").toLowerCase();
        const expectedRow = expected.get(portfolioAgentId) ?? expectedTombstones.get(portfolioAgentId);
        if (!expectedRow || expectedRow.companyId !== companyId || !UUID_PATTERN.test(claimAgentId)
            || !UUID_PATTERN.test(originRunId) || !UUID_PATTERN.test(executorRunId)) {
          throw new Error("Approval execution claim proof is outside the canonical agent partition");
        }
        return {
          id: value.id,
          portfolioAgentId,
          claimAgentId,
          companyId,
          originRunId,
          executorRunId,
          rowSha256: value.rowSha256,
        };
      }
      if (name === "workspaceRuntimeStartClaims") {
        const value = base([
          "id", "portfolioAgentId", "companyId", "serviceKey", "claimId", "status",
          "runtimeServiceId", "runtimeServiceOwnerAgentId", "ownerAgentId", "failureCode",
          "claimedAt", "expiresAt", "finalizedAt", "updatedAt", "rowSha256",
        ]);
        const portfolioAgentId = String(value.row.portfolioAgentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const claimId = String(value.row.claimId ?? "").toLowerCase();
        const runtimeServiceId = value.row.runtimeServiceId === null
          ? null
          : String(value.row.runtimeServiceId ?? "").toLowerCase();
        const runtimeServiceOwnerAgentId = value.row.runtimeServiceOwnerAgentId === null
          ? null
          : String(value.row.runtimeServiceOwnerAgentId ?? "").toLowerCase();
        const ownerAgentId = value.row.ownerAgentId === null
          ? null
          : String(value.row.ownerAgentId ?? "").toLowerCase();
        const expectedRow = expected.get(portfolioAgentId) ?? expectedTombstones.get(portfolioAgentId);
        const directBinding = ownerAgentId === portfolioAgentId;
        const runtimeBinding = runtimeServiceId !== null
          && runtimeServiceOwnerAgentId === portfolioAgentId;
        if (
          !expectedRow
          || expectedRow.companyId !== companyId
          || !UUID_PATTERN.test(claimId)
          || (runtimeServiceId !== null && !UUID_PATTERN.test(runtimeServiceId))
          || (runtimeServiceOwnerAgentId !== null && !UUID_PATTERN.test(runtimeServiceOwnerAgentId))
          || (ownerAgentId !== null && !UUID_PATTERN.test(ownerAgentId))
          || (!directBinding && !runtimeBinding)
          || !TERMINAL_RUNTIME_START_CLAIM_STATUSES.has(String(value.row.status ?? ""))
          || typeof value.row.serviceKey !== "string"
          || value.row.serviceKey.trim().length === 0
          || value.row.serviceKey.length > 300
          || (value.row.failureCode !== null && typeof value.row.failureCode !== "string")
        ) {
          throw new Error(
            "Workspace runtime start claim proof is active, malformed, or outside the canonical agent partition",
          );
        }
        return {
          id: value.id,
          portfolioAgentId,
          companyId,
          serviceKey: value.row.serviceKey,
          claimId,
          status: String(value.row.status),
          runtimeServiceId,
          runtimeServiceOwnerAgentId,
          ownerAgentId,
          failureCode: value.row.failureCode,
          claimedAt: normalizeTimestamp(value.row.claimedAt, "Runtime start claim claimedAt"),
          expiresAt: normalizeTimestamp(value.row.expiresAt, "Runtime start claim expiresAt"),
          finalizedAt: value.row.finalizedAt === null
            ? null
            : normalizeTimestamp(value.row.finalizedAt, "Runtime start claim finalizedAt"),
          updatedAt: normalizeTimestamp(value.row.updatedAt, "Runtime start claim updatedAt"),
          rowSha256: value.rowSha256,
        };
      }
      if (name === "historicalEnvironmentLeases") {
        const value = base([
          "id", "runId", "agentId", "companyId", "status", "leasePolicy", "cleanupStatus", "rowSha256",
        ]);
        const runId = value.row.runId === null ? null : String(value.row.runId ?? "").toLowerCase();
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const status = String(value.row.status ?? "");
        const leasePolicy = String(value.row.leasePolicy ?? "");
        const cleanupStatus = value.row.cleanupStatus === null ? null : String(value.row.cleanupStatus ?? "");
        const expectedRow = expectedTombstones.get(agentId);
        const terminal = isTerminalRetirementEnvironmentLease({ leasePolicy, status, cleanupStatus });
        if ((runId !== null && !UUID_PATTERN.test(runId)) || !UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(companyId)
            || !expectedRow || expectedRow.companyId !== companyId || !terminal) {
          throw new Error("Historical environment lease proof is outstanding or non-canonical");
        }
        return {
          id: value.id,
          runId,
          agentId,
          companyId,
          status,
          leasePolicy,
          cleanupStatus,
          rowSha256: value.rowSha256,
        };
      }
      if (name === "historicalWorkspaceOperations") {
        const value = base(["id", "runId", "agentId", "companyId", "status", "rowSha256"]);
        const runId = String(value.row.runId ?? "").toLowerCase();
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const status = String(value.row.status ?? "");
        const expectedRow = expectedTombstones.get(agentId);
        if (!UUID_PATTERN.test(runId) || !UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(companyId)
            || !expectedRow || expectedRow.companyId !== companyId
            || !isTerminalRetirementWorkspaceOperation(status)) {
          throw new Error("Historical workspace operation proof is running or non-canonical");
        }
        return { id: value.id, runId, agentId, companyId, status, rowSha256: value.rowSha256 };
      }
      if (name === "historicalTaskSessions") {
        const value = base(["id", "agentId", "companyId", "lastRunId", "rowSha256"]);
        const agentId = String(value.row.agentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const lastRunId = value.row.lastRunId === null
          ? null
          : String(value.row.lastRunId ?? "").toLowerCase();
        const expectedRow = expectedTombstones.get(agentId);
        if (
          !UUID_PATTERN.test(agentId)
          || !UUID_PATTERN.test(companyId)
          || !expectedRow
          || expectedRow.companyId !== companyId
          || (lastRunId !== null && !UUID_PATTERN.test(lastRunId))
        ) throw new Error("Historical task session proof is not canonical");
        return { id: value.id, agentId, companyId, lastRunId, rowSha256: value.rowSha256 };
      }
      if (name === "lifecycleContractAgents") {
        const value = base(["id", "companyId", "rowSha256"]);
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        if (!UUID_PATTERN.test(companyId)) throw new Error("Lifecycle proof company is malformed");
        return { id: value.id, companyId, rowSha256: value.rowSha256 };
      }
      if (name === "companies") {
        const value = base(["id", "name", "status", "updatedAt", "rowSha256"]);
        if (typeof value.row.name !== "string" || typeof value.row.status !== "string") throw new Error("Company proof is malformed");
        return { id: value.id, name: value.row.name, status: value.row.status,
          updatedAt: normalizeTimestamp(value.row.updatedAt, "Company proof"), rowSha256: value.rowSha256 };
      }
      if ([
        "activeApiKeys",
        "principalPermissionGrants",
        "activeCompanyMemberships",
        "nonLeftAgentMemberships",
        "agentSecretBindings",
        "agentUserSecretDeclarations",
        "agentSkillStars",
      ].includes(name)) {
        const value = base(["id", "sourceAgentId", "companyId", "rowSha256"]);
        const sourceAgentId = String(value.row.sourceAgentId ?? "").toLowerCase();
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        const expectedRow = expected.get(sourceAgentId);
        if (!UUID_PATTERN.test(sourceAgentId) || !UUID_PATTERN.test(companyId) || !expectedRow || expectedRow.companyId !== companyId) {
          throw new Error(`Retirement restore inventory ${name} source is not canonical`);
        }
        return { id: value.id, sourceAgentId, companyId, rowSha256: value.rowSha256 };
      }
      if (name === "companySecrets") {
        const value = base(["id", "companyId", "provider", "status", "rowSha256"]);
        const companyId = String(value.row.companyId ?? "").toLowerCase();
        if (!UUID_PATTERN.test(companyId) || typeof value.row.provider !== "string" || typeof value.row.status !== "string") {
          throw new Error("Company secret proof is malformed");
        }
        return { id: value.id, companyId, provider: value.row.provider, status: value.row.status, rowSha256: value.rowSha256 };
      }
      if (name === "companySecretVersions") {
        const value = base(["id", "secretId", "version", "status", "rowSha256"]);
        const secretId = String(value.row.secretId ?? "").toLowerCase();
        if (!UUID_PATTERN.test(secretId) || !Number.isSafeInteger(value.row.version) || Number(value.row.version) < 1 ||
            typeof value.row.status !== "string") throw new Error("Company secret version proof is malformed");
        return { id: value.id, secretId, version: Number(value.row.version), status: value.row.status, rowSha256: value.rowSha256 };
      }
      const value = base(["id", "companyId", "secretId", "rowSha256"]);
      const companyId = String(value.row.companyId ?? "").toLowerCase();
      const secretId = String(value.row.secretId ?? "").toLowerCase();
      if (!UUID_PATTERN.test(companyId) || !UUID_PATTERN.test(secretId)) throw new Error("Company secret binding proof is malformed");
      return { id: value.id, companyId, secretId, rowSha256: value.rowSha256 };
    }).sort((left, right) => {
      if (name === "historicalRoutineRuns") {
        return String(left.routineId).localeCompare(String(right.routineId))
          || String(left.id).localeCompare(String(right.id));
      }
      if (name === "historicalRoutineDeliveries") {
        return String(left.routineRunId).localeCompare(String(right.routineRunId))
          || String(left.id).localeCompare(String(right.id));
      }
      if (name === "approvalExecutionClaims" || name === "workspaceRuntimeStartClaims") {
        return String(left.portfolioAgentId).localeCompare(String(right.portfolioAgentId))
          || String(left.id).localeCompare(String(right.id));
      }
      const leftAgent = typeof left.agentId === "string" ? left.agentId : "";
      const rightAgent = typeof right.agentId === "string" ? right.agentId : "";
      if (leftAgent || rightAgent) {
        return leftAgent.localeCompare(rightAgent) || String(left.id).localeCompare(String(right.id));
      }
      const leftSource = typeof left.sourceAgentId === "string" ? left.sourceAgentId : "";
      const rightSource = typeof right.sourceAgentId === "string" ? right.sourceAgentId : "";
      if (leftSource || rightSource) return leftSource.localeCompare(rightSource) || String(left.id).localeCompare(String(right.id));
      if (name === "companySecretVersions") {
        return String(left.secretId).localeCompare(String(right.secretId)) || Number(left.version) - Number(right.version)
          || String(left.id).localeCompare(String(right.id));
      }
      if (name === "companySecretBindings") {
        return String(left.companyId).localeCompare(String(right.companyId))
          || String(left.secretId).localeCompare(String(right.secretId)) || String(left.id).localeCompare(String(right.id));
      }
      if (name === "historicalRoutineTriggers") {
        return String(left.routineId).localeCompare(String(right.routineId))
          || String(left.id).localeCompare(String(right.id));
      }
      return String(left.id).localeCompare(String(right.id));
    });
    if (
      new Set(rows.map((row) => row.id)).size !== rows.length
      || (name === "sourceAgents" && (
        rows.length !== SOURCE_COUNT
        || rows.some((row, index) => row.id !== sources[index]?.sourceAgentId)
      ))
      || (name === "retainedAgents" && (
        rows.length !== RETAINED_COUNT
        || rows.some((row, index) => row.id !== retainedPartition[index]?.agentId)
      ))
      || (name === "historicalTombstones" && (
        rows.length !== HISTORICAL_TOMBSTONE_COUNT
        || rows.some((row, index) => row.id !== tombstonePartition[index]?.agentId)
      ))
      || ([
        "historicalActiveApiKeys",
        "historicalPrincipalPermissionGrants",
        "historicalActiveCompanyMemberships",
        "historicalNonLeftAgentMemberships",
        "historicalAgentSecretBindings",
        "historicalAgentUserSecretDeclarations",
        "historicalAgentSkillStars",
        "historicalActiveProjectLeads",
        "historicalOperativeGoalOwnerships",
        "historicalActiveIssueWatchdogs",
        "historicalActiveRecoveryActions",
        "historicalPipelineAgentLeases",
        "historicalActiveReportees",
        "historicalActivePipelineApprovers",
        "historicalActiveHireApprovalReferences",
        "historicalOutstandingEnvironmentLeases",
        "historicalRunningWorkspaceOperations",
      ].includes(name) && rows.length !== 0)
    ) throw new Error(`Retirement restore inventory ${name} does not contain exact unique rows`);
    const normalizedSection = proofSection(rows);
    if (
      sectionRecord.count !== normalizedSection.count
      || sectionRecord.rowsSha256 !== normalizedSection.rowsSha256
      || retirementRestoreStableSha256(sectionRecord.rows) !== normalizedSection.rowsSha256
    ) throw new Error(`Retirement restore inventory ${name} is not exact`);
    normalized[name] = normalizedSection;
  }
  const retained = normalized.retainedAgents!.rows;
  const lifecycle = retained.filter((row) => row.hasLifecycleContract === true)
    .map((row) => ({ id: row.id, companyId: row.companyId, rowSha256: row.rowSha256 }));
  if (retirementRestoreStableSha256(lifecycle) !== normalized.lifecycleContractAgents!.rowsSha256) {
    throw new Error("Lifecycle contract proof is not the exact retained-agent lifecycle subset");
  }
  const companyIds = new Set(normalized.companies!.rows.map((row) => String(row.id)));
  const secretIds = new Set(normalized.companySecrets!.rows.map((row) => String(row.id)));
  const terminalRuns = new Map(normalized.historicalHeartbeatRuns!.rows.map((row) => [String(row.id), row]));
  if (normalized.historicalTaskSessions!.rows.some((row) => {
    const lastRunId = row.lastRunId === null ? null : String(row.lastRunId);
    if (lastRunId === null) return false;
    const run = terminalRuns.get(lastRunId);
    return !run
      || String(run.agentId) !== String(row.agentId)
      || String(run.companyId) !== String(row.companyId);
  })) {
    throw new Error("Historical task session lastRunId is not its own terminal tombstone run");
  }
  for (const sectionName of ["historicalEnvironmentLeases", "historicalWorkspaceOperations"] as const) {
    if (normalized[sectionName]!.rows.some((row) => {
      const run = terminalRuns.get(String(row.runId));
      if (sectionName === "historicalEnvironmentLeases" && row.runId === null) return false;
      return !run
        || String(run.agentId) !== String(row.agentId)
        || String(run.companyId) !== String(row.companyId);
    })) {
      throw new Error(`Retirement restore inventory ${sectionName} is outside terminal tombstone run history`);
    }
  }
  const historicalRoutines = new Map(normalized.historicalRoutines!.rows.map((row) => [String(row.id), row]));
  if (normalized.historicalRoutineTriggers!.rows.some((row) => {
    const routine = historicalRoutines.get(String(row.routineId));
    return !routine || String(routine.companyId) !== String(row.companyId) || row.enabled !== false;
  })) {
    throw new Error("Historical routine trigger is enabled or outside tombstone routine history");
  }
  if (normalized.historicalRoutineRuns!.rows.some((row) => {
    const routine = historicalRoutines.get(String(row.routineId));
    return !routine
      || String(routine.agentId) !== String(row.agentId)
      || String(routine.companyId) !== String(row.companyId);
  })) {
    throw new Error("Historical routine run is outside tombstone routine history");
  }
  const historicalRoutineRuns = new Map(normalized.historicalRoutineRuns!.rows.map((row) => [String(row.id), row]));
  if (normalized.historicalRoutineDeliveries!.rows.some((row) => {
    const run = historicalRoutineRuns.get(String(row.routineRunId));
    return !run
      || String(run.agentId) !== String(row.agentId)
      || String(run.companyId) !== String(row.companyId);
  })) {
    throw new Error("Historical routine delivery is outside tombstone routine run history");
  }
  if (retained.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalTombstones!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalHeartbeatRuns!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalWorkspaceRuntimeServices!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalApprovals!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalTaskSessions!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalIssues!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalRoutines!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalRoutineTriggers!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalRoutineRuns!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalRoutineDeliveries!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.approvalExecutionClaims!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.workspaceRuntimeStartClaims!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.agentSecretBindings!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.agentUserSecretDeclarations!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.agentSkillStars!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalWakeRequests!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalEnvironmentLeases!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.historicalWorkspaceOperations!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.companySecrets!.rows.some((row) => !companyIds.has(String(row.companyId))) ||
      normalized.companySecretVersions!.rows.some((row) => !secretIds.has(String(row.secretId))) ||
      normalized.companySecretBindings!.rows.some((row) =>
        !companyIds.has(String(row.companyId)) || !secretIds.has(String(row.secretId)))) {
    throw new Error("Restore inventory contains an out-of-scope company or secret reference");
  }
  const core = { schemaVersion: "3.0.0", ...normalized } as unknown as Omit<RetirementRestoreInventoryProof, "inventorySha256">;
  const result = { ...core, inventorySha256: retirementRestoreStableSha256(core) };
  if (!SHA256_PATTERN.test(String(record.inventorySha256 ?? "")) || record.inventorySha256 !== result.inventorySha256) {
    throw new Error("Retirement restore inventory fingerprint is invalid");
  }
  return result;
}

function copyIdentifier(raw: string) {
  const trimmed = raw.trim();
  if (/^"[a-z0-9_]+"$/i.test(trimmed)) return trimmed.slice(1, -1).toLowerCase();
  if (/^[a-z0-9_]+$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error("Database dump COPY column is malformed");
}

function decodeCopyField(raw: string): string | null {
  if (raw === "\\N") return null;
  let value = "";
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "\\") {
      value += raw[index];
      continue;
    }
    const escaped = raw[++index];
    if (escaped === undefined) throw new Error("Database dump COPY escape is truncated");
    const named: Record<string, string> = {
      b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\",
    };
    if (Object.hasOwn(named, escaped)) {
      value += named[escaped];
      continue;
    }
    if (escaped === "x") {
      const match = /^[0-9a-f]{1,2}/i.exec(raw.slice(index + 1));
      if (!match) throw new Error("Database dump COPY hex escape is malformed");
      value += String.fromCharCode(Number.parseInt(match[0], 16));
      index += match[0].length;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const suffix = /^[0-7]{0,2}/.exec(raw.slice(index + 1))?.[0] ?? "";
      value += String.fromCharCode(Number.parseInt(`${escaped}${suffix}`, 8));
      index += suffix.length;
      continue;
    }
    value += escaped;
  }
  return value;
}

export const RETIREMENT_RESTORE_FULL_COLUMNS = Object.freeze(Object.fromEntries(
  Object.entries(ROW_SCHEMAS).map(([table, specs]) => [table, specs.map(([snakeName]) => snakeName)]),
) as Record<string, string[]>);

export function createRetirementSqlInventoryCollector(
  rawPartition: RetirementRestoreAgentPartition,
) {
  const { sources, retainedAgents, historicalTombstones } = canonicalPartition(rawPartition);
  const sourceIds = new Set(sources.map((row) => row.sourceAgentId));
  const retainedIds = new Set(retainedAgents.map((row) => row.agentId));
  const tombstoneIds = new Set(historicalTombstones.map((row) => row.agentId));
  const created = new Set<string>();
  const copied = new Set<string>();
  const raw = {
    sourceAgents: [] as UnknownRecord[],
    retainedAgents: [] as UnknownRecord[],
    historicalTombstones: [] as UnknownRecord[],
    companies: [] as UnknownRecord[],
    activeApiKeys: [] as UnknownRecord[],
    principalPermissionGrants: [] as UnknownRecord[],
    activeCompanyMemberships: [] as UnknownRecord[],
    nonLeftAgentMemberships: [] as UnknownRecord[],
    agentSecretBindings: [] as UnknownRecord[],
    agentUserSecretDeclarations: [] as UnknownRecord[],
    agentSkillStars: [] as UnknownRecord[],
    historicalActiveApiKeys: [] as UnknownRecord[],
    historicalPrincipalPermissionGrants: [] as UnknownRecord[],
    historicalActiveCompanyMemberships: [] as UnknownRecord[],
    historicalNonLeftAgentMemberships: [] as UnknownRecord[],
    historicalAgentSecretBindings: [] as UnknownRecord[],
    historicalAgentUserSecretDeclarations: [] as UnknownRecord[],
    historicalAgentSkillStars: [] as UnknownRecord[],
    historicalActiveProjectLeads: [] as UnknownRecord[],
    historicalOperativeGoalOwnerships: [] as UnknownRecord[],
    historicalHeartbeatRuns: [] as UnknownRecord[],
    historicalWorkspaceRuntimeServices: [] as UnknownRecord[],
    historicalApprovals: [] as UnknownRecord[],
    historicalTaskSessions: [] as UnknownRecord[],
    historicalIssues: [] as UnknownRecord[],
    historicalRoutines: [] as UnknownRecord[],
    historicalRoutineTriggers: [] as UnknownRecord[],
    historicalRoutineRuns: [] as UnknownRecord[],
    historicalRoutineDeliveries: [] as UnknownRecord[],
    approvalExecutionClaims: [] as UnknownRecord[],
    workspaceRuntimeStartClaims: [] as UnknownRecord[],
    historicalWakeRequests: [] as UnknownRecord[],
    historicalActiveIssueWatchdogs: [] as UnknownRecord[],
    historicalActiveRecoveryActions: [] as UnknownRecord[],
    historicalPipelineAgentLeases: [] as UnknownRecord[],
    historicalActiveReportees: [] as UnknownRecord[],
    historicalActivePipelineApprovers: [] as UnknownRecord[],
    historicalActiveHireApprovalReferences: [] as UnknownRecord[],
    historicalEnvironmentLeases: [] as UnknownRecord[],
    historicalOutstandingEnvironmentLeases: [] as UnknownRecord[],
    historicalWorkspaceOperations: [] as UnknownRecord[],
    historicalRunningWorkspaceOperations: [] as UnknownRecord[],
    allAgents: [] as UnknownRecord[],
    allRoutineTriggers: [] as UnknownRecord[],
    allRoutineRuns: [] as UnknownRecord[],
    allRoutineDeliveries: [] as UnknownRecord[],
    allPortfolioHeartbeatRuns: [] as UnknownRecord[],
    allApprovalExecutionClaims: [] as UnknownRecord[],
    allWorkspaceRuntimeServices: [] as UnknownRecord[],
    allWorkspaceRuntimeStartClaims: [] as UnknownRecord[],
    allPipelines: [] as UnknownRecord[],
    allPipelineStages: [] as UnknownRecord[],
    allEnvironmentLeases: [] as UnknownRecord[],
    allWorkspaceOperations: [] as UnknownRecord[],
    companySecrets: [] as UnknownRecord[],
    companySecretVersions: [] as UnknownRecord[],
    companySecretBindings: [] as UnknownRecord[],
  };
  let activeCopy: { table: string; columns: string[]; tracked: boolean } | null = null;
  let trackedCount = 0;

  const fullRow = (values: string[]) => Object.fromEntries(
    activeCopy!.columns.map((column, index) => [column, decodeCopyField(values[index] ?? "")]),
  );
  const field = (values: string[], name: string) => {
    const index = activeCopy!.columns.indexOf(name);
    if (index < 0) throw new Error(`Database dump COPY row is missing ${name}`);
    return decodeCopyField(values[index] ?? "");
  };
  const add = (target: keyof typeof raw, row: UnknownRecord) => {
    trackedCount += 1;
    if (trackedCount > MAX_TRACKED_ROWS) throw new Error("Retirement inventory exceeds the fixed row bound");
    raw[target].push(row);
  };
  const jsonObject = (value: string | null, label: string): UnknownRecord => {
    if (value === null) throw new Error(`${label} JSON is missing`);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as UnknownRecord;
    } catch {
      throw new Error(`${label} JSON is malformed`);
    }
  };
  const problematicPipelineAgentLease = (values: string[]) => {
    const ownerType = field(values, "lease_owner_type");
    const agentId = field(values, "lease_agent_id");
    const userId = field(values, "lease_user_id");
    const token = field(values, "lease_token");
    const expiresAt = field(values, "lease_expires_at");
    const tombstoneReference = agentId !== null && tombstoneIds.has(agentId.toLowerCase());
    const agentShaped = ownerType === "agent" || agentId !== null;
    const wellFormedAgent = ownerType === "agent" && agentId !== null && userId === null
      && token !== null && expiresAt !== null;
    return tombstoneReference || (agentShaped && !wellFormedAgent);
  };

  return {
    pushLine(rawLine: string) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (activeCopy) {
        if (line === "\\.") {
          activeCopy = null;
          return;
        }
        if (!activeCopy.tracked) return;
        const values = line.split("\t");
        if (values.length !== activeCopy.columns.length) throw new Error("Database dump COPY row width is malformed");
        const row = fullRow(values);
        if (activeCopy.table === "agents") {
          const id = field(values, "id");
          if (!id) throw new Error("Database dump agents row has no ID");
          const normalizedId = id.toLowerCase();
          const target = sourceIds.has(normalizedId)
            ? "sourceAgents"
            : retainedIds.has(normalizedId)
              ? "retainedAgents"
              : tombstoneIds.has(normalizedId)
                ? "historicalTombstones"
                : null;
          if (target === null) {
            throw new Error(`Database dump contains an unclassified agent outside the closed partition: ${normalizedId}`);
          }
          add(target, row);
          raw.allAgents.push(row);
        } else if (activeCopy.table === "companies") {
          add("companies", row);
        } else if (activeCopy.table === "agent_api_keys") {
          const sourceId = field(values, "agent_id");
          if (sourceId && sourceIds.has(sourceId.toLowerCase()) && field(values, "revoked_at") === null) {
            add("activeApiKeys", row);
          } else if (sourceId && tombstoneIds.has(sourceId.toLowerCase()) && field(values, "revoked_at") === null) {
            add("historicalActiveApiKeys", row);
          }
        } else if (activeCopy.table === "principal_permission_grants") {
          const sourceId = field(values, "principal_id");
          if (field(values, "principal_type") === "agent" && sourceId && sourceIds.has(sourceId.toLowerCase())) {
            add("principalPermissionGrants", row);
          } else if (field(values, "principal_type") === "agent" && sourceId && tombstoneIds.has(sourceId.toLowerCase())) {
            add("historicalPrincipalPermissionGrants", row);
          }
        } else if (activeCopy.table === "company_memberships") {
          const sourceId = field(values, "principal_id");
          if (
            field(values, "principal_type") === "agent"
            && field(values, "status") === "active"
            && sourceId
            && sourceIds.has(sourceId.toLowerCase())
          ) add("activeCompanyMemberships", row);
          else if (
            field(values, "principal_type") === "agent"
            && field(values, "status") === "active"
            && sourceId
            && tombstoneIds.has(sourceId.toLowerCase())
          ) add("historicalActiveCompanyMemberships", row);
        } else if (activeCopy.table === "agent_memberships") {
          const sourceId = field(values, "agent_id");
          if (field(values, "state") !== "left" && sourceId && sourceIds.has(sourceId.toLowerCase())) {
            add("nonLeftAgentMemberships", row);
          } else if (field(values, "state") !== "left" && sourceId && tombstoneIds.has(sourceId.toLowerCase())) {
            add("historicalNonLeftAgentMemberships", row);
          }
        } else if (activeCopy.table === "projects") {
          const agentId = field(values, "lead_agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase()) && field(values, "archived_at") === null) {
            add("historicalActiveProjectLeads", row);
          }
        } else if (activeCopy.table === "goals") {
          const agentId = field(values, "owner_agent_id");
          if (
            agentId
            && tombstoneIds.has(agentId.toLowerCase())
            && isOperativeRetirementGoalStatus(field(values, "status") ?? "")
          ) add("historicalOperativeGoalOwnerships", row);
        } else if (activeCopy.table === "heartbeat_runs") {
          const agentId = field(values, "agent_id");
          if (agentId && (sourceIds.has(agentId.toLowerCase()) || tombstoneIds.has(agentId.toLowerCase()))) {
            add("allPortfolioHeartbeatRuns", row);
          }
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalHeartbeatRuns", row);
        } else if (activeCopy.table === "approval_execution_claims") {
          add("allApprovalExecutionClaims", row);
        } else if (activeCopy.table === "workspace_runtime_services") {
          raw.allWorkspaceRuntimeServices.push(row);
          const agentId = field(values, "owner_agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) {
            add("historicalWorkspaceRuntimeServices", row);
          }
        } else if (activeCopy.table === "workspace_runtime_start_claims") {
          add("allWorkspaceRuntimeStartClaims", row);
        } else if (activeCopy.table === "approvals") {
          const agentId = field(values, "requested_by_agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalApprovals", row);
          const payload = jsonObject(field(values, "payload"), "approvals.payload");
          if (
            field(values, "type") === "hire_agent"
            && isActiveRetirementHireApprovalStatus(field(values, "status") ?? "")
            && [payload.agentId, payload.reportsTo].some((value) => (
              typeof value === "string" && tombstoneIds.has(value.toLowerCase())
            ))
          ) add("historicalActiveHireApprovalReferences", row);
        } else if (activeCopy.table === "agent_task_sessions") {
          const agentId = field(values, "agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalTaskSessions", row);
        } else if (activeCopy.table === "issues") {
          const agentId = field(values, "assignee_agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalIssues", row);
        } else if (activeCopy.table === "routines") {
          const agentId = field(values, "assignee_agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalRoutines", row);
        } else if (activeCopy.table === "routine_triggers") {
          add("allRoutineTriggers", row);
        } else if (activeCopy.table === "routine_runs") {
          add("allRoutineRuns", row);
        } else if (activeCopy.table === "routine_run_deliveries") {
          add("allRoutineDeliveries", row);
        } else if (activeCopy.table === "agent_wakeup_requests") {
          const agentId = field(values, "agent_id");
          if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalWakeRequests", row);
        } else if (activeCopy.table === "issue_watchdogs") {
          const agentId = field(values, "watchdog_agent_id");
          if (
            isActiveRetirementIssueWatchdogStatus(field(values, "status") ?? "")
            && agentId
            && tombstoneIds.has(agentId.toLowerCase())
          ) add("historicalActiveIssueWatchdogs", row);
        } else if (activeCopy.table === "issue_recovery_actions") {
          const agentId = field(values, "owner_agent_id");
          if (
            isActiveRetirementRecoveryActionStatus(field(values, "status") ?? "")
            && agentId
            && tombstoneIds.has(agentId.toLowerCase())
          ) add("historicalActiveRecoveryActions", row);
        } else if (activeCopy.table === "pipeline_cases") {
          if (problematicPipelineAgentLease(values)) add("historicalPipelineAgentLeases", row);
        } else if (activeCopy.table === "pipelines") {
          add("allPipelines", row);
        } else if (activeCopy.table === "pipeline_stages") {
          jsonObject(field(values, "config"), "pipeline_stages.config");
          add("allPipelineStages", row);
        } else if (activeCopy.table === "environment_leases") {
          add("allEnvironmentLeases", row);
        } else if (activeCopy.table === "workspace_operations") {
          add("allWorkspaceOperations", row);
        } else if (activeCopy.table === "company_secrets") {
          add("companySecrets", row);
        } else if (activeCopy.table === "company_secret_versions") {
          add("companySecretVersions", row);
        } else if (activeCopy.table === "company_secret_bindings") {
          add("companySecretBindings", row);
          const agentId = field(values, "target_id");
          if (field(values, "target_type") === "agent" && agentId && sourceIds.has(agentId.toLowerCase())) {
            add("agentSecretBindings", row);
          } else if (
            field(values, "target_type") === "agent"
            && agentId
            && tombstoneIds.has(agentId.toLowerCase())
          ) add("historicalAgentSecretBindings", row);
        } else if (activeCopy.table === "user_secret_declarations") {
          const agentId = field(values, "target_id");
          if (field(values, "target_type") === "agent" && agentId && sourceIds.has(agentId.toLowerCase())) {
            add("agentUserSecretDeclarations", row);
          } else if (
            field(values, "target_type") === "agent"
            && agentId
            && tombstoneIds.has(agentId.toLowerCase())
          ) add("historicalAgentUserSecretDeclarations", row);
        } else if (activeCopy.table === "company_skill_stars") {
          const agentId = field(values, "agent_id");
          if (agentId && sourceIds.has(agentId.toLowerCase())) add("agentSkillStars", row);
          else if (agentId && tombstoneIds.has(agentId.toLowerCase())) add("historicalAgentSkillStars", row);
        }
        return;
      }

      const create = /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:(?:public|"?[a-z0-9_]+"?)\.)?"?([a-z0-9_]+)"?\s*\(/i.exec(line);
      if (create?.[1]) {
        created.add(create[1].toLowerCase());
        if (created.size > MAX_DUMP_TABLES) throw new Error("Database dump exceeds the fixed table bound");
      }
      const copy = /^COPY\s+(?:(?:public|"?[a-z0-9_]+"?)\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)\s+FROM\s+stdin;$/i.exec(line);
      if (!copy?.[1] || copy[2] === undefined) return;
      const table = copy[1].toLowerCase();
      const columns = copy[2].split(",").map(copyIdentifier);
      copied.add(table);
      if (copied.size > MAX_DUMP_TABLES) throw new Error("Database dump exceeds the fixed COPY-table bound");
      const required = RETIREMENT_RESTORE_FULL_COLUMNS[table];
      if (required) {
        const actualSorted = [...columns].sort();
        const expectedSorted = [...required].sort();
        if (
          actualSorted.length !== expectedSorted.length
          || expectedSorted.some((column, index) => column !== actualSorted[index])
        ) throw new Error(`Database dump COPY ${table} does not contain exact full-row retirement columns`);
      }
      activeCopy = { table, columns, tracked: Boolean(required) };
    },
    finish() {
      if (activeCopy) throw new Error("Database dump COPY section is unterminated");
      for (const table of RETIREMENT_RESTORE_REQUIRED_TABLES) {
        if (!created.has(table) || !copied.has(table)) throw new Error(`Database dump is missing ${table}`);
      }
      const historicalRoutineIds = new Set(raw.historicalRoutines.map((row) => String(row.id)));
      raw.historicalRoutineTriggers = raw.allRoutineTriggers.filter((row) => (
        historicalRoutineIds.has(String(row.routine_id))
      ));
      raw.historicalRoutineRuns = raw.allRoutineRuns.filter((row) => (
        historicalRoutineIds.has(String(row.routine_id))
      ));
      const historicalRoutineRunIds = new Set(raw.historicalRoutineRuns.map((row) => String(row.id)));
      raw.historicalRoutineDeliveries = raw.allRoutineDeliveries.filter((row) => (
        historicalRoutineRunIds.has(String(row.routine_run_id))
      ));
      const portfolioAgentIds = new Set([...sourceIds, ...tombstoneIds]);
      const runOwnerById = new Map(raw.allPortfolioHeartbeatRuns.map((row) => (
        [String(row.id), String(row.agent_id).toLowerCase()] as const
      )));
      for (const row of raw.allApprovalExecutionClaims) {
        const directAgentId = String(row.agent_id).toLowerCase();
        const originAgentId = runOwnerById.get(String(row.origin_run_id)) ?? null;
        const executorAgentId = runOwnerById.get(String(row.executor_run_id)) ?? null;
        const portfolioAgentId = [directAgentId, originAgentId, executorAgentId]
          .find((candidate): candidate is string => candidate !== null && portfolioAgentIds.has(candidate));
        if (portfolioAgentId) add("approvalExecutionClaims", { row, portfolioAgentId });
      }
      const runtimeServiceOwnerById = new Map(raw.allWorkspaceRuntimeServices
        .filter((row) => row.owner_agent_id !== null)
        .map((row) => [String(row.id), String(row.owner_agent_id).toLowerCase()] as const));
      for (const row of raw.allWorkspaceRuntimeStartClaims) {
        const ownerAgentId = row.owner_agent_id === null
          ? null
          : String(row.owner_agent_id).toLowerCase();
        const runtimeServiceOwnerAgentId = row.runtime_service_id === null
          ? null
          : runtimeServiceOwnerById.get(String(row.runtime_service_id)) ?? null;
        const portfolioAgentId = [ownerAgentId, runtimeServiceOwnerAgentId]
          .find((candidate): candidate is string => candidate !== null && portfolioAgentIds.has(candidate));
        if (portfolioAgentId) {
          add("workspaceRuntimeStartClaims", { row, portfolioAgentId, runtimeServiceOwnerAgentId });
        }
      }
      const agentChildren = new Map<string, string[]>();
      const agentsById = new Map<string, UnknownRecord>();
      for (const row of raw.allAgents) {
        const id = String(row.id).toLowerCase();
        agentsById.set(id, row);
        if (row.reports_to === null) continue;
        const managerId = String(row.reports_to).toLowerCase();
        agentChildren.set(managerId, [...(agentChildren.get(managerId) ?? []), id]);
      }
      const liveDescendantIds = new Set<string>();
      for (const tombstoneId of tombstoneIds) {
        const visited = new Set<string>([tombstoneId]);
        const queue = [...(agentChildren.get(tombstoneId) ?? [])];
        while (queue.length > 0) {
          const id = queue.shift()!;
          if (visited.has(id)) continue;
          visited.add(id);
          const row = agentsById.get(id);
          if (row?.status !== "terminated") liveDescendantIds.add(id);
          queue.push(...(agentChildren.get(id) ?? []));
        }
      }
      for (const id of [...liveDescendantIds].sort()) {
        add("historicalActiveReportees", agentsById.get(id)!);
      }
      const activePipelineIds = new Set(raw.allPipelines
        .filter((row) => row.archived_at === null)
        .map((row) => String(row.id)));
      for (const row of raw.allPipelineStages) {
        if (!activePipelineIds.has(String(row.pipeline_id))) continue;
        const config = jsonObject(String(row.config), "pipeline_stages.config");
        const approver = config.approver;
        const automation = config.automation && typeof config.automation === "object"
          && !Array.isArray(config.automation)
          ? config.automation as UnknownRecord
          : {};
        const isApprover = (
          config.requireApproval === true
          && approver
          && typeof approver === "object"
          && !Array.isArray(approver)
          && (approver as UnknownRecord).kind === "agent"
          && typeof (approver as UnknownRecord).id === "string"
          && tombstoneIds.has(String((approver as UnknownRecord).id).toLowerCase())
        );
        const isAutomationAssignee = typeof automation.assigneeAgentId === "string"
          && tombstoneIds.has(automation.assigneeAgentId.toLowerCase());
        if (isApprover || isAutomationAssignee) add("historicalActivePipelineApprovers", row);
      }
      const historicalRunIds = new Set(raw.historicalHeartbeatRuns.map((row) => String(row.id)));
      raw.historicalEnvironmentLeases = raw.allEnvironmentLeases.filter((row) => (
        (row.heartbeat_run_id !== null && historicalRunIds.has(String(row.heartbeat_run_id)))
        || (() => {
          const metadata = row.metadata === null
            ? {}
            : jsonObject(String(row.metadata), "environment_leases.metadata");
          const reusable = metadata.reusableSandboxLease;
          const nested = reusable && typeof reusable === "object" && !Array.isArray(reusable)
            ? reusable as UnknownRecord
            : {};
          return [metadata.agentId, nested.agentId].some((value) => (
            typeof value === "string" && tombstoneIds.has(value.toLowerCase())
          ));
        })()
      ));
      for (const row of raw.historicalEnvironmentLeases) {
        const status = String(row.status);
        const leasePolicy = String(row.lease_policy);
        const cleanupStatus = row.cleanup_status === null ? null : String(row.cleanup_status);
        const terminal = isTerminalRetirementEnvironmentLease({ leasePolicy, status, cleanupStatus });
        if (!terminal) add("historicalOutstandingEnvironmentLeases", row);
      }
      raw.historicalWorkspaceOperations = raw.allWorkspaceOperations.filter((row) => (
        row.heartbeat_run_id !== null && historicalRunIds.has(String(row.heartbeat_run_id))
      ));
      for (const row of raw.historicalWorkspaceOperations) {
        if (!isTerminalRetirementWorkspaceOperation(String(row.status))) {
          add("historicalRunningWorkspaceOperations", row);
        }
      }
      return {
        created: [...created].sort(),
        copied: [...copied].sort(),
        retirementInventory: createRetirementRestoreInventory(raw, {
          sources,
          retainedAgents,
          historicalTombstones: historicalTombstones as AgentRetirementHistoricalTombstone[],
        }),
      };
    },
  };
}

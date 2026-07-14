import type {
  AgentAdapterType,
  ModelProfileKey,
  AgentPauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";
import type {
  TrustAuthorizationPolicy,
  TrustPreset,
} from "../trust-policy.js";
import type { AgentOrgChainHealth } from "../agent-eligibility.js";
import type { AgentApiKeyScope } from "../validators/agent.js";

export interface AgentPermissions extends Record<string, unknown> {
  canCreateAgents: boolean;
  canCreateSkills?: boolean;
  canAssignTasks?: boolean;
  bypass?: {
    claudePermissionMode: boolean;
    codexApprovalsAndSandbox: boolean;
  };
  exception?: AgentLifecyclePermissionException;
  trustPreset?: TrustPreset;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export type AgentLifecyclePermissionBypass =
  | "claude_permission_mode"
  | "codex_approvals_and_sandbox";

export type AgentLifecyclePermissionException =
  | { kind: "none" }
  | {
      kind: "approved";
      exceptionIssueId: string;
      owner: AgentLifecycleOwner;
      scope: {
        cwdRoots: string[];
        tools: string[];
        networkHosts: string[];
        bypasses: AgentLifecyclePermissionBypass[];
      };
      justification: string;
      evidence: {
        canaryIssueId: string;
        runId: string;
        configFingerprint: string;
        result: "passed";
      };
      approvedAt: string;
      expiresAt: string;
    };

export type AgentLifecycleOwner =
  | { ownerType: "agent"; ownerAgentId: string }
  | { ownerType: "board_user"; ownerUserId: string }
  | { ownerType: "board_role"; ownerRoleSlug: string };

export interface AgentLifecycleServiceLevel {
  availabilityClass: "routine" | "business_hours" | "on_demand";
  triageTargetMinutes: number | null;
  completionTargetMinutes: number | null;
  targetExceptionReason: string | null;
}

export interface AgentLifecyclePause {
  reasonCode: string;
  reasonDetail: string;
  outcome?: string;
  repairIssueId: string;
  startedAt: string;
  expiresAt: string;
  exceptionApprovedByUserId?: string;
  exceptionReason?: string;
}

export interface AgentLifecycle {
  schemaVersion: "1.0.0";
  owner: AgentLifecycleOwner;
  purpose: string;
  acceptedTaskTypes: string[];
  rejectedTaskTypes: string[];
  taskSources: string[];
  operatingMode: "scheduled" | "issue_routed" | "manual_assignment_only";
  serviceLevel: AgentLifecycleServiceLevel;
  canaryIssueId: string | null;
  lastCanaryAt: string | null;
  lastCanaryResult: "pending" | "passed" | "failed";
  canaryFreshnessDays: number;
  reviewAt: string;
  retirementCriterion: string;
  decisionIssueId: string;
  replacementAgentId?: string;
  replacementSystemRef?: string;
  pause?: AgentLifecyclePause;
}

export interface AgentLifecycleFailedRepairTransition {
  mode: "reviewed_failed_repair";
  repairIssueId: string;
  expectedAgentUpdatedAt: string;
}

export interface AgentLifecyclePassedRevalidationTransition {
  mode: "reviewed_passed_revalidation";
  canaryIssueId: string;
  decisionIssueId: string;
  reasonCode: "runtime_evidence_invalidated";
  expectedAgentUpdatedAt: string;
}

export type AgentLifecycleTransition =
  | AgentLifecycleFailedRepairTransition
  | AgentLifecyclePassedRevalidationTransition;

export interface AgentLifecycleGate {
  schemaVersion: "1.0.0";
  configFingerprint: string;
  validatedAt: string;
  expiresAt: string;
  findingCount: 0;
  receiptHash: string;
  freshSessionRequired: boolean;
  lastSatisfiedRunId?: string;
}

export interface AgentLifecycleCanaryGate {
  schemaVersion: "1.0.0";
  agentId: string;
  companyId: string;
  canaryIssueId: string;
  runId: string;
  configFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  receiptHash: string;
}

export interface AgentMetadata extends Record<string, unknown> {
  lifecycle?: AgentLifecycle;
  lifecycleGate?: AgentLifecycleGate;
  lifecycleCanaryGate?: AgentLifecycleCanaryGate;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "simple_default" | "explicit_grant" | "agent_creator" | "ceo_role" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: AgentPauseReason | null;
  pausedAt: Date | null;
  errorReason?: string | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: AgentMetadata | null;
  orgChainHealth?: AgentOrgChainHealth;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export type ClearAgentErrorResponse = Agent;

export interface AgentKeyCreated {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

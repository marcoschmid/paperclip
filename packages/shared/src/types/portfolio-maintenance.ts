export const PORTFOLIO_MAINTENANCE_SCHEMA_VERSION = "1.0.0" as const;

export type PortfolioMaintenanceSchemaVersion = typeof PORTFOLIO_MAINTENANCE_SCHEMA_VERSION;

export interface PortfolioMaintenanceCoverage {
  hiddenIssues: true;
  pluginOperations: true;
  wakesComplete: true;
  liveRunsComplete: true;
  wakeQuiesce: true;
  triggerCas: true;
}

export interface PortfolioMaintenanceBlocker {
  code: string;
  message: string;
}

export interface PortfolioMaintenanceLifecycleGate {
  agentId: string;
  status: string;
  lastCanaryResult: "pending" | "passed" | "failed" | null;
  canaryIssueId: string | null;
  currentConfigFingerprint: string | null;
  gateConfigFingerprint: string | null;
  lastSatisfiedRunId: string | null;
  receiptHash: string | null;
  validatedAt: string | null;
  expiresAt: string | null;
  valid: boolean;
}

export interface PortfolioMaintenanceIssue {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string;
  originKind: string;
  hidden: boolean;
  updatedAt: string;
}

export interface PortfolioMaintenanceWake {
  id: string;
  agentId: string;
  issueId: string | null;
  status: "queued" | "claimed" | "deferred_issue_execution";
  updatedAt: string;
}

export interface PortfolioMaintenanceLiveRun {
  id: string;
  agentId: string;
  issueId: string | null;
  status: "queued" | "running" | "scheduled_retry" | "orphan_process";
  createdAt: string;
  updatedAt: string;
}

export type PortfolioMaintenanceGateStage = "fenced" | "quiesced";

/**
 * Restart-safe server state for one company-scoped maintenance intent. The
 * receipt is issued when the execution fence commits, before any cancellation
 * or process termination is attempted.
 */
export interface PortfolioMaintenanceExecutionGate {
  operationId: string;
  expectedSnapshotFingerprint: string;
  receiptId: string;
  stage: PortfolioMaintenanceGateStage;
}

export interface PortfolioMaintenancePreflightResponse {
  schemaVersion: PortfolioMaintenanceSchemaVersion;
  companyId: string;
  agentIds: string[];
  ready: boolean;
  restoreReady: boolean;
  blockers: PortfolioMaintenanceBlocker[];
  coverage: PortfolioMaintenanceCoverage;
  snapshotFingerprint: string;
  maintenanceGate: PortfolioMaintenanceExecutionGate | null;
  lifecycleGates: PortfolioMaintenanceLifecycleGate[];
  issues: PortfolioMaintenanceIssue[];
  wakes: PortfolioMaintenanceWake[];
  liveRuns: PortfolioMaintenanceLiveRun[];
}

export interface PortfolioMaintenanceQuiesceRequest {
  agentIds: string[];
  operationId: string;
  expectedSnapshotFingerprint: string;
}

export interface PortfolioMaintenanceQuiesceResponse {
  schemaVersion: PortfolioMaintenanceSchemaVersion;
  companyId: string;
  agentIds: string[];
  operationId: string;
  expectedSnapshotFingerprint: string;
  receiptId: string;
  stage: "quiesced";
  quiescedAt: string;
  cancelledWakeRequestIds: string[];
  remainingWakeRequestIds: string[];
  remainingLiveRunIds: string[];
}

export interface PortfolioMaintenanceGateReleaseRequest {
  agentIds: string[];
  receiptIds: string[];
  expectedSnapshotFingerprint: string;
}

export interface PortfolioMaintenanceGateReleaseResponse {
  schemaVersion: PortfolioMaintenanceSchemaVersion;
  companyId: string;
  agentIds: string[];
  receiptId: string;
  expectedSnapshotFingerprint: string;
  releasedAt: string;
}

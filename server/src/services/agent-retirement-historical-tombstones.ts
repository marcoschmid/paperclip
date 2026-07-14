import {
  AGENT_RETIREMENT_HISTORICAL_TOMBSTONE_IDS,
  normalizeAgentRetirementId,
} from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const INACTIVE_ROUTINE_STATUSES = new Set(["paused", "archived"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_WAKE_STATUSES = new Set([
  "coalesced", "skipped", "completed", "failed", "cancelled", "timed_out",
]);
const TERMINAL_GOAL_STATUSES = new Set(["achieved", "cancelled"]);
const TERMINAL_RUNTIME_SERVICE_STATUSES = new Set(["stopped", "failed"]);
const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "rejected", "cancelled"]);

export const HISTORICAL_AGENT_TOMBSTONE_IMMUTABLE_CODE =
  "historical_agent_tombstone_immutable" as const;
export const HISTORICAL_AGENT_TOMBSTONE_ACCESS_FORBIDDEN_CODE =
  "historical_agent_tombstone_access_forbidden" as const;
export const HISTORICAL_AGENT_TOMBSTONE_ACTIVE_REFERENCE_FORBIDDEN_CODE =
  "historical_agent_tombstone_active_reference_forbidden" as const;

export function isHistoricalAgentTombstoneId(agentId: string | null | undefined): agentId is string {
  const normalized = normalizeAgentRetirementId(agentId);
  return normalized !== null && AGENT_RETIREMENT_HISTORICAL_TOMBSTONE_IDS.has(normalized);
}

export function assertHistoricalAgentTombstoneMutable(agentId: string | null | undefined): void {
  if (!isHistoricalAgentTombstoneId(agentId)) return;
  throw conflict("Historical agent tombstones are immutable", {
    code: HISTORICAL_AGENT_TOMBSTONE_IMMUTABLE_CODE,
    agentId,
  });
}

export function assertHistoricalAgentTombstoneAccessMutable(
  agentId: string | null | undefined,
): void {
  if (!isHistoricalAgentTombstoneId(agentId)) return;
  throw forbidden("Historical agent tombstone access cannot be changed", {
    code: HISTORICAL_AGENT_TOMBSTONE_ACCESS_FORBIDDEN_CODE,
    agentId,
  });
}

export function assertHistoricalAgentTombstoneActiveReference(
  agentId: string | null | undefined,
): void {
  if (!isHistoricalAgentTombstoneId(agentId)) return;
  throw conflict("Historical agent tombstones cannot be used for active references", {
    code: HISTORICAL_AGENT_TOMBSTONE_ACTIVE_REFERENCE_FORBIDDEN_CODE,
    agentId,
  });
}

type AgentWorkRow = {
  id: string;
  agentId: string;
  status: string;
};

type IssueWorkRow = {
  id: string;
  assigneeAgentId: string | null;
  status: string;
};

type RoutineWorkRow = {
  id: string;
  assigneeAgentId: string | null;
  status: string;
};

type RoutineTriggerWorkRow = {
  id: string;
  routineId: string;
  enabled: boolean;
};

type ProjectLeadRow = {
  id: string;
  leadAgentId: string | null;
  archivedAt: Date | string | null;
};

type GoalOwnershipRow = {
  id: string;
  ownerAgentId: string | null;
  status: string;
};

type RuntimeServiceOwnershipRow = {
  id: string;
  ownerAgentId: string | null;
  status: string;
};

type ApprovalOwnershipRow = {
  id: string;
  requestedByAgentId: string | null;
  status: string;
};

type TaskSessionRow = {
  id: string;
  agentId: string;
  lastRunId: string | null;
};

type ActiveIssueWatchdogRow = {
  id: string;
  watchdogAgentId: string;
  status: string;
};

type ActiveRecoveryActionRow = {
  id: string;
  ownerAgentId: string;
  status: string;
};

type PipelineAgentLeaseRow = {
  id: string;
  leaseOwnerType: string | null;
  leaseAgentId: string | null;
  leaseUserId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
};

export type HistoricalTombstoneWorkState = {
  tombstoneIds: readonly string[];
  issues: readonly IssueWorkRow[];
  routines: readonly RoutineWorkRow[];
  routineTriggers: readonly RoutineTriggerWorkRow[];
  heartbeatRuns: readonly AgentWorkRow[];
  wakeRequests: readonly AgentWorkRow[];
  projects: readonly ProjectLeadRow[];
  goals: readonly GoalOwnershipRow[];
  runtimeServices: readonly RuntimeServiceOwnershipRow[];
  approvals: readonly ApprovalOwnershipRow[];
  taskSessions: readonly TaskSessionRow[];
  activeIssueWatchdogs: readonly ActiveIssueWatchdogRow[];
  activeRecoveryActions: readonly ActiveRecoveryActionRow[];
  pipelineAgentLeaseRows: readonly PipelineAgentLeaseRow[];
};

export type HistoricalTombstoneWorkInertnessProof = {
  tombstoneCount: number;
  terminalIssueCount: number;
  inactiveRoutineCount: number;
  disabledTriggerCount: number;
  terminalRunCount: number;
  terminalWakeCount: number;
  archivedProjectLeadCount: number;
  terminalGoalOwnershipCount: number;
  terminalRuntimeServiceCount: number;
  terminalApprovalCount: number;
  boundedTaskSessionCount: number;
  activeIssueWatchdogCount: 0;
  activeRecoveryActionCount: 0;
  unclearedPipelineAgentLeaseCount: 0;
};

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Historical tombstone ${label} is malformed`);
  }
}

function assertAgentRows(
  rows: readonly AgentWorkRow[],
  tombstoneIds: ReadonlySet<string>,
  terminalStatuses: ReadonlySet<string>,
  label: string,
) {
  if (!Array.isArray(rows)) throw new Error(`Historical tombstone ${label} rows are malformed`);
  for (const row of rows) {
    assertUuid(row?.id, `${label} row ID`);
    assertUuid(row?.agentId, `${label} agent ID`);
    if (!tombstoneIds.has(row.agentId)) {
      throw new Error(`Historical tombstone ${label} row is outside the tombstone set`);
    }
    if (!terminalStatuses.has(row.status)) {
      throw new Error(`Historical tombstone work is not inert: ${label} ${row.id} has status ${row.status}`);
    }
  }
}

export function assertHistoricalTombstoneWorkInertness(
  state: HistoricalTombstoneWorkState,
): HistoricalTombstoneWorkInertnessProof {
  if (!state || typeof state !== "object" || !Array.isArray(state.tombstoneIds) ||
      state.tombstoneIds.length !== 2) {
    throw new Error("Historical tombstone identity set must contain exactly two IDs");
  }
  for (const id of state.tombstoneIds) assertUuid(id, "identity");
  const tombstoneIds = new Set(state.tombstoneIds);
  if (tombstoneIds.size !== state.tombstoneIds.length) {
    throw new Error("Historical tombstone identity set contains duplicates");
  }
  if (!Array.isArray(state.issues) || !Array.isArray(state.routines) ||
      !Array.isArray(state.routineTriggers) || !Array.isArray(state.projects) ||
      !Array.isArray(state.goals) || !Array.isArray(state.runtimeServices) ||
      !Array.isArray(state.approvals) || !Array.isArray(state.taskSessions) ||
      !Array.isArray(state.activeIssueWatchdogs) || !Array.isArray(state.activeRecoveryActions) ||
      !Array.isArray(state.pipelineAgentLeaseRows)) {
    throw new Error("Historical tombstone work rows are malformed");
  }
  for (const issue of state.issues) {
    assertUuid(issue?.id, "issue ID");
    assertUuid(issue?.assigneeAgentId, "issue assignee");
    if (!tombstoneIds.has(issue.assigneeAgentId)) {
      throw new Error("Historical tombstone issue row is outside the tombstone set");
    }
    if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) {
      throw new Error(`Historical tombstone work is not inert: issue ${issue.id} has status ${issue.status}`);
    }
  }
  const routineIds = new Set<string>();
  for (const routine of state.routines) {
    assertUuid(routine?.id, "routine ID");
    assertUuid(routine?.assigneeAgentId, "routine assignee");
    if (!tombstoneIds.has(routine.assigneeAgentId)) {
      throw new Error("Historical tombstone routine row is outside the tombstone set");
    }
    if (!INACTIVE_ROUTINE_STATUSES.has(routine.status)) {
      throw new Error(`Historical tombstone work is not inert: routine ${routine.id} has status ${routine.status}`);
    }
    routineIds.add(routine.id);
  }
  for (const trigger of state.routineTriggers) {
    assertUuid(trigger?.id, "routine trigger ID");
    assertUuid(trigger?.routineId, "routine trigger routine ID");
    if (!routineIds.has(trigger.routineId)) {
      throw new Error("Historical tombstone routine trigger is outside the tombstone routine set");
    }
    if (trigger.enabled !== false) {
      throw new Error(`Historical tombstone work is not inert: routine trigger ${trigger.id} is enabled`);
    }
  }
  assertAgentRows(state.heartbeatRuns, tombstoneIds, TERMINAL_RUN_STATUSES, "heartbeat run");
  assertAgentRows(state.wakeRequests, tombstoneIds, TERMINAL_WAKE_STATUSES, "wake request");
  for (const project of state.projects) {
    assertUuid(project?.id, "project ID");
    assertUuid(project?.leadAgentId, "project lead");
    if (!tombstoneIds.has(project.leadAgentId)) {
      throw new Error("Historical tombstone project row is outside the tombstone set");
    }
    const archivedAt = project.archivedAt instanceof Date
      ? project.archivedAt
      : typeof project.archivedAt === "string"
        ? new Date(project.archivedAt)
        : null;
    if (!archivedAt || Number.isNaN(archivedAt.getTime())) {
      throw new Error(`Historical tombstone work is not inert: project ${project.id} is active`);
    }
  }
  for (const goal of state.goals) {
    assertUuid(goal?.id, "goal ID");
    assertUuid(goal?.ownerAgentId, "goal owner");
    if (!tombstoneIds.has(goal.ownerAgentId)) {
      throw new Error("Historical tombstone goal row is outside the tombstone set");
    }
    if (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      throw new Error(`Historical tombstone work is not inert: goal ${goal.id} has status ${goal.status}`);
    }
  }
  for (const runtimeService of state.runtimeServices) {
    assertUuid(runtimeService?.id, "runtime service ID");
    assertUuid(runtimeService?.ownerAgentId, "runtime service owner");
    if (!tombstoneIds.has(runtimeService.ownerAgentId)) {
      throw new Error("Historical tombstone runtime service row is outside the tombstone set");
    }
    if (!TERMINAL_RUNTIME_SERVICE_STATUSES.has(runtimeService.status)) {
      throw new Error(
        `Historical tombstone work is not inert: runtime service ${runtimeService.id} has status ${runtimeService.status}`,
      );
    }
  }
  for (const approval of state.approvals) {
    assertUuid(approval?.id, "approval ID");
    assertUuid(approval?.requestedByAgentId, "approval requester");
    if (!tombstoneIds.has(approval.requestedByAgentId)) {
      throw new Error("Historical tombstone approval row is outside the tombstone set");
    }
    if (!TERMINAL_APPROVAL_STATUSES.has(approval.status)) {
      throw new Error(`Historical tombstone work is not inert: approval ${approval.id} has status ${approval.status}`);
    }
  }
  const terminalRuns = new Map(state.heartbeatRuns.map((run) => [run.id, run]));
  if (terminalRuns.size !== state.heartbeatRuns.length) {
    throw new Error("Historical tombstone heartbeat run rows contain duplicate IDs");
  }
  for (const session of state.taskSessions) {
    assertUuid(session?.id, "task session ID");
    assertUuid(session?.agentId, "task session agent");
    if (!tombstoneIds.has(session.agentId)) {
      throw new Error("Historical tombstone task session row is outside the tombstone set");
    }
    if (session.lastRunId === null) continue;
    assertUuid(session.lastRunId, "task session last run");
    const run = terminalRuns.get(session.lastRunId);
    if (!run || run.agentId !== session.agentId) {
      throw new Error(
        `Historical tombstone work is not inert: task session ${session.id} does not reference its own terminal run`,
      );
    }
  }
  if (state.activeIssueWatchdogs.length > 0) {
    throw new Error("Historical tombstone work is not inert: active issue watchdog remains");
  }
  if (state.activeRecoveryActions.length > 0) {
    throw new Error("Historical tombstone work is not inert: active recovery action remains");
  }
  if (state.pipelineAgentLeaseRows.length > 0) {
    throw new Error("Historical tombstone work is not inert: uncleared or malformed pipeline agent lease remains");
  }
  return {
    tombstoneCount: tombstoneIds.size,
    terminalIssueCount: state.issues.length,
    inactiveRoutineCount: state.routines.length,
    disabledTriggerCount: state.routineTriggers.length,
    terminalRunCount: state.heartbeatRuns.length,
    terminalWakeCount: state.wakeRequests.length,
    archivedProjectLeadCount: state.projects.length,
    terminalGoalOwnershipCount: state.goals.length,
    terminalRuntimeServiceCount: state.runtimeServices.length,
    terminalApprovalCount: state.approvals.length,
    boundedTaskSessionCount: state.taskSessions.length,
    activeIssueWatchdogCount: 0,
    activeRecoveryActionCount: 0,
    unclearedPipelineAgentLeaseCount: 0,
  };
}

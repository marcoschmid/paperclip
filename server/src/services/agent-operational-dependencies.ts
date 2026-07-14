import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  documents,
  environmentLeases,
  goals,
  heartbeatRuns,
  issueRecoveryActions,
  issuePlanDecompositions,
  issueWatchdogs,
  issues,
  pipelineCases,
  pipelineStages,
  pipelines,
  projects,
  routineRunDeliveries,
  routineRuns,
  routineTriggers,
  routines,
  workspaceOperations,
  workspaceRuntimeServices,
  workspaceRuntimeStartClaims,
} from "@paperclipai/db";
import {
  normalizeAgentRetirementId,
  type AgentRetirementDependencyCounts,
} from "@paperclipai/shared";
import {
  isTerminalRetirementEnvironmentLease,
  isTerminalRetirementWorkspaceOperation,
} from "./agent-retirement-restore-inventory.js";
import {
  isPidAlive,
  isProcessGroupAlive,
  listLocalServiceRegistryRecordsStrict,
} from "./local-service-supervisor.js";

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_WAKE_STATUSES = new Set([
  "coalesced", "skipped", "completed", "failed", "cancelled", "timed_out",
]);
const TERMINAL_ROUTINE_STATUSES = new Set(["paused", "archived"]);
const TERMINAL_ROUTINE_RUN_STATUSES = new Set(["coalesced", "skipped", "issue_created", "completed", "failed"]);
const TERMINAL_GOAL_STATUSES = new Set(["achieved", "cancelled"]);
const TERMINAL_APPROVAL_STATUSES = new Set(["approved", "rejected", "cancelled"]);
const TERMINAL_WATCHDOG_STATUSES = new Set(["disabled"]);
const TERMINAL_RECOVERY_ACTION_STATUSES = new Set(["resolved", "cancelled"]);
const TERMINAL_RUNTIME_SERVICE_STATUSES = new Set(["stopped", "failed"]);

export const AGENT_OPERATIONAL_DEPENDENCY_KEYS = [
  "nonterminalIssues",
  "activeRuns",
  "activeWakeups",
  "activeRoutines",
  "enabledTriggers",
  "activeRoutineRuns",
  "activeDocumentLocks",
  "activePlanDecompositions",
  "activeProjectLeads",
  "operativeGoals",
  "activeRuntimeServices",
  "pendingApprovals",
  "activeIssueWatchdogs",
  "activeRecoveryActions",
  "unclearedPipelineAgentLeases",
  "activePipelineApprovers",
  "activeHireApprovalReferences",
  "outstandingEnvironmentLeases",
  "runningWorkspaceOperations",
  "liveDescendants",
] as const satisfies readonly (keyof AgentRetirementDependencyCounts)[];

export type AgentOperationalDependencyKey = (typeof AGENT_OPERATIONAL_DEPENDENCY_KEYS)[number];
export type AgentOperationalDependencyCounts = Pick<
  AgentRetirementDependencyCounts,
  AgentOperationalDependencyKey
>;
export type AgentOperationalDependencyIds = {
  [Key in AgentOperationalDependencyKey]: string[];
};
export type AgentOperationalDependencyInventory = {
  counts: AgentOperationalDependencyCounts;
  ids: AgentOperationalDependencyIds;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function canonicalAgentId(agentId: string) {
  return normalizeAgentRetirementId(agentId) ?? agentId;
}

function sortedIds(rows: Array<{ id: string }>) {
  return rows.map((row) => row.id).sort((left, right) => left.localeCompare(right));
}

export function createEmptyAgentOperationalDependencyCounts(): AgentOperationalDependencyCounts {
  return {
    nonterminalIssues: 0,
    activeRuns: 0,
    activeWakeups: 0,
    activeRoutines: 0,
    enabledTriggers: 0,
    activeRoutineRuns: 0,
    activeDocumentLocks: 0,
    activePlanDecompositions: 0,
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
  };
}

function createEmptyAgentOperationalDependencyIds(): AgentOperationalDependencyIds {
  return Object.fromEntries(
    AGENT_OPERATIONAL_DEPENDENCY_KEYS.map((key) => [key, []]),
  ) as unknown as AgentOperationalDependencyIds;
}

export function nonzeroAgentOperationalDependencyCounts(
  counts: AgentOperationalDependencyCounts,
): Partial<AgentOperationalDependencyCounts> {
  return Object.fromEntries(
    AGENT_OPERATIONAL_DEPENDENCY_KEYS
      .filter((key) => counts[key] > 0)
      .map((key) => [key, counts[key]]),
  );
}

export function hasAgentOperationalDependencies(counts: AgentOperationalDependencyCounts) {
  return AGENT_OPERATIONAL_DEPENDENCY_KEYS.some((key) => counts[key] > 0);
}

export function listLiveAgentDescendants(sourceId: string, rows: Array<{
  id: string;
  reportsTo: string | null;
  status: string;
}>) {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.reportsTo) continue;
    const managerId = canonicalAgentId(row.reportsTo);
    const values = children.get(managerId) ?? [];
    values.push(canonicalAgentId(row.id));
    children.set(managerId, values);
  }
  const byId = new Map(rows.map((row) => [canonicalAgentId(row.id), row]));
  const live = new Set<string>();
  const visited = new Set<string>([sourceId]);
  const queue = [...(children.get(sourceId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = byId.get(id);
    if (row?.status !== "terminated") live.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return [...live].sort((left, right) => left.localeCompare(right));
}

export async function scanAgentOperationalDependencies(
  targetDb: Db,
  rawAgentId: string,
): Promise<AgentOperationalDependencyInventory> {
  const agentId = canonicalAgentId(rawAgentId);
  const counts = createEmptyAgentOperationalDependencyCounts();
  const ids = createEmptyAgentOperationalDependencyIds();

  const sourceIssues = await targetDb
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.assigneeAgentId, agentId));
  const nonterminalIssues = sourceIssues.filter((row) => !TERMINAL_ISSUE_STATUSES.has(row.status));
  ids.nonterminalIssues = sortedIds(nonterminalIssues);
  counts.nonterminalIssues = ids.nonterminalIssues.length;

  const sourceRuns = await targetDb
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, agentId));
  const activeRuns = sourceRuns.filter((row) => !TERMINAL_RUN_STATUSES.has(row.status));
  ids.activeRuns = sortedIds(activeRuns);
  counts.activeRuns = ids.activeRuns.length;
  const sourceRunIds = new Set(sourceRuns.map((row) => row.id));

  const sourceEnvironmentLeases = (await targetDb.select().from(environmentLeases)).filter((row) => {
    if (row.heartbeatRunId !== null && sourceRunIds.has(row.heartbeatRunId)) return true;
    const metadata = asRecord(row.metadata);
    const reusableMetadata = asRecord(metadata.reusableSandboxLease);
    return [metadata.agentId, reusableMetadata.agentId].some((value) => (
      typeof value === "string" && normalizeAgentRetirementId(value) === agentId
    ));
  });
  const outstandingEnvironmentLeases = sourceEnvironmentLeases.filter((row) => (
    !isTerminalRetirementEnvironmentLease({
      leasePolicy: row.leasePolicy,
      status: row.status,
      cleanupStatus: row.cleanupStatus,
    })
  ));
  ids.outstandingEnvironmentLeases = sortedIds(outstandingEnvironmentLeases);
  counts.outstandingEnvironmentLeases = ids.outstandingEnvironmentLeases.length;

  const runningWorkspaceOperations = (await targetDb.select().from(workspaceOperations)).filter((row) => (
    row.heartbeatRunId !== null
    && sourceRunIds.has(row.heartbeatRunId)
    && !isTerminalRetirementWorkspaceOperation(row.status)
  ));
  ids.runningWorkspaceOperations = sortedIds(runningWorkspaceOperations);
  counts.runningWorkspaceOperations = ids.runningWorkspaceOperations.length;

  const sourceWakes = await targetDb
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.agentId, agentId));
  const activeWakeups = sourceWakes.filter((row) => !TERMINAL_WAKE_STATUSES.has(row.status));
  ids.activeWakeups = sortedIds(activeWakeups);
  counts.activeWakeups = ids.activeWakeups.length;

  const sourceRoutines = await targetDb
    .select({ id: routines.id, status: routines.status })
    .from(routines)
    .where(eq(routines.assigneeAgentId, agentId));
  const activeRoutines = sourceRoutines.filter((row) => !TERMINAL_ROUTINE_STATUSES.has(row.status));
  ids.activeRoutines = sortedIds(activeRoutines);
  counts.activeRoutines = ids.activeRoutines.length;
  const routineIds = new Set(sourceRoutines.map((row) => row.id));
  const triggerRows = sourceRoutines.length === 0
    ? []
    : await targetDb
      .select({ id: routineTriggers.id, routineId: routineTriggers.routineId, enabled: routineTriggers.enabled })
      .from(routineTriggers);
  const enabledTriggers = triggerRows.filter((row) => row.enabled && routineIds.has(row.routineId));
  ids.enabledTriggers = sortedIds(enabledTriggers);
  counts.enabledTriggers = ids.enabledTriggers.length;
  const activeRoutineRuns = sourceRoutines.length === 0
    ? []
    : (await targetDb.select().from(routineRuns)).filter((row) => (
      routineIds.has(row.routineId) && !TERMINAL_ROUTINE_RUN_STATUSES.has(row.status)
    ));
  const activeRoutineDeliveries = await targetDb
    .select({ id: routineRunDeliveries.routineRunId })
    .from(routineRunDeliveries)
    .where(and(
      eq(routineRunDeliveries.assigneeAgentId, agentId),
      inArray(routineRunDeliveries.status, ["pending", "claimed"]),
    ));
  ids.activeRoutineRuns = [...new Set([
    ...activeRoutineRuns.map((row) => row.id),
    ...activeRoutineDeliveries.map((row) => row.id),
  ])].sort((left, right) => left.localeCompare(right));
  counts.activeRoutineRuns = ids.activeRoutineRuns.length;

  const activeDocumentLocks = await targetDb
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.lockedByAgentId, agentId), sql`${documents.lockedAt} is not null`));
  ids.activeDocumentLocks = sortedIds(activeDocumentLocks);
  counts.activeDocumentLocks = ids.activeDocumentLocks.length;

  const activePlanDecompositions = (await targetDb
    .select({ id: issuePlanDecompositions.id, status: issuePlanDecompositions.status })
    .from(issuePlanDecompositions)
    .where(eq(issuePlanDecompositions.ownerAgentId, agentId)))
    .filter((row) => row.status !== "completed");
  ids.activePlanDecompositions = sortedIds(activePlanDecompositions);
  counts.activePlanDecompositions = ids.activePlanDecompositions.length;

  const projectRows = await targetDb
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.leadAgentId, agentId));
  const activeProjects = projectRows.filter((row) => row.archivedAt === null);
  ids.activeProjectLeads = sortedIds(activeProjects);
  counts.activeProjectLeads = ids.activeProjectLeads.length;

  const sourceGoals = await targetDb
    .select({ id: goals.id, status: goals.status })
    .from(goals)
    .where(eq(goals.ownerAgentId, agentId));
  const operativeGoals = sourceGoals.filter((row) => !TERMINAL_GOAL_STATUSES.has(row.status));
  ids.operativeGoals = sortedIds(operativeGoals);
  counts.operativeGoals = ids.operativeGoals.length;

  const sourceRuntimeServices = await targetDb
    .select({
      id: workspaceRuntimeServices.id,
      status: workspaceRuntimeServices.status,
      providerRef: workspaceRuntimeServices.providerRef,
    })
    .from(workspaceRuntimeServices)
    .where(eq(workspaceRuntimeServices.ownerAgentId, agentId));
  const localRegistryRows = await listLocalServiceRegistryRecordsStrict({ profileKind: "workspace-runtime" });
  const registryByRuntimeServiceId = new Map(localRegistryRows
    .filter((row) => row.runtimeServiceId !== null)
    .map((row) => [row.runtimeServiceId!, row]));
  const activeRuntimeServices = sourceRuntimeServices.filter((row) => {
    if (!TERMINAL_RUNTIME_SERVICE_STATUSES.has(row.status)) return true;
    const registry = registryByRuntimeServiceId.get(row.id);
    if (registry && (isPidAlive(registry.pid) || isProcessGroupAlive(registry.processGroupId))) return true;
    if (row.providerRef === null) return false;
    const providerProcessGroupId = Number.parseInt(row.providerRef, 10);
    if (!Number.isInteger(providerProcessGroupId) || providerProcessGroupId <= 0) return true;
    return isPidAlive(providerProcessGroupId) || isProcessGroupAlive(providerProcessGroupId);
  });
  // Durable active claims close both sides of the persistence race: `starting`
  // has no runtime row yet, while `running` remains authoritative until the
  // claim is finalized to terminal evidence. A persisted runtime is represented
  // by its service ID so the service row and claim count as one dependency.
  const activeRuntimeStartClaims = await targetDb
    .select({
      id: workspaceRuntimeStartClaims.id,
      runtimeServiceId: workspaceRuntimeStartClaims.runtimeServiceId,
    })
    .from(workspaceRuntimeStartClaims)
    .where(and(
      eq(workspaceRuntimeStartClaims.ownerAgentId, agentId),
      inArray(workspaceRuntimeStartClaims.status, ["starting", "running"]),
    ));
  ids.activeRuntimeServices = [...new Set([
    ...activeRuntimeServices.map((row) => row.id),
    ...activeRuntimeStartClaims.map((row) => row.runtimeServiceId ?? row.id),
  ])].sort((left, right) => left.localeCompare(right));
  counts.activeRuntimeServices = ids.activeRuntimeServices.length;

  const sourceApprovals = await targetDb
    .select({ id: approvals.id, status: approvals.status })
    .from(approvals)
    .where(eq(approvals.requestedByAgentId, agentId));
  const pendingApprovals = sourceApprovals.filter((row) => !TERMINAL_APPROVAL_STATUSES.has(row.status));
  ids.pendingApprovals = sortedIds(pendingApprovals);
  counts.pendingApprovals = ids.pendingApprovals.length;

  const sourceWatchdogs = await targetDb
    .select({ id: issueWatchdogs.id, status: issueWatchdogs.status })
    .from(issueWatchdogs)
    .where(eq(issueWatchdogs.watchdogAgentId, agentId));
  const activeIssueWatchdogs = sourceWatchdogs.filter((row) => !TERMINAL_WATCHDOG_STATUSES.has(row.status));
  ids.activeIssueWatchdogs = sortedIds(activeIssueWatchdogs);
  counts.activeIssueWatchdogs = ids.activeIssueWatchdogs.length;

  const sourceRecoveryActions = await targetDb
    .select({ id: issueRecoveryActions.id, status: issueRecoveryActions.status })
    .from(issueRecoveryActions)
    .where(eq(issueRecoveryActions.ownerAgentId, agentId));
  const activeRecoveryActions = sourceRecoveryActions.filter((row) => (
    !TERMINAL_RECOVERY_ACTION_STATUSES.has(row.status)
  ));
  ids.activeRecoveryActions = sortedIds(activeRecoveryActions);
  counts.activeRecoveryActions = ids.activeRecoveryActions.length;

  const pipelineAgentLeases = await targetDb
    .select({ id: pipelineCases.id })
    .from(pipelineCases)
    .where(eq(pipelineCases.leaseAgentId, agentId));
  ids.unclearedPipelineAgentLeases = sortedIds(pipelineAgentLeases);
  counts.unclearedPipelineAgentLeases = ids.unclearedPipelineAgentLeases.length;

  const allPipelines = await targetDb.select().from(pipelines);
  const activePipelineIds = new Set(allPipelines
    .filter((row) => row.archivedAt === null)
    .map((row) => row.id));
  const activePipelineApprovers = (await targetDb.select().from(pipelineStages)).filter((row) => {
    if (!activePipelineIds.has(row.pipelineId)) return false;
    const config = asRecord(row.config);
    const approver = asRecord(config.approver);
    const automation = asRecord(config.automation);
    const isApprover = config.requireApproval === true
      && approver.kind === "agent"
      && typeof approver.id === "string"
      && normalizeAgentRetirementId(approver.id) === agentId;
    const isAutomationAssignee = typeof automation.assigneeAgentId === "string"
      && normalizeAgentRetirementId(automation.assigneeAgentId) === agentId;
    return isApprover || isAutomationAssignee;
  });
  ids.activePipelineApprovers = sortedIds(activePipelineApprovers);
  counts.activePipelineApprovers = ids.activePipelineApprovers.length;

  const activeHireApprovalReferences = (await targetDb.select().from(approvals)).filter((row) => {
    if (row.type !== "hire_agent" || TERMINAL_APPROVAL_STATUSES.has(row.status)) return false;
    const payload = asRecord(row.payload);
    return [payload.agentId, payload.reportsTo].some((value) => (
      typeof value === "string" && normalizeAgentRetirementId(value) === agentId
    ));
  });
  ids.activeHireApprovalReferences = sortedIds(activeHireApprovalReferences);
  counts.activeHireApprovalReferences = ids.activeHireApprovalReferences.length;

  const allAgents = await targetDb
    .select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status })
    .from(agents);
  ids.liveDescendants = listLiveAgentDescendants(agentId, allAgents);
  counts.liveDescendants = ids.liveDescendants.length;

  return { counts, ids };
}

type ReferenceColumn = {
  schemaName: string;
  tableName: string;
  columnName: string;
  typeName: string;
};

export type AgentDeletionHistoryInventory = {
  total: number;
  referenceCounts: Record<string, number>;
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Physical deletion is intentionally rare. Scan every user-table UUID, textual,
 * array, and JSON provenance column so new direct/history references fail closed
 * without teaching the destructive path how to erase them.
 */
export async function scanAgentDeletionHistoryReferences(
  targetDb: Db,
  rawAgentId: string,
): Promise<AgentDeletionHistoryInventory> {
  const agentId = canonicalAgentId(rawAgentId);
  const columnsResult = await targetDb.execute(sql<ReferenceColumn>`
    select
      namespace.nspname as "schemaName",
      relation.relname as "tableName",
      attribute.attname as "columnName",
      data_type.typname as "typeName"
    from pg_attribute attribute
    join pg_class relation on relation.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_type data_type on data_type.oid = attribute.atttypid
    where attribute.attnum > 0
      and not attribute.attisdropped
      and relation.relkind in ('r', 'p')
      and namespace.nspname <> 'information_schema'
      and namespace.nspname not like 'pg_%'
      and data_type.typname in ('uuid', 'text', 'varchar', 'bpchar', 'json', 'jsonb', '_uuid', '_text', '_varchar')
      and not (
        namespace.nspname = 'public'
        and relation.relname = 'agents'
        and attribute.attname = 'id'
      )
    order by namespace.nspname, relation.relname, attribute.attname
  `);
  const columns = Array.from(columnsResult) as unknown as ReferenceColumn[];
  if (columns.length === 0) return { total: 0, referenceCounts: {} };

  const referenceQueries = columns.map((column) => {
    const qualifiedColumn = sql.raw(
      `${quoteIdentifier(column.schemaName)}.${quoteIdentifier(column.tableName)}.${quoteIdentifier(column.columnName)}`,
    );
    const qualifiedTable = sql.raw(
      `${quoteIdentifier(column.schemaName)}.${quoteIdentifier(column.tableName)}`,
    );
    const referenceKey = `${column.schemaName}.${column.tableName}.${column.columnName}`;
    let predicate = column.typeName === "uuid"
      ? sql`${qualifiedColumn} = ${agentId}::uuid`
      : sql`position(${agentId} in lower(coalesce(${qualifiedColumn}::text, ''))) > 0`;
    const directAccessReference = column.schemaName === "public" && (
      (["agent_api_keys", "agent_memberships", "company_skill_stars"].includes(column.tableName)
        && column.columnName === "agent_id")
      || (["company_memberships", "principal_permission_grants"].includes(column.tableName)
        && column.columnName === "principal_id")
      || (["company_secret_bindings", "user_secret_declarations"].includes(column.tableName)
        && column.columnName === "target_id")
    );
    if (directAccessReference) {
      const typeColumn = ["company_memberships", "principal_permission_grants"].includes(column.tableName)
        ? "principal_type"
        : ["company_secret_bindings", "user_secret_declarations"].includes(column.tableName)
          ? "target_type"
          : null;
      const typePredicate = typeColumn === null
        ? sql`true`
        : sql`lower(coalesce(${sql.raw(
          `${quoteIdentifier(column.schemaName)}.${quoteIdentifier(column.tableName)}.${quoteIdentifier(typeColumn)}`,
        )}::text, '')) = 'agent'`;
      predicate = sql`${predicate} and not (
        ${typePredicate}
      )`;
    }
    return sql`select ${referenceKey}::text as "referenceKey", count(*)::int as "count"
      from ${qualifiedTable}
      where ${predicate}`;
  });
  const rowsResult = await targetDb.execute(sql<{ referenceKey: string; count: number }>`
    ${sql.join(referenceQueries, sql` union all `)}
  `);
  const rows = Array.from(rowsResult) as unknown as Array<{ referenceKey: string; count: number }>;
  const referenceCounts: Record<string, number> = Object.fromEntries(rows
    .map((row) => [row.referenceKey, Number(row.count)] as const)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    total: Object.values(referenceCounts).reduce((total, count) => total + count, 0),
    referenceCounts,
  };
}

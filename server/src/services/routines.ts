import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentPortfolioMaintenanceGates,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueInboxArchives,
  issueReadStates,
  issues,
  pluginManagedResources,
  plugins,
  projects,
  routineRevisions,
  routineRunDeliveries,
  routineRuns,
  routineDocuments,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineDescriptionDocument,
  RoutineListItem,
  RoutineManagedByPlugin,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RoutineVariable,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  getBuiltinRoutineVariableValues,
  extractRoutineVariableNames,
  interpolateRoutineTemplate,
  isValidRoutineDateString,
  pluginOperationIssueOriginKind,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import { getTelemetryClient } from "../telemetry.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { issueService } from "./issues.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import {
  canonicalizeAgentReferenceId,
  lockAgentLifecycleReference,
} from "./agent-lifecycle-fence.js";
import { secretService } from "./secrets.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const MAX_ROUTINE_REVISIONS = 100;
const ROUTINE_DELIVERY_CLAIM_LEASE_MS = 60_000;
const ROUTINE_DELIVERY_MAX_ATTEMPTS = 5;
const ROUTINE_DELIVERY_RETRY_BASE_MS = 5_000;
const ROUTINE_DELIVERY_RECONCILE_BATCH = 25;
const ROUTINE_DELIVERY_DEFER_MS = 30_000;
const ROUTINE_DELIVERY_QUARANTINE_MS = 5 * 60_000;
const ROUTINE_DELIVERY_ERROR_MAX_CHARS = 1024;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function boundedRoutineDeliveryError(value: unknown) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current !== null && current !== undefined && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  const raw = messages.join(" | caused by: ");
  const redacted = redactSensitiveText(raw).replace(/\s+/g, " ").trim() || "routine_delivery_error";
  return redacted.slice(0, ROUTINE_DELIVERY_ERROR_MAX_CHARS);
}

async function resolveCompanyDefaultResponsibleUserId(db: Db, companyId: string) {
  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.defaultResponsibleUserId) return company.defaultResponsibleUserId;

  const owner = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return owner?.userId ?? null;
}

async function resolveRoutineResponsibleUserId(db: Db, companyId: string, actorUserId: string | null | undefined, parentIssueId?: string | null) {
  if (actorUserId) return actorUserId;
  if (parentIssueId) {
    const parent = await db
      .select({ responsibleUserId: issues.responsibleUserId, createdByUserId: issues.createdByUserId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, parentIssueId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.responsibleUserId) return parent.responsibleUserId;
    if (parent?.createdByUserId) return parent.createdByUserId;
  }
  return resolveCompanyDefaultResponsibleUserId(db, companyId);
}

type Actor = { agentId?: string | null; userId?: string | null; runId?: string | null };
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

const ROUTINE_DESCRIPTION_DOCUMENT_KEY = "description" as const;

interface RoutineTriggerSecretRestoreMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

function routineWebhookSecretConfigPath(secretId: string) {
  return `webhookSecret:${secretId}`;
}

function assertTimeZone(timeZone: string) {
  try {
    getZonedMinuteFormatter(timeZone).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

// Constructing an Intl.DateTimeFormat costs ~1ms of ICU work, and
// computeNextRun calls getZonedMinuteParts once per minute-step (up to
// 366*24*60*5 iterations for sparse schedules), which can block the event
// loop for minutes per scheduler tick. Formatter instances are immutable,
// so cache one per timezone. See #8033.
const zonedMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedMinuteFormatter(timeZone: string) {
  let formatter = zonedMinuteFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedMinuteFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = getZonedMinuteFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

export function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped_paused") return "Skipped because the project is paused";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanVariableValue(name: string, raw: unknown) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw unprocessable(`Variable "${name}" must be a boolean`);
}

function parseNumberVariableValue(name: string, raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw unprocessable(`Variable "${name}" must be a number`);
}

function parseDateVariableValue(name: string, raw: unknown) {
  if (typeof raw !== "string") {
    throw unprocessable(`Variable "${name}" must be a YYYY-MM-DD date`);
  }
  const normalized = raw.trim();
  if (!isValidRoutineDateString(normalized)) {
    throw unprocessable(`Variable "${name}" must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}

function normalizeRoutineVariableValue(variable: RoutineVariable, raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);
  if (variable.type === "date") return parseDateVariableValue(variable.name, raw);

  const normalized = stringifyRoutineVariableValue(raw);
  if (variable.type === "select") {
    if (!variable.options.includes(normalized)) {
      throw unprocessable(`Variable "${variable.name}" must match one of: ${variable.options.join(", ")}`);
    }
  }
  return normalized;
}

function isMissingRoutineVariableValue(value: string | number | boolean | null) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function assertRoutineVariableDefinitions(variables: RoutineVariable[]) {
  for (const variable of variables) {
    if (variable.defaultValue != null) {
      normalizeRoutineVariableValue(variable, variable.defaultValue);
    }
    if (variable.type === "select" && variable.options.length === 0) {
      throw unprocessable(`Variable "${variable.name}" must define at least one option`);
    }
  }
}

function sanitizeRoutineVariableInputs(
  variables: Array<Partial<RoutineVariable> & Pick<RoutineVariable, "name">> | null | undefined,
): RoutineVariable[] {
  return (variables ?? []).map((variable) => ({
    name: variable.name,
    label: variable.label ?? null,
    type: variable.type ?? "text",
    defaultValue: variable.defaultValue ?? null,
    required: variable.required ?? true,
    options: variable.options ?? [],
  }));
}

function assertScheduleCompatibleVariables(variables: RoutineVariable[]) {
  const missingDefaults = variables
    .filter((variable) => variable.required)
    .filter((variable) => {
      try {
        return isMissingRoutineVariableValue(normalizeRoutineVariableValue(variable, variable.defaultValue));
      } catch {
        return true;
      }
    })
    .map((variable) => variable.name);
  if (missingDefaults.length > 0) {
    throw unprocessable(
      `Scheduled routines require defaults for required variables: ${missingDefaults.join(", ")}`,
    );
  }
}

function statusRequiresDefaultAgent(status: string) {
  return status === "active";
}

function normalizeDraftRoutineStatus(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    return "paused";
  }
  return status;
}

function assertRoutineCanEnable(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    throw unprocessable("Default agent required");
  }
}

function collectProvidedRoutineVariables(
  source: "schedule" | "manual" | "api" | "webhook",
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, unknown> | null | undefined,
) {
  const nestedVariables = isPlainRecord(payload) && isPlainRecord(payload.variables) ? payload.variables : {};
  const provided = {
    ...(source === "webhook" && payload ? payload : {}),
    ...nestedVariables,
    ...(variables ?? {}),
  };
  delete provided.variables;
  return provided;
}

function resolveRoutineVariableValues(
  variables: RoutineVariable[],
  input: {
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    automaticVariables?: Record<string, string | number | boolean>;
  },
) {
  if (variables.length === 0) return {} as Record<string, string | number | boolean>;
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const automaticVariables = input.automaticVariables ?? {};
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    // Workspace-derived automatic values are authoritative for variables that
    // Paperclip manages from execution context, so callers cannot override them.
    const candidate = automaticVariables[variable.name] !== undefined
      ? automaticVariables[variable.name]
      : provided[variable.name] !== undefined
        ? provided[variable.name]
        : variable.defaultValue;
    const normalized = normalizeRoutineVariableValue(variable, candidate);
    if (normalized == null || (typeof normalized === "string" && normalized.trim().length === 0)) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = normalized;
  }

  if (missing.length > 0) {
    throw unprocessable(`Missing routine variables: ${missing.join(", ")}`);
  }

  return resolved;
}

function mergeRoutineRunPayload(
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, string | number | boolean>,
) {
  if (Object.keys(variables).length === 0) return payload ?? null;
  if (!payload) return { variables };
  const existingVariables = isPlainRecord(payload.variables) ? payload.variables : {};
  return {
    ...payload,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}

function normalizeRoutineDispatchFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeRoutineDispatchFingerprintValue(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeRoutineDispatchFingerprintValue(value[key])]),
    );
  }
  return String(value);
}

function createRoutineDispatchFingerprint(input: {
  payload: Record<string, unknown> | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  routineRevisionId: string | null;
  routineEnvFingerprint: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
  title: string;
  description: string | null;
}) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function createRoutineEnvFingerprint(env: unknown) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(env ?? null));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function readManagedRoutineIssueTemplate(defaultsJson: Record<string, unknown> | null | undefined) {
  const value = defaultsJson?.issueTemplate;
  if (!isPlainRecord(value)) return null;
  return {
    surfaceVisibility: typeof value.surfaceVisibility === "string" ? value.surfaceVisibility : null,
    originId: typeof value.originId === "string" && value.originId.trim() ? value.originId.trim() : null,
    billingCode: typeof value.billingCode === "string" && value.billingCode.trim() ? value.billingCode.trim() : null,
  };
}

function routineUsesWorkspaceBranch(routine: typeof routines.$inferSelect) {
  return (routine.variables ?? []).some((variable) => variable.name === WORKSPACE_BRANCH_ROUTINE_VARIABLE)
    || extractRoutineVariableNames([routine.title, routine.description]).includes(WORKSPACE_BRANCH_ROUTINE_VARIABLE);
}

function routineRevisionSnapshotRoutine(routine: RoutineRow): RoutineRevisionSnapshotV1["routine"] {
  return {
    id: routine.id,
    companyId: routine.companyId,
    projectId: routine.projectId,
    goalId: routine.goalId,
    parentIssueId: routine.parentIssueId,
    title: routine.title,
    description: routine.description,
    assigneeAgentId: routine.assigneeAgentId,
    priority: routine.priority as RoutineRevisionSnapshotV1["routine"]["priority"],
    status: routine.status as RoutineRevisionSnapshotV1["routine"]["status"],
    concurrencyPolicy: routine.concurrencyPolicy as RoutineRevisionSnapshotV1["routine"]["concurrencyPolicy"],
    catchUpPolicy: routine.catchUpPolicy as RoutineRevisionSnapshotV1["routine"]["catchUpPolicy"],
    variables: routine.variables ?? [],
    env: routine.env ?? null,
    responsibleUserId: routine.responsibleUserId ?? null,
  };
}

function routineRevisionSnapshotTrigger(trigger: RoutineTriggerRow): RoutineRevisionSnapshotV1["triggers"][number] {
  return {
    id: trigger.id,
    kind: trigger.kind as RoutineRevisionSnapshotV1["triggers"][number]["kind"],
    label: trigger.label,
    enabled: trigger.enabled,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    publicId: trigger.publicId,
    signingMode: trigger.signingMode as RoutineRevisionSnapshotV1["triggers"][number]["signingMode"],
    replayWindowSec: trigger.replayWindowSec,
  };
}

async function buildRoutineRevisionSnapshot(
  executor: Db,
  routine: RoutineRow,
): Promise<RoutineRevisionSnapshotV1> {
  const triggers = await executor
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.companyId, routine.companyId), eq(routineTriggers.routineId, routine.id)))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));

  return {
    version: 1,
    routine: routineRevisionSnapshotRoutine(routine),
    triggers: triggers.map(routineRevisionSnapshotTrigger),
  };
}

function canonicalSnapshot(value: RoutineRevisionSnapshotV1) {
  return JSON.stringify(value);
}

function snapshotsMatch(left: RoutineRevisionSnapshotV1, right: RoutineRevisionSnapshotV1) {
  return canonicalSnapshot(left) === canonicalSnapshot(right);
}

function routineCurrentFieldsMatch(left: RoutineRow, right: RoutineRow) {
  return snapshotsMatch(
    { version: 1, routine: routineRevisionSnapshotRoutine(left), triggers: [] },
    { version: 1, routine: routineRevisionSnapshotRoutine(right), triggers: [] },
  );
}

function mapRoutineRevision(row: typeof routineRevisions.$inferSelect): RoutineRevision {
  return {
    ...row,
    snapshot: row.snapshot as RoutineRevisionSnapshotV1,
  };
}

function mapRoutineDescriptionDocument(row: {
  id: string;
  companyId: string;
  routineId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RoutineDescriptionDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
    title: row.title,
    format: "markdown",
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function routineService(
  db: Db,
  deps: {
    heartbeat?: IssueAssignmentWakeupDeps;
    pluginWorkerManager?: PluginWorkerManager;
    routineDeliveryNow?: () => Date;
    routineDeliveryClaimLeaseMs?: number;
    routineDeliveryMaxAttempts?: number;
    routineDeliveryRetryBaseMs?: number;
  } = {},
) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db, {
    pluginWorkerManager: deps.pluginWorkerManager,
  });
  const routineDeliveryNow = deps.routineDeliveryNow ?? (() => new Date());
  const routineDeliveryClaimLeaseMs = deps.routineDeliveryClaimLeaseMs ?? ROUTINE_DELIVERY_CLAIM_LEASE_MS;
  const routineDeliveryMaxAttempts = deps.routineDeliveryMaxAttempts ?? ROUTINE_DELIVERY_MAX_ATTEMPTS;
  const routineDeliveryRetryBaseMs = deps.routineDeliveryRetryBaseMs ?? ROUTINE_DELIVERY_RETRY_BASE_MS;

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getManagedRoutineBinding(routine: typeof routines.$inferSelect) {
    return db
      .select({
        pluginKey: pluginManagedResources.pluginKey,
        defaultsJson: pluginManagedResources.defaultsJson,
        manifestJson: plugins.manifestJson,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.companyId, routine.companyId),
          eq(pluginManagedResources.resourceKind, "routine"),
          eq(pluginManagedResources.resourceId, routine.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function listManagedRoutineMetadata(routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineManagedByPlugin>();
    const rows = await db
      .select({
        id: pluginManagedResources.id,
        pluginId: pluginManagedResources.pluginId,
        pluginKey: pluginManagedResources.pluginKey,
        manifestJson: plugins.manifestJson,
        resourceKey: pluginManagedResources.resourceKey,
        resourceId: pluginManagedResources.resourceId,
        defaultsJson: pluginManagedResources.defaultsJson,
        createdAt: pluginManagedResources.createdAt,
        updatedAt: pluginManagedResources.updatedAt,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.resourceKind, "routine"),
          inArray(pluginManagedResources.resourceId, routineIds),
        ),
      );
    return new Map(rows.map((row) => [
      row.resourceId,
      {
        id: row.id,
        pluginId: row.pluginId,
        pluginKey: row.pluginKey,
        pluginDisplayName: row.manifestJson.displayName ?? row.pluginKey,
        resourceKind: "routine",
        resourceKey: row.resourceKey,
        defaultsJson: row.defaultsJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies RoutineManagedByPlugin,
    ]));
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getRoutineDescriptionDocument(
    routineId: string,
    executor: Db | any = db,
  ): Promise<RoutineDescriptionDocument | null> {
    const row = await executor
      .select({
        id: documents.id,
        companyId: documents.companyId,
        routineId: routineDocuments.routineId,
        key: routineDocuments.key,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(routineDocuments)
      .innerJoin(documents, eq(routineDocuments.documentId, documents.id))
      .where(and(
        eq(routineDocuments.routineId, routineId),
        eq(routineDocuments.key, ROUTINE_DESCRIPTION_DOCUMENT_KEY),
      ))
      .then((rows: any[]) => rows[0] ?? null);
    return row ? mapRoutineDescriptionDocument(row) : null;
  }

  async function upsertRoutineDescriptionDocument(
    executor: Db | any,
    routine: RoutineRow,
    actor: Actor,
    options: { changeSummary?: string | null } = {},
  ): Promise<RoutineDescriptionDocument> {
    if (executor === db) {
      return db.transaction(async (tx) => (
        upsertRoutineDescriptionDocument(tx as unknown as Db, routine, actor, options)
      ));
    }

    const now = new Date();
    const body = routine.description ?? "";
    const existing = await getRoutineDescriptionDocument(routine.id, executor);

    if (existing) {
      if (existing.body === body) return existing;
      const nextRevisionNumber = existing.latestRevisionNumber + 1;
      const [revision] = await executor
        .insert(documentRevisions)
        .values({
          companyId: routine.companyId,
          documentId: existing.id,
          revisionNumber: nextRevisionNumber,
          title: "Routine description",
          format: "markdown",
          body,
          changeSummary: options.changeSummary ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          createdAt: now,
        })
        .returning();

      await executor
        .update(documents)
        .set({
          title: "Routine description",
          format: "markdown",
          latestBody: body,
          latestRevisionId: revision.id,
          latestRevisionNumber: nextRevisionNumber,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: now,
        })
        .where(eq(documents.id, existing.id));
      await executor
        .update(routineDocuments)
        .set({ updatedAt: now })
        .where(eq(routineDocuments.documentId, existing.id));

      return {
        ...existing,
        title: "Routine description",
        body,
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: now,
      };
    }

    const [document] = await executor
      .insert(documents)
      .values({
        companyId: routine.companyId,
        title: "Routine description",
        format: "markdown",
        latestBody: body,
        latestRevisionId: null,
        latestRevisionNumber: 1,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [revision] = await executor
      .insert(documentRevisions)
      .values({
        companyId: routine.companyId,
        documentId: document.id,
        revisionNumber: 1,
        title: "Routine description",
        format: "markdown",
        body,
        changeSummary: options.changeSummary ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        createdAt: now,
      })
      .returning();
    await executor
      .update(documents)
      .set({ latestRevisionId: revision.id })
      .where(eq(documents.id, document.id));
    await executor.insert(routineDocuments).values({
      companyId: routine.companyId,
      routineId: routine.id,
      documentId: document.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: document.id,
      companyId: routine.companyId,
      routineId: routine.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      title: document.title,
      format: "markdown",
      body,
      latestRevisionId: revision.id,
      latestRevisionNumber: 1,
      createdByAgentId: document.createdByAgentId,
      createdByUserId: document.createdByUserId,
      updatedByAgentId: document.updatedByAgentId,
      updatedByUserId: document.updatedByUserId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  async function appendRoutineRevision(
    executor: Db,
    routine: RoutineRow,
    actor: Actor,
    options: {
      changeSummary?: string | null;
      restoredFromRevisionId?: string | null;
    } = {},
  ) {
    const snapshot = await buildRoutineRevisionSnapshot(executor, routine);
    const nextRevisionNumber = routine.latestRevisionId ? routine.latestRevisionNumber + 1 : 1;
    const now = new Date();
    const [revision] = await executor
      .insert(routineRevisions)
      .values({
        companyId: routine.companyId,
        routineId: routine.id,
        revisionNumber: nextRevisionNumber,
        title: snapshot.routine.title,
        description: snapshot.routine.description,
        snapshot,
        changeSummary: options.changeSummary ?? null,
        restoredFromRevisionId: options.restoredFromRevisionId ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        responsibleUserId: snapshot.routine.responsibleUserId ?? null,
        createdAt: now,
      })
      .returning();

    const [updatedRoutine] = await executor
      .update(routines)
      .set({
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedAt: now,
      })
      .where(eq(routines.id, routine.id))
      .returning();

    const routineForDocument = updatedRoutine ?? {
      ...routine,
      latestRevisionId: revision.id,
      latestRevisionNumber: nextRevisionNumber,
      updatedAt: now,
    };
    await upsertRoutineDescriptionDocument(executor, routineForDocument, actor, {
      changeSummary: options.changeSummary ?? null,
    });

    return {
      routine: routineForDocument,
      revision: mapRoutineRevision(revision),
    };
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  async function assertRestorableAssignee(
    companyId: string,
    assigneeAgentId: string | null | undefined,
    actor: Actor,
  ) {
    await assertAssignableAgent(db, companyId, assigneeAgentId, { kind: "routine" });
    if (actor.agentId && assigneeAgentId !== actor.agentId) {
      throw forbidden("Agents can only restore routine revisions assigned to themselves");
    }
  }

  async function assertProject(companyId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function assertGoal(companyId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.companyId !== companyId) throw unprocessable("Goal must belong to same company");
  }

  async function assertParentIssue(companyId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(row);
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        companyId: routineRuns.companyId,
        routineId: routineRuns.routineId,
        triggerId: routineRuns.triggerId,
        source: routineRuns.source,
        status: routineRuns.status,
        triggeredAt: routineRuns.triggeredAt,
        idempotencyKey: routineRuns.idempotencyKey,
        triggerPayload: routineRuns.triggerPayload,
        dispatchFingerprint: routineRuns.dispatchFingerprint,
        routineRevisionId: routineRuns.routineRevisionId,
        linkedIssueId: routineRuns.linkedIssueId,
        coalescedIntoRunId: routineRuns.coalescedIntoRunId,
        failureReason: routineRuns.failureReason,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
        updatedAt: routineRuns.updatedAt,
        triggerKind: routineTriggers.kind,
        triggerLabel: routineTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, {
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingRoutineIds = routineIds.filter((routineId) => !rowsByOriginId.has(routineId));
    if (missingRoutineIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.companyId, issues.companyId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "routine_execution"),
            inArray(issues.originId, missingRoutineIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, RoutineListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateRoutineTouchedState(input: {
    routineId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    updatedAt?: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    const updatedAt = input.updatedAt ?? routineDeliveryNow();
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt,
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt,
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  // Records a skipped scheduled firing without creating an execution issue. Used when the
  // routine's project is paused: the tick is still claimed/advanced upstream (no backfill),
  // and run history + trigger audit reflect the pause-specific skip.
  async function recordSuppressedScheduleRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    reason: string;
    nextRunAt: Date | null;
  }) {
    const triggeredAt = routineDeliveryNow();
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "skipped",
          triggeredAt,
          failureReason: input.reason,
          completedAt: triggeredAt,
          linkedIssueId: null,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId: input.routine.responsibleUserId ?? null,
        })
        .returning();
      await updateRoutineTouchedState({
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        triggeredAt,
        updatedAt: triggeredAt,
        status: "skipped_paused",
        nextRunAt: input.nextRunAt,
      }, txDb);
      return createdRun;
    });

    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId: "routine-scheduler",
        action: "routine.run_skipped",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "skipped",
          reason: input.reason,
        },
      });
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log skipped routine run");
    }

    return run;
  }

  function routineExecutionFingerprintCondition(dispatchFingerprint?: string | null) {
    if (!dispatchFingerprint) return null;
    // The "default" arm preserves coalescing against pre-migration open issues.
    // It becomes inert once those legacy routine execution issues drain out.
    return or(
      eq(issues.originFingerprint, dispatchFingerprint),
      eq(issues.originFingerprint, "default"),
    );
  }

  async function findLiveExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
  ) {
    const fingerprintCondition = routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    const contextBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issues.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (contextBoundIssue) return contextBoundIssue;

    // Issue creation, its routine-run receipt, and the durable delivery commit
    // atomically. Only an active delivery lease/queue row is a live marker: a
    // bare legacy `received` run must never suppress future work indefinitely.
    return executor
      .select()
      .from(issues)
      .innerJoin(
        routineRuns,
        and(
          sql`${routineRuns.id}::text = ${issues.originRunId}`,
          eq(routineRuns.linkedIssueId, issues.id),
          eq(routineRuns.status, "received"),
        ),
      )
      .innerJoin(
        routineRunDeliveries,
        and(
          eq(routineRunDeliveries.routineRunId, routineRuns.id),
          eq(routineRunDeliveries.companyId, issues.companyId),
          eq(routineRunDeliveries.issueId, issues.id),
          inArray(routineRunDeliveries.status, ["pending", "claimed"]),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  async function finalizeRun(
    runId: string,
    patch: Partial<typeof routineRuns.$inferInsert>,
    executor: Db = db,
    updatedAt: Date = routineDeliveryNow(),
  ) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt,
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  type RoutineDeliveryContext = Awaited<ReturnType<typeof readRoutineDeliveryContext>>;

  async function readRoutineDeliveryContext(deliveryId: string, executor: Db = db) {
    return executor
      .select({
        delivery: routineRunDeliveries,
        routineId: routineRuns.routineId,
        runCompanyId: routineRuns.companyId,
        runSource: routineRuns.source,
        runStatus: routineRuns.status,
        runLinkedIssueId: routineRuns.linkedIssueId,
        routineCompanyId: routines.companyId,
        issueCompanyId: issues.companyId,
        issueAssigneeAgentId: issues.assigneeAgentId,
        issueStatus: issues.status,
        issueExecutionRunId: issues.executionRunId,
        agentCompanyId: agents.companyId,
        agentName: agents.name,
        agentReportsTo: agents.reportsTo,
        agentStatus: agents.status,
      })
      .from(routineRunDeliveries)
      .innerJoin(routineRuns, eq(routineRuns.id, routineRunDeliveries.routineRunId))
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .leftJoin(issues, eq(issues.id, routineRunDeliveries.issueId))
      .leftJoin(agents, eq(agents.id, routineRunDeliveries.assigneeAgentId))
      .where(eq(routineRunDeliveries.id, deliveryId))
      .then((rows) => rows[0] ?? null);
  }

  function assertRoutineDeliveryContext(
    context: RoutineDeliveryContext,
  ): asserts context is NonNullable<RoutineDeliveryContext> {
    if (!context) throw notFound("Routine delivery not found");
    const knownStatus = new Set(["pending", "claimed", "delivered", "failed"]);
    if (!knownStatus.has(context.delivery.status)) {
      throw conflict("Routine delivery has an unsupported status", {
        code: "routine_delivery_status_invalid",
      });
    }
    if (context.delivery.status === "failed") return;
    if (!context.delivery.issueId || !context.delivery.assigneeAgentId ||
      context.delivery.companyId !== context.runCompanyId ||
      context.delivery.companyId !== context.routineCompanyId ||
      context.delivery.companyId !== context.issueCompanyId ||
      context.delivery.companyId !== context.agentCompanyId ||
      context.delivery.issueId !== context.runLinkedIssueId ||
      context.delivery.assigneeAgentId !== context.issueAssigneeAgentId) {
      throw conflict("Routine delivery tenant or identity binding drifted", {
        code: "routine_delivery_identity_drift",
      });
    }
  }

  async function lockRoutineDeliveryContext(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    context: NonNullable<RoutineDeliveryContext>,
  ) {
    const txDb = tx as unknown as Db;
    if (!context.delivery.assigneeAgentId) return null;
    await lockAgentLifecycleReference(txDb, {
      companyId: context.delivery.companyId,
      agentId: context.delivery.assigneeAgentId,
    });
    await tx.execute(sql`
      select id from ${routines}
      where ${routines.id} = ${context.routineId}
        and ${routines.companyId} = ${context.delivery.companyId}
      for update
    `);
    const locked = await txDb
      .select({ id: routineRunDeliveries.id })
      .from(routineRunDeliveries)
      .where(eq(routineRunDeliveries.id, context.delivery.id))
      .for("update", { of: routineRunDeliveries, skipLocked: true })
      .then((rows) => rows[0] ?? null);
    if (!locked) return null;
    const reread = await readRoutineDeliveryContext(context.delivery.id, txDb);
    assertRoutineDeliveryContext(reread);
    return reread;
  }

  function routineDeliveryEligible(context: NonNullable<RoutineDeliveryContext>, now: Date) {
    if (context.delivery.status === "pending") return context.delivery.availableAt.getTime() <= now.getTime();
    if (context.delivery.status === "claimed") {
      return Boolean(context.delivery.claimExpiresAt && context.delivery.claimExpiresAt.getTime() <= now.getTime());
    }
    return false;
  }

  async function claimRoutineDelivery(deliveryId: string) {
    const initial = await readRoutineDeliveryContext(deliveryId);
    assertRoutineDeliveryContext(initial);
    if (initial.delivery.status !== "pending" && initial.delivery.status !== "claimed") return null;

    return db.transaction(async (tx) => {
      const locked = await lockRoutineDeliveryContext(tx, initial);
      if (!locked) return null;
      const lockedNow = routineDeliveryNow();
      if (!routineDeliveryEligible(locked, lockedNow)) return null;
      const txDb = tx as unknown as Db;
      const maintenanceGate = await txDb
        .select({ id: agentPortfolioMaintenanceGates.id })
        .from(agentPortfolioMaintenanceGates)
        .where(and(
          eq(agentPortfolioMaintenanceGates.companyId, locked.delivery.companyId),
          eq(agentPortfolioMaintenanceGates.agentId, locked.delivery.assigneeAgentId!),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const invokability = await evaluateAgentInvokabilityFromDb(txDb, {
        id: locked.delivery.assigneeAgentId!,
        companyId: locked.delivery.companyId,
        name: locked.agentName!,
        reportsTo: locked.agentReportsTo,
        status: locked.agentStatus!,
      });
      if (maintenanceGate || (!invokability.invokable && invokability.reason === "paused")) {
        const deferReason = maintenanceGate
          ? "Routine delivery deferred by agent portfolio maintenance gate"
          : "Routine delivery deferred while assignee agent is paused";
        await txDb
          .update(routineRunDeliveries)
          .set({
            status: "pending",
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            availableAt: new Date(lockedNow.getTime() + ROUTINE_DELIVERY_DEFER_MS),
            lastError: boundedRoutineDeliveryError(deferReason),
            updatedAt: lockedNow,
          })
          .where(and(
            eq(routineRunDeliveries.id, locked.delivery.id),
            eq(routineRunDeliveries.status, locked.delivery.status),
            eq(routineRunDeliveries.updatedAt, locked.delivery.updatedAt),
          ));
        return null;
      }
      const claimToken = crypto.randomUUID();
      const exhausted = locked.delivery.attemptCount >= routineDeliveryMaxAttempts;
      const blockedReason = invokability.invokable
        ? null
        : `Routine delivery blocked because assignee is not invokable: ${invokability.reason}`;
      const updatedAt = new Date(lockedNow);
      const claimed = await txDb
        .update(routineRunDeliveries)
        .set({
          status: "claimed",
          claimToken,
          claimedAt: lockedNow,
          claimExpiresAt: new Date(lockedNow.getTime() + routineDeliveryClaimLeaseMs),
          attemptCount: exhausted ? locked.delivery.attemptCount : locked.delivery.attemptCount + 1,
          updatedAt,
        })
        .where(and(
          eq(routineRunDeliveries.id, locked.delivery.id),
          eq(routineRunDeliveries.status, locked.delivery.status),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return claimed ? { ...locked, delivery: claimed, exhausted, blockedReason } : null;
    });
  }

  async function findExactRoutineDeliveryWakeEvidence(
    context: NonNullable<RoutineDeliveryContext>,
    executor: Db = db,
    lock = false,
  ) {
    if (!context.delivery.issueId || !context.delivery.assigneeAgentId) return null;
    const query = executor
      .select({
        wakeupRequestId: agentWakeupRequests.id,
        heartbeatRunId: heartbeatRuns.id,
      })
      .from(agentWakeupRequests)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, agentWakeupRequests.runId),
          eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id),
          eq(heartbeatRuns.companyId, context.delivery.companyId),
          eq(heartbeatRuns.agentId, context.delivery.assigneeAgentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${context.delivery.issueId}`,
        ),
      )
      .where(and(
        eq(agentWakeupRequests.companyId, context.delivery.companyId),
        eq(agentWakeupRequests.agentId, context.delivery.assigneeAgentId),
        eq(agentWakeupRequests.idempotencyKey, context.delivery.wakeupIdempotencyKey),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${context.delivery.issueId}`,
      ))
      .orderBy(desc(agentWakeupRequests.createdAt))
      .limit(2);
    const rows = lock ? await query.for("share") : await query;
    return rows.length === 1 ? rows[0]! : null;
  }

  function assertCurrentRoutineDeliveryClaim(
    locked: NonNullable<RoutineDeliveryContext> | null,
    claimed: NonNullable<Awaited<ReturnType<typeof claimRoutineDelivery>>>,
  ): asserts locked is NonNullable<RoutineDeliveryContext> {
    if (!locked || locked.delivery.status !== "claimed" ||
      locked.delivery.claimToken !== claimed.delivery.claimToken ||
      locked.delivery.updatedAt.getTime() !== claimed.delivery.updatedAt.getTime()) {
      throw conflict("Routine delivery claim was lost", {
        code: "routine_delivery_claim_lost",
      });
    }
  }

  async function completeRoutineDeliveryInTransaction(
    txDb: Db,
    locked: NonNullable<RoutineDeliveryContext>,
    claimed: NonNullable<Awaited<ReturnType<typeof claimRoutineDelivery>>>,
    evidence: { wakeupRequestId: string; heartbeatRunId: string },
    now: Date,
  ) {
    const delivered = await txDb
      .update(routineRunDeliveries)
      .set({
        status: "delivered",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        deliveredWakeupRequestId: evidence.wakeupRequestId,
        deliveredHeartbeatRunId: evidence.heartbeatRunId,
        deliveredAt: now,
        failedAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(
        eq(routineRunDeliveries.id, locked.delivery.id),
        eq(routineRunDeliveries.status, "claimed"),
        eq(routineRunDeliveries.claimToken, claimed.delivery.claimToken!),
        eq(routineRunDeliveries.updatedAt, claimed.delivery.updatedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!delivered) {
      throw conflict("Routine delivery claim was lost", {
        code: "routine_delivery_claim_lost",
      });
    }
    const updatedRun = await finalizeRun(locked.delivery.routineRunId, {
      status: "issue_created",
      linkedIssueId: locked.delivery.issueId,
      failureReason: null,
      completedAt: now,
    }, txDb, now);
    await updateRoutineTouchedState({
      routineId: locked.routineId,
      triggerId: updatedRun?.triggerId ?? null,
      triggeredAt: updatedRun?.triggeredAt ?? now,
      updatedAt: now,
      status: "issue_created",
      issueId: locked.delivery.issueId,
    }, txDb);
    return updatedRun;
  }

  async function finalizeRoutineDelivery(
    claimed: NonNullable<Awaited<ReturnType<typeof claimRoutineDelivery>>>,
  ) {
    return db.transaction(async (tx) => {
      const locked = await lockRoutineDeliveryContext(tx, claimed);
      assertCurrentRoutineDeliveryClaim(locked, claimed);
      const txDb = tx as unknown as Db;
      const evidence = await findExactRoutineDeliveryWakeEvidence(locked, txDb, true);
      if (!evidence) return null;
      return completeRoutineDeliveryInTransaction(txDb, locked, claimed, evidence, routineDeliveryNow());
    });
  }

  async function releaseRoutineDeliveryForRetry(
    claimed: NonNullable<Awaited<ReturnType<typeof claimRoutineDelivery>>>,
    failureReason: string,
  ) {
    return db.transaction(async (tx) => {
      const locked = await lockRoutineDeliveryContext(tx, claimed);
      assertCurrentRoutineDeliveryClaim(locked, claimed);
      const now = routineDeliveryNow();
      const delay = routineDeliveryRetryBaseMs * (2 ** Math.max(0, locked.delivery.attemptCount - 1));
      const released = await (tx as unknown as Db)
        .update(routineRunDeliveries)
        .set({
          status: "pending",
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          availableAt: new Date(now.getTime() + delay),
          lastError: boundedRoutineDeliveryError(failureReason),
          updatedAt: now,
        })
        .where(and(
          eq(routineRunDeliveries.id, locked.delivery.id),
          eq(routineRunDeliveries.status, "claimed"),
          eq(routineRunDeliveries.claimToken, claimed.delivery.claimToken!),
          eq(routineRunDeliveries.updatedAt, claimed.delivery.updatedAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!released) {
        throw conflict("Routine delivery claim was lost", {
          code: "routine_delivery_claim_lost",
        });
      }
      return released;
    });
  }

  async function failRoutineDelivery(
    claimed: NonNullable<Awaited<ReturnType<typeof claimRoutineDelivery>>>,
    failureReason: string,
  ) {
    return db.transaction(async (tx) => {
      const locked = await lockRoutineDeliveryContext(tx, claimed);
      assertCurrentRoutineDeliveryClaim(locked, claimed);
      const txDb = tx as unknown as Db;
      const exactEvidence = await findExactRoutineDeliveryWakeEvidence(locked, txDb, true);
      if (exactEvidence) {
        return completeRoutineDeliveryInTransaction(
          txDb,
          locked,
          claimed,
          exactEvidence,
          routineDeliveryNow(),
        );
      }
      const now = routineDeliveryNow();
      const safeFailureReason = boundedRoutineDeliveryError(failureReason);
      // Delivery CAS is the first mutation. If it misses, throwing rolls back
      // the entire transaction before follower or issue cleanup can occur.
      const failedDelivery = await txDb.update(routineRunDeliveries).set({
        status: "failed",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        deliveredWakeupRequestId: null,
        deliveredHeartbeatRunId: null,
        deliveredAt: null,
        lastError: safeFailureReason,
        failedAt: now,
        updatedAt: now,
      }).where(and(
        eq(routineRunDeliveries.id, locked.delivery.id),
        eq(routineRunDeliveries.status, "claimed"),
        eq(routineRunDeliveries.claimToken, claimed.delivery.claimToken!),
        eq(routineRunDeliveries.updatedAt, claimed.delivery.updatedAt),
      )).returning().then((rows) => rows[0] ?? null);
      if (!failedDelivery) {
        throw conflict("Routine delivery claim was lost", {
          code: "routine_delivery_claim_lost",
        });
      }
      const followerCondition = and(
        eq(routineRuns.companyId, locked.delivery.companyId),
        eq(routineRuns.coalescedIntoRunId, locked.delivery.routineRunId),
        locked.delivery.issueId ? eq(routineRuns.linkedIssueId, locked.delivery.issueId) : sql`false`,
        eq(routineRuns.status, "coalesced"),
      );
      const followers = await txDb.select({ id: routineRuns.id }).from(routineRuns).where(followerCondition);
      if (followers.length > 0) {
        await txDb.update(routineRuns).set({
          status: "failed",
          linkedIssueId: null,
          failureReason: "Coalesced routine delivery target failed before wake acceptance",
          completedAt: now,
          updatedAt: now,
        }).where(followerCondition);
      }
      const otherDelivery = locked.delivery.issueId && locked.delivery.assigneeAgentId
        ? await txDb.select({ id: routineRunDeliveries.id }).from(routineRunDeliveries).where(and(
            eq(routineRunDeliveries.companyId, locked.delivery.companyId),
            eq(routineRunDeliveries.issueId, locked.delivery.issueId),
            eq(routineRunDeliveries.assigneeAgentId, locked.delivery.assigneeAgentId),
            ne(routineRunDeliveries.id, locked.delivery.id),
            inArray(routineRunDeliveries.status, ["pending", "claimed", "delivered"]),
          )).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const liveHeartbeat = locked.delivery.issueId && locked.delivery.assigneeAgentId
        ? await txDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, locked.delivery.companyId),
            eq(heartbeatRuns.agentId, locked.delivery.assigneeAgentId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            or(
              locked.issueExecutionRunId
                ? eq(heartbeatRuns.id, locked.issueExecutionRunId)
                : sql`false`,
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${locked.delivery.issueId}`,
            ),
          )).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const legitimateOther = otherDelivery ?? liveHeartbeat;
      const failedRun = await finalizeRun(locked.delivery.routineRunId, {
        status: "failed",
        linkedIssueId: legitimateOther ? locked.delivery.issueId : null,
        failureReason: safeFailureReason,
        completedAt: now,
      }, txDb, now);
      if (locked.delivery.issueId && !legitimateOther) {
        await txDb.delete(issues).where(and(
          eq(issues.id, locked.delivery.issueId),
          eq(issues.companyId, locked.delivery.companyId),
          eq(issues.originRunId, locked.delivery.routineRunId),
        ));
      }
      await updateRoutineTouchedState({
        routineId: locked.routineId,
        triggerId: failedRun?.triggerId ?? null,
        triggeredAt: failedRun?.triggeredAt ?? now,
        updatedAt: now,
        status: "failed",
      }, txDb);
      return failedRun;
    });
  }

  async function processRoutineRunDelivery(deliveryId: string) {
    const claimed = await claimRoutineDelivery(deliveryId);
    if (!claimed) return readRoutineDeliveryContext(deliveryId);
    if (claimed.exhausted || claimed.blockedReason) {
      await failRoutineDelivery(
        claimed,
        claimed.blockedReason ?? "Routine delivery retry attempts exhausted",
      );
      return readRoutineDeliveryContext(deliveryId);
    }
    const adopted = await finalizeRoutineDelivery(claimed);
    if (adopted) {
      return readRoutineDeliveryContext(deliveryId);
    }
    try {
      const receipt = await queueIssueAssignmentWakeup({
        heartbeat,
        issue: {
          id: claimed.delivery.issueId!,
          assigneeAgentId: claimed.delivery.assigneeAgentId,
          status: claimed.issueStatus ?? "todo",
        },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "routine.dispatch",
        requestedByActorType: claimed.runSource === "schedule" ? "system" : undefined,
        idempotencyKey: claimed.delivery.wakeupIdempotencyKey,
        rethrowOnError: true,
      });
      if (receipt.kind === "skipped") {
        await failRoutineDelivery(claimed, `Routine wake was skipped: ${receipt.reason}`);
      } else {
        const finalized = await finalizeRoutineDelivery(claimed);
        if (!finalized) {
          const missingEvidence = "Routine wake acceptance lacked exact durable wake evidence";
          if (claimed.delivery.attemptCount >= routineDeliveryMaxAttempts) {
            await failRoutineDelivery(claimed, missingEvidence);
          } else {
            await releaseRoutineDeliveryForRetry(claimed, missingEvidence);
          }
        }
      }
    } catch (error) {
      const finalized = await finalizeRoutineDelivery(claimed);
      if (finalized) {
        // The wake committed before the adapter surfaced an error. Adopt the
        // freshly locked durable receipt rather than scheduling a duplicate.
      } else {
        const failureReason = boundedRoutineDeliveryError(error);
        if (claimed.delivery.attemptCount >= routineDeliveryMaxAttempts) {
          await failRoutineDelivery(claimed, failureReason);
        } else {
          await releaseRoutineDeliveryForRetry(claimed, failureReason);
        }
      }
    }
    return readRoutineDeliveryContext(deliveryId);
  }

  async function quarantineRoutineRunDelivery(deliveryId: string, error: unknown) {
    const now = routineDeliveryNow();
    const lastError = boundedRoutineDeliveryError(`Routine delivery quarantined: ${boundedRoutineDeliveryError(error)}`);
    await db
      .update(routineRunDeliveries)
      .set({
        status: "pending",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        availableAt: new Date(now.getTime() + ROUTINE_DELIVERY_QUARANTINE_MS),
        lastError,
        updatedAt: now,
      })
      .where(and(
        eq(routineRunDeliveries.id, deliveryId),
        or(
          eq(routineRunDeliveries.status, "pending"),
          and(
            eq(routineRunDeliveries.status, "claimed"),
            lte(routineRunDeliveries.claimExpiresAt, now),
          ),
        ),
      ));
  }

  async function reconcileRoutineRunDeliveries(limit = ROUTINE_DELIVERY_RECONCILE_BATCH) {
    const now = routineDeliveryNow();
    const candidates = await db
      .select({ id: routineRunDeliveries.id })
      .from(routineRunDeliveries)
      .where(or(
        and(eq(routineRunDeliveries.status, "pending"), lte(routineRunDeliveries.availableAt, now)),
        and(eq(routineRunDeliveries.status, "claimed"), lte(routineRunDeliveries.claimExpiresAt, now)),
      ))
      .orderBy(asc(routineRunDeliveries.availableAt), asc(routineRunDeliveries.createdAt))
      .limit(Math.max(1, Math.min(limit, ROUTINE_DELIVERY_RECONCILE_BATCH)));
    let delivered = 0;
    let failed = 0;
    let pending = 0;
    let quarantined = 0;
    for (const candidate of candidates) {
      try {
        const result = await processRoutineRunDelivery(candidate.id);
        if (result?.delivery.status === "delivered") delivered += 1;
        else if (result?.delivery.status === "failed") failed += 1;
        else pending += 1;
      } catch (error) {
        quarantined += 1;
        pending += 1;
        try {
          await quarantineRoutineRunDelivery(candidate.id, error);
        } catch (quarantineError) {
          logger.error({
            deliveryId: candidate.id,
            err: boundedRoutineDeliveryError(quarantineError),
          }, "failed to quarantine routine delivery");
        }
      }
    }
    return { scanned: candidates.length, delivered, failed, pending, quarantined };
  }

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
    executor?: Db,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = getConfiguredSecretProvider();
    const input = {
      name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
      provider: providerId,
      value: secretValue,
      description: `Webhook auth for routine ${routineId}`,
    };
    const provider = getSecretProvider(input.provider);
    const prepared = await provider.createSecret({
      value: input.value,
      externalRef: null,
      context: {
        companyId,
        secretKey: input.name,
        secretName: input.name,
        version: 1,
      },
    });

    const insertSecret = async (secretDb: Db) => {
      const secret = await secretDb
        .insert(companySecrets)
        .values({
          companyId,
          key: input.name,
          name: input.name,
          provider: input.provider,
          status: "active",
          managedMode: "paperclip_managed",
          externalRef: prepared.externalRef,
          providerMetadata: null,
          latestVersion: 1,
          description: input.description,
          lastRotatedAt: new Date(),
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      await secretDb.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
        providerVersionRef: prepared.providerVersionRef ?? null,
        status: "current",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      });

      await secretDb.insert(companySecretBindings).values({
        companyId,
        secretId: secret.id,
        targetType: "routine",
        targetId: routineId,
        configPath: routineWebhookSecretConfigPath(secret.id),
      });

      return secret;
    };

    const secret = executor
      ? await insertSecret(executor)
      : await db.transaction(async (tx) => insertSecret(tx as unknown as Db));
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "routine",
      consumerId: trigger.routineId,
      actorType: "system",
      actorId: null,
      configPath: routineWebhookSecretConfigPath(trigger.secretId),
    });
    return value;
  }

  async function touchIssueForUserInbox(
    executor: Db,
    input: {
      companyId: string;
      issueId: string;
      userId: string;
      touchedAt: Date;
    },
  ) {
    await executor
      .insert(issueReadStates)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        userId: input.userId,
        lastReadAt: input.touchedAt,
        updatedAt: input.touchedAt,
      })
      .onConflictDoUpdate({
        target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
        set: {
          lastReadAt: input.touchedAt,
          updatedAt: input.touchedAt,
        },
      });

    await executor
      .delete(issueInboxArchives)
      .where(
        and(
          eq(issueInboxArchives.companyId, input.companyId),
          eq(issueInboxArchives.issueId, input.issueId),
          eq(issueInboxArchives.userId, input.userId),
        ),
      );
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    assigneeAgentId?: string | null;
    idempotencyKey?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
    descriptionAppendix?: string | null;
    actor?: Actor;
  }) {
    const projectId = input.projectId ?? input.routine.projectId ?? null;
    const projectWorkspaceId = input.projectWorkspaceId ?? null;
    const rawAssigneeAgentId = input.assigneeAgentId ?? input.routine.assigneeAgentId ?? null;
    if (!rawAssigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    const assigneeAgentId = canonicalizeAgentReferenceId(rawAssigneeAgentId);
    const expectedRoutineAssigneeAgentId = input.routine.assigneeAgentId
      ? canonicalizeAgentReferenceId(input.routine.assigneeAgentId)
      : null;
    await assertAssignableAgent(db, input.routine.companyId, assigneeAgentId, { kind: "routine" });
    const automaticVariables: Record<string, string | number | boolean> = {};
    if (input.executionWorkspaceId && routineUsesWorkspaceBranch(input.routine)) {
      const workspace = await db
        .select({
          branchName: executionWorkspaces.branchName,
          mode: executionWorkspaces.mode,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const branchName = workspace?.branchName?.trim();
      if (workspace && workspace.mode !== "shared_workspace" && branchName) {
        automaticVariables[WORKSPACE_BRANCH_ROUTINE_VARIABLE] = branchName;
      }
    }
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], {
      ...input,
      automaticVariables,
    });
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...automaticVariables, ...resolvedVariables };
    const title = interpolateRoutineTemplate(input.routine.title, allVariables) ?? input.routine.title;
    const baseDescription = interpolateRoutineTemplate(input.routine.description, allVariables);
    const description = [baseDescription, input.descriptionAppendix]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n");
    const triggerPayload = mergeRoutineRunPayload(input.payload, { ...automaticVariables, ...resolvedVariables });
    const managedRoutineBinding = await getManagedRoutineBinding(input.routine);
    const managedIssueTemplate = readManagedRoutineIssueTemplate(managedRoutineBinding?.defaultsJson);
    const issueOriginKind = managedIssueTemplate?.surfaceVisibility === "plugin_operation" && managedRoutineBinding
      ? pluginOperationIssueOriginKind(managedRoutineBinding.pluginKey)
      : "routine_execution";
    const issueOriginId = managedIssueTemplate?.originId ?? input.routine.id;
    const issueBillingCode = managedIssueTemplate?.billingCode ?? null;
    const dispatchFingerprint = createRoutineDispatchFingerprint({
      payload: triggerPayload,
      projectId,
      projectWorkspaceId,
      assigneeAgentId,
      routineRevisionId: input.routine.latestRevisionId,
      routineEnvFingerprint: createRoutineEnvFingerprint(input.routine.env),
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      executionWorkspacePreference: input.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
      title,
      description,
    });
    const dispatch = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Every lifecycle-sensitive writer takes canonical Agent locks before
      // dependent rows. Dispatch must follow the same order as routine updates,
      // trigger enables, and retirement or those paths can deadlock.
      await lockAgentLifecycleReference(txDb, {
        companyId: input.routine.companyId,
        agentId: assigneeAgentId,
      });
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
      );
      const lockedRoutine = await txDb
        .select()
        .from(routines)
        .where(and(
          eq(routines.id, input.routine.id),
          eq(routines.companyId, input.routine.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!lockedRoutine) throw notFound("Routine not found");
      if (lockedRoutine.latestRevisionId !== input.routine.latestRevisionId) {
        throw conflict("Routine changed while dispatching", {
          code: "routine_dispatch_snapshot_drift",
          field: "latestRevisionId",
          expectedRevisionId: input.routine.latestRevisionId,
          currentRevisionId: lockedRoutine.latestRevisionId,
        });
      }
      const lockedRoutineAssigneeAgentId = lockedRoutine.assigneeAgentId
        ? canonicalizeAgentReferenceId(lockedRoutine.assigneeAgentId)
        : null;
      if (lockedRoutineAssigneeAgentId !== expectedRoutineAssigneeAgentId) {
        throw conflict("Routine assignee changed while dispatching", {
          code: "routine_dispatch_snapshot_drift",
          field: "assigneeAgentId",
          expectedAssigneeAgentId: expectedRoutineAssigneeAgentId,
          currentAssigneeAgentId: lockedRoutineAssigneeAgentId,
        });
      }
      await assertAssignableAgent(txDb, input.routine.companyId, assigneeAgentId, { kind: "routine" });

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(routineRuns.triggerId, input.trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return { run: existing, deliveryId: null };
      }

      const triggeredAt = routineDeliveryNow();
      const manualRunnerUserId = input.source === "manual" ? input.actor?.userId ?? null : null;
      const latestRevisionResponsibleUserId = input.routine.latestRevisionId
        ? await txDb
            .select({
              responsibleUserId: routineRevisions.responsibleUserId,
              snapshot: routineRevisions.snapshot,
            })
            .from(routineRevisions)
            .where(and(
              eq(routineRevisions.companyId, input.routine.companyId),
              eq(routineRevisions.routineId, input.routine.id),
              eq(routineRevisions.id, input.routine.latestRevisionId),
            ))
            .then((rows) => {
              const row = rows[0] ?? null;
              const snapshot = row?.snapshot as RoutineRevisionSnapshotV1 | undefined;
              return row?.responsibleUserId ?? snapshot?.routine.responsibleUserId ?? null;
            })
        : null;
      const responsibleUserId =
        manualRunnerUserId ?? latestRevisionResponsibleUserId ?? input.routine.responsibleUserId ?? null;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
          dispatchFingerprint,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const activeIssue = await findLiveExecutionIssue(input.routine, txDb, dispatchFingerprint, {
          kind: issueOriginKind,
          id: issueOriginId,
        });
        if (activeIssue && input.routine.concurrencyPolicy !== "always_enqueue") {
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: activeIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb, triggeredAt);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            updatedAt: triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return { run: updated ?? createdRun, deliveryId: null };
        }

        try {
          // Bind issue creation to this transaction. `issueService` uses a
          // nested savepoint when its DB is already a transaction, so the issue
          // and routine-run receipt have one parent commit boundary.
          createdIssue = await issueService(txDb).create(input.routine.companyId, {
            projectId,
            projectWorkspaceId,
            goalId: input.routine.goalId,
            parentId: input.routine.parentIssueId,
            title,
            description,
            status: "todo",
            priority: input.routine.priority,
            assigneeAgentId,
            createdByAgentId: input.source === "manual" ? input.actor?.agentId ?? null : null,
            createdByUserId: manualRunnerUserId,
            responsibleUserId,
            trustExplicitResponsibleUserId: true,
            originKind: issueOriginKind,
            originId: issueOriginId,
            originRunId: createdRun.id,
            originFingerprint: dispatchFingerprint,
            billingCode: issueBillingCode,
            executionWorkspaceId: input.executionWorkspaceId ?? null,
            executionWorkspacePreference: input.executionWorkspacePreference ?? null,
            executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
          });
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
          if (!isOpenExecutionConflict || input.routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(input.routine, txDb, dispatchFingerprint, {
            kind: issueOriginKind,
            id: issueOriginId,
          });
          if (!existingIssue) throw error;
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: existingIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb, triggeredAt);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            updatedAt: triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          return { run: updated ?? createdRun, deliveryId: null };
        }

        // Commit the issue and its linked receipt before invoking the heartbeat
        // service, which may use another connection and must be able to observe
        // the new issue. The `received` receipt is also the distributed
        // no-duplicate marker consumed by findLiveExecutionIssue above.
        const updated = await finalizeRun(createdRun.id, {
          status: "received",
          linkedIssueId: createdIssue.id,
        }, txDb, triggeredAt);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          updatedAt: triggeredAt,
          status: "received",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        const deliveryId = crypto.randomUUID();
        await txDb.insert(routineRunDeliveries).values({
          id: deliveryId,
          companyId: input.routine.companyId,
          routineRunId: createdRun.id,
          issueId: createdIssue.id,
          assigneeAgentId,
          status: "pending",
          wakeupIdempotencyKey: `routine-delivery:${createdRun.id}`,
          availableAt: triggeredAt,
          createdAt: triggeredAt,
          updatedAt: triggeredAt,
        });
        return { run: updated ?? createdRun, deliveryId };
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failedAt = routineDeliveryNow();
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: failedAt,
        }, txDb, failedAt);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          updatedAt: failedAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return { run: failed ?? createdRun, deliveryId: null };
      }
    });

    let run = dispatch.run;
    if (dispatch.deliveryId) {
      await processRoutineRunDelivery(dispatch.deliveryId);
      run = await db.select().from(routineRuns).where(eq(routineRuns.id, dispatch.run.id))
        .then((rows) => rows[0] ?? dispatch.run);
    }

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log automated routine run");
      }
    }

    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineRun(telemetryClient, {
        source: run.source,
        status: run.status,
      });
    }

    return run;
  }

  return {
    get: getRoutineById,
    getTrigger: getTriggerById,
    claimRunDelivery: claimRoutineDelivery,
    processRunDelivery: processRoutineRunDelivery,
    reconcileRunDeliveries: reconcileRoutineRunDeliveries,

    list: async (
      companyId: string,
      filters?: { projectId?: string | null },
    ): Promise<RoutineListItem[]> => {
      const conditions = [eq(routines.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(routines.projectId, filters.projectId));

      const rows = await db
        .select()
        .from(routines)
        .where(and(...conditions))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeIssueByRoutine, managedByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listLiveIssueByRoutineIds(companyId, routineIds),
        listManagedRoutineMetadata(routineIds),
      ]);
      return rows.map((row) => ({
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeIssue: activeIssueByRoutine.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, descriptionDocument, triggers, recentRuns, activeIssue, managedByRoutine] = await Promise.all([
        row.projectId
          ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null)
          : null,
        row.assigneeAgentId
          ? db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null)
          : null,
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        getRoutineDescriptionDocument(row.id),
        db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id)).orderBy(asc(routineTriggers.createdAt)),
        db
          .select({
            id: routineRuns.id,
            companyId: routineRuns.companyId,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            idempotencyKey: routineRuns.idempotencyKey,
            triggerPayload: routineRuns.triggerPayload,
            dispatchFingerprint: routineRuns.dispatchFingerprint,
            routineRevisionId: routineRuns.routineRevisionId,
            linkedIssueId: routineRuns.linkedIssueId,
            coalescedIntoRunId: routineRuns.coalescedIntoRunId,
            failureReason: routineRuns.failureReason,
            completedAt: routineRuns.completedAt,
            createdAt: routineRuns.createdAt,
            updatedAt: routineRuns.updatedAt,
            triggerKind: routineTriggers.kind,
            triggerLabel: routineTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(routineRuns)
          .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
          .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
          .where(eq(routineRuns.routineId, row.id))
          .orderBy(desc(routineRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              companyId: run.companyId,
              routineId: run.routineId,
              triggerId: run.triggerId,
              source: run.source as RoutineRunSummary["source"],
              status: run.status as RoutineRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              dispatchFingerprint: run.dispatchFingerprint,
              routineRevisionId: run.routineRevisionId,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Routine execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
        listManagedRoutineMetadata([row.id]),
      ]);

      return {
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        project,
        assignee,
        parentIssue,
        descriptionDocument,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    getDescriptionDocument: async (routineId: string) => getRoutineDescriptionDocument(routineId),

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      await assertProject(companyId, input.projectId ?? null);
      await assertAssignableAgent(db, companyId, input.assigneeAgentId ?? null, { kind: "routine" });
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const env = input.env === undefined || input.env === null
        ? null
        : await secretsSvc.normalizeEnvBindingsForPersistence(companyId, input.env, {
            strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
            fieldPath: "env",
          });
      const variables = syncRoutineVariablesWithTemplate(
        [input.title, input.description],
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const status = normalizeDraftRoutineStatus(input.status, input.assigneeAgentId);
      const responsibleUserId = await resolveRoutineResponsibleUserId(db, companyId, actor.userId, input.parentIssueId ?? null);
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const createdRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const assigneeAgentId = input.assigneeAgentId
          ? canonicalizeAgentReferenceId(input.assigneeAgentId)
          : null;
        if (assigneeAgentId) {
          await lockAgentLifecycleReference(txDb, {
            companyId,
            agentId: assigneeAgentId,
          });
        }
        const [created] = await txDb
          .insert(routines)
          .values({
            companyId,
            projectId: input.projectId ?? null,
            goalId: input.goalId ?? null,
            parentIssueId: input.parentIssueId ?? null,
            title: input.title,
            description: input.description ?? null,
            assigneeAgentId,
            priority: input.priority,
            status,
            concurrencyPolicy: input.concurrencyPolicy,
            catchUpPolicy: input.catchUpPolicy,
            variables,
            env,
            responsibleUserId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const { routine } = await appendRoutineRevision(txDb, created, actor, {
          changeSummary: "Created routine",
        });
        if (env) {
          await secretsSvc.syncEnvBindingsForTarget(
            companyId,
            { targetType: "routine", targetId: routine.id },
            env,
            { db: tx },
          );
        }
        return routine;
      });
      return createdRoutine;
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId;
      const nextTitle = patch.title ?? existing.title;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const nextEnv = patch.env === undefined
        ? existing.env
        : patch.env === null
          ? null
          : await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, patch.env, {
              strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
              fieldPath: "env",
            });
      const requestedStatus = patch.status ?? existing.status;
      if (patch.status === "active") {
        assertRoutineCanEnable(patch.status, nextAssigneeAgentId);
      }
      const nextStatus = patch.assigneeAgentId === undefined
        ? requestedStatus
        : normalizeDraftRoutineStatus(requestedStatus, nextAssigneeAgentId);
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.assigneeAgentId !== undefined || patch.status === "active") {
        await assertAssignableAgent(db, existing.companyId, nextAssigneeAgentId, { kind: "routine" });
      }
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.companyId, patch.parentIssueId);
      assertRoutineVariableDefinitions(nextVariables);
      const enabledTriggers = await db
        .select({ kind: routineTriggers.kind })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.routineId, existing.id),
            eq(routineTriggers.enabled, true),
          ),
        )
        .then((rows) => rows);
      const hasEnabledTrigger = enabledTriggers.length > 0;
      const enabledScheduleTriggers = enabledTriggers.some((trigger) => trigger.kind === "schedule");
      if (enabledScheduleTriggers) {
        assertScheduleCompatibleVariables(nextVariables);
      }
      const responsibleUserId = await resolveRoutineResponsibleUserId(
        db,
        existing.companyId,
        actor.userId,
        patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
      );
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const updatedRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const shouldFenceAssignee = Boolean(nextAssigneeAgentId) && (
          patch.assigneeAgentId !== undefined
          || !["paused", "archived"].includes(nextStatus)
          || hasEnabledTrigger
        );
        const fencedAssigneeAgentId = nextAssigneeAgentId
          ? canonicalizeAgentReferenceId(nextAssigneeAgentId)
          : null;
        if (shouldFenceAssignee && fencedAssigneeAgentId) {
          await lockAgentLifecycleReference(txDb, {
            companyId: existing.companyId,
            agentId: fencedAssigneeAgentId,
          });
        }
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .then((rows) => rows[0] ?? null);
        if (!locked) return null;

        if (patch.baseRevisionId && patch.baseRevisionId !== locked.latestRevisionId) {
          throw conflict("Routine was updated by someone else", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const candidate: RoutineRow = {
          ...locked,
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? locked.parentIssueId : patch.parentIssueId,
          title: nextTitle,
          description: nextDescription,
          assigneeAgentId: fencedAssigneeAgentId,
          priority: patch.priority ?? locked.priority,
          status: nextStatus,
          concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
          variables: nextVariables,
          env: nextEnv,
          responsibleUserId: locked.responsibleUserId ?? responsibleUserId,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        };

        if (locked.latestRevisionId && routineCurrentFieldsMatch(locked, candidate)) {
          return locked;
        }

        const nextSnapshot = await buildRoutineRevisionSnapshot(txDb, candidate);
        if (locked.latestRevisionId) {
          const latestRevision = await txDb
            .select({ snapshot: routineRevisions.snapshot })
            .from(routineRevisions)
            .where(
              and(
                eq(routineRevisions.companyId, locked.companyId),
                eq(routineRevisions.routineId, locked.id),
                eq(routineRevisions.id, locked.latestRevisionId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (latestRevision && snapshotsMatch(nextSnapshot, latestRevision.snapshot as RoutineRevisionSnapshotV1)) {
            if (patch.env !== undefined) {
              await secretsSvc.syncEnvBindingsForTarget(
                locked.companyId,
                { targetType: "routine", targetId: locked.id },
                candidate.env,
                { db: tx },
              );
            }
            return locked;
          }
        }

        const [updated] = await txDb
          .update(routines)
          .set({
            projectId: candidate.projectId,
            goalId: candidate.goalId,
            parentIssueId: candidate.parentIssueId,
            title: candidate.title,
            description: candidate.description,
            assigneeAgentId: candidate.assigneeAgentId,
            priority: candidate.priority,
            status: candidate.status,
            concurrencyPolicy: candidate.concurrencyPolicy,
            catchUpPolicy: candidate.catchUpPolicy,
            variables: candidate.variables,
            env: candidate.env,
            responsibleUserId: candidate.responsibleUserId,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, id))
          .returning();
        if (!updated) return null;
        const { routine } = await appendRoutineRevision(txDb, updated, actor, {
          changeSummary: "Updated routine",
        });
        if (patch.env !== undefined) {
          await secretsSvc.syncEnvBindingsForTarget(
            routine.companyId,
            { targetType: "routine", targetId: routine.id },
            routine.env,
            { db: tx },
          );
        }
        return routine;
      });
      return updatedRoutine;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null; revision: RoutineRevision }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");
      const nextEnabled = input.enabled ?? true;
      const expectedEnabledAssigneeAgentId = nextEnabled && routine.assigneeAgentId
        ? canonicalizeAgentReferenceId(routine.assigneeAgentId)
        : null;
      if (nextEnabled) {
        await assertAssignableAgent(db, routine.companyId, routine.assigneeAgentId, { kind: "routine" });
      }

      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        assertScheduleCompatibleVariables(routine.variables ?? []);
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        if (expectedEnabledAssigneeAgentId) {
          await lockAgentLifecycleReference(txDb, {
            companyId: routine.companyId,
            agentId: expectedEnabledAssigneeAgentId,
          });
        }
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routine.id} for update`);
        const lockedRoutine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, routine.id))
          .then((rows) => rows[0] ?? null);
        if (!lockedRoutine) throw notFound("Routine not found");
        if (nextEnabled) {
          if (lockedRoutine.assigneeAgentId !== expectedEnabledAssigneeAgentId) {
            throw conflict("Routine assignee changed while enabling trigger", {
              expectedAssigneeAgentId: expectedEnabledAssigneeAgentId,
              currentAssigneeAgentId: lockedRoutine.assigneeAgentId,
            });
          }
          await assertAssignableAgent(txDb, lockedRoutine.companyId, lockedRoutine.assigneeAgentId, { kind: "routine" });
        }
        const [createdTrigger] = await txDb
          .insert(routineTriggers)
          .values({
            companyId: routine.companyId,
            routineId: routine.id,
            kind: input.kind,
            label: input.label ?? null,
            enabled: input.enabled ?? true,
            cronExpression: input.kind === "schedule" ? input.cronExpression : null,
            timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
            nextRunAt,
            publicId,
            secretId,
            signingMode: input.kind === "webhook" ? input.signingMode : null,
            replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
            lastRotatedAt: input.kind === "webhook" ? new Date() : null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const latestRoutine = await txDb.select().from(routines).where(eq(routines.id, routine.id)).then((rows) => rows[0] ?? routine);
        const appended = await appendRoutineRevision(txDb, latestRoutine, actor, {
          changeSummary: `Created ${input.kind} trigger`,
        });
        return { trigger: createdTrigger, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial,
        revision,
      };
    },

    updateTrigger: async (
      id: string,
      patch: UpdateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; revision: RoutineRevision } | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;
      const nextEnabled = patch.enabled ?? existing.enabled;
      let expectedEnabledRoutine: (typeof routines.$inferSelect) | null = null;
      if (nextEnabled) {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        expectedEnabledRoutine = routine;
        await assertAssignableAgent(db, routine.companyId, routine.assigneeAgentId, { kind: "routine" });
      }

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
      }

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const expectedEnabledAssigneeAgentId = expectedEnabledRoutine?.assigneeAgentId
          ? canonicalizeAgentReferenceId(expectedEnabledRoutine.assigneeAgentId)
          : null;
        if (expectedEnabledAssigneeAgentId && expectedEnabledRoutine) {
          await lockAgentLifecycleReference(txDb, {
            companyId: expectedEnabledRoutine.companyId,
            agentId: expectedEnabledAssigneeAgentId,
          });
        }
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const lockedRoutine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!lockedRoutine) throw notFound("Routine not found");
        if (nextEnabled) {
          if (lockedRoutine.assigneeAgentId !== expectedEnabledAssigneeAgentId) {
            throw conflict("Routine assignee changed while enabling trigger", {
              expectedAssigneeAgentId: expectedEnabledAssigneeAgentId,
              currentAssigneeAgentId: lockedRoutine.assigneeAgentId,
            });
          }
          await assertAssignableAgent(txDb, lockedRoutine.companyId, lockedRoutine.assigneeAgentId, { kind: "routine" });
        }
        if (
          patch.baseRevisionId !== undefined
          && patch.baseRevisionId !== null
          && patch.baseRevisionId !== lockedRoutine.latestRevisionId
        ) {
          throw conflict("Routine trigger revision changed", {
            expectedRevisionId: patch.baseRevisionId,
            currentRevisionId: lockedRoutine.latestRevisionId,
          });
        }
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            label: patch.label === undefined ? existing.label : patch.label,
            enabled: patch.enabled ?? existing.enabled,
            cronExpression,
            timezone,
            nextRunAt,
            signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
            replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        if (!updated) return null;
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Updated ${existing.kind} trigger`,
        });
        return { trigger: updated as RoutineTrigger, revision: appended.revision };
      });
      return result;
    },

    deleteTrigger: async (id: string, actor: Actor = {}): Promise<{ deleted: boolean; revision: RoutineRevision | null }> => {
      const existing = await getTriggerById(id);
      if (!existing) return { deleted: false, revision: null };
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        await txDb.delete(routineTriggers).where(eq(routineTriggers.id, id));
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Deleted ${existing.kind} trigger`,
        });
        return { deleted: true, revision: appended.revision };
      });
      if (result.deleted && existing.secretId) {
        try {
          await secretsSvc.remove(existing.secretId);
        } catch (err) {
          logger.warn(
            { err, routineId: existing.routineId, triggerId: existing.id, secretId: existing.secretId },
            "failed to remove routine trigger webhook secret after trigger deletion",
          );
        }
      }
      return result;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial; revision: RoutineRevision }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            lastRotatedAt: new Date(),
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: "Rotated webhook trigger secret",
        });
        return { trigger: updated, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
        revision,
      };
    },

    listRevisions: async (routineId: string): Promise<RoutineRevision[]> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");
      const rows = await db
        .select()
        .from(routineRevisions)
        .where(and(eq(routineRevisions.companyId, routine.companyId), eq(routineRevisions.routineId, routine.id)))
        .orderBy(desc(routineRevisions.revisionNumber), desc(routineRevisions.createdAt))
        .limit(MAX_ROUTINE_REVISIONS);
      return rows.map(mapRoutineRevision);
    },

    restoreRevision: async (
      routineId: string,
      revisionId: string,
      actor: Actor,
    ): Promise<{
      routine: Routine;
      revision: RoutineRevision;
      restoredFromRevisionId: string;
      restoredFromRevisionNumber: number;
      secretMaterials: RoutineTriggerSecretRestoreMaterial[];
    }> => {
      const existingRoutine = await getRoutineById(routineId);
      if (!existingRoutine) throw notFound("Routine not found");
      const targetRevision = await db
        .select()
        .from(routineRevisions)
        .where(
          and(
            eq(routineRevisions.companyId, existingRoutine.companyId),
            eq(routineRevisions.routineId, existingRoutine.id),
            eq(routineRevisions.id, revisionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!targetRevision) throw notFound("Routine revision not found");

      const snapshot = targetRevision.snapshot as RoutineRevisionSnapshotV1;
      const routineSnapshot = snapshot.routine;
      await assertRestorableAssignee(existingRoutine.companyId, routineSnapshot.assigneeAgentId, actor);

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const restoredAssigneeAgentId = routineSnapshot.assigneeAgentId
          ? canonicalizeAgentReferenceId(routineSnapshot.assigneeAgentId)
          : null;
        if (restoredAssigneeAgentId) {
          await lockAgentLifecycleReference(txDb, {
            companyId: existingRoutine.companyId,
            agentId: restoredAssigneeAgentId,
          });
        }
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existingRoutine.id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existingRoutine.id))
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Routine not found");
        if (locked.latestRevisionId === targetRevision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const currentTriggers = await txDb
          .select({ id: routineTriggers.id })
          .from(routineTriggers)
          .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        const currentTriggerIds = new Set(currentTriggers.map((trigger) => trigger.id));
        const missingWebhookTriggers = snapshot.triggers
          .filter((trigger) => trigger.kind === "webhook" && !currentTriggerIds.has(trigger.id));
        const recreatedWebhookSecrets = new Map<string, { publicId: string; secretId: string; secretMaterial: RoutineTriggerSecretRestoreMaterial }>();
        for (const trigger of missingWebhookTriggers) {
          const publicId = crypto.randomBytes(12).toString("hex");
          const created = await createWebhookSecret(locked.companyId, locked.id, actor, txDb);
          recreatedWebhookSecrets.set(trigger.id, {
            publicId,
            secretId: created.secret.id,
            secretMaterial: {
              triggerId: trigger.id,
              webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
              webhookSecret: created.secretValue,
            },
          });
        }

        const now = new Date();
        const [restoredRoutine] = await txDb
          .update(routines)
          .set({
            projectId: routineSnapshot.projectId,
            goalId: routineSnapshot.goalId,
            parentIssueId: routineSnapshot.parentIssueId,
            title: routineSnapshot.title,
            description: routineSnapshot.description,
            assigneeAgentId: restoredAssigneeAgentId,
            priority: routineSnapshot.priority,
            status: routineSnapshot.status,
            concurrencyPolicy: routineSnapshot.concurrencyPolicy,
            catchUpPolicy: routineSnapshot.catchUpPolicy,
            variables: routineSnapshot.variables,
            env: routineSnapshot.env,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          })
          .where(eq(routines.id, locked.id))
          .returning();

        const snapshotTriggerIds = new Set(snapshot.triggers.map((trigger) => trigger.id));
        if (snapshotTriggerIds.size === 0) {
          await txDb
            .delete(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        } else {
          await txDb
            .delete(routineTriggers)
            .where(
              and(
                eq(routineTriggers.companyId, locked.companyId),
                eq(routineTriggers.routineId, locked.id),
                not(inArray(routineTriggers.id, snapshot.triggers.map((trigger) => trigger.id))),
              ),
            );
        }

        for (const triggerSnapshot of snapshot.triggers) {
          const current = await txDb
            .select()
            .from(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.id, triggerSnapshot.id)))
            .then((rows) => rows[0] ?? null);
          const webhookSecret = recreatedWebhookSecrets.get(triggerSnapshot.id);
          const restoredNextRunAt = triggerSnapshot.kind === "schedule" && triggerSnapshot.enabled
            && triggerSnapshot.cronExpression && triggerSnapshot.timezone
            ? nextCronTickInTimeZone(triggerSnapshot.cronExpression, triggerSnapshot.timezone, now)
            : null;
          const baseValues = {
            companyId: locked.companyId,
            routineId: locked.id,
            kind: triggerSnapshot.kind,
            label: triggerSnapshot.label,
            enabled: triggerSnapshot.enabled,
            cronExpression: triggerSnapshot.kind === "schedule" ? triggerSnapshot.cronExpression : null,
            timezone: triggerSnapshot.kind === "schedule" ? triggerSnapshot.timezone : null,
            publicId: triggerSnapshot.kind === "webhook" ? (current?.publicId ?? webhookSecret?.publicId ?? triggerSnapshot.publicId) : null,
            secretId: triggerSnapshot.kind === "webhook" ? (current?.secretId ?? webhookSecret?.secretId ?? null) : null,
            signingMode: triggerSnapshot.kind === "webhook" ? triggerSnapshot.signingMode : null,
            replayWindowSec: triggerSnapshot.kind === "webhook" ? triggerSnapshot.replayWindowSec : null,
            nextRunAt: restoredNextRunAt,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          };
          if (current) {
            await txDb.update(routineTriggers).set(baseValues).where(eq(routineTriggers.id, triggerSnapshot.id));
          } else {
            await txDb.insert(routineTriggers).values({
              id: triggerSnapshot.id,
              ...baseValues,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
              createdAt: now,
            });
          }
        }

        const appended = await appendRoutineRevision(txDb, restoredRoutine ?? locked, actor, {
          changeSummary: `Restored from revision ${targetRevision.revisionNumber}`,
          restoredFromRevisionId: targetRevision.id,
        });
        await secretsSvc.syncEnvBindingsForTarget(
          locked.companyId,
          { targetType: "routine", targetId: locked.id },
          routineSnapshot.env,
          { db: tx },
        );
        return {
          routine: appended.routine,
          revision: appended.revision,
          restoredFromRevisionId: targetRevision.id,
          restoredFromRevisionNumber: targetRevision.revisionNumber,
          secretMaterials: [...recreatedWebhookSecrets.values()].map((entry) => entry.secretMaterial),
        };
      });
      return result;
    },

    runRoutine: async (id: string, input: RunRoutine, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        actor,
      });
    },

    runPipelineStageEntryRoutine: async (id: string, input: RunRoutine & { descriptionAppendix?: string | null }, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      return dispatchRoutineRun({
        routine,
        trigger: null,
        source: "api",
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        descriptionAppendix: input.descriptionAppendix ?? null,
        actor,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      hubSignatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        // Accept X-Hub-Signature-256 (GitHub/Sentry) or fall back to the
        // generic X-Paperclip-Signature header so operators can use github_hmac
        // mode with either header convention.
        const providedSignature = (input.hubSignatureHeader ?? input.signatureHeader)?.trim() ?? "";
        if (!providedSignature) throw unauthorized();
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const normalizedBuf = Buffer.from(normalizedSignature);
        const expectedBuf = Buffer.from(expectedHmac);
        const valid =
          normalizedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(normalizedBuf, expectedBuf);
        if (!valid) throw unauthorized();
      } else if (trigger.signingMode === "bearer") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        variables: isPlainRecord(input.payload) && isPlainRecord(input.payload.variables)
          ? input.payload.variables
          : null,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          dispatchFingerprint: routineRuns.dispatchFingerprint,
          routineRevisionId: routineRuns.routineRevisionId,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
          triggerKind: routineTriggers.kind,
          triggerLabel: routineTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(routineRuns)
        .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
        .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
          projectPausedAt: projects.pausedAt,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .leftJoin(projects, eq(routines.projectId, projects.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        // Suppress scheduled firings while the routine's project is paused. The tick is still
        // claimed and advanced to the next single cron tick (no backfill), so resume continues
        // at the next cron boundary instead of replaying missed firings. Routines with no
        // project are never suppressed here.
        const projectPaused = !!(row.routine.projectId && row.projectPausedAt);

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (!projectPaused && row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              eq(routineTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        if (projectPaused) {
          await recordSuppressedScheduleRun({
            routine: row.routine,
            trigger: row.trigger,
            reason: "paused",
            nextRunAt: claimedNextRunAt,
          });
          continue;
        }

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}

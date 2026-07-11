import { and, asc, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import type {
  StaleWakeupMaintenanceClassificationItem,
  StaleWakeupMaintenancePreview,
  StaleWakeupMaintenancePreviewRequest,
  StaleWakeupMaintenanceRunRequest,
  StaleWakeupMaintenanceRun,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import {
  logActivities,
  publishLoggedActivities,
  type LogActivityInput,
} from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

const ELIGIBLE_WAKEUP_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const AUDIT_REQUEST_ID_LIMIT = 100;

type WakeupRow = Pick<
  typeof agentWakeupRequests.$inferSelect,
  "id" | "companyId" | "status" | "runId" | "requestedAt" | "payload"
> & { requestedBeforeCutoff: boolean };

type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "status"
>;

export type StaleWakeupMaintenanceActor = Pick<
  LogActivityInput,
  "actorType" | "actorId" | "agentId" | "runId"
>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function canonicalIssueReference(value: string) {
  return isUuidLike(value) ? value.toLowerCase() : value.toUpperCase();
}

function issueReferencesFromPayload(payload: unknown): string[] {
  const root = asRecord(payload);
  const nested = asRecord(root._paperclipWakeContext);
  const references = [
    nonEmptyString(root.issueId),
    nonEmptyString(root.taskId),
    nonEmptyString(nested.issueId),
    nonEmptyString(nested.taskId),
  ].filter((value): value is string => value !== null);
  return [...new Set(references.map(canonicalIssueReference))];
}

function buildIssueLookup(rows: IssueRow[]) {
  const byId = new Map<string, IssueRow>();
  const byIdentifier = new Map<string, IssueRow>();
  for (const row of rows) {
    byId.set(row.id.toLowerCase(), row);
    if (row.identifier) {
      byIdentifier.set(row.identifier.toUpperCase(), row);
    }
  }
  return { byId, byIdentifier };
}

type IssueLookup = ReturnType<typeof buildIssueLookup>;

function issueProjection(row: WakeupRow, issueLookup: IssueLookup) {
  const references = issueReferencesFromPayload(row.payload);
  const resolved: IssueRow[] = [];
  const seenIssueIds = new Set<string>();
  for (const reference of references) {
    const canonicalReference = canonicalIssueReference(reference);
    const issue = issueLookup.byId.get(canonicalReference) ?? issueLookup.byIdentifier.get(canonicalReference);
    if (!issue || seenIssueIds.has(issue.id)) continue;
    seenIssueIds.add(issue.id);
    resolved.push(issue);
  }

  const activeIssue = resolved.find((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status));
  if (activeIssue) {
    return {
      issueId: activeIssue.id,
      issueStatus: activeIssue.status,
      hasActiveIssue: true,
      hasTerminalIssue: false,
    };
  }

  const terminalIssue = resolved[0] ?? null;
  return {
    issueId: terminalIssue?.id ?? references[0] ?? null,
    issueStatus: terminalIssue?.status ?? null,
    hasActiveIssue: false,
    hasTerminalIssue: terminalIssue !== null,
  };
}

function classifyWakeup(
  requestId: string,
  row: WakeupRow | null,
  issueLookup: IssueLookup,
): StaleWakeupMaintenanceClassificationItem {
  if (!row) {
    return {
      requestId,
      eligible: false,
      classification: "request_not_found",
      wakeupStatus: null,
      runId: null,
      requestedAt: null,
      issueId: null,
      issueStatus: null,
    };
  }

  const issue = issueProjection(row, issueLookup);
  const base = {
    requestId,
    wakeupStatus: row.status,
    runId: row.runId,
    requestedAt: row.requestedAt.toISOString(),
    issueId: issue.issueId,
    issueStatus: issue.issueStatus,
  };

  if (!ELIGIBLE_WAKEUP_STATUSES.includes(row.status as (typeof ELIGIBLE_WAKEUP_STATUSES)[number])) {
    return { ...base, eligible: false, classification: "status_not_eligible" };
  }
  if (row.runId !== null) {
    return { ...base, eligible: false, classification: "run_already_linked" };
  }
  if (!row.requestedBeforeCutoff) {
    return { ...base, eligible: false, classification: "requested_after_cutoff" };
  }
  if (issue.hasActiveIssue) {
    return { ...base, eligible: false, classification: "issue_not_terminal" };
  }
  if (issue.hasTerminalIssue) {
    return { ...base, eligible: true, classification: "eligible_terminal_issue" };
  }
  return { ...base, eligible: true, classification: "eligible_no_resolvable_issue" };
}

async function loadSelectedWakeups(
  dbOrTx: Db,
  requestIds: string[],
  staleBefore: Date,
  lock: "none" | "nowait",
) {
  const query = dbOrTx
    .select({
      id: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      requestedAt: agentWakeupRequests.requestedAt,
      payload: agentWakeupRequests.payload,
      requestedBeforeCutoff:
        sql<boolean>`${lte(agentWakeupRequests.requestedAt, staleBefore)}`.as("requestedBeforeCutoff"),
    })
    .from(agentWakeupRequests)
    .where(inArray(agentWakeupRequests.id, requestIds))
    .orderBy(asc(agentWakeupRequests.id));
  return lock === "nowait" ? query.for("update", { noWait: true }) : query;
}

async function loadReferencedIssues(dbOrTx: Db, wakeups: WakeupRow[], lock: boolean) {
  const references = [...new Set(wakeups.flatMap((row) => issueReferencesFromPayload(row.payload)))];
  if (references.length === 0) return [];

  const uuidReferences = references.filter(isUuidLike);
  const issueReferencePredicate = or(
    ...(uuidReferences.length > 0 ? [inArray(issues.id, uuidReferences)] : []),
    inArray(issues.identifier, references),
  );
  const query = dbOrTx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issues)
    // Instance admins must not treat a corrupt cross-company reference as
    // unresolvable: any referenced active issue blocks cancellation.
    .where(issueReferencePredicate)
    .orderBy(asc(issues.companyId), asc(issues.id));
  return lock ? query.for("update") : query;
}

function classifySelected(
  requestIds: string[],
  wakeups: WakeupRow[],
  issueRows: IssueRow[],
) {
  const wakeupsById = new Map(wakeups.map((row) => [row.id, row]));
  const issueLookup = buildIssueLookup(issueRows);
  return requestIds.map((requestId) =>
    classifyWakeup(requestId, wakeupsById.get(requestId) ?? null, issueLookup));
}

function wakeupReferenceFingerprint(row: WakeupRow) {
  return JSON.stringify({
    companyId: row.companyId,
    references: issueReferencesFromPayload(row.payload).sort(),
  });
}

function issueReferencesChanged(initialWakeups: WakeupRow[], lockedWakeups: WakeupRow[]) {
  const initial = new Map(initialWakeups.map((row) => [row.id, wakeupReferenceFingerprint(row)]));
  const locked = new Map(lockedWakeups.map((row) => [row.id, wakeupReferenceFingerprint(row)]));
  const ids = new Set([...initial.keys(), ...locked.keys()]);
  for (const id of ids) {
    if (initial.get(id) !== locked.get(id)) return true;
  }
  return false;
}

function issueResolutionFingerprint(rows: IssueRow[]) {
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    identifier: row.identifier,
    status: row.status,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function issueResolutionChanged(initialRows: IssueRow[], refreshedRows: IssueRow[]) {
  return issueResolutionFingerprint(initialRows) !== issueResolutionFingerprint(refreshedRows);
}

function maintenanceDatabaseConflictKind(error: unknown): "serialization" | "lock" | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = asRecord(current);
    if (record.code === "40001") return "serialization";
    if (record.code === "40P01" || record.code === "55P03") return "lock";
    if (!("cause" in record) || record.cause === current) return null;
    current = record.cause;
  }
  return null;
}

export function staleWakeupMaintenanceService(db: Db) {
  return {
    async preview(input: StaleWakeupMaintenancePreviewRequest): Promise<StaleWakeupMaintenancePreview> {
      const staleBefore = new Date(input.staleBefore).toISOString();
      const cutoff = new Date(staleBefore);
      const wakeups = await loadSelectedWakeups(db, input.requestIds, cutoff, "none");
      const issueRows = await loadReferencedIssues(db, wakeups, false);
      const classifications = classifySelected(input.requestIds, wakeups, issueRows);
      const eligible = classifications.filter((item) => item.eligible).length;
      return {
        staleBefore,
        generatedAt: new Date().toISOString(),
        totals: {
          requested: input.requestIds.length,
          eligible,
          skipped: input.requestIds.length - eligible,
        },
        classifications,
      };
    },

    async run(
      input: StaleWakeupMaintenanceRunRequest,
      actor: StaleWakeupMaintenanceActor,
    ): Promise<StaleWakeupMaintenanceRun> {
      const staleBefore = new Date(input.staleBefore).toISOString();
      const cutoff = new Date(staleBefore);
      const sanitizedReason = redactSensitiveText(input.reason);
      // Load operator preferences before entering SERIALIZABLE. The issue-table
      // lock must be the transaction's first database statement so its snapshot
      // cannot predate a writer that commits immediately before lock acquisition.
      const censorUsernameInLogs = (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs;

      try {
        const committed = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;

          // This is a rare, explicit instance-admin operation. Take the table lock
          // before issue reads or wakeup row locks: SHARE blocks issue writes (and
          // therefore phantom resolutions), while remaining compatible with the
          // ROW SHARE lock used by deferred promotion's issue-first FOR UPDATE.
          // NOWAIT avoids a lock convoy behind an already-running issue writer;
          // the caller gets the same retryable 409 used for wakeup lock conflicts.
          // Some recovery paths already hold wakeup rows before writing issues, so
          // wakeup locks below use NOWAIT: maintenance releases this table guard
          // with a retryable 409 instead of forming a wakeup -> issue / issue ->
          // wakeup deadlock. Stable plain issue reads avoid another reverse edge.
          await txDb.execute(sql`lock table ${issues} in share mode nowait`);

          const initialWakeups = await loadSelectedWakeups(txDb, input.requestIds, cutoff, "none");
          const initialIssueRows = await loadReferencedIssues(txDb, initialWakeups, false);
          const lockedWakeups = await loadSelectedWakeups(txDb, input.requestIds, cutoff, "nowait");
          if (issueReferencesChanged(initialWakeups, lockedWakeups)) {
            throw conflict("Selected wakeup issue reference changed during maintenance; retry the preview and run");
          }
          const refreshedIssueRows = await loadReferencedIssues(txDb, lockedWakeups, false);
          if (issueResolutionChanged(initialIssueRows, refreshedIssueRows)) {
            throw conflict("Selected wakeup issue resolution changed during maintenance; retry the preview and run");
          }
          const classifications = classifySelected(input.requestIds, lockedWakeups, refreshedIssueRows);
          const eligibleIds = classifications.filter((item) => item.eligible).map((item) => item.requestId);
          const completedAt = new Date();

          const cancelledRows = eligibleIds.length === 0
            ? []
            : await txDb
            .update(agentWakeupRequests)
            .set({
              status: "cancelled",
              finishedAt: completedAt,
              error: sanitizedReason,
              updatedAt: completedAt,
            })
            .where(
              and(
                inArray(agentWakeupRequests.id, eligibleIds),
                inArray(agentWakeupRequests.status, [...ELIGIBLE_WAKEUP_STATUSES]),
                isNull(agentWakeupRequests.runId),
                lte(agentWakeupRequests.requestedAt, cutoff),
              ),
            )
            .returning({
              id: agentWakeupRequests.id,
              companyId: agentWakeupRequests.companyId,
            });

          if (cancelledRows.length !== eligibleIds.length) {
            throw new Error("Stale wakeup candidate changed during maintenance transaction");
          }

          const cancelledById = new Map(cancelledRows.map((row) => [row.id, row]));
          const cancelledRequestIds = input.requestIds.filter((id) => cancelledById.has(id));
          const cancelledByCompany = new Map<string, string[]>();
          for (const requestId of cancelledRequestIds) {
            const companyId = cancelledById.get(requestId)!.companyId;
            const companyRequestIds = cancelledByCompany.get(companyId) ?? [];
            companyRequestIds.push(requestId);
            cancelledByCompany.set(companyId, companyRequestIds);
          }

          const activityInputs = [...cancelledByCompany.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([companyId, requestIds]): LogActivityInput => {
            const omittedRequestIdCount = Math.max(0, requestIds.length - AUDIT_REQUEST_ID_LIMIT);
            return {
              companyId,
              ...actor,
              action: "instance.maintenance.stale_wakeups_cancelled",
              entityType: "instance_maintenance",
              entityId: "stale-wakeups",
              details: {
                reason: sanitizedReason,
                staleBefore,
                cancelledCount: requestIds.length,
                cancelledRequestIds: requestIds.slice(0, AUDIT_REQUEST_ID_LIMIT),
                cancelledRequestIdsTruncated: omittedRequestIdCount > 0,
                omittedRequestIdCount,
              },
            };
          });
          const pendingActivities = await logActivities(txDb, activityInputs, {
            censorUsernameInLogs,
            publish: false,
          });

          const skipped = classifications.filter((item) => !cancelledById.has(item.requestId));
          return {
            maintenanceRun: {
              staleBefore,
              completedAt: completedAt.toISOString(),
              totals: {
                requested: input.requestIds.length,
                cancelled: cancelledRequestIds.length,
                skipped: skipped.length,
              },
              cancelledRequestIds,
              skipped,
            },
            pendingActivities,
          };
        }, { isolationLevel: "serializable" });
        publishLoggedActivities(committed.pendingActivities);
        return committed.maintenanceRun;
      } catch (error) {
        const conflictKind = maintenanceDatabaseConflictKind(error);
        if (conflictKind === "serialization") {
          throw conflict("Stale wakeup maintenance serialization conflict; retry the preview and run");
        }
        if (conflictKind === "lock") {
          throw conflict("Stale wakeup maintenance lock conflict; retry the preview and run");
        }
        throw error;
      }
    },
  };
}

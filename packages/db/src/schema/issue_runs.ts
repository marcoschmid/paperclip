import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * issue_runs is the canonical, auditable lock contract for Paperclip issue execution.
 *
 * Jarvis-OS Phase-4 spec uses the abstract contract names lock_id / locked_by / locked_at / expires_at.
 * Per Marco-Decision 4D-4 = A (signed 2026-05-13, see
 * .openclaw/workspace/projects/jarvis-os-redesign/docs/phase-4-marco-decisions-2026-05-13.md)
 * we keep the existing lease_* columns from migration 0060 and apply the spec mapping below:
 *
 *   spec-name      column           drizzle field
 *   ---------      ------           -------------
 *   lock_id        run_id           runId
 *   locked_by      lease_owner      leaseOwner
 *   locked_at      leased_at        leasedAt
 *   expires_at     lease_expires_at leaseExpiresAt
 *
 * Service code uses the drizzle field names; spec docs reference the abstract names. Do not
 * rename the columns silently — if an external contract ever requires the exact spec names,
 * add an additive migration (0064_issue_runs_lock_contract.sql) rather than mutating in place.
 */
export const issueRuns = pgTable(
  "issue_runs",
  {
    runId: uuid("run_id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    executor: text("executor").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leasedAt: timestamp("leased_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    promptSnapshotPath: text("prompt_snapshot_path"),
    exitCode: integer("exit_code"),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeLeasePerIssueIdx: uniqueIndex("issue_runs_active_lease_per_issue_uq")
      .on(table.issueId)
      .where(sql`${table.status} = 'running'`),
    companyStatusIdx: index("issue_runs_company_status_idx").on(table.companyId, table.status),
    statusIdx: index("issue_runs_status_idx").on(table.status),
    executorIdx: index("issue_runs_executor_idx").on(table.executor),
  }),
);

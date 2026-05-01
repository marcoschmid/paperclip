import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

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

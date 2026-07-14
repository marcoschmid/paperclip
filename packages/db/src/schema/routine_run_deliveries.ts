import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { routineRuns } from "./routines.js";

/** Durable at-least-once delivery state for a freshly created routine issue. */
export const routineRunDeliveries = pgTable(
  "routine_run_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineRunId: uuid("routine_run_id").notNull().references(() => routineRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    wakeupIdempotencyKey: text("wakeup_idempotency_key").notNull(),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    deliveredWakeupRequestId: uuid("delivered_wakeup_request_id")
      .references(() => agentWakeupRequests.id, { onDelete: "restrict" }),
    deliveredHeartbeatRunId: uuid("delivered_heartbeat_run_id")
      .references(() => heartbeatRuns.id, { onDelete: "restrict" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineRunUnique: uniqueIndex("routine_run_deliveries_routine_run_unique").on(table.routineRunId),
    wakeupIdempotencyUnique: uniqueIndex("routine_run_deliveries_wakeup_idempotency_unique")
      .on(table.wakeupIdempotencyKey),
    statusAvailableIdx: index("routine_run_deliveries_status_available_idx")
      .on(table.status, table.availableAt),
    agentStatusIdx: index("routine_run_deliveries_agent_status_idx")
      .on(table.assigneeAgentId, table.status),
    companyStatusIdx: index("routine_run_deliveries_company_status_idx")
      .on(table.companyId, table.status),
    claimedExpiryIdx: index("routine_run_deliveries_claimed_expiry_idx")
      .on(table.status, table.claimExpiresAt)
      .where(sql`${table.status} = 'claimed'`),
    statusCheck: check(
      "routine_run_deliveries_status_check",
      sql`${table.status} in ('pending', 'claimed', 'delivered', 'failed')`,
    ),
    attemptCountCheck: check(
      "routine_run_deliveries_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    wakeupIdempotencyCheck: check(
      "routine_run_deliveries_wakeup_idempotency_check",
      sql`${table.wakeupIdempotencyKey} = 'routine-delivery:' || ${table.routineRunId}::text`,
    ),
    lastErrorBoundCheck: check(
      "routine_run_deliveries_last_error_bound_check",
      sql`${table.lastError} is null or char_length(${table.lastError}) <= 1024`,
    ),
    activeIdentityCheck: check(
      "routine_run_deliveries_active_identity_check",
      sql`${table.status} in ('failed') or (${table.issueId} is not null and ${table.assigneeAgentId} is not null)`,
    ),
    claimWindowCheck: check(
      "routine_run_deliveries_claim_window_check",
      sql`${table.claimedAt} is null or ${table.claimExpiresAt} > ${table.claimedAt}`,
    ),
    statusPayloadCheck: check(
      "routine_run_deliveries_status_payload_check",
      sql`(
        (${table.status} = 'pending' and ${table.claimToken} is null and ${table.claimedAt} is null and
          ${table.claimExpiresAt} is null and ${table.deliveredWakeupRequestId} is null and
          ${table.deliveredHeartbeatRunId} is null and ${table.deliveredAt} is null and ${table.failedAt} is null)
        or (${table.status} = 'claimed' and ${table.claimToken} is not null and ${table.claimedAt} is not null and
          ${table.claimExpiresAt} is not null and ${table.deliveredWakeupRequestId} is null and
          ${table.deliveredHeartbeatRunId} is null and ${table.deliveredAt} is null and ${table.failedAt} is null)
        or (${table.status} = 'delivered' and ${table.claimToken} is null and ${table.claimedAt} is null and
          ${table.claimExpiresAt} is null and ${table.deliveredWakeupRequestId} is not null and
          ${table.deliveredHeartbeatRunId} is not null and ${table.deliveredAt} is not null and
          ${table.failedAt} is null)
        or (${table.status} = 'failed' and ${table.claimToken} is null and ${table.claimedAt} is null and
          ${table.claimExpiresAt} is null and ${table.deliveredWakeupRequestId} is null and
          ${table.deliveredHeartbeatRunId} is null and ${table.deliveredAt} is null and
          ${table.failedAt} is not null)
      )`,
    ),
  }),
);

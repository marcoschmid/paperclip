import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Server-authoritative, globally serialized execution lease for one approved
 * external pipe operation. Issuance is replay-safe only while pending;
 * provider dispatch requires a one-shot pending -> executing transition.
 */
export const approvalExecutionClaims = pgTable(
  "approval_execution_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id),
    executorRunId: uuid("executor_run_id").notNull().references(() => heartbeatRuns.id),
    executionRunId: text("execution_run_id").notNull(),
    approvalPayloadSha256: text("approval_payload_sha256").notNull(),
    callFingerprintSha256: text("call_fingerprint_sha256").notNull(),
    receiptSha256: text("receipt_sha256").notNull(),
    status: text("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executionStartedAt: timestamp("execution_started_at", { withTimezone: true }),
    executionExpiresAt: timestamp("execution_expires_at", { withTimezone: true }),
    executionReceiptSha256: text("execution_receipt_sha256"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    finalizationReceiptSha256: text("finalization_receipt_sha256"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalUnique: uniqueIndex("approval_execution_claims_approval_unique").on(table.approvalId),
    executionRunUnique: uniqueIndex("approval_execution_claims_execution_run_unique").on(
      table.executionRunId,
    ),
    receiptUnique: uniqueIndex("approval_execution_claims_receipt_unique").on(table.receiptSha256),
    executionReceiptUnique: uniqueIndex("approval_execution_claims_execution_receipt_unique")
      .on(table.executionReceiptSha256),
    finalizationReceiptUnique: uniqueIndex("approval_execution_claims_finalization_receipt_unique")
      .on(table.finalizationReceiptSha256),
    companyClaimedIdx: index("approval_execution_claims_company_claimed_idx").on(
      table.companyId,
      table.claimedAt,
    ),
    agentClaimedIdx: index("approval_execution_claims_agent_claimed_idx").on(
      table.agentId,
      table.claimedAt,
    ),
    companyStatusExpiryIdx: index("approval_execution_claims_company_status_expiry_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    executorStatusIdx: index("approval_execution_claims_executor_status_idx").on(
      table.executorRunId,
      table.status,
    ),
    executionRunIdCheck: check(
      "approval_execution_claims_execution_run_id_check",
      sql`length(btrim(${table.executionRunId})) between 1 and 200`,
    ),
    approvalPayloadShaCheck: check(
      "approval_execution_claims_payload_sha_check",
      sql`${table.approvalPayloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    callFingerprintShaCheck: check(
      "approval_execution_claims_call_fingerprint_sha_check",
      sql`${table.callFingerprintSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    receiptShaCheck: check(
      "approval_execution_claims_receipt_sha_check",
      sql`${table.receiptSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    executionReceiptShaCheck: check(
      "approval_execution_claims_execution_receipt_sha_check",
      sql`${table.executionReceiptSha256} is null or ${table.executionReceiptSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    finalizationReceiptShaCheck: check(
      "approval_execution_claims_finalization_receipt_sha_check",
      sql`${table.finalizationReceiptSha256} is null or ${table.finalizationReceiptSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    statusCheck: check(
      "approval_execution_claims_status_check",
      sql`${table.status} in ('pending', 'executing', 'completed', 'failed', 'revoked')`,
    ),
    expiryCheck: check(
      "approval_execution_claims_expiry_check",
      sql`${table.expiresAt} > ${table.claimedAt}`,
    ),
    lifecycleCheck: check(
      "approval_execution_claims_lifecycle_check",
      sql`(
        (${table.status} = 'pending'
          and ${table.executionStartedAt} is null
          and ${table.executionExpiresAt} is null
          and ${table.executionReceiptSha256} is null
          and ${table.finishedAt} is null
          and ${table.failureCode} is null
          and ${table.finalizationReceiptSha256} is null
          and ${table.revokedAt} is null
          and ${table.revocationReason} is null)
        or
        (${table.status} = 'executing'
          and ${table.executionStartedAt} is not null
          and ${table.executionExpiresAt} > ${table.executionStartedAt}
          and ${table.executionReceiptSha256} is not null
          and ${table.finishedAt} is null
          and ${table.failureCode} is null
          and ${table.finalizationReceiptSha256} is null
          and ${table.revokedAt} is null
          and ${table.revocationReason} is null)
        or
        (${table.status} = 'completed'
          and ${table.executionStartedAt} is not null
          and ${table.executionExpiresAt} > ${table.executionStartedAt}
          and ${table.executionReceiptSha256} is not null
          and ${table.finishedAt} is not null
          and ${table.failureCode} is null
          and ${table.finalizationReceiptSha256} is not null
          and ${table.revokedAt} is null
          and ${table.revocationReason} is null)
        or
        (${table.status} = 'failed'
          and ${table.executionStartedAt} is not null
          and ${table.executionExpiresAt} > ${table.executionStartedAt}
          and ${table.executionReceiptSha256} is not null
          and ${table.finishedAt} is not null
          and ${table.failureCode} is not null
          and ${table.finalizationReceiptSha256} is not null
          and ${table.revokedAt} is null
          and ${table.revocationReason} is null)
        or
        (${table.status} = 'revoked'
          and ${table.executionStartedAt} is null
          and ${table.executionExpiresAt} is null
          and ${table.executionReceiptSha256} is null
          and ${table.finishedAt} is null
          and ${table.failureCode} is null
          and ${table.finalizationReceiptSha256} is null
          and ${table.revokedAt} is not null
          and ${table.revocationReason} is not null)
      )`,
    ),
  }),
);

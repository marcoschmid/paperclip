import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Server-issued authorization for one reviewed 26-source retirement plan.
 * The common artifact receipt is captured once and then reused by exact
 * content binding; execution remains separately claimed per source.
 */
export const agentRetirementPlanClaims = pgTable(
  "agent_retirement_plan_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientPlanReceiptId: text("client_plan_receipt_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    approvalCommentId: uuid("approval_comment_id").notNull(),
    approvalNonce: text("approval_nonce").notNull(),
    approvalFingerprint: text("approval_fingerprint").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    commonArtifactReceipt: jsonb("common_artifact_receipt").$type<Record<string, unknown>>().notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    evidenceExpiresAt: timestamp("evidence_expires_at", { withTimezone: true }).notNull(),
    executionExpiresAt: timestamp("execution_expires_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientReceiptUnique: uniqueIndex("agent_retirement_plan_claims_client_receipt_unique")
      .on(table.clientPlanReceiptId),
    receiptUnique: uniqueIndex("agent_retirement_plan_claims_receipt_unique").on(table.receiptId),
    approvalCommentUnique: uniqueIndex("agent_retirement_plan_claims_approval_comment_unique")
      .on(table.approvalCommentId),
    approvalNonceUnique: uniqueIndex("agent_retirement_plan_claims_approval_nonce_unique")
      .on(table.approvalNonce),
    approvalFingerprintUnique: uniqueIndex("agent_retirement_plan_claims_approval_fingerprint_unique")
      .on(table.approvalFingerprint),
    executionExpiryIdx: index("agent_retirement_plan_claims_execution_expiry_idx")
      .on(table.executionExpiresAt),
    clientReceiptCheck: check(
      "agent_retirement_plan_claims_client_receipt_check",
      sql`${table.clientPlanReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    receiptCheck: check(
      "agent_retirement_plan_claims_receipt_check",
      sql`${table.receiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    approvalNonceCheck: check(
      "agent_retirement_plan_claims_approval_nonce_check",
      sql`${table.approvalNonce} ~ '^[a-f0-9]{64}$'`,
    ),
    approvalFingerprintCheck: check(
      "agent_retirement_plan_claims_approval_fingerprint_check",
      sql`${table.approvalFingerprint} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    expiryCheck: check(
      "agent_retirement_plan_claims_expiry_check",
      sql`${table.evidenceExpiresAt} >= ${table.issuedAt} and ${table.executionExpiresAt} > ${table.evidenceExpiresAt}`,
    ),
  }),
);

/** Durable per-source execution right created while the evidence is fresh. */
export const agentRetirementExecutionClaims = pgTable(
  "agent_retirement_execution_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planClaimId: uuid("plan_claim_id").notNull().references(() => agentRetirementPlanClaims.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id),
    receiptId: text("receipt_id").notNull(),
    evidenceFingerprint: text("evidence_fingerprint").notNull(),
    sourceArtifactReceipt: jsonb("source_artifact_receipt").$type<Record<string, unknown>>().notNull(),
    initialPreflightFingerprint: text("initial_preflight_fingerprint").notNull(),
    phase: text("phase").notNull().default("started"),
    cleanupReceiptId: text("cleanup_receipt_id"),
    finalPreflightFingerprint: text("final_preflight_fingerprint"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceUnique: uniqueIndex("agent_retirement_execution_claims_source_unique").on(table.sourceAgentId),
    receiptUnique: uniqueIndex("agent_retirement_execution_claims_receipt_unique").on(table.receiptId),
    planPhaseIdx: index("agent_retirement_execution_claims_plan_phase_idx")
      .on(table.planClaimId, table.phase),
    expiryIdx: index("agent_retirement_execution_claims_expiry_idx").on(table.expiresAt),
    receiptCheck: check(
      "agent_retirement_execution_claims_receipt_check",
      sql`${table.receiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    evidenceFingerprintCheck: check(
      "agent_retirement_execution_claims_evidence_fingerprint_check",
      sql`${table.evidenceFingerprint} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    initialPreflightCheck: check(
      "agent_retirement_execution_claims_initial_preflight_check",
      sql`${table.initialPreflightFingerprint} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    cleanupReceiptCheck: check(
      "agent_retirement_execution_claims_cleanup_receipt_check",
      sql`${table.cleanupReceiptId} is null or ${table.cleanupReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    finalPreflightCheck: check(
      "agent_retirement_execution_claims_final_preflight_check",
      sql`${table.finalPreflightFingerprint} is null or ${table.finalPreflightFingerprint} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    phaseCheck: check(
      "agent_retirement_execution_claims_phase_check",
      sql`${table.phase} in ('started', 'cleaned', 'termination_ready', 'terminated')`,
    ),
    phasePayloadCheck: check(
      "agent_retirement_execution_claims_phase_payload_check",
      sql`(
        (${table.phase} = 'started' and ${table.cleanupReceiptId} is null and ${table.finalPreflightFingerprint} is null)
        or (${table.phase} = 'cleaned' and ${table.cleanupReceiptId} is not null and ${table.finalPreflightFingerprint} is null)
        or (${table.phase} in ('termination_ready', 'terminated') and ${table.cleanupReceiptId} is not null and ${table.finalPreflightFingerprint} is not null)
      )`,
    ),
    expiryCheck: check(
      "agent_retirement_execution_claims_expiry_check",
      sql`${table.expiresAt} > ${table.startedAt}`,
    ),
  }),
);

/** Private, server-only durable evidence for the atomically reviewed 26-source plan. */
export const agentRetirementPlanEvidenceBundles = pgTable(
  "agent_retirement_plan_evidence_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planClaimId: uuid("plan_claim_id").notNull().references(() => agentRetirementPlanClaims.id),
    registrationReceiptId: text("registration_receipt_id").notNull(),
    evidenceBySourceId: jsonb("evidence_by_source_id").$type<Record<string, unknown>>().notNull(),
    sourceArtifactReceiptsBySourceId: jsonb("source_artifact_receipts_by_source_id")
      .$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    planClaimUnique: uniqueIndex("agent_retirement_plan_evidence_bundles_plan_unique")
      .on(table.planClaimId),
    registrationReceiptUnique: uniqueIndex("agent_retirement_plan_evidence_bundles_receipt_unique")
      .on(table.registrationReceiptId),
    registrationReceiptCheck: check(
      "agent_retirement_plan_evidence_bundles_receipt_check",
      sql`${table.registrationReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
  }),
);

/** Append-only private recovery evidence for a superseded bounded execution lease. */
export const agentRetirementExecutionRecoveries = pgTable(
  "agent_retirement_execution_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    executionClaimId: uuid("execution_claim_id").notNull()
      .references(() => agentRetirementExecutionClaims.id),
    planClaimId: uuid("plan_claim_id").notNull().references(() => agentRetirementPlanClaims.id),
    sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id),
    requestReceiptId: text("request_receipt_id").notNull(),
    recoveryReceiptId: text("recovery_receipt_id").notNull(),
    previousExecutionClaimReceiptId: text("previous_execution_claim_receipt_id"),
    newExecutionClaimReceiptId: text("new_execution_claim_receipt_id").notNull(),
    previousPhase: text("previous_phase").notNull(),
    previousCleanupReceiptId: text("previous_cleanup_receipt_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    sourceArtifactReceipt: jsonb("source_artifact_receipt").$type<Record<string, unknown>>().notNull(),
    commonArtifactReceipt: jsonb("common_artifact_receipt").$type<Record<string, unknown>>().notNull(),
    initialPreflightFingerprint: text("initial_preflight_fingerprint").notNull(),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    recoveryReceiptUnique: uniqueIndex("agent_retirement_execution_recoveries_receipt_unique")
      .on(table.recoveryReceiptId),
    requestReceiptUnique: uniqueIndex("agent_retirement_execution_recoveries_request_unique")
      .on(table.requestReceiptId),
    newExecutionReceiptUnique: uniqueIndex("agent_retirement_execution_recoveries_new_execution_unique")
      .on(table.newExecutionClaimReceiptId),
    sourceRecoveredAtIdx: index("agent_retirement_execution_recoveries_source_time_idx")
      .on(table.sourceAgentId, table.recoveredAt),
    recoveryReceiptCheck: check(
      "agent_retirement_execution_recoveries_receipt_check",
      sql`${table.recoveryReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    requestReceiptCheck: check(
      "agent_retirement_execution_recoveries_request_check",
      sql`${table.requestReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    previousExecutionReceiptCheck: check(
      "agent_retirement_execution_recoveries_previous_execution_check",
      sql`${table.previousExecutionClaimReceiptId} is null or ${table.previousExecutionClaimReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    newExecutionReceiptCheck: check(
      "agent_retirement_execution_recoveries_new_execution_check",
      sql`${table.newExecutionClaimReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    previousCleanupReceiptCheck: check(
      "agent_retirement_execution_recoveries_previous_cleanup_check",
      sql`${table.previousCleanupReceiptId} is null or ${table.previousCleanupReceiptId} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    initialPreflightCheck: check(
      "agent_retirement_execution_recoveries_initial_preflight_check",
      sql`${table.initialPreflightFingerprint} ~ '^v1:sha256:[a-f0-9]{64}$'`,
    ),
    phaseCheck: check(
      "agent_retirement_execution_recoveries_previous_phase_check",
      sql`${table.previousPhase} in ('unstarted', 'started', 'cleaned', 'termination_ready')`,
    ),
    expiryCheck: check(
      "agent_retirement_execution_recoveries_expiry_check",
      sql`${table.expiresAt} > ${table.recoveredAt}`,
    ),
  }),
);

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Durable execution fence installed by the audited portfolio-maintenance
 * quiesce flow. Keeping this state outside agent metadata prevents ordinary
 * agent PATCH/import/rollback paths from accidentally removing the fence.
 */
export const agentPortfolioMaintenanceGates = pgTable(
  "agent_portfolio_maintenance_gates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    operationId: text("operation_id").notNull(),
    expectedSnapshotFingerprint: text("expected_snapshot_fingerprint").notNull(),
    recoveryFingerprint: text("recovery_fingerprint").notNull(),
    receiptId: text("receipt_id").notNull(),
    stage: text("stage").notNull().default("fenced"),
    issuedByUserId: text("issued_by_user_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUnique: uniqueIndex("agent_portfolio_maintenance_gates_agent_unique").on(table.agentId),
    companyOperationIdx: index("agent_portfolio_maintenance_gates_company_operation_idx").on(
      table.companyId,
      table.operationId,
    ),
    companyReceiptIdx: index("agent_portfolio_maintenance_gates_company_receipt_idx").on(
      table.companyId,
      table.receiptId,
    ),
    stageCheck: check(
      "agent_portfolio_maintenance_gates_stage_check",
      sql`${table.stage} in ('fenced', 'quiesced')`,
    ),
  }),
);

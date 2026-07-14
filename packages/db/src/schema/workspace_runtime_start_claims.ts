import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";

/**
 * Durable cross-process reservation for one company-bound local workspace
 * service identity. A caller must own the current claim id before spawning and
 * must CAS that same claim to `running` when the runtime row is persisted.
 */
export const workspaceRuntimeStartClaims = pgTable(
  "workspace_runtime_start_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    serviceKey: text("service_key").notNull(),
    claimId: uuid("claim_id").notNull(),
    status: text("status").notNull().default("starting"),
    runtimeServiceId: uuid("runtime_service_id")
      .references(() => workspaceRuntimeServices.id, { onDelete: "set null" }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    failureCode: text("failure_code"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyServiceUnique: uniqueIndex("workspace_runtime_start_claims_company_service_unique")
      .on(table.companyId, table.serviceKey),
    claimUnique: uniqueIndex("workspace_runtime_start_claims_claim_unique").on(table.claimId),
    runtimeServiceUnique: uniqueIndex("workspace_runtime_start_claims_runtime_service_unique")
      .on(table.runtimeServiceId),
    ownerStatusIdx: index("workspace_runtime_start_claims_owner_status_idx")
      .on(table.ownerAgentId, table.status),
    companyStatusExpiryIdx: index("workspace_runtime_start_claims_company_status_expiry_idx")
      .on(table.companyId, table.status, table.expiresAt),
    statusCheck: check(
      "workspace_runtime_start_claims_status_check",
      sql`${table.status} in ('starting', 'running', 'stopped', 'failed')`,
    ),
    serviceKeyCheck: check(
      "workspace_runtime_start_claims_service_key_check",
      sql`length(btrim(${table.serviceKey})) between 1 and 300`,
    ),
  }),
);

import { asc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { normalizeAgentRetirementId } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { assertHistoricalAgentTombstoneActiveReference } from "./agent-retirement-historical-tombstones.js";

export type AgentLifecycleReferenceMode = "active" | "cleanup";

export type LockedAgentLifecycleReference = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "status"
>;

export function canonicalizeAgentReferenceId(agentId: string): string {
  const canonicalId = normalizeAgentRetirementId(agentId);
  if (!canonicalId) {
    throw unprocessable("Agent reference must be a UUID", {
      code: "agent_reference_invalid",
      agentId,
    });
  }
  return canonicalId;
}

/**
 * Locks referenced agent rows in canonical order and performs the final
 * lifecycle/company check that must share a transaction with the caller's
 * write. Cleanup mode permits terminated/pending/missing agents so stale
 * references can be removed, but still rejects cross-company identities.
 */
export async function lockAgentLifecycleReferences(
  targetDb: Db,
  input: {
    companyId: string;
    agentIds: readonly string[];
    mode?: AgentLifecycleReferenceMode;
    allowPendingApproval?: boolean;
    allowMissingCleanup?: boolean;
  },
): Promise<Map<string, LockedAgentLifecycleReference>> {
  const mode = input.mode ?? "active";
  const canonicalIds = [...new Set(input.agentIds.map(canonicalizeAgentReferenceId))].sort();
  if (canonicalIds.length === 0) return new Map();

  if (mode === "active") {
    for (const agentId of canonicalIds) assertHistoricalAgentTombstoneActiveReference(agentId);
  }

  const rows = await targetDb
    .select({
      id: agents.id,
      companyId: agents.companyId,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.id, canonicalIds))
    .orderBy(asc(agents.id))
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const agentId of canonicalIds) {
    const row = byId.get(agentId);
    if (!row) {
      if (mode === "cleanup" && input.allowMissingCleanup !== false) continue;
      throw notFound("Agent not found");
    }
    if (row.companyId !== input.companyId) {
      // Keep cross-tenant identities indistinguishable from missing rows.
      // Cleanup remains a company-scoped no-op, matching the missing-row path.
      if (mode === "cleanup") {
        byId.delete(agentId);
        continue;
      }
      throw notFound("Agent not found");
    }
    if (mode === "cleanup") continue;
    if (row.status === "terminated") {
      throw conflict("Terminated agents cannot receive active references", {
        code: "agent_lifecycle_reference_forbidden",
        reason: "terminated",
        agentId,
      });
    }
    if (row.status === "pending_approval" && input.allowPendingApproval !== true) {
      throw conflict("Pending approval agents cannot receive active references", {
        code: "agent_lifecycle_reference_forbidden",
        reason: "pending_approval",
        agentId,
      });
    }
  }

  return byId;
}

export async function lockAgentLifecycleReference(
  targetDb: Db,
  input: {
    companyId: string;
    agentId: string;
    mode?: AgentLifecycleReferenceMode;
    allowPendingApproval?: boolean;
    allowMissingCleanup?: boolean;
  },
): Promise<LockedAgentLifecycleReference | null> {
  const canonicalId = canonicalizeAgentReferenceId(input.agentId);
  const rows = await lockAgentLifecycleReferences(targetDb, {
    companyId: input.companyId,
    agentIds: [canonicalId],
    mode: input.mode,
    allowPendingApproval: input.allowPendingApproval,
    allowMissingCleanup: input.allowMissingCleanup,
  });
  return rows.get(canonicalId) ?? null;
}

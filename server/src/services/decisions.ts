import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisions } from "@paperclipai/db";

export type DecisionStatus = "proposed" | "accepted" | "deprecated" | "superseded";

export interface UpsertDecisionInput {
  projectId: string;
  sourceProjectSlug: string;
  sourceKey: string;
  sourceHash: string;
  title: string;
  decision: string;
  context?: string | null;
  consequences?: string | null;
  status?: DecisionStatus;
  metadata?: Record<string, unknown>;
  supersededBy?: string | null;
  decidedAt?: Date | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

// Phase-6 project-memory decision log. Writes are idempotent on
// (company_id, source_key): re-applying the same source decision updates the
// existing row in place rather than creating duplicates.
export function decisionService(db: Db) {
  return {
    upsert: async (companyId: string, input: UpsertDecisionInput) => {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: decisions.id })
          .from(decisions)
          .where(and(eq(decisions.companyId, companyId), eq(decisions.sourceKey, input.sourceKey)))
          .limit(1);

        const [row] = await tx
          .insert(decisions)
          .values({
            companyId,
            projectId: input.projectId,
            sourceProjectSlug: input.sourceProjectSlug,
            sourceKey: input.sourceKey,
            sourceHash: input.sourceHash,
            title: input.title,
            decision: input.decision,
            context: input.context ?? null,
            consequences: input.consequences ?? null,
            ...(input.status ? { status: input.status } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
            supersededBy: input.supersededBy ?? null,
            decidedAt: input.decidedAt ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .onConflictDoUpdate({
            target: [decisions.companyId, decisions.sourceKey],
            set: {
              projectId: input.projectId,
              sourceProjectSlug: input.sourceProjectSlug,
              sourceHash: input.sourceHash,
              title: input.title,
              decision: input.decision,
              context: input.context ?? null,
              consequences: input.consequences ?? null,
              ...(input.status ? { status: input.status } : {}),
              ...(input.metadata ? { metadata: input.metadata } : {}),
              supersededBy: input.supersededBy ?? null,
              decidedAt: input.decidedAt ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();

        return { created: !existing, decision: row };
      });
    },

    getByKey: async (companyId: string, sourceKey: string) => {
      const [row] = await db
        .select()
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.sourceKey, sourceKey)))
        .limit(1);
      return row ?? null;
    },

    listByProject: async (companyId: string, projectId: string) => {
      return db
        .select()
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.projectId, projectId)))
        .orderBy(desc(decisions.updatedAt));
    },
  };
}

import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { assertAssignableAgent } from "./agent-assignability.js";
import {
  canonicalizeAgentReferenceId,
  lockAgentLifecycleReference,
} from "./agent-lifecycle-fence.js";

function isOperativeGoalStatus(status: string) {
  return status !== "achieved" && status !== "cancelled";
}

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      const resultingStatus = data.status ?? "planned";
      if (isOperativeGoalStatus(resultingStatus) && data.ownerAgentId) {
        await assertAssignableAgent(db, companyId, data.ownerAgentId, { kind: "work" });
      }
      return db.transaction(async (tx) => {
        const values = { ...data, companyId };
        if (isOperativeGoalStatus(resultingStatus) && data.ownerAgentId) {
          await lockAgentLifecycleReference(tx as unknown as Db, {
            companyId,
            agentId: data.ownerAgentId,
          });
          values.ownerAgentId = canonicalizeAgentReferenceId(data.ownerAgentId);
        }
        return tx
          .insert(goals)
          .values(values)
          .returning()
          .then((rows) => rows[0]);
      });
    },

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      const existing = await db
        .select({
          companyId: goals.companyId,
          status: goals.status,
          ownerAgentId: goals.ownerAgentId,
        })
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const resultingCompanyId = data.companyId ?? existing.companyId;
      const resultingStatus = data.status ?? existing.status;
      const resultingOwnerAgentId = data.ownerAgentId === undefined
        ? existing.ownerAgentId
        : data.ownerAgentId;
      if (isOperativeGoalStatus(resultingStatus) && resultingOwnerAgentId) {
        await assertAssignableAgent(db, resultingCompanyId, resultingOwnerAgentId, { kind: "work" });
      }

      return db.transaction(async (tx) => {
        const values = { ...data, updatedAt: new Date() };
        if (isOperativeGoalStatus(resultingStatus) && resultingOwnerAgentId) {
          await lockAgentLifecycleReference(tx as unknown as Db, {
            companyId: resultingCompanyId,
            agentId: resultingOwnerAgentId,
          });
          if (data.ownerAgentId !== undefined) {
            values.ownerAgentId = canonicalizeAgentReferenceId(resultingOwnerAgentId);
          }
        }
        return tx
          .update(goals)
          .set(values)
          .where(eq(goals.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}

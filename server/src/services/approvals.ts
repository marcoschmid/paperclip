import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { isAgentRetirementSource, normalizeAgentRetirementId } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService, terminateAgentInTransaction } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import {
  canonicalizeAgentReferenceId,
  lockAgentLifecycleReferences,
} from "./agent-lifecycle-fence.js";
import { assertHistoricalAgentTombstoneActiveReference } from "./agent-retirement-historical-tombstones.js";
import { withAgentStartLock } from "./agent-start-lock.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const terminalStatuses = new Set(["approved", "rejected", "cancelled"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function validateHireAgentPayload(
    companyId: string,
    payload: Record<string, unknown>,
    options: { validateReportsTo?: boolean } = {},
  ) {
    const rawAgentId = payload.agentId;
    const rawReportsTo = payload.reportsTo;
    if (rawAgentId !== undefined && rawAgentId !== null && typeof rawAgentId !== "string") {
      throw unprocessable("Hire approval payload.agentId must be a string", {
        code: "invalid_hire_agent_payload",
      });
    }
    if (rawReportsTo !== undefined && rawReportsTo !== null && typeof rawReportsTo !== "string") {
      throw unprocessable("Hire approval payload.reportsTo must be a string", {
        code: "invalid_hire_agent_payload",
      });
    }
    const agentId = typeof rawAgentId === "string" && rawAgentId.trim() ? rawAgentId.trim() : null;
    const reportsTo = typeof rawReportsTo === "string" && rawReportsTo.trim() ? rawReportsTo.trim() : null;

    if (agentId) {
      assertHistoricalAgentTombstoneActiveReference(agentId);
      const pendingAgent = await agentsSvc.getById(agentId);
      if (!pendingAgent || pendingAgent.companyId !== companyId) {
        throw unprocessable("Hire approval agent must belong to the same company", {
          code: "invalid_hire_agent_payload",
          agentId,
        });
      }
      if (pendingAgent.status !== "pending_approval") {
        throw conflict("Hire approval agent must still be pending approval", {
          code: "invalid_hire_agent_payload",
          agentId,
          status: pendingAgent.status,
        });
      }
    }
    if (reportsTo && options.validateReportsTo !== false) {
      await assertAssignableAgent(db, companyId, reportsTo, { kind: "work" });
    }
    return { agentId, reportsTo };
  }

  async function lockApprovalAgentReferences(
    targetDb: Db,
    input: {
      companyId: string;
      requestedByAgentId: string | null | undefined;
      type: string;
      payload: Record<string, unknown>;
    },
  ) {
    const requestedByAgentId = input.requestedByAgentId
      ? canonicalizeAgentReferenceId(input.requestedByAgentId)
      : null;
    const parsedHirePayload = input.type === "hire_agent"
      ? await validateHireAgentPayload(input.companyId, input.payload, { validateReportsTo: false })
      : { agentId: null, reportsTo: null };
    const hireAgentId = parsedHirePayload.agentId
      ? canonicalizeAgentReferenceId(parsedHirePayload.agentId)
      : null;
    const reportsToAgentId = parsedHirePayload.reportsTo
      ? canonicalizeAgentReferenceId(parsedHirePayload.reportsTo)
      : null;
    const lockedAgents = await lockAgentLifecycleReferences(targetDb, {
      companyId: input.companyId,
      agentIds: [requestedByAgentId, hireAgentId, reportsToAgentId].filter(
        (agentId): agentId is string => agentId !== null,
      ),
      // A hire candidate is expected to be pending approval. Requester and
      // reportsTo eligibility are revalidated below while these rows remain locked.
      allowPendingApproval: true,
    });

    if (requestedByAgentId) {
      await assertAssignableAgent(targetDb, input.companyId, requestedByAgentId, { kind: "work" });
    }
    if (reportsToAgentId) {
      await assertAssignableAgent(targetDb, input.companyId, reportsToAgentId, { kind: "work" });
    }
    if (hireAgentId) {
      const pendingAgent = lockedAgents.get(hireAgentId);
      if (!pendingAgent || pendingAgent.status !== "pending_approval") {
        throw conflict("Hire approval agent must still be pending approval", {
          code: "invalid_hire_agent_payload",
          agentId: hireAgentId,
          status: pendingAgent?.status ?? null,
        });
      }
    }

    const payload = input.type === "hire_agent"
      ? {
          ...input.payload,
          ...(hireAgentId ? { agentId: hireAgentId } : {}),
          ...(reportsToAgentId ? { reportsTo: reportsToAgentId } : {}),
        }
      : input.payload;
    return { requestedByAgentId, payload };
  }

  function resubmitSnapshotFingerprint(approval: ApprovalRecord) {
    return JSON.stringify({
      companyId: approval.companyId,
      type: approval.type,
      requestedByAgentId: approval.requestedByAgentId,
      status: approval.status,
      payload: approval.payload,
      decisionNote: approval.decisionNote,
      decidedByUserId: approval.decidedByUserId,
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      updatedAt: approval.updatedAt.toISOString(),
    });
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    preloaded?: ApprovalRecord,
  ): Promise<ResolutionResult> {
    const existing = preloaded ?? await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: async (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) => {
      const status = data.status ?? "pending";
      if (data.requestedByAgentId && !terminalStatuses.has(status)) {
        await assertAssignableAgent(db, companyId, data.requestedByAgentId, { kind: "work" });
      }
      if (data.type === "hire_agent" && !terminalStatuses.has(status)) {
        await validateHireAgentPayload(companyId, data.payload as Record<string, unknown>);
      }
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        let requestedByAgentId = data.requestedByAgentId ?? null;
        let payload = data.payload as Record<string, unknown>;
        if (!terminalStatuses.has(status)) {
          const lockedReferences = await lockApprovalAgentReferences(txDb, {
            companyId,
            requestedByAgentId,
            type: data.type,
            payload,
          });
          requestedByAgentId = lockedReferences.requestedByAgentId;
          payload = lockedReferences.payload;
        }
        return txDb
          .insert(approvals)
          .values({ ...data, companyId, requestedByAgentId, payload })
          .returning()
          .then((rows) => rows[0]);
      });
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (canResolveStatuses.has(existing.status) && existing.type === "hire_agent") {
        await validateHireAgentPayload(existing.companyId, existing.payload as Record<string, unknown>);
      }
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
        existing,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const observed = await getExistingApproval(id);
      const observedPayload = observed.payload as Record<string, unknown>;
      const observedAgentId = observed.type === "hire_agent" && typeof observedPayload.agentId === "string"
        ? normalizeAgentRetirementId(observedPayload.agentId) ?? observedPayload.agentId
        : null;
      const execute = () => db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const existing = await txDb
          .select()
          .from(approvals)
          .where(eq(approvals.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Approval not found");
        if (!canResolveStatuses.has(existing.status)) {
          if (existing.status === "rejected") return { approval: existing, applied: false };
          throw unprocessable("Only pending or revision requested approvals can be rejected");
        }

        const payload = existing.payload as Record<string, unknown>;
        const payloadAgentId = existing.type === "hire_agent" && typeof payload.agentId === "string"
          ? payload.agentId
          : null;
        const canonicalPayloadAgentId = payloadAgentId
          ? normalizeAgentRetirementId(payloadAgentId) ?? payloadAgentId
          : null;
        if (canonicalPayloadAgentId !== observedAgentId) {
          throw conflict("Approval target changed while rejection was prepared", {
            code: "approval_rejection_target_changed",
          });
        }
        if (payloadAgentId && isAgentRetirementSource(payloadAgentId)) {
          throw conflict("This agent requires the gated retirement workflow", {
            code: "retirement_gated_termination_required",
            sourceAgentId: payloadAgentId,
          });
        }

        const now = new Date();
        const updated = await txDb
          .update(approvals)
          .set({
            status: "rejected",
            decidedByUserId,
            decisionNote: decisionNote ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw conflict("Approval changed while rejection was prepared");

        if (payloadAgentId) {
          let validPendingAgent = false;
          try {
            assertHistoricalAgentTombstoneActiveReference(payloadAgentId);
            const pendingAgent = await agentService(txDb).getById(payloadAgentId);
            validPendingAgent = Boolean(
              pendingAgent
              && pendingAgent.companyId === updated.companyId
              && pendingAgent.status === "pending_approval",
            );
          } catch (error) {
            if (!(error && typeof error === "object" && "status" in error)) throw error;
          }
          if (validPendingAgent) {
            await terminateAgentInTransaction(txDb, payloadAgentId, {
              actorType: "user",
              actorId: decidedByUserId,
              source: "hire_approval_rejected",
              details: { approvalId: updated.id },
            });
          }
        }

        return { approval: updated, applied: true };
      }, { isolationLevel: "serializable" });
      return observedAgentId
        ? withAgentStartLock(observedAgentId, execute)
        : execute();
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const nextPayload = payload ?? existing.payload as Record<string, unknown>;
      if (existing.requestedByAgentId) {
        await assertAssignableAgent(db, existing.companyId, existing.requestedByAgentId, { kind: "work" });
      }
      if (existing.type === "hire_agent") {
        await validateHireAgentPayload(existing.companyId, nextPayload);
      }

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedReferences = await lockApprovalAgentReferences(txDb, {
          companyId: existing.companyId,
          requestedByAgentId: existing.requestedByAgentId,
          type: existing.type,
          payload: nextPayload,
        });
        const lockedApproval = await txDb
          .select()
          .from(approvals)
          .where(eq(approvals.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedApproval) throw notFound("Approval not found");
        if (resubmitSnapshotFingerprint(lockedApproval) !== resubmitSnapshotFingerprint(existing)) {
          throw conflict("Approval changed while resubmission was prepared", {
            code: "approval_resubmit_reference_drift",
          });
        }
        if (lockedApproval.status !== "revision_requested") {
          throw unprocessable("Only revision requested approvals can be resubmitted");
        }

        const now = new Date();
        const updated = await txDb
          .update(approvals)
          .set({
            status: "pending",
            payload: lockedReferences.payload,
            requestedByAgentId: lockedReferences.requestedByAgentId,
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: now,
          })
          .where(and(eq(approvals.id, id), eq(approvals.status, "revision_requested")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Approval changed while resubmission was prepared", {
            code: "approval_resubmit_reference_drift",
          });
        }
        return updated;
      });
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}

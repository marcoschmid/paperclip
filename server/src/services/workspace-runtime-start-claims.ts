import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "@paperclipai/db";
import { workspaceRuntimeStartClaims } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lockAgentLifecycleReference } from "./agent-lifecycle-fence.js";

const START_CLAIM_TTL_MS = 15 * 60 * 1_000;
const START_CLAIM_WAIT_MS = 15_000;

export async function lockWorkspaceRuntimeStartClaimFence(
  targetDb: Db,
  input: { companyId: string; serviceKey: string },
) {
  const lockIdentity = `workspace-runtime-start:${input.companyId}:${input.serviceKey}`;
  await targetDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`,
  );
}

export type WorkspaceRuntimeStartClaimReservation =
  | { kind: "acquired"; claimId: string }
  | { kind: "pending"; claimId: string; expiresAt: Date }
  | { kind: "running"; claimId: string; runtimeServiceId: string };

async function lockActiveOwner(input: {
  db: Db;
  companyId: string;
  ownerAgentId: string | null;
}) {
  if (!input.ownerAgentId) return;
  await lockAgentLifecycleReference(input.db, {
    companyId: input.companyId,
    agentId: input.ownerAgentId,
    mode: "active",
  });
}

export async function reserveWorkspaceRuntimeStartClaim(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  ownerAgentId: string | null;
  now?: Date;
}): Promise<WorkspaceRuntimeStartClaimReservation> {
  const now = input.now ?? new Date();
  const claimId = randomUUID();
  const expiresAt = new Date(now.getTime() + START_CLAIM_TTL_MS);
  return await input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockActiveOwner({
      db: txDb,
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
    });
    await lockWorkspaceRuntimeStartClaimFence(txDb, input);
    const inserted = await txDb
      .insert(workspaceRuntimeStartClaims)
      .values({
        companyId: input.companyId,
        serviceKey: input.serviceKey,
        claimId,
        status: "starting",
        runtimeServiceId: null,
        ownerAgentId: input.ownerAgentId,
        failureCode: null,
        claimedAt: now,
        expiresAt,
        finalizedAt: null,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [workspaceRuntimeStartClaims.companyId, workspaceRuntimeStartClaims.serviceKey],
      })
      .returning({ claimId: workspaceRuntimeStartClaims.claimId });
    if (inserted.length === 1) return { kind: "acquired", claimId };

    const existing = await txDb
      .select()
      .from(workspaceRuntimeStartClaims)
      .where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) {
      throw new Error("Workspace runtime start claim disappeared during reservation");
    }
    if (existing.status === "running") {
      if (!existing.runtimeServiceId) {
        throw new Error("Running workspace runtime start claim has no runtime service binding");
      }
      return {
        kind: "running",
        claimId: existing.claimId,
        runtimeServiceId: existing.runtimeServiceId,
      };
    }
    if (existing.status === "starting") {
      return {
        kind: "pending",
        claimId: existing.claimId,
        expiresAt: existing.expiresAt,
      };
    }

    await txDb
      .update(workspaceRuntimeStartClaims)
      .set({
        claimId,
        status: "starting",
        runtimeServiceId: null,
        ownerAgentId: input.ownerAgentId,
        failureCode: null,
        claimedAt: now,
        expiresAt,
        finalizedAt: null,
        updatedAt: now,
      })
      .where(eq(workspaceRuntimeStartClaims.id, existing.id));
    return { kind: "acquired", claimId };
  });
}

export async function waitForWorkspaceRuntimeStartClaim(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  observedClaimId: string;
  waitMs?: number;
}): Promise<{ claimId: string; runtimeServiceId: string }> {
  const deadline = Date.now() + (input.waitMs ?? START_CLAIM_WAIT_MS);
  while (Date.now() < deadline) {
    const row = await input.db
      .select()
      .from(workspaceRuntimeStartClaims)
      .where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("Workspace runtime start claim disappeared while waiting");
    if (row.status === "running" && row.runtimeServiceId) {
      return { claimId: row.claimId, runtimeServiceId: row.runtimeServiceId };
    }
    if (row.status === "failed" || row.status === "stopped") {
      throw new Error(
        `Workspace runtime start claim ${row.claimId} ended as ${row.status}: ${row.failureCode ?? "unknown"}`,
      );
    }
    if (row.claimId !== input.observedClaimId) {
      throw new Error("Workspace runtime start claim changed owner before it became running");
    }
    await delay(25);
  }
  throw new Error(
    `Workspace runtime start claim ${input.observedClaimId} did not finalize before the wait deadline`,
  );
}

export async function finalizeWorkspaceRuntimeStartClaim(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  claimId: string;
  runtimeServiceId: string;
  ownerAgentId: string | null;
  assertReady?: (tx: Db) => Promise<void>;
  persist: (tx: Db) => Promise<void>;
}) {
  await input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockActiveOwner({
      db: txDb,
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
    });
    await lockWorkspaceRuntimeStartClaimFence(txDb, input);
    const claim = await txDb
      .select()
      .from(workspaceRuntimeStartClaims)
      .where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!claim || claim.claimId !== input.claimId || claim.status !== "starting") {
      throw new Error("Workspace runtime start claim ownership changed before finalization");
    }
    await input.assertReady?.(txDb);
    await input.persist(txDb);
    const now = new Date();
    const updated = await txDb
      .update(workspaceRuntimeStartClaims)
      .set({
        status: "running",
        runtimeServiceId: input.runtimeServiceId,
        ownerAgentId: input.ownerAgentId,
        failureCode: null,
        finalizedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(workspaceRuntimeStartClaims.id, claim.id),
        eq(workspaceRuntimeStartClaims.claimId, input.claimId),
        eq(workspaceRuntimeStartClaims.status, "starting"),
      ))
      .returning({ id: workspaceRuntimeStartClaims.id });
    if (updated.length !== 1) {
      throw new Error("Workspace runtime start claim CAS finalization failed");
    }
  });
}

export async function terminalizeWorkspaceRuntimeStartClaim(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  claimId: string;
  runtimeServiceId: string;
  expectedStatus: "starting" | "running" | "stopped" | "failed";
  expectedRuntimeServiceId: string | null;
  terminalRuntimeServiceId?: string | null;
  terminalStatus: "stopped" | "failed";
  failureCode: string | null;
  persist: (tx: Db) => Promise<void>;
}) {
  await input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockWorkspaceRuntimeStartClaimFence(txDb, input);
    const claim = await txDb
      .select()
      .from(workspaceRuntimeStartClaims)
      .where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !claim ||
      claim.claimId !== input.claimId ||
      claim.status !== input.expectedStatus ||
      claim.runtimeServiceId !== input.expectedRuntimeServiceId
    ) {
      throw new Error("Workspace runtime start claim terminalization binding changed");
    }

    await input.persist(txDb);
    const now = new Date();
    const runtimeBinding = input.expectedRuntimeServiceId === null
      ? isNull(workspaceRuntimeStartClaims.runtimeServiceId)
      : eq(workspaceRuntimeStartClaims.runtimeServiceId, input.expectedRuntimeServiceId);
    const updated = await txDb
      .update(workspaceRuntimeStartClaims)
      .set({
        status: input.terminalStatus,
        runtimeServiceId: input.terminalRuntimeServiceId === undefined
          ? input.expectedRuntimeServiceId
          : input.terminalRuntimeServiceId,
        failureCode: input.failureCode,
        finalizedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(workspaceRuntimeStartClaims.id, claim.id),
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
        eq(workspaceRuntimeStartClaims.claimId, input.claimId),
        eq(workspaceRuntimeStartClaims.status, input.expectedStatus),
        runtimeBinding,
      ))
      .returning({ id: workspaceRuntimeStartClaims.id });
    if (updated.length !== 1) {
      throw new Error("Workspace runtime start claim terminalization CAS failed");
    }
  });
}

export async function failWorkspaceRuntimeStartClaim(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  claimId: string;
  failureCode: string;
}) {
  await input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await lockWorkspaceRuntimeStartClaimFence(txDb, input);
    const now = new Date();
    await txDb
      .update(workspaceRuntimeStartClaims)
      .set({
        status: "failed",
        runtimeServiceId: null,
        failureCode: input.failureCode,
        finalizedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
        eq(workspaceRuntimeStartClaims.claimId, input.claimId),
        eq(workspaceRuntimeStartClaims.status, "starting"),
      ));
  });
}

export async function markWorkspaceRuntimeStartClaimStopped(input: {
  db: Db;
  runtimeServiceId: string;
  failureCode?: string | null;
}) {
  const now = new Date();
  await input.db
    .update(workspaceRuntimeStartClaims)
    .set({
      status: "stopped",
      failureCode: input.failureCode ?? null,
      finalizedAt: now,
      updatedAt: now,
    })
    .where(eq(workspaceRuntimeStartClaims.runtimeServiceId, input.runtimeServiceId));
}

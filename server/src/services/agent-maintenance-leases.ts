import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { withAgentStartLock } from "./agent-start-lock.js";

export const AGENT_MAINTENANCE_LEASE_SCOPE = "codex_profile_migration" as const;
export const AGENT_MAINTENANCE_LEASE_HEADER = "X-Paperclip-Maintenance-Lease" as const;
export const DEFAULT_AGENT_MAINTENANCE_LEASE_TTL_MS = 10 * 60 * 1000;
export const MAX_AGENT_MAINTENANCE_LEASE_TTL_MS = 30 * 60 * 1000;

type MaintenanceLeaseRecord = {
  leaseId: string;
  companyId: string;
  agentIds: string[];
  scope: typeof AGENT_MAINTENANCE_LEASE_SCOPE;
  ownerUserId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  drainStartedAt: Date | null;
  drainedAt: Date | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

export type AcquireAgentMaintenanceLeaseInput = {
  companyId: string;
  agentIds: string[];
  scope: typeof AGENT_MAINTENANCE_LEASE_SCOPE;
  ownerUserId: string;
};

function hashLeaseToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function leaseTokenMatches(record: MaintenanceLeaseRecord, token: string) {
  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = Buffer.from(hashLeaseToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function withAgentStartLocks<T>(agentIds: string[], callback: () => Promise<T>): Promise<T> {
  const [agentId, ...rest] = agentIds;
  if (!agentId) return callback();
  return withAgentStartLock(agentId, () => withAgentStartLocks(rest, callback));
}

export class AgentMaintenanceLeaseRegistry {
  private readonly leasesById = new Map<string, MaintenanceLeaseRecord>();
  private readonly leaseIdByAgentId = new Map<string, string>();

  constructor(
    private readonly db: Db,
    ttlMs = DEFAULT_AGENT_MAINTENANCE_LEASE_TTL_MS,
  ) {
    this.ttlMs = Math.max(1, Math.min(MAX_AGENT_MAINTENANCE_LEASE_TTL_MS, ttlMs));
  }

  private readonly ttlMs: number;

  private remove(record: MaintenanceLeaseRecord) {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = null;
    this.leasesById.delete(record.leaseId);
    for (const agentId of record.agentIds) {
      if (this.leaseIdByAgentId.get(agentId) === record.leaseId) this.leaseIdByAgentId.delete(agentId);
    }
  }

  private async expire(record: MaintenanceLeaseRecord) {
    if (this.leasesById.get(record.leaseId) !== record) return;
    this.remove(record);
    await logActivity(this.db, {
      companyId: record.companyId,
      actorType: "system",
      actorId: "maintenance_lease_expiry",
      action: "agent.maintenance_lease_expired",
      entityType: "agent_maintenance_lease",
      entityId: record.leaseId,
      details: {
        scope: record.scope,
        agentIds: record.agentIds,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
      },
    });
  }

  private async expireIfNeeded(record: MaintenanceLeaseRecord) {
    if (record.expiresAt.getTime() > Date.now()) return false;
    await this.expire(record);
    return true;
  }

  private async requireActiveLease(companyId: string, leaseId: string, leaseToken: string) {
    const record = this.leasesById.get(leaseId);
    if (!record || record.companyId !== companyId) throw notFound("Maintenance lease not found");
    if (await this.expireIfNeeded(record)) throw notFound("Maintenance lease not found");
    if (!leaseTokenMatches(record, leaseToken)) throw forbidden("Invalid maintenance lease token");
    return record;
  }

  private async recheckActiveLease(record: MaintenanceLeaseRecord) {
    if (this.leasesById.get(record.leaseId) !== record) throw notFound("Maintenance lease not found");
    if (await this.expireIfNeeded(record)) throw notFound("Maintenance lease not found");
  }

  async acquire(input: AcquireAgentMaintenanceLeaseInput) {
    const agentIds = [...new Set(input.agentIds)].sort((left, right) => left.localeCompare(right));
    return withAgentStartLocks(agentIds, async () => {
      for (const agentId of agentIds) {
        const activeLeaseId = this.leaseIdByAgentId.get(agentId);
        if (!activeLeaseId) continue;
        const activeLease = this.leasesById.get(activeLeaseId);
        if (activeLease && !(await this.expireIfNeeded(activeLease))) {
          throw conflict("An agent already has an active maintenance lease");
        }
      }

      const leaseId = randomUUID();
      const leaseToken = randomBytes(32).toString("base64url");
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
      const record: MaintenanceLeaseRecord = {
        leaseId,
        companyId: input.companyId,
        agentIds,
        scope: input.scope,
        ownerUserId: input.ownerUserId,
        tokenHash: hashLeaseToken(leaseToken),
        createdAt,
        expiresAt,
        drainStartedAt: null,
        drainedAt: null,
        expiryTimer: null,
      };

      this.leasesById.set(leaseId, record);
      for (const agentId of agentIds) this.leaseIdByAgentId.set(agentId, leaseId);
      try {
        await logActivity(this.db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.ownerUserId,
          action: "agent.maintenance_lease_acquired",
          entityType: "agent_maintenance_lease",
          entityId: leaseId,
          details: {
            scope: input.scope,
            agentIds,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
        });
      } catch (error) {
        this.remove(record);
        throw error;
      }

      if (expiresAt.getTime() <= Date.now()) {
        await this.expire(record);
        throw conflict("Maintenance lease expired during acquisition");
      }

      record.expiryTimer = setTimeout(() => {
        void this.expire(record).catch((error) => {
          logger.warn({ err: error, leaseId: record.leaseId }, "failed to audit expired agent maintenance lease");
        });
      }, Math.max(1, expiresAt.getTime() - Date.now()));
      record.expiryTimer.unref?.();

      return {
        leaseId,
        leaseToken,
        status: "acquired" as const,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async isAgentLeased(agentId: string) {
    const leaseId = this.leaseIdByAgentId.get(agentId);
    if (!leaseId) return false;
    const record = this.leasesById.get(leaseId);
    if (!record) {
      this.leaseIdByAgentId.delete(agentId);
      return false;
    }
    return !(await this.expireIfNeeded(record));
  }

  async drainReceipt(companyId: string, leaseId: string, leaseToken: string) {
    const record = await this.requireActiveLease(companyId, leaseId, leaseToken);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.agentId, record.agentIds),
        eq(heartbeatRuns.status, "running"),
      ));
    const runningCount = Number(count ?? 0);
    await this.recheckActiveLease(record);
    if (runningCount > 0 && !record.drainStartedAt) {
      const drainStartedAt = new Date();
      await logActivity(this.db, {
        companyId,
        actorType: "user",
        actorId: record.ownerUserId,
        action: "agent.maintenance_lease_draining",
        entityType: "agent_maintenance_lease",
        entityId: leaseId,
        details: {
          scope: record.scope,
          agentIds: record.agentIds,
          runningCount,
          drainStartedAt: drainStartedAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
        },
      });
      await this.recheckActiveLease(record);
      record.drainStartedAt = drainStartedAt;
    }
    if (runningCount === 0 && !record.drainedAt) {
      const drainedAt = new Date();
      await logActivity(this.db, {
        companyId,
        actorType: "user",
        actorId: record.ownerUserId,
        action: "agent.maintenance_lease_drained",
        entityType: "agent_maintenance_lease",
        entityId: leaseId,
        details: {
          scope: record.scope,
          agentIds: record.agentIds,
          drainedAt: drainedAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
        },
      });
      await this.recheckActiveLease(record);
      record.drainedAt = drainedAt;
    }
    return {
      leaseId,
      status: runningCount === 0 ? "drained" as const : "draining" as const,
      agentIds: [...record.agentIds],
      drainedAt: runningCount === 0 ? record.drainedAt?.toISOString() ?? null : null,
      runningCount,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  async release(companyId: string, leaseId: string, leaseToken: string) {
    const record = await this.requireActiveLease(companyId, leaseId, leaseToken);
    const releasedAt = new Date();
    await logActivity(this.db, {
      companyId,
      actorType: "user",
      actorId: record.ownerUserId,
      action: "agent.maintenance_lease_released",
      entityType: "agent_maintenance_lease",
      entityId: leaseId,
      details: {
        scope: record.scope,
        agentIds: record.agentIds,
        releasedAt: releasedAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
      },
    });
    await this.recheckActiveLease(record);
    this.remove(record);
    return {
      leaseId,
      status: "released" as const,
      restoredAgentIds: [] as string[],
      releasedAt: releasedAt.toISOString(),
    };
  }
}

const registryByDb = new WeakMap<Db, AgentMaintenanceLeaseRegistry>();

export function agentMaintenanceLeaseService(db: Db, options: { ttlMs?: number } = {}) {
  const existing = registryByDb.get(db);
  if (existing) return existing;
  const registry = new AgentMaintenanceLeaseRegistry(db, options.ttlMs);
  registryByDb.set(db, registry);
  return registry;
}

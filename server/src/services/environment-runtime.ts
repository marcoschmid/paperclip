import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecrets,
  companySecretVersions,
  environmentLeases,
  heartbeatRuns,
} from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  PluginEnvironmentConfig,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import { normalizeAgentRetirementId } from "@paperclipai/shared";
import type {
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import { environmentService } from "./environments.js";
import {
  collectEnvironmentSecretRefs,
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  stripSandboxProviderEnvelope,
} from "./environment-config.js";
import {
  createEffectiveRunConfigFingerprints,
  type EffectiveRunConfigFingerprint,
  type EffectiveRunConfigSecretVersionMetadata,
} from "./effective-run-config-fingerprints.js";
import {
  acquireSandboxProviderLease,
  destroySandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  getSandboxProvider as getBuiltinSandboxProvider,
  isBuiltinSandboxProvider,
  releaseSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
} from "./sandbox-provider-runtime.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  destroyPluginEnvironmentLease,
  executePluginEnvironmentCommand,
  realizePluginEnvironmentWorkspace,
  resolvePluginSandboxProviderDriverByKey,
  resolvePluginExecuteRpcTimeoutMs,
  resumePluginEnvironmentLease,
} from "./plugin-environment-driver.js";
import { collectSecretRefPaths } from "./json-schema-secret-refs.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";
import {
  assertHistoricalAgentTombstoneActiveReference,
  isHistoricalAgentTombstoneId,
} from "./agent-retirement-historical-tombstones.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

function stripSecretRefValuesFromPluginLeaseMetadata(input: {
  metadata: Record<string, unknown> | null | undefined;
  schema: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const sanitized = structuredClone(input.metadata ?? {}) as Record<string, unknown>;

  for (const path of collectSecretRefPaths(input.schema)) {
    const keys = path.split(".");
    const parents: Array<{ container: Record<string, unknown>; key: string }> = [];
    let cursor: Record<string, unknown> | null = sanitized;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index]!;
      const next = cursor?.[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor = null;
        break;
      }
      parents.push({ container: cursor, key });
      cursor = next as Record<string, unknown>;
    }

    if (!cursor) continue;

    const leafKey = keys[keys.length - 1]!;
    if (!Object.prototype.hasOwnProperty.call(cursor, leafKey)) continue;
    delete cursor[leafKey];

    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const { container, key } = parents[index]!;
      const value = container[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).length === 0
      ) {
        delete container[key];
      } else {
        break;
      }
    }
  }

  return sanitized;
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  agentId: string | null;
  /**
   * UUID of the owning heartbeat run, or null for ad-hoc invocations
   * (e.g. operator-initiated `Test` probes) that are not tied to a run.
   * Null leases must be released by id via `getDriver(...).releaseRunLease`
   * since `releaseRunLeases(heartbeatRunId)` cannot find them.
   */
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceMode: ExecutionWorkspace["mode"] | null;
  /**
   * The harness/adapter type for this run (the agent's adapter). Drivers that
   * materialize a per-run sandbox use it to select the runtime image so a single
   * environment can serve mixed harnesses; null falls back to the environment's
   * configured default adapter.
   */
  adapterType: string | null;
  /**
   * Force applying the active custom-image template even when issueId and
   * heartbeatRunId are null. Operator-initiated `Test` probes set this so the
   * probe uses the operator-prepared custom image for the runtime lease instead
   * of the base image, matching what real agent runs do.
   */
  applyCustomImageTemplate?: boolean;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}

function resolvePluginSandboxRpcTimeoutMs(config: Record<string, unknown>): number | undefined {
  const timeoutCandidates = [
    typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    typeof config.bridgeRequestTimeoutMs === "number" ? config.bridgeRequestTimeoutMs : undefined,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (timeoutCandidates.length === 0) {
    return undefined;
  }

  return resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: Math.max(...timeoutCandidates),
    config,
  });
}

export interface EnvironmentDriverLeaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  failureReason?: string;
}

export interface EnvironmentDriverRealizeWorkspaceInput extends EnvironmentDriverLeaseInput {
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface EnvironmentDriverExecuteInput extends EnvironmentDriverLeaseInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface EnvironmentRuntimeDriver {
  readonly driver: string;
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentLease>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
  resumeRunLease?(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null>;
  destroyRunLease?(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null>;
  realizeWorkspace?(input: EnvironmentDriverRealizeWorkspaceInput): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  execute?(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult>;
}

export interface EnvironmentRuntimeLeaseRecord {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLeaseDriverKey(lease: Pick<EnvironmentLease, "metadata">, environment: Pick<Environment, "driver">): string {
  const leaseDriver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : null;
  return leaseDriver ?? environment.driver;
}

function toEnvironmentLeaseSnapshot(row: typeof environmentLeases.$inferSelect): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: row.status as EnvironmentLease["status"],
    leasePolicy: row.leasePolicy as EnvironmentLease["leasePolicy"],
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: row.cleanupStatus as EnvironmentLease["cleanupStatus"],
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeLeaseOwnerAgentId(agentId: string | null | undefined): string | null {
  return normalizeAgentRetirementId(agentId);
}

async function resolveHeartbeatRunOwners(
  db: Db,
  runIds: Iterable<string>,
): Promise<Map<string, { agentId: string; companyId: string }>> {
  const ids = [...new Set(runIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, ids));
  return new Map(rows.map((row) => [row.id, {
    agentId: normalizeLeaseOwnerAgentId(row.agentId)!,
    companyId: row.companyId,
  }] as const));
}

async function resolveAgentOwnerRecords(
  db: Db,
  agentIds: Iterable<string>,
  options: { lockForUpdate?: boolean } = {},
): Promise<Map<string, { status: string; companyId: string }>> {
  const ids = [...new Set(
    [...agentIds]
      .map((id) => normalizeLeaseOwnerAgentId(id))
      .filter((id): id is string => id !== null),
  )];
  if (ids.length === 0) return new Map();
  const query = db
    .select({ id: agents.id, status: agents.status, companyId: agents.companyId })
    .from(agents)
    .where(inArray(agents.id, ids))
    .orderBy(agents.id);
  const rows = options.lockForUpdate
    ? await query.for("update")
    : await query;
  return new Map(rows.map((row) => [normalizeLeaseOwnerAgentId(row.id)!, {
    status: row.status,
    companyId: row.companyId,
  }] as const));
}

function readLeaseMetadataOwners(lease: Pick<EnvironmentLease, "metadata">): {
  invalid: boolean;
  agentIds: string[];
} {
  if (!lease.metadata) return { invalid: false, agentIds: [] };
  const rawValues: unknown[] = [];
  let structurallyInvalid = false;
  if (Object.prototype.hasOwnProperty.call(lease.metadata, "agentId")) {
    rawValues.push(lease.metadata.agentId);
  }
  const reusableScope = lease.metadata.reusableSandboxLease;
  if (Object.prototype.hasOwnProperty.call(lease.metadata, "reusableSandboxLease")) {
    if (!reusableScope || typeof reusableScope !== "object" || Array.isArray(reusableScope)) {
      structurallyInvalid = true;
    } else if (!Object.prototype.hasOwnProperty.call(reusableScope, "agentId")) {
      structurallyInvalid = true;
    } else {
      rawValues.push((reusableScope as Record<string, unknown>).agentId);
    }
  }
  const agentIds = rawValues
    .map((value) => typeof value === "string" ? normalizeLeaseOwnerAgentId(value) : null)
    .filter((id): id is string => id !== null);
  return {
    invalid: structurallyInvalid || agentIds.length !== rawValues.length,
    agentIds: [...new Set(agentIds)],
  };
}

async function resolveTerminatedOwnerLeaseIds(
  db: Db,
  leases: readonly EnvironmentLease[],
): Promise<Set<string>> {
  const runOwners = await resolveHeartbeatRunOwners(
    db,
    leases.flatMap((lease) => lease.heartbeatRunId ? [lease.heartbeatRunId] : []),
  );
  const ownersByLeaseId = new Map<string, string[]>();
  const allOwnerIds: string[] = [];
  const unsafeLeaseIds = new Set<string>();
  for (const lease of leases) {
    const runOwner = lease.heartbeatRunId ? runOwners.get(lease.heartbeatRunId) ?? null : null;
    const metadataOwners = readLeaseMetadataOwners(lease);
    const ownerEvidence = [runOwner?.agentId ?? null, ...metadataOwners.agentIds]
      .filter((id): id is string => id !== null);
    if (
      (lease.heartbeatRunId && (!runOwner || runOwner.companyId !== lease.companyId)) ||
      metadataOwners.invalid ||
      new Set(ownerEvidence).size > 1
    ) {
      unsafeLeaseIds.add(lease.id);
    }
    const ownerIds = [...new Set(ownerEvidence)];
    if (lease.leasePolicy === "reuse_by_environment" && ownerIds.length === 0) {
      unsafeLeaseIds.add(lease.id);
    }
    ownersByLeaseId.set(lease.id, ownerIds);
    allOwnerIds.push(...ownerIds);
  }
  const agentRecords = await resolveAgentOwnerRecords(db, allOwnerIds);
  for (const lease of leases) {
    for (const ownerId of ownersByLeaseId.get(lease.id) ?? []) {
      const owner = agentRecords.get(ownerId);
      if (
        isHistoricalAgentTombstoneId(ownerId) ||
        !owner ||
        owner.status === "terminated" ||
        owner.companyId !== lease.companyId
      ) {
        unsafeLeaseIds.add(lease.id);
      }
    }
  }
  return unsafeLeaseIds;
}

async function assertLeaseOwnerActive(
  db: Db,
  input: {
    companyId: string;
    agentId?: string | null;
    heartbeatRunId?: string | null;
    lease?: EnvironmentLease;
    lockOwnersForUpdate?: boolean;
  },
): Promise<void> {
  const runIds = [input.heartbeatRunId, input.lease?.heartbeatRunId]
    .filter((id): id is string => Boolean(id));
  const runOwners = await resolveHeartbeatRunOwners(db, runIds);
  const directOwnerId = normalizeLeaseOwnerAgentId(input.agentId);
  const metadataOwners = input.lease
    ? readLeaseMetadataOwners(input.lease)
    : { invalid: false, agentIds: [] };
  if ((input.agentId && !directOwnerId) || metadataOwners.invalid) {
    throw conflict("Environment lease owner reference is invalid", {
      code: "agent_environment_lease_owner_invalid",
    });
  }
  const runOwnerRecords = runIds.map((runId) => runOwners.get(runId) ?? null);
  if (runOwnerRecords.some((owner) => !owner || owner.companyId !== input.companyId)) {
    throw conflict("Environment lease run owner is missing or belongs to another company", {
      code: "agent_environment_lease_owner_invalid",
    });
  }
  const runOwnerIds = runOwnerRecords
    .map((owner) => owner?.agentId ?? null)
    .filter((id): id is string => id !== null);
  const declaredOwnerIds = [directOwnerId, ...metadataOwners.agentIds]
    .filter((id): id is string => id !== null);
  if (new Set([...declaredOwnerIds, ...runOwnerIds]).size > 1) {
    throw conflict("Environment lease owner references disagree", {
      code: "agent_environment_lease_owner_invalid",
    });
  }
  const ownerIds = [...new Set([...declaredOwnerIds, ...runOwnerIds])];
  const durableOwnerIds = [...new Set([...metadataOwners.agentIds, ...runOwnerIds])];
  if (input.lease?.leasePolicy === "reuse_by_environment" && durableOwnerIds.length === 0) {
    throw conflict("Reusable environment lease has no verifiable owner", {
      code: "agent_environment_lease_owner_invalid",
    });
  }
  const ownerRecords = await resolveAgentOwnerRecords(db, ownerIds, {
    lockForUpdate: input.lockOwnersForUpdate ?? false,
  });
  for (const ownerId of ownerIds) {
    assertHistoricalAgentTombstoneActiveReference(ownerId);
    const owner = ownerRecords.get(ownerId);
    if (!owner || owner.status === "terminated" || owner.companyId !== input.companyId) {
      throw conflict("Terminated agents cannot own or resume environment leases", {
        code: "agent_terminated_active_reference_forbidden",
        agentId: ownerId,
      });
    }
    if (owner.status === "pending_approval" || owner.status === "paused") {
      throw conflict("Non-invokable agents cannot own or resume environment leases", {
        code: "agent_lifecycle_active_reference_forbidden",
        reason: owner.status,
        agentId: ownerId,
      });
    }
  }
}

async function excludeTerminatedOwnerLeases(
  db: Db,
  leases: EnvironmentLease[],
): Promise<EnvironmentLease[]> {
  const terminatedLeaseIds = await resolveTerminatedOwnerLeaseIds(db, leases);
  return leases.filter((lease) => !terminatedLeaseIds.has(lease.id));
}

function assertLeaseEnvironmentBinding(input: {
  environment: Pick<Environment, "id">;
  lease: Pick<EnvironmentLease, "environmentId">;
}): void {
  if (input.environment.id !== input.lease.environmentId) {
    throw conflict("Environment lease does not belong to the supplied environment", {
      code: "environment_lease_binding_mismatch",
      environmentId: input.environment.id,
      leaseEnvironmentId: input.lease.environmentId,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readLeaseOwnerEvidenceForComparison(lease: Pick<EnvironmentLease, "metadata">) {
  const metadata = lease.metadata;
  const hasTopLevelOwner = Boolean(metadata) && Object.prototype.hasOwnProperty.call(metadata, "agentId");
  const reusableScope = isRecord(metadata?.reusableSandboxLease)
    ? metadata.reusableSandboxLease
    : null;
  const hasReusableScope = Boolean(metadata) &&
    Object.prototype.hasOwnProperty.call(metadata, "reusableSandboxLease");
  const hasReusableOwner = Boolean(reusableScope) &&
    Object.prototype.hasOwnProperty.call(reusableScope, "agentId");
  return {
    hasTopLevelOwner,
    topLevelOwner: hasTopLevelOwner ? metadata?.agentId : null,
    hasReusableScope,
    reusableScopeValid: reusableScope !== null,
    hasReusableOwner,
    reusableOwner: hasReusableOwner ? reusableScope?.agentId : null,
  };
}

function readLeaseRoutingEvidenceForComparison(lease: Pick<EnvironmentLease, "metadata">) {
  const metadata = lease.metadata;
  return {
    driver: metadata?.driver ?? null,
    provider: metadata?.provider ?? null,
    pluginId: metadata?.pluginId ?? null,
    pluginKey: metadata?.pluginKey ?? null,
    driverKey: metadata?.driverKey ?? null,
    sandboxProviderPlugin: metadata?.sandboxProviderPlugin ?? null,
    executionWorkspaceMode: metadata?.executionWorkspaceMode ?? null,
  };
}

function criticalLeasePersistenceIdentity(lease: EnvironmentLease) {
  return {
    correlation: leaseCorrelationIdentity(lease),
    status: lease.status,
    cleanupStatus: lease.cleanupStatus,
    failureReason: lease.failureReason,
    releasedAt: lease.releasedAt?.toISOString() ?? null,
    resource: leaseResourceIdentity(lease),
  };
}

function leaseCorrelationIdentity(lease: EnvironmentLease) {
  return {
    id: lease.id,
    companyId: lease.companyId,
    environmentId: lease.environmentId,
    executionWorkspaceId: lease.executionWorkspaceId,
    issueId: lease.issueId,
    heartbeatRunId: lease.heartbeatRunId,
  };
}

function leaseResourceIdentity(lease: EnvironmentLease) {
  return {
    correlation: leaseCorrelationIdentity(lease),
    leasePolicy: lease.leasePolicy,
    provider: lease.provider,
    providerLeaseId: lease.providerLeaseId,
    ownerEvidence: readLeaseOwnerEvidenceForComparison(lease),
    routingEvidence: readLeaseRoutingEvidenceForComparison(lease),
  };
}

function leaseIdentityMatches(
  left: EnvironmentLease,
  right: EnvironmentLease,
  selector: (lease: EnvironmentLease) => unknown,
) {
  return stableStringify(selector(left)) === stableStringify(selector(right));
}

function assertPersistedLeaseMatchesDriverOrCaller(input: {
  supplied: EnvironmentLease;
  persisted: EnvironmentLease | null;
  operation: string;
}): EnvironmentLease {
  if (
    !input.persisted ||
    stableStringify(criticalLeasePersistenceIdentity(input.supplied)) !==
      stableStringify(criticalLeasePersistenceIdentity(input.persisted))
  ) {
    throw conflict(`Environment lease persistence mismatch during ${input.operation}`, {
      code: "environment_lease_persistence_mismatch",
      leaseId: input.supplied.id,
      operation: input.operation,
    });
  }
  return input.persisted;
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

function serializeLeaseFingerprint(
  fingerprint: EffectiveRunConfigFingerprint | null | undefined,
): Record<string, unknown> | null {
  if (!fingerprint) return null;
  return {
    version: fingerprint.version,
    category: fingerprint.category,
    algorithm: fingerprint.algorithm,
    fingerprint: fingerprint.fingerprint,
  };
}

function readLeaseFingerprint(value: unknown): string | null {
  return isRecord(value) ? readString(value.fingerprint) : null;
}

async function buildEnvironmentSecretMetadataForLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
}): Promise<EffectiveRunConfigSecretVersionMetadata[]> {
  const refs = await collectEnvironmentSecretRefs({
    db: input.db,
    environment: input.environment,
  });
  if (refs.length === 0) return [];

  const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
  const secretRows = await input.db
    .select()
    .from(companySecrets)
    .where(inArray(companySecrets.id, secretIds));
  const secretsById = new Map(
    secretRows
      .filter((secret) => secret.companyId === input.companyId)
      .map((secret) => [secret.id, secret]),
  );

  const versionRequests = refs.flatMap((ref) => {
    const secret = secretsById.get(ref.secretId);
    if (!secret) return [];
    const resolvedVersion = ref.versionSelector === "latest" || ref.versionSelector === undefined
      ? secret.latestVersion
      : ref.versionSelector;
    return typeof resolvedVersion === "number"
      ? [{ secretId: secret.id, version: resolvedVersion }]
      : [];
  });
  const versionSecretIds = [...new Set(versionRequests.map((request) => request.secretId))];
  const versions = [...new Set(versionRequests.map((request) => request.version))];
  const versionRows = versionSecretIds.length > 0 && versions.length > 0
    ? await input.db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            inArray(companySecretVersions.secretId, versionSecretIds),
            inArray(companySecretVersions.version, versions),
          ),
        )
    : [];
  const versionsBySecretAndNumber = new Map(
    versionRows.map((row) => [`${row.secretId}:${row.version}`, row]),
  );

  const metadata: EffectiveRunConfigSecretVersionMetadata[] = [];
  for (const ref of refs) {
    const secret = secretsById.get(ref.secretId);
    if (!secret) {
      metadata.push({
        configPath: ref.configPath,
        envKey: null,
        secretId: ref.secretId,
        version: typeof ref.versionSelector === "number" ? ref.versionSelector : "unresolved",
        outcome: "failure",
      });
      continue;
    }

    const resolvedVersion = ref.versionSelector === "latest" || ref.versionSelector === undefined
      ? secret.latestVersion
      : ref.versionSelector;
    const versionRow = typeof resolvedVersion === "number"
      ? versionsBySecretAndNumber.get(`${secret.id}:${resolvedVersion}`) ?? null
      : null;

    metadata.push({
      configPath: ref.configPath,
      envKey: null,
      secretId: secret.id,
      version: resolvedVersion,
      provider: secret.provider,
      providerVersionRef: versionRow?.providerVersionRef ?? null,
      outcome: versionRow ? "success" : "failure",
    });
  }

  return metadata;
}

async function buildReusableSandboxLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  providerConfig: Record<string, unknown>;
  providerPlugin?: {
    id: string;
    pluginKey: string;
    packageName: string;
    version: string;
  } | null;
}): Promise<EffectiveRunConfigFingerprint> {
  const secretMetadata = await buildEnvironmentSecretMetadataForLeaseFingerprint({
    db: input.db,
    companyId: input.companyId,
    environment: input.environment,
  });
  return createEffectiveRunConfigFingerprints({
    lease: {
      companyId: input.companyId,
      environment: {
        id: input.environment.id,
        driver: input.environment.driver,
      },
      executionWorkspaceId: input.executionWorkspaceId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      provider: input.provider,
      providerPlugin: input.providerPlugin ?? null,
      providerConfig: input.providerConfig,
      secrets: secretMetadata,
    },
    secretManifest: secretMetadata,
  }).leaseFingerprint;
}

function buildReusableSandboxLeaseScope(input: {
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  providerMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  if (!input.executionWorkspaceId || !input.agentId) return null;
  const providerMetadata = input.providerMetadata ?? {};
  const adapterType = input.adapterType ?? null;
  const remoteCwd = readString(providerMetadata.remoteCwd);
  const workspaceSentinel = isRecord(providerMetadata.workspaceSentinel)
    ? { ...providerMetadata.workspaceSentinel }
    : null;
  return {
    version: 1,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    agentId: input.agentId,
    adapterType,
    provider: input.provider,
    runtimeFingerprint: reusableRuntimeFingerprint({
      provider: input.provider,
      adapterType,
      config: input.config,
    }),
    ...(input.leaseFingerprint
      ? { leaseFingerprint: serializeLeaseFingerprint(input.leaseFingerprint) }
      : {}),
    ...(remoteCwd ? { remoteCwd } : {}),
    ...(workspaceSentinel ? { workspaceSentinel } : {}),
  };
}

function reusableSandboxLeaseScopeMatches(input: {
  lease: Pick<EnvironmentLease, "metadata">;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  allowLegacyRuntimeFingerprint?: boolean;
}): boolean {
  if (!input.executionWorkspaceId || !input.agentId) return false;
  const scope = input.lease.metadata?.reusableSandboxLease;
  if (!isRecord(scope)) return false;
  const adapterType = input.adapterType ?? null;
  const baseScopeMatches =
    scope.companyId === input.companyId &&
    scope.environmentId === input.environmentId &&
    scope.executionWorkspaceId === input.executionWorkspaceId &&
    scope.agentId === input.agentId &&
    scope.adapterType === adapterType &&
    scope.provider === input.provider;
  if (!baseScopeMatches) return false;

  const expectedLeaseFingerprint = input.leaseFingerprint?.fingerprint ?? null;
  if (expectedLeaseFingerprint) {
    const storedLeaseFingerprint = readLeaseFingerprint(scope.leaseFingerprint);
    if (storedLeaseFingerprint) {
      return storedLeaseFingerprint === expectedLeaseFingerprint;
    }
    if (!input.allowLegacyRuntimeFingerprint) return false;
  }

  return scope.runtimeFingerprint === reusableRuntimeFingerprint({
    provider: input.provider,
    adapterType,
    config: input.config,
  });
}

function reusableLeaseCanBeResumed(input: {
  lease: Pick<EnvironmentLease, "status" | "heartbeatRunId">;
  heartbeatRunId: string | null;
}): boolean {
  if (input.lease.status === "released" || input.lease.status === "retained") return true;
  return input.lease.status === "active" && input.heartbeatRunId !== null && input.lease.heartbeatRunId === input.heartbeatRunId;
}

function reusableLeaseCanBeCleanedUp(lease: Pick<EnvironmentLease, "status">): boolean {
  return lease.status === "released" || lease.status === "retained";
}

export function findReusableSandboxLeaseId(input: {
  config: SandboxEnvironmentConfig;
  leases: Array<Pick<EnvironmentLease, "providerLeaseId" | "metadata">>;
}): string | null {
  return findReusableSandboxProviderLeaseId(input);
}

function createLocalEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "local",

    async acquireRunLease(input) {
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? null,
      });
      return {
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? "/",
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSshEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "ssh",

    async acquireRunLease(input) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "ssh",
        providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          host: parsed.config.host,
          port: parsed.config.port,
          username: parsed.config.username,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSandboxEnvironmentDriver(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
  } = {},
): EnvironmentRuntimeDriver {
  const pluginWorkerManager = options.pluginWorkerManager;
  const pluginWorkerReadyTimeoutMs = options.pluginWorkerReadyTimeoutMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS;
  const pluginWorkerReadyPollMs = options.pluginWorkerReadyPollMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS;
  const environmentsSvc = environmentService(db);

  async function resolveSandboxProviderPlugin(input: { provider: string }) {
    const running = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: true,
    });
    if (running) {
      return { state: "running" as const, resolved: running };
    }

    const installed = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: false,
    });
    if (!installed) {
      return { state: "missing" as const, resolved: null };
    }

    if (installed.plugin.status !== "ready") {
      return { state: "not_ready" as const, resolved: installed };
    }

    if (!pluginWorkerManager) {
      return { state: "worker_unavailable" as const, resolved: installed };
    }

    const deadline = Date.now() + Math.max(0, pluginWorkerReadyTimeoutMs);
    while (Date.now() < deadline) {
      const retried = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: input.provider,
        workerManager: pluginWorkerManager,
        requireRunning: true,
      });
      if (retried) {
        return { state: "running" as const, resolved: retried };
      }
      await delay(Math.max(1, pluginWorkerReadyPollMs));
    }

    return { state: "worker_unavailable" as const, resolved: installed };
  }

  async function resolvePluginSandboxRuntimeConfig(input: {
    environment: Environment;
    lease: EnvironmentLease;
    provider: string;
  }): Promise<Record<string, unknown>> {
    const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
    if (metadataConfig && metadataConfig.provider === input.provider) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
        id: input.environment.id,
        driver: "sandbox",
        config: sandboxConfigForLeaseMetadata(metadataConfig),
      });
      if (parsed.driver === "sandbox") {
        return parsed.config as unknown as Record<string, unknown>;
      }
    }

    if (input.environment.driver === "sandbox") {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(
          db,
          input.lease.companyId,
          input.environment,
        );
        if (parsed.driver === "sandbox" && parsed.config.provider === input.provider) {
          return parsed.config as unknown as Record<string, unknown>;
        }
      } catch {
        // Lease metadata below is intentionally kept sufficient for cleanup
        // after the environment config changes or becomes invalid.
      }
    }

    return {
      provider: input.provider,
      ...sanitizePluginSandboxConfigFromLeaseMetadata(input.lease.metadata),
    };
  }

  async function cleanupObsoleteReusableSandboxLeases(input: {
    environment: Environment;
    leases: EnvironmentLease[];
    reusableLeases: EnvironmentLease[];
  }) {
    const reusableIds = new Set(input.reusableLeases.map((lease) => lease.id));
    for (const lease of input.leases) {
      if (reusableIds.has(lease.id)) continue;
      if (!reusableLeaseCanBeCleanedUp(lease)) continue;
      await destroyReusableSandboxLease({
        environment: input.environment,
        lease,
        failureReason: "lease_fingerprint_mismatch",
      });
    }
  }

  return {
    driver: "sandbox",

    async acquireRunLease(input) {
      const storedParsed = parseEnvironmentDriverConfig(input.environment);
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "sandbox" || storedParsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for driver "${input.environment.driver}".`);
      }

      // Check if this provider should be handled by a plugin.
      if (!isBuiltinSandboxProvider(parsed.config.provider)) {
        const pluginProvider = await resolveSandboxProviderPlugin({
          provider: parsed.config.provider,
        });
        if (pluginProvider.state === "missing") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is not registered as a built-in provider and no matching plugin is available.`,
          );
        }
        if (pluginProvider.state === "not_ready") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but that plugin is currently ${pluginProvider.resolved.plugin.status}.`,
          );
        }
        if (pluginProvider.state === "worker_unavailable") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but its worker is not running.`,
          );
        }
        if (!pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed, but sandbox plugin workers are unavailable in this server process.`,
          );
        }

        const workerConfig = stripSandboxProviderEnvelope(parsed.config);
        const storedConfig = storedParsed.config;
        const providerConfigForLease = sandboxConfigForLeaseMetadata(storedConfig);
        const supportsReusableLeases = pluginProvider.resolved.driver.supportsReusableLeases === true;
        const leaseFingerprint =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
            ? await buildReusableSandboxLeaseFingerprint({
                db,
                companyId: input.companyId,
                environment: input.environment,
                executionWorkspaceId: input.executionWorkspaceId,
                agentId: input.agentId,
                adapterType: input.adapterType,
                provider: parsed.config.provider,
                providerConfig: providerConfigForLease,
                providerPlugin: {
                  id: pluginProvider.resolved.plugin.id,
                  pluginKey: pluginProvider.resolved.plugin.pluginKey,
                  packageName: pluginProvider.resolved.plugin.packageName,
                  version: pluginProvider.resolved.plugin.version,
                },
              })
            : null;
        // Ad-hoc tests (heartbeatRunId === null) must never resume an existing
        // provider lease. If they did, releasing the test lease at the end of
        // the probe would tear down the live heartbeat run that owns it.
        // We also filter out leases whose policy is not reuse_by_environment
        // and whose status is not reusable so non-reusable, cleanup-pending,
        // or terminal rows cannot be matched.
        const reusableCandidateLeases =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? await excludeTerminatedOwnerLeases(db,
              (await environmentsSvc.listLeases(input.environment.id)).filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              ),
            )
          : [];
        const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
          reusableSandboxLeaseScopeMatches({
            lease,
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            agentId: input.agentId,
            adapterType: input.adapterType,
            provider: parsed.config.provider,
            config: providerConfigForLease,
            leaseFingerprint,
            allowLegacyRuntimeFingerprint:
              lease.status === "active" &&
              input.heartbeatRunId !== null &&
              lease.heartbeatRunId === input.heartbeatRunId,
          }),
        );
        if (reusableCandidateLeases.length > reusableExistingLeases.length) {
          await cleanupObsoleteReusableSandboxLeases({
            environment: input.environment,
            leases: reusableCandidateLeases,
            reusableLeases: reusableExistingLeases,
          });
        }
        const reusableProviderLeaseId =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? findReusableSandboxLeaseId({ config: storedConfig, leases: reusableExistingLeases })
          : null;
        const reusableLease = reusableProviderLeaseId
          ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
          : null;

        let providerLease: PluginEnvironmentLease | null = null;
        if (reusableLease?.providerLeaseId) {
          try {
            const resumed = await pluginWorkerManager.call(
                pluginProvider.resolved.plugin.id,
                "environmentResumeLease",
                {
                  driverKey: parsed.config.provider,
                  companyId: input.companyId,
                  environmentId: input.environment.id,
                  issueId: input.issueId,
                  config: workerConfig,
                  providerLeaseId: reusableLease.providerLeaseId,
                  leaseMetadata: reusableLease.metadata ?? undefined,
                },
                resolvePluginSandboxRpcTimeoutMs(workerConfig),
              );
            providerLease =
              typeof resumed.providerLeaseId === "string" && resumed.providerLeaseId.length > 0
                ? resumed
                : null;
          } catch {
            providerLease = null;
          }
          if (!providerLease) {
            await destroyReusableSandboxLease({
              environment: input.environment,
              lease: reusableLease,
              failureReason: "resume_failed",
            });
          }
        }
        const acquiredLease = providerLease ?? await pluginWorkerManager.call(
          pluginProvider.resolved.plugin.id,
          "environmentAcquireLease",
          {
            driverKey: parsed.config.provider,
            companyId: input.companyId,
            environmentId: input.environment.id,
            issueId: input.issueId,
            config: workerConfig,
            // Plugin SDK requires a string; ad-hoc test leases use a fresh
            // UUID so providers that validate or persist the runId still see
            // a well-formed identifier.
            runId: input.heartbeatRunId ?? randomUUID(),
            workspaceMode: input.executionWorkspaceMode ?? undefined,
            agentId: input.agentId ?? undefined,
            executionWorkspaceId: input.executionWorkspaceId ?? undefined,
            // The agent's harness for THIS run, so the plugin picks the matching
            // runtime image (per-run adapter, mixed-harness environments).
            // NOTE: environment-runtime.ts has TWO drivers calling
            // environmentAcquireLease; this plugin-sandbox one is the HEARTBEAT
            // path. Omitting adapterType here silently falls back to the
            // environment's default adapter image (a pi agent then runs in the
            // opencode image and the harness binary is missing at exec time).
            adapterType: input.adapterType ?? undefined,
          },
          resolvePluginSandboxRpcTimeoutMs(workerConfig),
        );

        // Ad-hoc test leases are never publishable for reuse: storing them
        // as `reuse_by_environment` would let a concurrent heartbeat resume
        // the test's provider lease and lose its sandbox when the test ends.
        const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
          ? "reuse_by_environment"
          : "ephemeral";
        const sanitizedProviderMetadata = stripSecretRefValuesFromPluginLeaseMetadata({
          metadata: acquiredLease.metadata,
          schema: pluginProvider.resolved.driver.configSchema as Record<string, unknown> | null | undefined,
        });
        const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
          ? buildReusableSandboxLeaseScope({
              companyId: input.companyId,
              environmentId: input.environment.id,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              config: providerConfigForLease,
              leaseFingerprint,
              providerMetadata: sanitizedProviderMetadata,
            })
          : null;

        return await environmentsSvc.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: resolvedLeasePolicy,
          provider: parsed.config.provider,
          providerLeaseId: acquiredLease.providerLeaseId,
          expiresAt: acquiredLease.expiresAt ? new Date(acquiredLease.expiresAt) : undefined,
          metadata: {
            ...(input.agentId ? { agentId: input.agentId } : {}),
            driver: input.environment.driver,
            executionWorkspaceMode: input.executionWorkspaceMode,
            pluginId: pluginProvider.resolved.plugin.id,
            pluginKey: pluginProvider.resolved.plugin.pluginKey,
            sandboxProviderPlugin: true,
            ...sandboxConfigForLeaseMetadata(storedConfig),
            ...sanitizedProviderMetadata,
            ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
          },
        });
      }

      // Built-in sandbox provider path. Same guard as the plugin-backed path:
      // ad-hoc tests (heartbeatRunId === null) must never resume an existing
      // provider lease, or releasing the test lease will terminate the live
      // heartbeat run that shares it. Filter to reusable policies and statuses
      // so non-reusable, cleanup-pending, or terminal rows can never be matched.
      const builtinSandboxProvider = getBuiltinSandboxProvider(parsed.config.provider);
      const supportsReusableLeases = builtinSandboxProvider?.supportsReusableLeases === true;
      const providerConfigForLease = sandboxConfigForLeaseMetadata(parsed.config);
      const leaseFingerprint =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? await buildReusableSandboxLeaseFingerprint({
              db,
              companyId: input.companyId,
              environment: input.environment,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              providerConfig: providerConfigForLease,
            })
          : null;
      const reusableCandidateLeases =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? await excludeTerminatedOwnerLeases(db,
              (await environmentsSvc.listLeases(input.environment.id)).filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              ),
            )
          : [];
      const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
        reusableSandboxLeaseScopeMatches({
          lease,
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          provider: parsed.config.provider,
          config: providerConfigForLease,
          leaseFingerprint,
          allowLegacyRuntimeFingerprint:
            lease.status === "active" &&
            input.heartbeatRunId !== null &&
            lease.heartbeatRunId === input.heartbeatRunId,
        }),
      );
      if (reusableCandidateLeases.length > reusableExistingLeases.length) {
        await cleanupObsoleteReusableSandboxLeases({
          environment: input.environment,
          leases: reusableCandidateLeases,
          reusableLeases: reusableExistingLeases,
        });
      }
      const reusableProviderLeaseId =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? findReusableSandboxLeaseId({ config: parsed.config, leases: reusableExistingLeases })
        : null;
      const reusableLease = reusableProviderLeaseId
        ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
        : null;

      let providerLease;
      try {
        providerLease = await acquireSandboxProviderLease({
          config: parsed.config,
          environmentId: input.environment.id,
          heartbeatRunId: input.heartbeatRunId ?? randomUUID(),
          issueId: input.issueId,
          agentId: input.agentId,
          executionWorkspaceId: input.executionWorkspaceId,
          reusableProviderLeaseId,
        });
      } catch (error) {
        if (reusableLease) {
          await destroyReusableSandboxLease({
            environment: input.environment,
            lease: reusableLease,
            failureReason: "resume_failed",
          });
        }
        throw error;
      }
      if (reusableLease && providerLease.providerLeaseId !== reusableLease.providerLeaseId) {
        await destroyReusableSandboxLease({
          environment: input.environment,
          lease: reusableLease,
          failureReason: "resume_failed",
        });
      }

      // Same ephemeral-policy-for-tests guard as the plugin-backed path:
      // ad-hoc test leases must not be publishable for reuse.
      const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
        ? "reuse_by_environment"
        : "ephemeral";
      const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
        ? buildReusableSandboxLeaseScope({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            agentId: input.agentId,
            adapterType: input.adapterType,
            provider: parsed.config.provider,
            config: providerConfigForLease,
            leaseFingerprint,
            providerMetadata: providerLease.metadata,
          })
        : null;

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: resolvedLeasePolicy,
        provider: parsed.config.provider,
        providerLeaseId: providerLease.providerLeaseId,
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          ...providerLease.metadata,
          ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
        },
      });
    },

    async releaseRunLease(input) {
      if (input.status === "expired" && input.lease.leasePolicy === "reuse_by_environment") {
        return await destroyReusableSandboxLease({
          environment: input.environment,
          lease: input.lease,
          failureReason: "lease_expired",
        });
      }

      // Check if this lease was acquired through a plugin.
      if (input.lease.metadata?.sandboxProviderPlugin) {
        return await releasePluginBackedSandboxLease(input);
      }

      const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);

      // If no built-in provider handles this metadata, try plugin path.
      if (!metadataConfig) {
        const looseConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
        if (looseConfig && !isBuiltinSandboxProvider(looseConfig.provider)) {
          return await releasePluginBackedSandboxLease(input);
        }
      }

      const parsed = metadataConfig
        ? await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
            id: input.environment.id,
            driver: "sandbox",
            config: metadataConfig as unknown as Record<string, unknown>,
          })
        : await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment);
      if (parsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for lease "${input.lease.id}".`);
      }

      let cleanupStatus: "success" | "failed" = "success";
      try {
        await releaseSandboxProviderLease({
          config: parsed.config,
          providerLeaseId: input.lease.providerLeaseId,
          status: input.status,
        });
      } catch {
        cleanupStatus = "failed";
      }
      const releaseStatus = input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? "retained" as const
        : input.status;
      return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
        failureReason: input.status === "failed" ? "adapter_or_run_failure" : undefined,
        cleanupStatus,
      });
    },

    async realizeWorkspace(input) {
      // Plugin-backed sandbox providers: delegate workspace realization.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey =
          readString(input.lease.metadata?.provider) ??
          (input.environment.driver === "sandbox"
            ? (parseEnvironmentDriverConfig(input.environment).config as SandboxEnvironmentConfig).provider
            : null);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          return await pluginWorkerManager.call(pluginId, "environmentRealizeWorkspace", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            workspace: input.workspace,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
        }
      }

      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },

    async execute(input) {
      // Plugin-backed sandbox providers: delegate command execution.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey = readString(input.lease.metadata?.provider);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const sanitizedConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
          return await pluginWorkerManager.call(pluginId, "environmentExecute", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: sanitizedConfig,
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
          }, resolvePluginExecuteRpcTimeoutMs({
            requestedTimeoutMs: input.timeoutMs,
            config: sanitizedConfig,
          }));
        }
      }
      throw new Error("Sandbox driver does not support direct command execution for built-in providers.");
    },

    async destroyRunLease(input) {
      return await destroyReusableSandboxLease({
        environment: input.environment,
        lease: input.lease,
        failureReason: input.failureReason ?? "lease_destroyed",
      });
    },
  };

  async function releasePluginBackedSandboxLease(
    input: EnvironmentDriverReleaseInput,
  ): Promise<EnvironmentLease | null> {
    const metadata = input.lease.metadata ?? {};
    const pluginId = readString(metadata.pluginId);
    const providerKey = readString(metadata.provider);

    let cleanupStatus: "success" | "failed" = "success";
    if (pluginId && providerKey && pluginWorkerManager?.isRunning(pluginId)) {
      try {
        const config = await resolvePluginSandboxRuntimeConfig({
          environment: input.environment,
          lease: input.lease,
          provider: providerKey,
        });
        await pluginWorkerManager.call(pluginId, "environmentReleaseLease", {
          driverKey: providerKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
          providerLeaseId: input.lease.providerLeaseId,
          leaseMetadata: metadata,
        }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
      } catch {
        cleanupStatus = "failed";
      }
    } else {
      cleanupStatus = "failed";
    }

    const releaseStatus =
      input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? ("retained" as const)
        : input.status;
    return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
      failureReason: input.status === "failed" ? "adapter_or_run_failure" : undefined,
      cleanupStatus,
    });
  }

  async function destroyReusableSandboxLease(input: {
    environment: Environment;
    lease: EnvironmentLease;
    failureReason: string;
  }): Promise<EnvironmentLease | null> {
    let cleanupStatus: "success" | "failed" = "success";
    const metadata = input.lease.metadata ?? {};

    try {
      if (metadata.sandboxProviderPlugin) {
        const pluginId = readString(metadata.pluginId);
        const providerKey = readString(metadata.provider);
        if (!pluginId || !providerKey || !pluginWorkerManager?.isRunning(pluginId)) {
          cleanupStatus = "failed";
        } else {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          await pluginWorkerManager.call(pluginId, "environmentDestroyLease", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            providerLeaseId: input.lease.providerLeaseId,
            leaseMetadata: metadata,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
        }
      } else {
        const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);
        const parsed = metadataConfig
          ? await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
              id: input.environment.id,
              driver: "sandbox",
              config: metadataConfig as unknown as Record<string, unknown>,
            })
          : await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment);
        if (parsed.driver !== "sandbox") {
          cleanupStatus = "failed";
        } else {
          await destroySandboxProviderLease({
            config: parsed.config,
            providerLeaseId: input.lease.providerLeaseId,
          });
        }
      }
    } catch {
      cleanupStatus = "failed";
    }

    return await environmentsSvc.releaseLease(
      input.lease.id,
      cleanupStatus === "success" ? "expired" : "pending_cleanup",
      {
        failureReason: input.failureReason,
        cleanupStatus,
      },
    );
  }
}

function parseExpiresAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pluginDriverProviderKey(config: PluginEnvironmentConfig): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS = new Set([
  "driver",
  "executionWorkspaceMode",
  "pluginId",
  "pluginKey",
  "providerMetadata",
  "shellCommand",
  "sandboxProviderPlugin",
]);

function sanitizePluginSandboxConfigFromLeaseMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sandboxConfigForLeaseMetadata(config: SandboxEnvironmentConfig): Record<string, unknown> {
  return { ...config };
}

function tryParseCurrentPluginConfig(environment: Environment): PluginEnvironmentConfig | null {
  if (environment.driver !== "plugin") {
    return null;
  }
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    return parsed.driver === "plugin" ? parsed.config : null;
  } catch {
    return null;
  }
}

function createPluginEnvironmentDriver(
  db: Db,
  workerManager: PluginWorkerManager,
): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);
  const pluginRegistry = pluginRegistryService(db);

  async function resolvePluginDriver(config: PluginEnvironmentConfig) {
    const plugin = await pluginRegistry.getByKey(config.pluginKey);
    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" is not ready.`);
    }
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === config.driverKey,
    );
    if (!driver) {
      throw new Error(`Plugin "${config.pluginKey}" does not declare environment driver "${config.driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" has no running worker.`);
    }
    return { plugin };
  }

  async function resolvePluginDriverForRelease(input: EnvironmentDriverReleaseInput) {
    const metadata = input.lease.metadata ?? {};
    const metadataPluginId = readString(metadata.pluginId);
    const metadataPluginKey = readString(metadata.pluginKey);
    const metadataDriverKey = readString(metadata.driverKey);
    const currentConfig = tryParseCurrentPluginConfig(input.environment);

    if (!metadataPluginId && !metadataPluginKey && !metadataDriverKey) {
      if (!currentConfig) {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(currentConfig);
      return {
        plugin,
        pluginKey: currentConfig.pluginKey,
        driverKey: currentConfig.driverKey,
        driverConfig: currentConfig.driverConfig,
      };
    }

    const plugin = metadataPluginId
      ? await pluginRegistry.getById(metadataPluginId)
      : metadataPluginKey
        ? await pluginRegistry.getByKey(metadataPluginKey)
        : currentConfig
          ? await pluginRegistry.getByKey(currentConfig.pluginKey)
          : null;
    const driverKey = metadataDriverKey ?? currentConfig?.driverKey;
    const pluginKey = metadataPluginKey ?? plugin?.pluginKey ?? currentConfig?.pluginKey ?? "unknown";

    if (!driverKey) {
      throw new Error(`Plugin environment driver "${pluginKey}:unknown" is missing a driver key.`);
    }

    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginKey}:${driverKey}" is not ready.`);
    }
    const declaredDriver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === driverKey,
    );
    if (!declaredDriver) {
      throw new Error(`Plugin "${plugin.pluginKey}" does not declare environment driver "${driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${plugin.pluginKey}:${driverKey}" has no running worker.`);
    }

    const currentConfigStillMatches =
      currentConfig?.pluginKey === plugin.pluginKey && currentConfig.driverKey === driverKey;

    return {
      plugin,
      pluginKey: plugin.pluginKey,
      driverKey,
      driverConfig: currentConfigStillMatches ? currentConfig.driverConfig : {},
    };
  }

  return {
    driver: "plugin",

    async acquireRunLease(input) {
      const parsed = parseEnvironmentDriverConfig(input.environment);
      if (parsed.driver !== "plugin") {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(parsed.config);
      const providerLease = await workerManager.call(plugin.id, "environmentAcquireLease", {
        driverKey: parsed.config.driverKey,
        companyId: input.companyId,
        environmentId: input.environment.id,
        issueId: input.issueId,
        config: parsed.config.driverConfig,
        runId: input.heartbeatRunId ?? randomUUID(),
        workspaceMode: input.executionWorkspaceMode ?? undefined,
        agentId: input.agentId ?? undefined,
        executionWorkspaceId: input.executionWorkspaceId ?? undefined,
        adapterType: input.adapterType ?? undefined,
      });

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: `plugin:${parsed.config.pluginKey}:${parsed.config.driverKey}`,
        providerLeaseId: providerLease.providerLeaseId,
        expiresAt: parseExpiresAt(providerLease.expiresAt),
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          providerMetadata: providerLease.metadata ?? {},
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: plugin.id,
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      });
    },

    async releaseRunLease(input) {
      const { plugin, driverKey, driverConfig } = await resolvePluginDriverForRelease(input);
      await workerManager.call(plugin.id, "environmentReleaseLease", {
        driverKey,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: driverConfig,
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async resumeRunLease(input) {
      if (!input.lease.providerLeaseId) {
        throw new Error(`Plugin environment lease "${input.lease.id}" does not have a provider lease id to resume.`);
      }
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "released",
      });
      return await resumePluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
    },

    async destroyRunLease(input) {
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "failed",
      });
      await destroyPluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, "expired", {
        failureReason: input.failureReason ?? "lease_destroyed",
        cleanupStatus: "success",
      });
    },

    async realizeWorkspace(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await realizePluginEnvironmentWorkspace({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          workspace: input.workspace,
        },
      });
    },

    async execute(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await executePluginEnvironmentCommand({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          stdin: input.stdin,
          timeoutMs: input.timeoutMs,
        },
      });
    },
  };
}

export function environmentRuntimeService(
  db: Db,
  options: {
    drivers?: EnvironmentRuntimeDriver[];
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const drivers = new Map<string, EnvironmentRuntimeDriver>();

  const defaultDrivers = [
    createLocalEnvironmentDriver(db),
    createSshEnvironmentDriver(db),
    createSandboxEnvironmentDriver(db, {
      pluginWorkerManager: options.pluginWorkerManager,
      pluginWorkerReadyTimeoutMs: options.pluginWorkerReadyTimeoutMs,
      pluginWorkerReadyPollMs: options.pluginWorkerReadyPollMs,
    }),
    ...(options.pluginWorkerManager
      ? [createPluginEnvironmentDriver(db, options.pluginWorkerManager)]
      : []),
  ];

  for (const driver of options.drivers ?? defaultDrivers) {
    drivers.set(driver.driver, driver);
  }

  function getDriver(driverKey: string): EnvironmentRuntimeDriver | null {
    return drivers.get(driverKey) ?? null;
  }

  function requireDriver(environment: Pick<Environment, "driver">): EnvironmentRuntimeDriver {
    const driver = getDriver(environment.driver);
    if (!driver) {
      throw new Error(
        `Environment driver "${environment.driver}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  function requireDriverKey(driverKey: string): EnvironmentRuntimeDriver {
    const driver = getDriver(driverKey);
    if (!driver) {
      throw new Error(
        `Environment driver "${driverKey}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  async function loadPersistedLeaseForActiveOperation(
    input: EnvironmentDriverLeaseInput,
    operation: string,
    allowedStatuses: ReadonlySet<EnvironmentLease["status"]>,
  ): Promise<{ environment: Environment; lease: EnvironmentLease }> {
    assertLeaseEnvironmentBinding(input);
    const persisted = assertPersistedLeaseMatchesDriverOrCaller({
      supplied: input.lease,
      persisted: await environmentsSvc.getLeaseById(input.lease.id),
      operation,
    });
    if (!allowedStatuses.has(persisted.status)) {
      throw conflict(`Environment lease cannot be used for ${operation} while ${persisted.status}`, {
        code: "environment_lease_not_active",
        leaseId: persisted.id,
        leaseStatus: persisted.status,
        operation,
      });
    }
    await assertLeaseOwnerActive(db, { companyId: persisted.companyId, lease: persisted });
    const environment = await environmentsSvc.getById(persisted.environmentId);
    if (!environment) {
      throw conflict(`Environment ${persisted.environmentId} no longer exists`, {
        code: "environment_lease_binding_mismatch",
        leaseId: persisted.id,
        environmentId: persisted.environmentId,
      });
    }
    if (environment.status !== "active") {
      throw conflict(`Environment ${environment.id} is not active`, {
        code: "environment_lease_binding_mismatch",
        leaseId: persisted.id,
        environmentId: environment.id,
        environmentStatus: environment.status,
      });
    }
    return { environment, lease: persisted };
  }

  async function quarantineUnprovenLeaseDestruction(input: {
    lease: EnvironmentLease;
    failureReason: string;
  }): Promise<EnvironmentLease | null> {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const currentRow = await txDb
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, input.lease.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const current = currentRow ? toEnvironmentLeaseSnapshot(currentRow) : null;
      if (!current || !leaseIdentityMatches(input.lease, current, leaseResourceIdentity)) {
        return null;
      }

      const now = new Date();
      await txDb
        .update(environmentLeases)
        .set({
          status: "pending_cleanup",
          cleanupStatus: "failed",
          failureReason: input.failureReason,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(environmentLeases.id, input.lease.id));
      const quarantinedRow = await txDb
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, input.lease.id))
        .then((rows) => rows[0] ?? null);
      const quarantined = quarantinedRow ? toEnvironmentLeaseSnapshot(quarantinedRow) : null;
      return quarantined &&
        leaseIdentityMatches(input.lease, quarantined, leaseResourceIdentity) &&
        quarantined.status === "pending_cleanup" &&
        quarantined.cleanupStatus === "failed"
        ? quarantined
        : null;
    });
  }

  async function destroyLeaseWithDurableProof(input: {
    lease: EnvironmentLease;
    failureReason: string;
    destroy: () => Promise<EnvironmentLease | null | void>;
  }): Promise<{
    lease: EnvironmentLease | null;
    destroyed: boolean;
    failureMessage: string | null;
  }> {
    let failureMessage: string | null = null;
    try {
      await input.destroy();
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }

    const persisted = await environmentsSvc.getLeaseById(input.lease.id).catch(() => null);
    if (
      persisted &&
      leaseIdentityMatches(input.lease, persisted, leaseResourceIdentity) &&
      persisted.status === "expired" &&
      persisted.cleanupStatus === "success"
    ) {
      return { lease: persisted, destroyed: true, failureMessage: null };
    }

    failureMessage ??= persisted
      ? "Environment driver did not durably persist exact lease destruction"
      : "Environment lease disappeared before destruction could be durably proven";
    const quarantined = await quarantineUnprovenLeaseDestruction({
      lease: input.lease,
      failureReason: input.failureReason,
    }).catch((error) => {
      const quarantineMessage = error instanceof Error ? error.message : String(error);
      failureMessage = `${failureMessage}; cleanup quarantine failed: ${quarantineMessage}`;
      return null;
    });
    if (!quarantined) {
      failureMessage = `${failureMessage}; cleanup quarantine was not durably persisted for the exact resource identity`;
    }
    return { lease: quarantined, destroyed: false, failureMessage };
  }

  const runtime = {
    getDriver,

    async acquireRunLease(input: {
      companyId: string;
      environment: Environment;
      issueId: string | null;
      agentId?: string | null;
      /** Null for ad-hoc invocations (e.g. operator-initiated `Test` probes). */
      heartbeatRunId: string | null;
      persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
      /** The agent's adapter type for this run (mixed-harness environments). */
      adapterType?: string | null;
      /**
       * Force applying the active custom-image template even for ad-hoc (no
       * issue/run) invocations. Operator `Test` probes set this so the runtime
       * lease uses the operator-prepared custom image.
       */
      applyCustomImageTemplate?: boolean;
    }): Promise<EnvironmentRuntimeLeaseRecord> {
      const directOwnerId = normalizeLeaseOwnerAgentId(input.agentId ?? null);
      const runOwners = input.heartbeatRunId
        ? await resolveHeartbeatRunOwners(db, [input.heartbeatRunId])
        : new Map<string, { agentId: string; companyId: string }>();
      const runOwnerId = input.heartbeatRunId
        ? runOwners.get(input.heartbeatRunId)?.agentId ?? null
        : null;
      const requestedOwnerId = directOwnerId ?? runOwnerId;

      const environment = await environmentsSvc.getById(input.environment.id);
      if (!environment || environment.status !== "active") {
        throw new Error(`Environment "${input.environment.name}" is not active.`);
      }
      await assertLeaseOwnerActive(db, {
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        heartbeatRunId: input.heartbeatRunId,
      });

      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const driver = requireDriver(environment);
      const lease = await driver.acquireRunLease({
        companyId: input.companyId,
        environment,
        issueId: input.issueId,
        agentId: input.agentId ?? null,
        heartbeatRunId: input.heartbeatRunId,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        executionWorkspaceMode: leaseContext.executionWorkspaceMode,
        adapterType: input.adapterType ?? null,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });

      try {
        if (
          lease.companyId !== input.companyId ||
          lease.environmentId !== environment.id ||
          lease.heartbeatRunId !== input.heartbeatRunId ||
          lease.executionWorkspaceId !== leaseContext.executionWorkspaceId ||
          lease.issueId !== input.issueId ||
          lease.status !== "active"
        ) {
          throw conflict("Environment driver returned a lease outside the requested binding", {
            code: "environment_lease_binding_mismatch",
            leaseId: lease.id,
          });
        }
        if (lease.leasePolicy === "reuse_by_environment" && !requestedOwnerId) {
          throw conflict("Reusable environment driver output has no lifecycle-fenced owner", {
            code: "agent_environment_lease_owner_invalid",
            leaseId: lease.id,
          });
        }
        const persisted = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const row = await txDb
            .select()
            .from(environmentLeases)
            .where(eq(environmentLeases.id, lease.id))
            .for("update")
            .then((rows) => rows[0] ?? null);
          const snapshot = assertPersistedLeaseMatchesDriverOrCaller({
            supplied: lease,
            persisted: row ? toEnvironmentLeaseSnapshot(row) : null,
            operation: "acquire",
          });
          await assertLeaseOwnerActive(txDb, {
            companyId: snapshot.companyId,
            agentId: input.agentId ?? null,
            heartbeatRunId: snapshot.heartbeatRunId,
            lease: snapshot,
            lockOwnersForUpdate: true,
          });
          return snapshot;
        });
        return {
          environment,
          lease: persisted,
          leaseContext,
        };
      } catch (error) {
        let cleanupError: Error | null = null;
        const persistedBeforeCleanup = await environmentsSvc.getLeaseById(lease.id).catch(() => null);
        const correlationMatches = Boolean(
          persistedBeforeCleanup &&
          leaseIdentityMatches(lease, persistedBeforeCleanup, leaseCorrelationIdentity),
        );
        const criticalIdentityMatches = Boolean(
          persistedBeforeCleanup &&
          leaseIdentityMatches(lease, persistedBeforeCleanup, criticalLeasePersistenceIdentity),
        );
        // A row that merely shares correlation fields is not enough: a driver
        // may release persistence by id before targeting the returned provider
        // resource. Reuse the durable id only for an exact critical identity;
        // otherwise isolate provider cleanup behind a synthetic id and
        // quarantine the correlated row ourselves below.
        const cleanupLease = criticalIdentityMatches ? lease : { ...lease, id: randomUUID() };
        try {
          if (driver.destroyRunLease) {
            await driver.destroyRunLease({
              environment,
              lease: cleanupLease,
              failureReason: "rejected_environment_driver_output",
            });
          }
        } catch (destroyError) {
          cleanupError = destroyError instanceof Error
            ? destroyError
            : new Error(String(destroyError));
        }

        const originalError = error instanceof Error ? error : new Error(String(error));
        if (!correlationMatches || !persistedBeforeCleanup) {
          throw new AggregateError(
            cleanupError ? [originalError, cleanupError] : [originalError],
            `Rejected environment lease ${lease.id} is not correlated with a persisted row; persisted state was left untouched`,
          );
        }

        let durableLease = await environmentsSvc.getLeaseById(lease.id).catch(() => null);
        const destructionDurablyProven =
          criticalIdentityMatches &&
          durableLease !== null &&
          leaseIdentityMatches(lease, durableLease, leaseResourceIdentity) &&
          durableLease.status === "expired" &&
          durableLease.cleanupStatus === "success";
        if (!destructionDurablyProven) {
          const quarantined = await environmentsSvc.releaseLease(lease.id, "pending_cleanup", {
            failureReason: "rejected_environment_driver_output",
            cleanupStatus: "failed",
          }).catch((quarantineError) => {
            cleanupError = quarantineError instanceof Error
              ? quarantineError
              : new Error(String(quarantineError));
            return null;
          });
          durableLease = quarantined ?? await environmentsSvc.getLeaseById(lease.id).catch(() => null);
          const quarantineDurable =
            durableLease !== null &&
            leaseIdentityMatches(persistedBeforeCleanup, durableLease, leaseResourceIdentity) &&
            durableLease.status === "pending_cleanup" &&
            durableLease.cleanupStatus === "failed";
          if (!quarantineDurable) {
            throw new AggregateError(
              cleanupError ? [originalError, cleanupError] : [originalError],
              `Rejected environment lease ${lease.id} could not be durably quarantined`,
            );
          }
        }
        throw error;
      }
    },

    async reconcileEnvironmentLeasesOnStartup(): Promise<{
      reconciled: number;
      destroyed: number;
      failed: number;
      failures: Array<{ leaseId: string; message: string }>;
    }> {
      let destroyed = 0;
      const failures: Array<{ leaseId: string; message: string }> = [];
      const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
      const leaseRows = await db.select().from(environmentLeases);
      const allLeaseSnapshots = leaseRows
        .map(toEnvironmentLeaseSnapshot)
        .filter((lease) => !(lease.status === "expired" && lease.cleanupStatus === "success"));
      const unsafeOwnerLeaseIds = await resolveTerminatedOwnerLeaseIds(db, allLeaseSnapshots);
      const unsafeOwnerCandidates = allLeaseSnapshots.filter((lease) =>
        unsafeOwnerLeaseIds.has(lease.id)
      );
      const unsafeOwnerAttemptedLeaseIds = new Set(
        unsafeOwnerCandidates.map((lease) => lease.id),
      );

      const reconcileDestroyedLease = async (input: {
        lease: EnvironmentLease;
        driverFailureReason: string;
        quarantineFailureReason: string;
        logMessage: string;
      }) => {
        const environment = await environmentsSvc.getById(input.lease.environmentId);
        const outcome = await destroyLeaseWithDurableProof({
          lease: input.lease,
          failureReason: input.quarantineFailureReason,
          destroy: async () => {
            if (!environment) {
              throw new Error(`Environment ${input.lease.environmentId} is missing`);
            }
            const driverKey = getLeaseDriverKey(input.lease, environment);
            const driver = getDriver(driverKey);
            if (!driver?.destroyRunLease) {
              throw new Error(`Environment driver ${driverKey} cannot destroy leases`);
            }
            return await driver.destroyRunLease({
              environment,
              lease: input.lease,
              failureReason: input.driverFailureReason,
            });
          },
        });
        if (outcome.destroyed) {
          destroyed += 1;
          return;
        }
        const failureMessage = outcome.failureMessage ??
          "Environment lease destruction was not durably proven";
        failures.push({ leaseId: input.lease.id, message: failureMessage });
        logger.error(
          { leaseId: input.lease.id, environmentId: input.lease.environmentId, err: failureMessage },
          input.logMessage,
        );
      };

      for (const lease of unsafeOwnerCandidates) {
        const reusable = lease.leasePolicy === "reuse_by_environment";
        await reconcileDestroyedLease({
          lease,
          driverFailureReason: reusable
            ? "reusable_environment_lease_reconciliation"
            : "unsafe_environment_lease_owner_reconciliation",
          quarantineFailureReason: reusable
            ? "reusable_environment_lease_cleanup_failed"
            : "unsafe_environment_lease_owner_cleanup_failed",
          logMessage: "failed to reconcile environment lease with an unsafe owner during startup",
        });
      }

      const activeLeaseSnapshots = allLeaseSnapshots.filter((lease) => lease.status === "active");
      const activeRunIds = [...new Set(
        activeLeaseSnapshots.flatMap((lease) => lease.heartbeatRunId ? [lease.heartbeatRunId] : []),
      )];
      const activeRunRows = activeRunIds.length > 0
        ? await db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, activeRunIds))
        : [];
      const terminalRunStatusById = new Map(
        activeRunRows
          .filter((run) => terminalRunStatuses.has(run.status))
          .map((run) => [run.id, run.status] as const),
      );
      const terminalRunLeaseCandidates = activeLeaseSnapshots.filter((lease) =>
        lease.heartbeatRunId !== null &&
        terminalRunStatusById.has(lease.heartbeatRunId) &&
        !unsafeOwnerAttemptedLeaseIds.has(lease.id)
      );
      const terminalRunAttemptedLeaseIds = new Set(
        terminalRunLeaseCandidates.map((lease) => lease.id),
      );

      for (const lease of terminalRunLeaseCandidates) {
        const runStatus = terminalRunStatusById.get(lease.heartbeatRunId!)!;
        const releaseStatus: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> =
          runStatus === "cancelled"
            ? "expired"
            : runStatus === "failed" || runStatus === "timed_out"
              ? "failed"
              : "released";
        const expectedStatus =
          lease.leasePolicy === "retain_on_failure" && releaseStatus === "failed"
            ? "retained"
            : releaseStatus;
        let failureMessage: string | null = null;
        try {
          const environment = await environmentsSvc.getById(lease.environmentId);
          const driver = environment ? getDriver(getLeaseDriverKey(lease, environment)) : null;
          if (!environment) {
            failureMessage = `Environment ${lease.environmentId} is missing`;
          } else if (!driver) {
            failureMessage = `Environment driver ${getLeaseDriverKey(lease, environment)} is unavailable`;
          } else {
            const released = await driver.releaseRunLease({
              environment,
              lease,
              status: releaseStatus,
            });
            const persisted = await environmentsSvc.getLeaseById(lease.id);
            if (
              !released ||
              !persisted ||
              !leaseIdentityMatches(lease, persisted, leaseResourceIdentity) ||
              persisted.status !== expectedStatus ||
              persisted.cleanupStatus === "failed"
            ) {
              failureMessage = "Environment driver did not durably finalize the terminal-run lease";
            }
          }
        } catch (error) {
          failureMessage = error instanceof Error ? error.message : String(error);
        }

        if (failureMessage) {
          const pending = await quarantineUnprovenLeaseDestruction({
            lease,
            failureReason: "terminal_run_lease_cleanup_failed",
          });
          if (!pending) {
            failureMessage = `${failureMessage}; failed to durably persist exact cleanup quarantine`;
          }
          failures.push({ leaseId: lease.id, message: failureMessage });
          logger.error(
            { leaseId: lease.id, heartbeatRunId: lease.heartbeatRunId, err: failureMessage },
            "failed to finalize environment lease for terminal heartbeat run during startup reconciliation",
          );
          continue;
        }
        destroyed += 1;
      }

      const reusableLeaseSnapshots = allLeaseSnapshots.filter((lease) =>
        lease.leasePolicy === "reuse_by_environment"
      );
      const reusableLiveStatuses = new Set<EnvironmentLease["status"]>([
        "active",
        "released",
        "retained",
      ]);
      const reusableCandidates = reusableLeaseSnapshots.filter((lease) => {
        if (
          unsafeOwnerAttemptedLeaseIds.has(lease.id) ||
          terminalRunAttemptedLeaseIds.has(lease.id)
        ) return false;
        const liveStateIsIntended =
          reusableLiveStatuses.has(lease.status) &&
          (lease.cleanupStatus === null || lease.cleanupStatus === "success");
        return !liveStateIsIntended;
      });
      for (const lease of reusableCandidates) {
        await reconcileDestroyedLease({
          lease,
          driverFailureReason: "reusable_environment_lease_reconciliation",
          quarantineFailureReason: "reusable_environment_lease_cleanup_failed",
          logMessage: "failed to reconcile reusable environment lease during startup",
        });
      }

      return {
        reconciled:
          unsafeOwnerCandidates.length +
          terminalRunLeaseCandidates.length +
          reusableCandidates.length,
        destroyed,
        failed: failures.length,
        failures,
      };
    },

    async releaseRunLeases(
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            inArray(environmentLeases.status, ["active"]),
          ),
        );
      if (leaseRows.length === 0) {
        return [];
      }

      const released: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of leaseRows) {
        const environment = await environmentsSvc.getById(leaseRow.environmentId);
        if (!environment) continue;

        const leaseSnapshot = toEnvironmentLeaseSnapshot(leaseRow);
        const driver = getDriver(getLeaseDriverKey(leaseSnapshot, environment));
        const lease = driver
          ? await driver.releaseRunLease({
              environment,
              lease: leaseSnapshot,
              status,
            })
          : await environmentsSvc.releaseLease(leaseRow.id, status);
        if (!lease) continue;

        released.push({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: lease.executionWorkspaceId,
            executionWorkspaceMode:
              (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
          },
        });
      }

      return released;
    },

    async destroyReusableSandboxLeases(input: {
      companyId: string;
      issueId?: string | null;
      executionWorkspaceId?: string | null;
      failureReason?: string;
    }): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const scopeConditions = [
        input.issueId ? eq(environmentLeases.issueId, input.issueId) : undefined,
        input.executionWorkspaceId ? eq(environmentLeases.executionWorkspaceId, input.executionWorkspaceId) : undefined,
      ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
      if (scopeConditions.length === 0) return [];

      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.leasePolicy, "reuse_by_environment"),
            ...scopeConditions,
          ),
        );
      const cleanupRows = leaseRows.filter((row) =>
        !(row.status === "expired" && row.cleanupStatus === "success")
      );

      const destroyed: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of cleanupRows) {
        const leaseSnapshot = toEnvironmentLeaseSnapshot(leaseRow);
        const environment = await environmentsSvc.getById(leaseRow.environmentId);
        const failureReason = input.failureReason ?? "reusable_lease_destroyed";
        const outcome = await destroyLeaseWithDurableProof({
          lease: leaseSnapshot,
          failureReason,
          destroy: async () => {
            if (!environment) {
              throw new Error(`Environment ${leaseSnapshot.environmentId} is missing`);
            }
            const driverKey = getLeaseDriverKey(leaseSnapshot, environment);
            const driver = getDriver(driverKey);
            if (!driver?.destroyRunLease) {
              throw new Error(`Environment driver ${driverKey} cannot destroy leases`);
            }
            return await driver.destroyRunLease({
              environment,
              lease: leaseSnapshot,
              failureReason,
            });
          },
        });
        if (!outcome.lease) {
          throw new Error(
            `Reusable lease ${leaseSnapshot.id} could not be destroyed or durably quarantined: ${outcome.failureMessage}`,
          );
        }
        if (!environment) {
          throw new Error(
            `Reusable lease ${leaseSnapshot.id} was quarantined because environment ${leaseSnapshot.environmentId} is missing`,
          );
        }
        const lease = outcome.lease;
        destroyed.push({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: lease.executionWorkspaceId,
            executionWorkspaceMode:
              (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
          },
        });
      }
      return destroyed;
    },

    async resumeRunLease(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null> {
      const current = await loadPersistedLeaseForActiveOperation(
        input,
        "resume",
        new Set(["active", "released", "retained"]),
      );
      const driver = requireDriverKey(getLeaseDriverKey(current.lease, current.environment));
      if (!driver.resumeRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease resume.`);
      }
      return await driver.resumeRunLease({ ...input, ...current });
    },

    async destroyRunLease(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null> {
      assertLeaseEnvironmentBinding(input);
      const persisted = await environmentsSvc.getLeaseById(input.lease.id);
      if (
        !persisted ||
        !leaseIdentityMatches(input.lease, persisted, leaseResourceIdentity)
      ) {
        throw conflict("Environment lease cleanup input does not match persisted resource identity", {
          code: "environment_lease_persistence_mismatch",
          leaseId: input.lease.id,
          operation: "destroy",
        });
      }
      if (persisted.status === "expired" && persisted.cleanupStatus === "success") {
        return persisted;
      }
      const environment = await environmentsSvc.getById(persisted.environmentId);
      const outcome = await destroyLeaseWithDurableProof({
        lease: persisted,
        failureReason: input.failureReason ?? "lease_destroy_cleanup_failed",
        destroy: async () => {
          if (!environment) {
            throw new Error(`Environment "${persisted.environmentId}" no longer exists.`);
          }
          const driverKey = getLeaseDriverKey(persisted, environment);
          const driver = getDriver(driverKey);
          if (!driver?.destroyRunLease) {
            throw new Error(`Environment driver "${driverKey}" does not support lease destroy.`);
          }
          return await driver.destroyRunLease({ ...input, environment, lease: persisted });
        },
      });
      if (!outcome.lease) {
        throw conflict("Environment lease cleanup changed or removed persisted resource identity", {
          code: "environment_lease_persistence_mismatch",
          leaseId: persisted.id,
          operation: "destroy",
          failureMessage: outcome.failureMessage,
        });
      }
      return outcome.lease;
    },

    async realizeWorkspace(
      input: EnvironmentDriverRealizeWorkspaceInput,
    ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const current = await loadPersistedLeaseForActiveOperation(
        input,
        "workspace realization",
        new Set(["active"]),
      );
      const driver = requireDriverKey(getLeaseDriverKey(current.lease, current.environment));
      if (!driver.realizeWorkspace) {
        throw new Error(`Environment driver "${driver.driver}" does not support workspace realization.`);
      }
      return await driver.realizeWorkspace({ ...input, ...current });
    },

    async execute(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult> {
      const current = await loadPersistedLeaseForActiveOperation(
        input,
        "command execution",
        new Set(["active"]),
      );
      const driver = requireDriverKey(getLeaseDriverKey(current.lease, current.environment));
      if (!driver.execute) {
        throw new Error(`Environment driver "${driver.driver}" does not support command execution.`);
      }
      return await driver.execute({ ...input, ...current });
    },
  };
  return {
    ...runtime,
    reconcileTerminatedAgentLeasesOnStartup: runtime.reconcileEnvironmentLeasesOnStartup,
  };
}

export type EnvironmentRuntimeService = ReturnType<typeof environmentRuntimeService>;

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretBindings, companySecrets } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  createLocalEncryptedProofReceipt,
  getLocalEncryptedMasterKeyProof,
} from "../secrets/local-encrypted-provider.js";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { secretService } from "./secrets.js";
import { assertHistoricalAgentTombstoneMutable } from "./agent-retirement-historical-tombstones.js";
import {
  canonicalizeAgentReferenceId,
  lockAgentLifecycleReference,
} from "./agent-lifecycle-fence.js";

const OPENCLAW_ADAPTER_TYPE = "openclaw_gateway";
const OPENCLAW_SECRET_PATHS = [
  "authToken",
  "devicePrivateKeyPem",
  "deviceToken",
  "password",
  "token",
] as const;
const FINGERPRINT_PATTERN = /^v1:hmac-sha256:[a-f0-9]{64}$/;
const SENSITIVE_HEADER_NAMES = new Set([
  "x-openclaw-token",
  "x-openclaw-auth",
  "authorization",
]);

export interface AdapterSecretExternalizationRequest {
  schemaVersion: "1.0.0";
  expectedCompanyId: string;
  expectedAdapterType: "openclaw_gateway";
  expectedConfigFingerprint: string;
  expectedPreflightReceipt: string;
}

export interface AdapterSecretExternalizationPreflight {
  schemaVersion: "1.0.0";
  agentId: string;
  companyId: string;
  adapterType: "openclaw_gateway";
  configFingerprint: string;
  masterKeyFingerprintSha256: string;
  receipt: string;
}

export interface AdapterSecretExternalizationProof {
  schemaVersion: "1.0.0";
  agentId: string;
  companyId: string;
  adapterType: "openclaw_gateway";
  configFingerprint: string;
  provider: "local_encrypted";
  secretRefCount: number;
  secretRefPaths: string[];
  secretIds: string[];
  bindingCount: number;
  bindingIds: string[];
  runtimeResolvedCount: number;
  runtimeResolutionHash: string;
  masterKeyFingerprintSha256: string;
  receipt: string;
}

export interface AdapterSecretExternalizationResponse {
  schemaVersion: "1.0.0";
  agentId: string;
  companyId: string;
  createdSecretCount: number;
  createdSecretIds: string[];
  removedHeaderCount: number;
  removedHeaderPaths: string[];
  secretRefCount: number;
  secretRefPaths: string[];
  secretIds: string[];
  configFingerprint: string;
  preflightReceipt: string;
  proof: AdapterSecretExternalizationProof;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (!record) return JSON.stringify(value);
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isNonEmptyPlainBinding(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  const record = asRecord(value);
  return record?.type === "plain" && typeof record.value === "string" && record.value.trim().length > 0;
}

function isConfiguredValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  const record = asRecord(value);
  if (record?.type === "plain" && typeof record.value === "string") {
    return record.value.trim().length > 0;
  }
  return true;
}

function readSecretRef(value: unknown): { secretId: string } | null {
  const record = asRecord(value);
  if (record?.type !== "secret_ref" || typeof record.secretId !== "string") return null;
  return { secretId: record.secretId };
}

function normalizeHeaderToken(headerName: string, value: string): string {
  const trimmed = value.trim();
  if (headerName === "x-openclaw-token") return trimmed;
  const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
  return bearer?.[1]?.trim() ?? trimmed;
}

function configuredPlainValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  if (record?.type === "plain" && typeof record.value === "string") return record.value.trim() || null;
  return null;
}

function moveSensitiveHeaderToAuthToken(adapterConfig: Record<string, unknown>): {
  adapterConfig: Record<string, unknown>;
  removedHeaderPaths: string[];
} {
  const normalized = structuredClone(adapterConfig) as Record<string, unknown>;
  const headers = asRecord(normalized.headers);
  if (!headers) return { adapterConfig: normalized, removedHeaderPaths: [] };

  const sensitiveEntries = Object.entries(headers)
    .map(([key, value]) => ({ key, normalizedKey: key.trim().toLowerCase(), value }))
    .filter((entry) => SENSITIVE_HEADER_NAMES.has(entry.normalizedKey));
  if (sensitiveEntries.length === 0) {
    return { adapterConfig: normalized, removedHeaderPaths: [] };
  }

  const normalizedEntries = sensitiveEntries.map((entry) => {
    if (typeof entry.value !== "string") {
      throw unprocessable("Sensitive OpenClaw gateway header must contain a string", {
        code: "openclaw_gateway_sensitive_header_invalid",
        path: `headers.${entry.normalizedKey}`,
      });
    }
    return { ...entry, token: normalizeHeaderToken(entry.normalizedKey, entry.value) };
  });
  const tokens = [...new Set(normalizedEntries.map((entry) => entry.token).filter(Boolean))];
  if (tokens.length > 1) {
    throw conflict("Multiple sensitive OpenClaw gateway header paths require manual review", {
      code: "openclaw_gateway_sensitive_header_ambiguous",
      paths: normalizedEntries.map((entry) => `headers.${entry.normalizedKey}`).sort(),
    });
  }
  const token = tokens[0] ?? "";
  if (isConfiguredValue(normalized.authToken)) {
    const configured = configuredPlainValue(normalized.authToken);
    if (configured === null || configured !== token) {
      throw conflict("Sensitive OpenClaw gateway header conflicts with top-level authToken", {
        code: "openclaw_gateway_auth_token_conflict",
        paths: [
          "authToken",
          ...normalizedEntries.map((entry) => `headers.${entry.normalizedKey}`),
        ].sort(),
      });
    }
  }

  const nextHeaders = { ...headers };
  for (const entry of normalizedEntries) delete nextHeaders[entry.key];
  if (Object.keys(nextHeaders).length === 0) delete normalized.headers;
  else normalized.headers = nextHeaders;
  if (!isConfiguredValue(normalized.authToken)) {
    if (token) normalized.authToken = token;
    else delete normalized.authToken;
  }

  return {
    adapterConfig: normalized,
    removedHeaderPaths: [...new Set(normalizedEntries
      .map((entry) => `headers.${entry.normalizedKey}`))].sort(),
  };
}

function nextUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

function configFingerprint(agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">) {
  return createLocalEncryptedProofReceipt(`gateway-config:${stableJson({
    schemaVersion: "1.0.0",
    agentId: agent.id,
    companyId: agent.companyId,
    adapterType: agent.adapterType,
    adapterConfig: asRecord(agent.adapterConfig) ?? {},
  })}`);
}

function preflightProjection(
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">,
): AdapterSecretExternalizationPreflight {
  if (agent.adapterType !== OPENCLAW_ADAPTER_TYPE) {
    throw conflict("Agent adapter type does not match the externalization contract", {
      code: "agent_adapter_secret_type_mismatch",
      expectedAdapterType: OPENCLAW_ADAPTER_TYPE,
    });
  }
  const projection = {
    schemaVersion: "1.0.0" as const,
    agentId: agent.id,
    companyId: agent.companyId,
    adapterType: OPENCLAW_ADAPTER_TYPE as "openclaw_gateway",
    configFingerprint: configFingerprint(agent),
    masterKeyFingerprintSha256: getLocalEncryptedMasterKeyProof().fingerprintSha256,
  };
  return {
    ...projection,
    receipt: createLocalEncryptedProofReceipt(`gateway-preflight:${stableJson(projection)}`),
  };
}

async function buildExternalizationProof(
  db: Db,
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">,
): Promise<AdapterSecretExternalizationProof> {
  if (agent.adapterType !== OPENCLAW_ADAPTER_TYPE) {
    throw conflict("Agent adapter type does not match the externalization proof contract", {
      code: "agent_adapter_secret_type_mismatch",
    });
  }
  const adapterConfig = asRecord(agent.adapterConfig) ?? {};
  const moved = moveSensitiveHeaderToAuthToken(adapterConfig);
  if (moved.removedHeaderPaths.length > 0 || stableJson(moved.adapterConfig) !== stableJson(adapterConfig)) {
    throw unprocessable("OpenClaw gateway proof found a remaining sensitive header literal", {
      code: "openclaw_gateway_postproof_literal_detected",
    });
  }
  const refs = OPENCLAW_SECRET_PATHS.map((path) => ({ path, ref: readSecretRef(adapterConfig[path]) }))
    .filter((entry): entry is { path: typeof OPENCLAW_SECRET_PATHS[number]; ref: { secretId: string } } =>
      entry.ref !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const path of OPENCLAW_SECRET_PATHS) {
    if (isConfiguredValue(adapterConfig[path]) && readSecretRef(adapterConfig[path]) === null) {
      throw unprocessable("OpenClaw gateway proof found a remaining credential literal", {
        code: "openclaw_gateway_postproof_literal_detected",
        path,
      });
    }
  }
  const secretIds = [...new Set(refs.map((entry) => entry.ref.secretId))].sort();
  const secretRows = secretIds.length === 0
    ? []
    : await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, agent.companyId),
      inArray(companySecrets.id, secretIds),
    ));
  if (secretRows.length !== secretIds.length || secretRows.some((secret) =>
    secret.provider !== "local_encrypted" || secret.status !== "active" || secret.deletedAt !== null)) {
    throw unprocessable("OpenClaw gateway proof requires active local-encrypted secrets", {
      code: "openclaw_gateway_postproof_provider_invalid",
    });
  }

  const allBindings = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, agent.companyId),
    eq(companySecretBindings.targetType, "agent"),
    eq(companySecretBindings.targetId, agent.id),
  ));
  const refPaths = new Set(refs.map((entry) => entry.path));
  const bindings = allBindings.filter((binding) => refPaths.has(binding.configPath as typeof OPENCLAW_SECRET_PATHS[number]));
  if (bindings.length !== refs.length || refs.some((entry) => {
    const matches = bindings.filter((binding) => binding.configPath === entry.path);
    return matches.length !== 1 || matches[0]?.secretId !== entry.ref.secretId;
  })) {
    throw unprocessable("OpenClaw gateway proof found secret-ref/binding drift", {
      code: "openclaw_gateway_postproof_binding_mismatch",
    });
  }

  const resolved = await secretService(db).resolveAdapterConfigForRuntime(
    agent.companyId,
    adapterConfig,
    { consumerType: "agent", consumerId: agent.id },
    { adapterType: OPENCLAW_ADAPTER_TYPE },
  );
  const runtimeEntries = resolved.manifest
    .filter((entry) => refPaths.has(entry.configPath as typeof OPENCLAW_SECRET_PATHS[number]))
    .map((entry) => ({
      configPath: entry.configPath,
      secretId: entry.secretId,
      bindingId: entry.bindingId,
      provider: entry.provider,
      outcome: entry.outcome,
    }))
    .sort((left, right) => left.configPath.localeCompare(right.configPath));
  if (runtimeEntries.length !== refs.length || runtimeEntries.some((entry) =>
    entry.provider !== "local_encrypted" || entry.outcome !== "success" ||
    typeof entry.bindingId !== "string" || !secretIds.includes(entry.secretId))) {
    throw unprocessable("OpenClaw gateway runtime-resolution proof was incomplete", {
      code: "openclaw_gateway_postproof_runtime_resolution_failed",
    });
  }

  const proofBase = {
    schemaVersion: "1.0.0" as const,
    agentId: agent.id,
    companyId: agent.companyId,
    adapterType: OPENCLAW_ADAPTER_TYPE as "openclaw_gateway",
    configFingerprint: configFingerprint(agent),
    provider: "local_encrypted" as const,
    secretRefCount: refs.length,
    secretRefPaths: refs.map((entry) => entry.path),
    secretIds,
    bindingCount: bindings.length,
    bindingIds: bindings.map((binding) => binding.id).sort(),
    runtimeResolvedCount: runtimeEntries.length,
    runtimeResolutionHash: createHash("sha256").update(stableJson(runtimeEntries)).digest("hex"),
    masterKeyFingerprintSha256: getLocalEncryptedMasterKeyProof().fingerprintSha256,
  };
  return {
    ...proofBase,
    receipt: createLocalEncryptedProofReceipt(`gateway-postproof:${stableJson(proofBase)}`),
  };
}

export function agentAdapterSecretExternalizationService(db: Db) {
  return {
    preflight: async (
      agentId: string,
      expectedCompanyId: string,
    ): Promise<AdapterSecretExternalizationPreflight> => {
      const canonicalAgentId = canonicalizeAgentReferenceId(agentId);
      const current = await db.select().from(agents).where(eq(agents.id, canonicalAgentId))
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Agent not found");
      if (current.companyId !== expectedCompanyId) {
        throw conflict("Agent company changed before adapter secret preflight", {
          code: "agent_adapter_secret_company_mismatch",
        });
      }
      return preflightProjection(current);
    },

    proof: async (
      agentId: string,
      expectedCompanyId: string,
      expectedReceipt: string,
    ): Promise<AdapterSecretExternalizationProof> => {
      const canonicalAgentId = canonicalizeAgentReferenceId(agentId);
      const current = await db.select().from(agents).where(eq(agents.id, canonicalAgentId))
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Agent not found");
      if (current.companyId !== expectedCompanyId) {
        throw conflict("Agent company changed before adapter secret proof", {
          code: "agent_adapter_secret_company_mismatch",
        });
      }
      const proof = await buildExternalizationProof(db, current);
      if (!FINGERPRINT_PATTERN.test(expectedReceipt ?? "") || proof.receipt !== expectedReceipt) {
        throw conflict("Adapter secret externalization proof changed before reread", {
          code: "agent_adapter_secret_proof_mismatch",
        });
      }
      return proof;
    },

    externalize: async (
      agentId: string,
      input: AdapterSecretExternalizationRequest,
      actor?: { userId?: string | null },
    ): Promise<AdapterSecretExternalizationResponse> => {
      const canonicalAgentId = canonicalizeAgentReferenceId(agentId);
      assertHistoricalAgentTombstoneMutable(canonicalAgentId);
      if (input.schemaVersion !== "1.0.0" || input.expectedAdapterType !== OPENCLAW_ADAPTER_TYPE ||
        typeof input.expectedCompanyId !== "string" || !input.expectedCompanyId.trim() ||
        !FINGERPRINT_PATTERN.test(input.expectedConfigFingerprint ?? "") ||
        !FINGERPRINT_PATTERN.test(input.expectedPreflightReceipt ?? "")) {
        throw unprocessable("Unsupported adapter secret externalization contract", {
          code: "invalid_agent_adapter_secret_contract",
        });
      }

      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, canonicalAgentId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Agent not found");
        if (locked.companyId !== input.expectedCompanyId) {
          throw conflict("Agent company does not match the externalization contract", {
            code: "agent_adapter_secret_company_mismatch",
            expectedCompanyId: input.expectedCompanyId,
          });
        }
        if (locked.adapterType !== OPENCLAW_ADAPTER_TYPE) {
          throw conflict("Agent adapter type does not match the externalization contract", {
            code: "agent_adapter_secret_type_mismatch",
            expectedAdapterType: OPENCLAW_ADAPTER_TYPE,
          });
        }
        const txDb = tx as unknown as Db;
        await lockAgentLifecycleReference(txDb, {
          companyId: input.expectedCompanyId,
          agentId: canonicalAgentId,
          mode: "active",
        });
        const lockedPreflight = preflightProjection(locked);
        if (lockedPreflight.configFingerprint !== input.expectedConfigFingerprint ||
          lockedPreflight.receipt !== input.expectedPreflightReceipt) {
          throw conflict("Agent changed after adapter secret externalization was prepared", {
            code: "agent_adapter_secret_cas_mismatch",
            expectedConfigFingerprint: input.expectedConfigFingerprint,
            currentConfigFingerprint: lockedPreflight.configFingerprint,
          });
        }

        const currentConfig = asRecord(locked.adapterConfig) ?? {};
        const moved = moveSensitiveHeaderToAuthToken(currentConfig);
        const literalPaths = OPENCLAW_SECRET_PATHS.filter((key) =>
          isNonEmptyPlainBinding(moved.adapterConfig[key]));
        const scopedSecrets = secretService(txDb);
        const normalizedConfig = await scopedSecrets.normalizeAdapterConfigForPersistence(
          locked.companyId,
          moved.adapterConfig,
          {
            adapterType: OPENCLAW_ADAPTER_TYPE,
            actor: { userId: actor?.userId ?? null },
          },
        );

        const secretRefs = OPENCLAW_SECRET_PATHS
          .map((path) => ({ path, ref: readSecretRef(normalizedConfig[path]) }))
          .filter((entry): entry is { path: typeof OPENCLAW_SECRET_PATHS[number]; ref: { secretId: string } } =>
            entry.ref !== null)
          .sort((left, right) => left.path.localeCompare(right.path));
        const createdSecretIds = literalPaths
          .map((path) => readSecretRef(normalizedConfig[path])?.secretId)
          .filter((secretId): secretId is string => typeof secretId === "string")
          .sort();
        const changed = stableJson(currentConfig) !== stableJson(normalizedConfig);
        let updatedAt = locked.updatedAt;

        if (changed) {
          const requestedUpdatedAt = nextUpdatedAt(locked.updatedAt);
          const updated = await tx
            .update(agents)
            .set({ adapterConfig: normalizedConfig, updatedAt: requestedUpdatedAt })
            .where(and(
              eq(agents.id, locked.id),
              eq(agents.companyId, locked.companyId),
              eq(agents.adapterType, OPENCLAW_ADAPTER_TYPE),
            ))
            .returning({ updatedAt: agents.updatedAt })
            .then((rows) => rows[0] ?? null);
          if (!updated) {
            throw conflict("Agent changed during adapter secret externalization", {
              code: "agent_adapter_secret_cas_mismatch",
            });
          }
          updatedAt = updated.updatedAt;
        }

        // Binding repair is intentionally unconditional: config can already be
        // normalized while a prior partial operation or manual edit removed a
        // target binding.
        await syncAgentAdapterEnvBindings({
          secretsSvc: scopedSecrets,
          companyId: locked.companyId,
          agentId: locked.id,
          adapterConfig: normalizedConfig,
        });

        const secretIds = [...new Set(secretRefs.map((entry) => entry.ref.secretId))].sort();
        const proof = await buildExternalizationProof(txDb, {
          ...locked,
          adapterConfig: normalizedConfig,
        });
        return {
          schemaVersion: "1.0.0",
          agentId: locked.id,
          companyId: locked.companyId,
          createdSecretCount: createdSecretIds.length,
          createdSecretIds,
          removedHeaderCount: moved.removedHeaderPaths.length,
          removedHeaderPaths: [...moved.removedHeaderPaths].sort(),
          secretRefCount: secretRefs.length,
          secretRefPaths: secretRefs.map((entry) => entry.path),
          secretIds,
          configFingerprint: proof.configFingerprint,
          preflightReceipt: lockedPreflight.receipt,
          proof,
          updatedAt: updatedAt.toISOString(),
        };
      });
    },
  };
}

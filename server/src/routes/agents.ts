import { Router, type Request, type Response } from "express";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  authUsers,
  companies,
  companySkills as companySkillsTable,
  heartbeatRuns,
  issues as issuesTable,
  projects as projectsTable,
} from "@paperclipai/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentMineInboxQuerySchema,
  ADAPTER_AGNOSTIC_KEYS,
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  isAgentRetirementSource,
  normalizeIssueIdentifier,
  agentLifecycleSchema,
  pauseAgentSchema,
  resumeAgentSchema,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentDesiredSkillEntry,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  supportedEnvironmentDriversForAdapter,
  LOW_TRUST_REVIEW_PRESET,
  agentRetirementCleanupRequestSchema,
  agentRetirementEvidenceSchema,
  agentRetirementExecutionRecoveryRequestSchema,
  agentRetirementPreflightRequestSchema,
  agentRetirementTerminationSchema,
  type AgentLifecycleGate,
  type AgentLifecycleTransition,
} from "@paperclipai/shared";
import {
  resolvePaperclipInstanceRootForAdapter,
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentRetirementService,
  agentInstructionsService,
  accessService,
  approvalService,
  companySkillService,
  budgetService,
  heartbeatService,
  ISSUE_LIST_DEFAULT_LIMIT,
  issueApprovalService,
  issueRecoveryActionService,
  issueService,
  logActivity,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { skillVersionSelectionMap } from "../services/runtime-skill-selections.js";
import { secretService } from "../services/secrets.js";
import { agentAdapterSecretExternalizationService } from "../services/agent-adapter-secret-externalization.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  listAdapterModelProfiles,
  refreshAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  assertClaudePermissionConfigIsFailClosed,
  runClaudeLogin,
} from "@paperclipai/adapter-claude-local/server";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
} from "@paperclipai/adapter-acpx-local";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { assertCodexPermissionConfigIsFailClosed } from "@paperclipai/adapter-codex-local/server";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { requireOpenCodeModelId } from "@paperclipai/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { recoveryService } from "../services/recovery/service.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";
import { readObject } from "../lib/objects.js";
import { listInvalidOrgChainDescendantIds } from "../services/agent-invokability.js";
import { createAgentConfigurationFingerprint } from "../services/effective-run-config-fingerprints.js";
import {
  computeAgentLifecycleConfigFingerprint,
  createAgentLifecycleCanaryReceipt,
  createAgentLifecycleValidationReceipt,
  hashAgentLifecycleContent,
  parseAgentLifecycleGate,
  resolveAgentLifecycleDesiredSkills,
  SERVER_MANAGED_AGENT_LIFECYCLE_GATE_KEYS,
  validateAgentLifecyclePatchTransition,
  validateAgentLifecycleGate,
  type AgentLifecycleFingerprintInput,
} from "../services/agent-lifecycle.js";
import {
  assertHistoricalAgentTombstoneAccessMutable,
  assertHistoricalAgentTombstoneMutable,
} from "../services/agent-retirement-historical-tombstones.js";

const RUN_LOG_DEFAULT_LIMIT_BYTES = 256_000;
const RUN_LOG_MAX_LIMIT_BYTES = 1024 * 1024;
const adapterSecretExternalizationSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  expectedCompanyId: z.string().uuid(),
  expectedAdapterType: z.literal("openclaw_gateway"),
  expectedConfigFingerprint: z.string().regex(/^v1:hmac-sha256:[a-f0-9]{64}$/),
  expectedPreflightReceipt: z.string().regex(/^v1:hmac-sha256:[a-f0-9]{64}$/),
}).strict();
const adapterSecretExternalizationProofSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  expectedCompanyId: z.string().uuid(),
  expectedReceipt: z.string().regex(/^v1:hmac-sha256:[a-f0-9]{64}$/),
}).strict();

function readRunLogLimitBytes(value: unknown) {
  const parsed = Number(value ?? RUN_LOG_DEFAULT_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return RUN_LOG_DEFAULT_LIMIT_BYTES;
  return Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)));
}

function readLiveRunsQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

function readRunIssueId(context: Record<string, unknown> | null) {
  const directIssueId = context?.issueId;
  if (typeof directIssueId === "string" && isUuidLike(directIssueId)) return directIssueId;
  const paperclipIssue = readObject(context?.paperclipIssue);
  const nestedIssueId = paperclipIssue?.id;
  return typeof nestedIssueId === "string" && isUuidLike(nestedIssueId) ? nestedIssueId : null;
}

export function agentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  // Legacy hardcoded maps — used as fallback when adapter module does not
  // declare capability flags explicitly.
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    acpx_local: "instructionsFilePath",
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    droid_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

  /** Check if an adapter supports the managed instructions bundle. */
  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  /** Resolve the adapter config key for the instructions file path. */
  function resolveInstructionsPathKey(adapterType: string): string | null {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
    if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
    if (adapter?.supportsInstructionsBundle === false) return null;
    return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
  }
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;
  const KNOWN_INSTRUCTIONS_BUNDLE_KEY_SET: ReadonlySet<string> = new Set(KNOWN_INSTRUCTIONS_BUNDLE_KEYS);

  const router = Router();
  const svc = agentService(db);
  const retirement = agentRetirementService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const budgets = budgetService(db);
  const environmentsSvc = environmentService(db);
  const environmentRuntime = environmentRuntimeService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
  const issuesSvc = issueService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const adapterSecretExternalization = agentAdapterSecretExternalizationService(db);
  const instructions = agentInstructionsService();
  const companySkills = companySkillService(db);
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  type LifecycleAgentCandidate = {
    id: string;
    companyId: string;
    adapterType: string;
    adapterConfig: unknown;
    runtimeConfig: unknown;
    permissions: unknown;
    metadata: unknown;
    name: string;
  };

  function readSha256Reference(...values: unknown[]) {
    return values.find((value): value is string =>
      typeof value === "string" && /^(?:sha256:|v1:sha256:)[a-f0-9]{64}$/.test(value),
    ) ?? null;
  }

  async function buildLifecycleFingerprintInput(
    agent: LifecycleAgentCandidate,
  ): Promise<AgentLifecycleFingerprintInput> {
    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
    const metadata = asRecord(agent.metadata) ?? {};
    const desiredSkillEntries = readPaperclipSkillSyncPreference(adapterConfig).desiredSkillEntries;
    const [grants, bundle, skillCatalog] = await Promise.all([
      access.listPrincipalGrants(agent.companyId, "agent", agent.id),
      instructions.exportFiles(agent),
      desiredSkillEntries.length > 0
        ? db
          .select({
            id: companySkillsTable.id,
            key: companySkillsTable.key,
            currentVersionId: companySkillsTable.currentVersionId,
          })
          .from(companySkillsTable)
          .where(and(
            eq(companySkillsTable.companyId, agent.companyId),
            inArray(companySkillsTable.key, desiredSkillEntries.map((entry) => entry.key)),
          ))
        : Promise.resolve([]),
    ]);
    const desiredSkills = resolveAgentLifecycleDesiredSkills(desiredSkillEntries, skillCatalog);
    const contextPackContent = bundle.files[bundle.entryFile] ?? "";
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      adapterConfig,
      runtimeConfig,
      permissions: asRecord(agent.permissions) ?? {},
      grants: grants.map((grant) => ({
        permissionKey: grant.permissionKey,
        scope: asRecord(grant.scope),
      })),
      desiredSkills,
      lifecycle: metadata.lifecycle,
      contextPackSha256: hashAgentLifecycleContent(contextPackContent),
      managedInstructionsSha256: hashAgentLifecycleContent(bundle.files),
      companyProfileSha256: readSha256Reference(
        adapterConfig.companyProfileSha256,
        runtimeConfig.companyProfileSha256,
      ),
    };
  }

  function lifecycleGateFailure(result: Exclude<ReturnType<typeof validateAgentLifecycleGate>, { ok: true }>): never {
    throw conflict("Agent lifecycle gate failed", {
      code: "lifecycle_gate_failed",
      reason: result.reason,
      ...(result.issues ? { issues: result.issues } : {}),
    });
  }

  async function assertLifecycleGate(agent: LifecycleAgentCandidate) {
    const metadata = asRecord(agent.metadata) ?? {};
    const result = validateAgentLifecycleGate({
      fingerprintInput: await buildLifecycleFingerprintInput(agent),
      gate: metadata.lifecycleGate,
    });
    if (!result.ok) lifecycleGateFailure(result);
    return result;
  }

  async function refreshLifecycleReceiptForPatch(input: {
    existing: LifecycleAgentCandidate;
    candidate: LifecycleAgentCandidate;
    patchData: Record<string, unknown>;
    requestMetadata: Record<string, unknown> | null;
  }) {
    const metadata = asRecord(input.candidate.metadata) ?? {};
    if (!Object.prototype.hasOwnProperty.call(metadata, "lifecycle")) return null;
    const lifecycleRelevantChange = ["adapterType", "adapterConfig", "runtimeConfig"]
      .some((key) => Object.prototype.hasOwnProperty.call(input.patchData, key))
      || Boolean(input.requestMetadata && Object.prototype.hasOwnProperty.call(input.requestMetadata, "lifecycle"));
    if (!lifecycleRelevantChange) return null;

    const existingMetadata = asRecord(input.existing.metadata) ?? {};
    let lifecycleGate: AgentLifecycleGate | undefined;
    try {
      lifecycleGate = createAgentLifecycleValidationReceipt({
        fingerprintInput: await buildLifecycleFingerprintInput(input.candidate),
        previousGate: parseAgentLifecycleGate(existingMetadata.lifecycleGate),
      });
    } catch {
      lifecycleGate = undefined;
    }
    const nextMetadata = { ...metadata };
    if (lifecycleGate) nextMetadata.lifecycleGate = lifecycleGate;
    else delete nextMetadata.lifecycleGate;
    input.patchData.metadata = nextMetadata;
    input.candidate.metadata = nextMetadata;
    return { lifecycleGate: lifecycleGate ?? null };
  }

  async function assertAgentEnvironmentSelection(
    companyId: string,
    adapterType: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentService(db), companyId, environmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
    });
  }

  async function decideAgentRead(req: Request, agent: { id: string; companyId: string }) {
    return access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
  }

  async function assertAgentReadAllowed(req: Request, res: Response, agent: { id: string; companyId: string }) {
    const decision = await decideAgentRead(req, agent);
    if (decision.allowed) return true;
    res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
    return false;
  }

  async function filterAgentsForActor<T extends Record<string, unknown>>(
    req: Request,
    rows: T[],
    fallbackCompanyId?: string,
  ) {
    const decisions = await Promise.all(rows.map((agent) => {
      const id = typeof agent.id === "string" ? agent.id : null;
      const companyId = typeof agent.companyId === "string" ? agent.companyId : fallbackCompanyId ?? null;
      if (!id || !companyId) return Promise.resolve({ allowed: false });
      return decideAgentRead(req, { id, companyId });
    }));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → acquires an ad-hoc lease, realizes the
   *   workspace, and resolves a sandbox execution target wired to the runtime
   *   so the adapter probe runs inside the sandbox the same way a heartbeat
   *   would. The returned `release` callback rolls the lease back when the
   *   route is done.
   *
   * The caller MUST always invoke `release()` (typically in a `finally` block).
   */
  async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
    release: (status?: "released" | "failed") => Promise<void>;
  }> {
    const noopRelease = async () => {};

    if (!input.environmentId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. The test did not run.",
          },
        ],
        release: noopRelease,
      };
    }

    if (environment.driver === "local") {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return {
            executionTarget: target,
            environmentName: environment.name,
            fallbackChecks: [],
            release: noopRelease,
          };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". The test did not run.`,
            },
          ],
          release: noopRelease,
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
          release: noopRelease,
        };
      }
    }

    // sandbox / plugin / other remote drivers: spin up an ad-hoc lease, realize
    // the workspace inside the box, and run the same probe SSH uses against
    // a sandbox execution target wired to the environment runtime.
    //
    // We pass `heartbeatRunId: null` because there's no heartbeat run for an
    // operator-initiated `Test` invocation — the leases table FKs heartbeat
    // run id to heartbeat_runs.id, and we don't want to manufacture a fake
    // run row. Cleanup goes through the driver's `releaseRunLease` directly
    // (by lease record), since the batch helper queries by heartbeatRunId.
    let leaseRecord: Awaited<ReturnType<typeof environmentRuntime.acquireRunLease>>;
    try {
      leaseRecord = await environmentRuntime.acquireRunLease({
        companyId: input.companyId,
        environment,
        issueId: null,
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        // Apply the active custom-image template so the Test boots with the
        // operator's captured sandbox customizations and prepared image state,
        // matching what real agent runs use. Without this the test would
        // silently fall back to the base image.
        applyCustomImageTemplate: true,
      });
    } catch (err) {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_lease_acquire_failed",
            level: "error",
            message: `Could not acquire a lease for environment "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
            hint: "Check the environment's provider credentials and quota.",
          },
        ],
        release: noopRelease,
      };
    }

    const driver = environmentRuntime.getDriver(environment.driver);
    const releaseLease = async (status: "released" | "failed" = "released") => {
      try {
        if (driver) {
          await driver.releaseRunLease({
            environment,
            lease: leaseRecord.lease,
            status,
          });
        } else {
          await environmentsSvc.releaseLease(leaseRecord.lease.id, status);
        }
      } catch (err) {
        // Cleanup failures must not mask the test result.
        // eslint-disable-next-line no-console
        console.warn(
          `[adapter-test] Failed to release lease ${leaseRecord.lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let realizedCwd: string | null = null;
    try {
      const realized = await environmentRuntime.realizeWorkspace({
        environment,
        lease: leaseRecord.lease,
        // No host workspace to copy for a Test invocation; sandbox/plugin
        // realize implementations use the lease metadata's remoteCwd to
        // create the working directory inside the box.
        workspace: {},
      });
      realizedCwd =
        typeof realized.cwd === "string" && realized.cwd.trim().length > 0
          ? realized.cwd.trim()
          : null;
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_workspace_realize_failed",
            level: "error",
            message: `Could not realize a workspace inside "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    let target: AdapterExecutionTarget | null;
    try {
      // Prefer the cwd the realize step returned; fall back to lease metadata.
      const leaseMetadataForTarget: Record<string, unknown> | null =
        realizedCwd
          ? { ...(leaseRecord.lease.metadata ?? {}), remoteCwd: realizedCwd }
          : (leaseRecord.lease.metadata as Record<string, unknown> | null) ?? null;

      target = await resolveEnvironmentExecutionTarget({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: {
          id: environment.id,
          driver: environment.driver,
          config: environment.config ?? null,
        },
        leaseId: leaseRecord.lease.id,
        leaseMetadata: leaseMetadataForTarget,
        lease: leaseRecord.lease,
        environmentRuntime,
      });
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_failed",
            level: "error",
            message: `Could not resolve a sandbox execution target for "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    if (!target) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_unsupported",
            level: "warn",
            message:
              `Adapter "${input.adapterType}" is not allowed in "${environment.name}" environments.`,
          },
        ],
        release: noopRelease,
      };
    }

    return {
      executionTarget: target,
      environmentName: environment.name,
      fallbackChecks: [],
      release: releaseLease,
    };
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    if (asRecord(agent.permissions)?.canAssignTasks === true) {
      return {
        canAssignTasks: true,
        taskAssignSource: "permission_manifest" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  async function resolveAgentSelfTrustPreset(req: Request, agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    if (req.actor.type !== "agent" || req.actor.agentId !== agent.id) {
      return { kind: "standard" as const };
    }
    const run = req.actor.type === "agent" && req.actor.runId
      ? await db
          .select({
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const runContext = run?.agentId === agent.id ? readObject(run.contextSnapshot) : null;
    const runExecutionPolicy = readObject(runContext?.executionPolicy);
    const runIssueId = readRunIssueId(runContext);
    const runScopedIssue = runIssueId
      ? await db
          .select({
            companyId: issuesTable.companyId,
            projectId: issuesTable.projectId,
            executionPolicy: issuesTable.executionPolicy,
            projectExecutionWorkspacePolicy: projectsTable.executionWorkspacePolicy,
          })
          .from(issuesTable)
          .leftJoin(projectsTable, and(eq(projectsTable.id, issuesTable.projectId), eq(projectsTable.companyId, issuesTable.companyId)))
          .where(and(eq(issuesTable.id, runIssueId), eq(issuesTable.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;

    return resolveCoreTrustPreset({
      companyId: agent.companyId,
      agent,
      project: runScopedIssue?.projectId
        ? {
            companyId: runScopedIssue.companyId,
            executionWorkspacePolicy: runScopedIssue.projectExecutionWorkspacePolicy,
          }
        : null,
      issue: runScopedIssue
        ? {
            companyId: runScopedIssue.companyId,
            executionPolicy: runScopedIssue.executionPolicy,
          }
        : null,
      run: runExecutionPolicy ? { companyId: agent.companyId, executionPolicy: runExecutionPolicy } : null,
    });
  }

  function buildLowTrustSelfView(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    };
  }

  async function applyAgentTaskAssignGrant(
    companyId: string,
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    grantedByUserId: string | null,
    options: { allowPendingApproval?: boolean } = {},
  ) {
    const enabled = agent.role === "ceo"
      || asRecord(agent.permissions)?.canAssignTasks === true;
    if (options.allowPendingApproval === true) {
      await access.ensureMembership(
        companyId,
        "agent",
        agent.id,
        "member",
        "active",
        { allowPendingApproval: true },
      );
      await access.setPrincipalPermission(
        companyId,
        "agent",
        agent.id,
        "tasks:assign",
        enabled,
        grantedByUserId,
        null,
        { allowPendingApproval: true },
      );
      return;
    }
    await access.ensureMembership(companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agent.id,
      "tasks:assign",
      enabled,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    if (req.actor.type !== "agent") return null;
    const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return actorAgent;
  }

  async function assertBoardCanManageAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanManageAgentPermissions(
    req: Request,
    existing: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
  ) {
    assertCompanyAccess(req, existing.companyId);
    if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        throw forbidden("Forbidden");
      }
      if (actorAgent.role !== "ceo") {
        throw forbidden("Only CEO can manage permissions");
      }
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, existing.companyId);
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    // Reading agent configurations, skills, and config revisions is a
    // read-only operation available to any board (human) member of the
    // company. Responses go through `redactAgentConfiguration` so secrets
    // are never exposed. Mutations and environment probes still gate on
    // agents:create via assertCanCreateAgentsForCompany / assertCanUpdateAgent.
    //
    // For AGENT actors we keep the previous, stricter gate: an agent must
    // either have an explicit `agents:create` grant or the legacy
    // `canCreateAgents` permission on its own record. Agents are
    // non-human principals — they should not be able to introspect peer
    // agents' configurations just by virtue of being in the same company.
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const actorAgent = await svc.getById(req.actor.agentId);
      if (!actorAgent || actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      const allowedByGrant = await access.hasPermission(
        companyId,
        "agent",
        actorAgent.id,
        "agents:create",
      );
      if (!allowedByGrant && !canCreateAgents(actorAgent)) {
        throw forbidden("Missing permission: can create agents");
      }
      return actorAgent;
    }
    return null;
  }

  async function getAccessibleAgent(req: Request, res: Response, id: string) {
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    assertCompanyAccess(req, agent.companyId);
    if (req.actor.type === "board") {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    return agent;
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    // Mirrors assertCanReadConfigurations but returns a boolean instead of
    // throwing. Board actors only need company access; agent actors must
    // still pass the agents:create gate (explicit grant or canCreateAgents
    // on their own record) so peer agents cannot snoop each others'
    // configurations.
    try {
      assertCompanyAccess(req, companyId);
    } catch {
      return false;
    }
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(
      companyId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanReadAgent(req: Request, targetAgent: { companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      await assertCanReadConfigurations(req, targetAgent.companyId);
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  async function assertAgentDefaultEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
    options?: { allowedDrivers?: string[]; allowedSandboxProviders?: string[] },
  ) {
    if (environmentId === undefined || environmentId === null) return;
    const environment = await environmentsSvc.getById(environmentId);
    if (!environment) {
      throw unprocessable("Selected environment was not found");
    }
    if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
      throw unprocessable(`Environment driver "${environment.driver}" is not allowed here`);
    }
    if (environment.driver === "sandbox" && options?.allowedSandboxProviders) {
      const config = environment.config && typeof environment.config === "object"
        ? environment.config as Record<string, unknown>
        : {};
      const provider = typeof config.provider === "string" ? config.provider : "";
      if (provider === "fake") {
        throw unprocessable(
          `Selected sandbox provider "${provider}" is not supported for agent defaults yet`,
        );
      }
      if (options.allowedSandboxProviders.length > 0 && !options.allowedSandboxProviders.includes(provider)) {
        throw unprocessable(
          `Selected sandbox provider "${provider || "unknown"}" is not supported for agent defaults yet`,
        );
      }
    }
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  function allowedEnvironmentDriversForAgent(adapterType: string): string[] {
    return supportedEnvironmentDriversForAdapter(adapterType);
  }

  function allowedSandboxProvidersForAgent(adapterType: string): string[] | undefined {
    return supportedEnvironmentDriversForAdapter(adapterType).includes("sandbox") ? [] : [];
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function asEnvBindingString(value: unknown): string | null {
    const direct = asNonEmptyString(value);
    if (direct) return direct;
    const record = asRecord(value);
    if (record?.type !== "plain") return null;
    return asNonEmptyString(record.value);
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  type GovernedPermissionBypass =
    | "claude_permission_mode"
    | "codex_approvals_and_sandbox";

  const CLAUDE_GLOBAL_BYPASS_FLAG = "--dangerously-skip-permissions";
  const CODEX_GLOBAL_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

  function isUuidValue(value: unknown): value is string {
    return typeof value === "string" && isUuidLike(value);
  }

  function requiredPermissionBypass(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): GovernedPermissionBypass | null {
    const extraArgs = [
      ...(Array.isArray(adapterConfig.extraArgs) ? adapterConfig.extraArgs : []),
      ...(Array.isArray(adapterConfig.args) ? adapterConfig.args : []),
    ].filter((value): value is string => typeof value === "string");
    if (
      adapterType === "claude_local"
      && (
        adapterConfig.dangerouslySkipPermissions === true
        || extraArgs.some(
          (arg) => arg === CLAUDE_GLOBAL_BYPASS_FLAG
            || arg.startsWith(`${CLAUDE_GLOBAL_BYPASS_FLAG}=`),
        )
      )
    ) {
      return "claude_permission_mode";
    }
    if (
      adapterType === "codex_local"
      && (
        adapterConfig.dangerouslyBypassApprovalsAndSandbox === true
        || adapterConfig.dangerouslyBypassSandbox === true
        || extraArgs.some(
          (arg) => arg === CODEX_GLOBAL_BYPASS_FLAG
            || arg.startsWith(`${CODEX_GLOBAL_BYPASS_FLAG}=`),
        )
      )
    ) {
      return "codex_approvals_and_sandbox";
    }
    return null;
  }

  function hasCurrentCompletePermissionException(
    permissions: unknown,
    requiredBypass: GovernedPermissionBypass,
    now = new Date(),
  ): boolean {
    const permissionRecord = asRecord(permissions);
    const bypassPolicy = asRecord(permissionRecord?.bypass);
    const expectsClaude = requiredBypass === "claude_permission_mode";
    if (
      bypassPolicy?.claudePermissionMode !== expectsClaude
      || bypassPolicy?.codexApprovalsAndSandbox !== !expectsClaude
    ) {
      return false;
    }

    const exception = asRecord(permissionRecord?.exception);
    if (exception?.kind !== "approved" || !isUuidValue(exception.exceptionIssueId)) {
      return false;
    }

    const owner = asRecord(exception.owner);
    const validOwner = owner?.ownerType === "agent"
      ? isUuidValue(owner.ownerAgentId)
        && owner.ownerUserId === undefined
        && owner.ownerRoleSlug === undefined
      : owner?.ownerType === "board_user"
        ? Boolean(asNonEmptyString(owner.ownerUserId))
          && owner.ownerAgentId === undefined
          && owner.ownerRoleSlug === undefined
        : owner?.ownerType === "board_role"
          ? Boolean(asNonEmptyString(owner.ownerRoleSlug))
            && owner.ownerAgentId === undefined
            && owner.ownerUserId === undefined
          : false;
    if (!validOwner) return false;

    const scope = asRecord(exception.scope);
    const cwdRoots = Array.isArray(scope?.cwdRoots) ? scope.cwdRoots : null;
    const tools = Array.isArray(scope?.tools) ? scope.tools : null;
    const networkHosts = Array.isArray(scope?.networkHosts) ? scope.networkHosts : null;
    const bypasses = Array.isArray(scope?.bypasses) ? scope.bypasses : null;
    if (
      !cwdRoots
      || !cwdRoots.every((value) => typeof value === "string" && path.isAbsolute(value))
      || !tools
      || !tools.every((value) => Boolean(asNonEmptyString(value)))
      || !networkHosts
      || !networkHosts.every(
        (value) => typeof value === "string"
          && /^[a-z0-9.-]+$/i.test(value)
          && !value.includes(".."),
      )
      || !bypasses
      || bypasses.length !== 1
      || bypasses[0] !== requiredBypass
    ) {
      return false;
    }

    if (!asNonEmptyString(exception.justification)) return false;
    const evidence = asRecord(exception.evidence);
    if (
      !isUuidValue(evidence?.canaryIssueId)
      || !isUuidValue(evidence?.runId)
      || typeof evidence?.configFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(evidence.configFingerprint)
      || evidence.result !== "passed"
    ) {
      return false;
    }

    if (
      typeof exception.approvedAt !== "string"
      || typeof exception.expiresAt !== "string"
    ) {
      return false;
    }
    const approvedAt = new Date(exception.approvedAt).getTime();
    const expiresAt = new Date(exception.expiresAt).getTime();
    const nowMs = now.getTime();
    const maxExceptionMs = 30 * 24 * 60 * 60 * 1_000;
    return Number.isFinite(approvedAt)
      && Number.isFinite(expiresAt)
      && approvedAt <= nowMs
      && expiresAt > nowMs
      && expiresAt > approvedAt
      && expiresAt - approvedAt <= maxExceptionMs;
  }

  async function isActualCompanyBoardUser(companyId: string, userId: string) {
    const [membership, user] = await Promise.all([
      access.getMembership(companyId, "user", userId),
      db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(user?.id === userId && membership?.status === "active");
  }

  async function hasCompanyBoundPermissionOwner(
    companyId: string,
    owner: Record<string, unknown>,
  ) {
    if (owner.ownerType === "agent") {
      const ownerAgentId = asNonEmptyString(owner.ownerAgentId);
      if (!ownerAgentId) return false;
      const ownerAgent = await svc.getById(ownerAgentId);
      return ownerAgent?.companyId === companyId && ownerAgent.status !== "terminated";
    }
    if (owner.ownerType === "board_user") {
      const ownerUserId = asNonEmptyString(owner.ownerUserId);
      return ownerUserId ? isActualCompanyBoardUser(companyId, ownerUserId) : false;
    }
    if (owner.ownerType === "board_role") {
      const ownerRoleSlug = asNonEmptyString(owner.ownerRoleSlug);
      if (!ownerRoleSlug) return false;
      const members = await access.listMembers(companyId);
      const candidates = members.filter(
        (member) => member.principalType === "user"
          && member.status === "active"
          && member.membershipRole === ownerRoleSlug,
      );
      for (const candidate of candidates) {
        if (await isActualCompanyBoardUser(companyId, candidate.principalId)) return true;
      }
    }
    return false;
  }

  function permissionGovernanceError(code: string, message: string): never {
    throw badRequest(message, { code });
  }

  function assertAdapterSecurityConfigFailClosed(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    try {
      if (adapterType === "claude_local") {
        assertClaudePermissionConfigIsFailClosed(adapterConfig);
      } else if (adapterType === "codex_local") {
        assertCodexPermissionConfigIsFailClosed(adapterConfig);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      permissionGovernanceError(
        message.includes("Board-managed tool scope")
          ? "claude_allowed_tools_board_manifest_required"
          : "adapter_security_args_not_allowlisted",
        message,
      );
    }
  }

  function sameStringArray(left: unknown, right: unknown): boolean {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => typeof value === "string" && value === right[index]);
  }

  function isPathWithinRoot(candidate: string, root: string) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function readRunEffectiveConfigFingerprint(run: unknown): string | null {
    const resultJson = asRecord(asRecord(run)?.resultJson);
    const configFreshness = asRecord(resultJson?.configFreshness);
    const session = asRecord(configFreshness?.session);
    const fingerprint = asNonEmptyString(session?.nextFingerprint);
    const match = fingerprint?.match(/^v1:sha256:([a-f0-9]{64})$/);
    return match?.[1] ?? null;
  }

  function readRunAgentConfigurationFingerprint(run: unknown): string | null {
    const resultJson = asRecord(asRecord(run)?.resultJson);
    const configFreshness = asRecord(resultJson?.configFreshness);
    const session = asRecord(configFreshness?.session);
    const fingerprint = asNonEmptyString(session?.agentConfigurationFingerprint);
    return fingerprint && /^v1:sha256:[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
  }

  async function pathIsContainedWithoutSymlinks(candidate: string, root: string) {
    const lexicalRoot = path.resolve(root);
    const lexicalCandidate = path.resolve(candidate);
    if (!isPathWithinRoot(lexicalCandidate, lexicalRoot)) return false;
    try {
      const rootStat = await fs.lstat(lexicalRoot);
      if (rootStat.isSymbolicLink()) return false;
      const relative = path.relative(lexicalRoot, lexicalCandidate);
      let cursor = lexicalRoot;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) return false;
      }
      const [realRoot, realCandidate] = await Promise.all([
        fs.realpath(lexicalRoot),
        fs.realpath(lexicalCandidate),
      ]);
      return isPathWithinRoot(realCandidate, realRoot);
    } catch {
      return false;
    }
  }

  function boardApprovalMatchesException(input: {
    approval: Record<string, unknown>;
    agentId: string;
    companyId: string;
    requiredBypass: GovernedPermissionBypass;
    exception: Record<string, unknown>;
    evidence: Record<string, unknown>;
    agentConfigurationFingerprint: string;
  }) {
    const payload = asRecord(input.approval.payload);
    const payloadScope = asRecord(payload?.scope);
    const exceptionScope = asRecord(input.exception.scope);
    return input.approval.companyId === input.companyId
      && input.approval.type === "request_board_approval"
      && input.approval.status === "approved"
      && Boolean(asNonEmptyString(input.approval.decidedByUserId))
      && input.approval.decidedAt != null
      && new Date(input.approval.decidedAt as string | Date).getTime()
        === new Date(String(input.exception.approvedAt)).getTime()
      && payload?.action === "agent_permission_exception"
      && payload.agentId === input.agentId
      && payload.configFingerprint === input.evidence.configFingerprint
      && payload.agentConfigurationFingerprint === input.agentConfigurationFingerprint
      && payload.expiresAt === input.exception.expiresAt
      && sameStringArray(payload.bypasses, [input.requiredBypass])
      && sameStringArray(payloadScope?.cwdRoots, exceptionScope?.cwdRoots)
      && sameStringArray(payloadScope?.tools, exceptionScope?.tools)
      && sameStringArray(payloadScope?.networkHosts, exceptionScope?.networkHosts)
      && sameStringArray(payloadScope?.bypasses, exceptionScope?.bypasses);
  }

  async function assertPermissionBypassGoverned(input: {
    agentId: string;
    companyId: string;
    adapterType: string | null | undefined;
    adapterConfig: Record<string, unknown>;
    runtimeConfig: Record<string, unknown>;
    permissions: unknown;
  }) {
    let governedAdapterConfig = input.adapterConfig;
    let requiredBypass = requiredPermissionBypass(input.adapterType, governedAdapterConfig);
    if (!requiredBypass) {
      for (const profile of listRuntimeModelProfileAdapterConfigs(input.runtimeConfig)) {
        const effectiveProfileConfig = { ...input.adapterConfig, ...profile.adapterConfig };
        requiredBypass = requiredPermissionBypass(input.adapterType, effectiveProfileConfig);
        if (requiredBypass) {
          governedAdapterConfig = effectiveProfileConfig;
          break;
        }
      }
    }
    if (!requiredBypass) {
      assertAdapterSecurityConfigFailClosed(input.adapterType, input.adapterConfig);
      for (const profile of listRuntimeModelProfileAdapterConfigs(input.runtimeConfig)) {
        assertAdapterSecurityConfigFailClosed(input.adapterType, {
          ...input.adapterConfig,
          ...profile.adapterConfig,
        });
      }
      return;
    }
    const rejectIncomplete = (): never => permissionGovernanceError(
      "permission_exception_incomplete",
      `Explicit ${requiredBypass} bypass requires a current complete lifecycle permission exception`,
    );
    if (!hasCurrentCompletePermissionException(input.permissions, requiredBypass)) rejectIncomplete();

    const permissions = asRecord(input.permissions);
    const exception = asRecord(permissions?.exception);
    const owner = asRecord(exception?.owner);
    const evidence = asRecord(exception?.evidence);
    const exceptionIssueId = asNonEmptyString(exception?.exceptionIssueId);
    const canaryIssueId = asNonEmptyString(evidence?.canaryIssueId);
    const runId = asNonEmptyString(evidence?.runId);
    const scope = asRecord(exception?.scope);
    if (!owner || !scope || !exceptionIssueId || !canaryIssueId || !runId) rejectIncomplete();
    const boundOwner = owner as Record<string, unknown>;
    const boundScope = scope as Record<string, unknown>;
    const boundExceptionIssueId = exceptionIssueId as string;
    const boundCanaryIssueId = canaryIssueId as string;
    const boundRunId = runId as string;

    const [ownerValid, exceptionIssue, canaryIssue, run, linkedApprovals] = await Promise.all([
      hasCompanyBoundPermissionOwner(input.companyId, boundOwner),
      issuesSvc.getById(boundExceptionIssueId),
      issuesSvc.getById(boundCanaryIssueId),
      heartbeat.getRun(boundRunId),
      issueApprovalsSvc.listApprovalsForIssue(boundExceptionIssueId),
    ]);
    const runContext = asRecord(run?.contextSnapshot);
    const runWorkspace = asRecord(runContext?.paperclipWorkspace);
    if (
      !ownerValid
      || exceptionIssue?.id !== boundExceptionIssueId
      || exceptionIssue.companyId !== input.companyId
      || canaryIssue?.id !== boundCanaryIssueId
      || canaryIssue.companyId !== input.companyId
      || canaryIssue.assigneeAgentId !== input.agentId
      || canaryIssue.status !== "done"
      || canaryIssue.executionRunId !== boundRunId
      || run?.id !== boundRunId
      || run.companyId !== input.companyId
      || run.agentId !== input.agentId
      || run.status !== "succeeded"
      || runContext?.issueId !== boundCanaryIssueId
    ) {
      permissionGovernanceError(
        "permission_exception_canary_invalid",
        "The permission exception canary issue and successful run must be bound to this agent and company",
      );
    }

    const runFingerprint = readRunEffectiveConfigFingerprint(run);
    if (!runFingerprint || evidence?.configFingerprint !== runFingerprint) {
      permissionGovernanceError(
        "permission_exception_run_fingerprint_mismatch",
        "The permission exception must match the canary run's persisted effective-run-config fingerprint",
      );
    }

    const canaryAgentConfigurationFingerprint = readRunAgentConfigurationFingerprint(run);
    const currentAgentConfigurationFingerprint = createAgentConfigurationFingerprint({
      adapterType: input.adapterType ?? "",
      adapterConfig: input.adapterConfig,
      runtimeConfig: input.runtimeConfig,
    });
    if (
      !canaryAgentConfigurationFingerprint
      || currentAgentConfigurationFingerprint !== canaryAgentConfigurationFingerprint
    ) {
      permissionGovernanceError(
        "permission_exception_current_config_fingerprint_mismatch",
        "The current adapter and runtime model-profile configuration must exactly match the canary configuration",
      );
    }

    const approval = linkedApprovals.find((candidate) => boardApprovalMatchesException({
      approval: candidate as Record<string, unknown>,
      agentId: input.agentId,
      companyId: input.companyId,
      requiredBypass,
      exception: exception as Record<string, unknown>,
      evidence: evidence as Record<string, unknown>,
      agentConfigurationFingerprint: currentAgentConfigurationFingerprint,
    })) as Record<string, unknown> | undefined;
    const decidedByUserId = approval ? asNonEmptyString(approval.decidedByUserId) : null;
    if (!approval || !decidedByUserId || !(await isActualCompanyBoardUser(input.companyId, decidedByUserId))) {
      permissionGovernanceError(
        "permission_exception_board_approval_missing",
        "The permission exception requires a linked, completed Board approval decision",
      );
    }

    const actualCwd = asNonEmptyString(runWorkspace?.cwd);
    const cwdRoots = Array.isArray(boundScope.cwdRoots)
      ? boundScope.cwdRoots.filter((value): value is string => typeof value === "string")
      : [];
    const cwdContained = actualCwd && path.isAbsolute(actualCwd)
      ? (await Promise.all(cwdRoots.map((root) => pathIsContainedWithoutSymlinks(actualCwd, root)))).some(Boolean)
      : false;
    if (!cwdContained) {
      permissionGovernanceError(
        "permission_exception_cwd_scope_mismatch",
        "The canary run's actual working directory is outside the approved roots",
      );
    }

    if (Array.isArray(boundScope.networkHosts) && boundScope.networkHosts.length > 0) {
      permissionGovernanceError(
        "permission_exception_network_scope_unenforceable",
        "Host-level network scopes are not enforceable by the current Claude and Codex runtimes",
      );
    }

    if (input.adapterType === "claude_local") {
      const allowedTools = Array.isArray(governedAdapterConfig.allowedTools)
        ? governedAdapterConfig.allowedTools.filter((value): value is string => typeof value === "string")
        : [];
      if (!sameStringArray(boundScope.tools, allowedTools)) {
        permissionGovernanceError(
          "permission_exception_tool_scope_mismatch",
          "Claude allowedTools must exactly match the approved and canary-tested tool scope",
        );
      }
    }

    permissionGovernanceError(
      "global_permission_bypass_unenforceable",
      "Global Claude/Codex permission and sandbox bypasses are disabled because their declared scopes cannot be enforced at runtime",
    );
  }

  function mergeAgentPermissionPatch(existing: unknown, patchValue: unknown) {
    const current = asRecord(existing) ?? {};
    const patch = asRecord(patchValue) ?? {};
    const merged: Record<string, unknown> = { ...current, ...patch };
    const currentBypass = asRecord(current.bypass);
    const patchBypass = asRecord(patch.bypass);
    if (patchBypass) merged.bypass = { ...(currentBypass ?? {}), ...patchBypass };

    const patchException = asRecord(patch.exception);
    if (patchException) {
      if (patchException.kind === "none") {
        merged.exception = { kind: "none" };
      } else {
        const currentException = asRecord(current.exception) ?? {};
        const nextException: Record<string, unknown> = { ...currentException, ...patchException };
        for (const field of ["owner", "scope", "evidence"] as const) {
          const nestedPatch = asRecord(patchException[field]);
          if (nestedPatch) {
            nextException[field] = {
              ...(asRecord(currentException[field]) ?? {}),
              ...nestedPatch,
            };
          }
        }
        merged.exception = nextException;
      }
    }
    return merged;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
    const parsedRuntimeConfig = asRecord(runtimeConfig);
    const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
    const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
    const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

    if (parseBooleanLike(heartbeat.enabled) == null) {
      heartbeat.enabled = false;
    }
    if (parseNumberLike(heartbeat.maxConcurrentRuns) == null) {
      heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
    }

    normalizedRuntimeConfig.heartbeat = heartbeat;
    return normalizedRuntimeConfig;
  }

  function listRuntimeModelProfileAdapterConfigs(runtimeConfig: unknown): Array<{
    profileKey: string;
    profile: Record<string, unknown>;
    adapterConfig: Record<string, unknown>;
    path: string;
  }> {
    const runtimeRecord = asRecord(runtimeConfig);
    const modelProfiles = asRecord(runtimeRecord?.modelProfiles);
    if (!modelProfiles) return [];

    const entries: Array<{
      profileKey: string;
      profile: Record<string, unknown>;
      adapterConfig: Record<string, unknown>;
      path: string;
    }> = [];
    for (const [profileKey, rawProfile] of Object.entries(modelProfiles)) {
      const profile = asRecord(rawProfile);
      const adapterConfig = asRecord(profile?.adapterConfig);
      if (!profile || !adapterConfig) continue;
      entries.push({
        profileKey,
        profile,
        adapterConfig,
        path: `runtimeConfig.modelProfiles.${profileKey}.adapterConfig`,
      });
    }
    return entries;
  }

  function assertNoAgentRuntimeConfigAdapterConfigMutation(req: Request, runtimeConfig: unknown) {
    for (const entry of listRuntimeModelProfileAdapterConfigs(runtimeConfig)) {
      assertNoAgentAdapterConfigMutation(req, entry.adapterConfig, entry.path);
    }
  }

  async function normalizeMediatedAdapterConfigForPersistence(input: {
    companyId: string;
    adapterType: string | null | undefined;
    adapterConfig: Record<string, unknown>;
    constraintAdapterConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      input.companyId,
      input.adapterConfig,
      {
        strictMode: strictSecretsMode,
        adapterType: input.adapterType ?? null,
      },
    );
    await assertAdapterConfigConstraints(
      input.adapterType,
      input.constraintAdapterConfig
        ? { ...input.constraintAdapterConfig, ...normalizedAdapterConfig }
        : normalizedAdapterConfig,
    );
    return normalizedAdapterConfig;
  }

  async function normalizeRuntimeConfigAdapterConfigsForPersistence(
    companyId: string,
    adapterType: string,
    runtimeConfig: Record<string, unknown>,
    baseAdapterConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entries = listRuntimeModelProfileAdapterConfigs(runtimeConfig);
    if (entries.length === 0) return runtimeConfig;
    const adapterModelProfiles = await listAdapterModelProfiles(adapterType);

    const normalizedRuntimeConfig = { ...runtimeConfig };
    const modelProfiles = asRecord(runtimeConfig.modelProfiles) ?? {};
    const normalizedModelProfiles = { ...modelProfiles };
    normalizedRuntimeConfig.modelProfiles = normalizedModelProfiles;

    for (const entry of entries) {
      const adapterProfile = adapterModelProfiles.find((profile) => profile.key === entry.profileKey);
      const adapterDefaultConfig = asRecord(adapterProfile?.adapterConfig) ?? {};
      const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId,
        adapterType,
        adapterConfig: entry.adapterConfig,
        constraintAdapterConfig: {
          ...baseAdapterConfig,
          ...adapterDefaultConfig,
        },
      });
      normalizedModelProfiles[entry.profileKey] = {
        ...entry.profile,
        adapterConfig: normalizedAdapterConfig,
      };
    }

    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function hasConfiguredGatewayDeviceKey(value: unknown): boolean {
    if (asNonEmptyString(value)) return true;
    const binding = asRecord(value);
    if (binding?.type === "plain") return asNonEmptyString(binding.value) !== null;
    if (binding?.type === "secret_ref") return asNonEmptyString(binding.secretId) !== null;
    // Preserve unsupported binding shapes so the secret normalizer rejects
    // them instead of silently replacing operator input with a new literal.
    return binding?.type === "user_secret_ref";
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (hasConfiguredGatewayDeviceKey(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function codexLocalAgentHome(companyId: string, agentId: string): string {
    const instanceRoot = resolvePaperclipInstanceRootForAdapter({
      homeDir: asNonEmptyString(process.env.PAPERCLIP_HOME) ?? undefined,
      instanceId: asNonEmptyString(process.env.PAPERCLIP_INSTANCE_ID) ?? undefined,
      env: process.env,
    });
    return path.resolve(instanceRoot, "companies", companyId, "agents", agentId, "codex-home");
  }

  function codexLocalEnvKeyConfigured(value: unknown): boolean {
    if (asEnvBindingString(value)) return true;
    const record = asRecord(value);
    return record?.type === "secret_ref" && typeof record.secretId === "string";
  }

  // codex_local agents inherit whatever Codex login is already on the device
  // (the host's ~/.codex or $CODEX_HOME) by default, so a fresh agent needs no
  // env overrides at all. We only carve out an isolated per-agent CODEX_HOME
  // when the agent sets its own OPENAI_API_KEY, so that key's api-key auth.json
  // does not collide with the shared company home other agents use for the host
  // login. Agents without a key share the host credentials.
  function applyCodexLocalKeyIsolation(
    companyId: string,
    agentId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "codex_local") return adapterConfig;
    const existingEnv = asRecord(adapterConfig.env);
    if (!existingEnv) return adapterConfig;
    if (!codexLocalEnvKeyConfigured(existingEnv.OPENAI_API_KEY)) return adapterConfig;
    if (codexLocalEnvKeyConfigured(existingEnv.CODEX_HOME)) return adapterConfig;
    return {
      ...adapterConfig,
      env: { ...existingEnv, CODEX_HOME: codexLocalAgentHome(companyId, agentId) },
    };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "acpx_local") {
      if (!asNonEmptyString(next.agent)) {
        next.agent = DEFAULT_ACPX_LOCAL_AGENT;
      }
      if (!asNonEmptyString(next.mode)) {
        next.mode = DEFAULT_ACPX_LOCAL_MODE;
      }
      if (!asNonEmptyString(next.permissionMode)) {
        next.permissionMode = DEFAULT_ACPX_LOCAL_PERMISSION_MODE;
      }
      if (!asNonEmptyString(next.nonInteractivePermissions)) {
        next.nonInteractivePermissions = DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "claude_local") {
      if (typeof next.dangerouslySkipPermissions !== "boolean") {
        next.dangerouslySkipPermissions = false;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "codex_local") {
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "opencode_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_OPENCODE_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return ensureGatewayDeviceKey(adapterType, next);
  }

  async function assertAdapterConfigConstraints(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    try {
      requireOpenCodeModelId(adapterConfig.model);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(
    agent: T,
    input?: { files: Record<string, string>; entryFile?: string },
  ): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      const nextAdapterConfig = { ...adapterConfig };
      const hadLegacyPrompt =
        Object.prototype.hasOwnProperty.call(nextAdapterConfig, "promptTemplate")
        || Object.prototype.hasOwnProperty.call(nextAdapterConfig, "bootstrapPromptTemplate");
      delete nextAdapterConfig.promptTemplate;
      delete nextAdapterConfig.bootstrapPromptTemplate;
      if (!hadLegacyPrompt) return agent;

      const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
      return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
    }

    const files = input?.files
      ?? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role));
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: input?.entryFile ?? "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  function assertNoNewAgentLegacyPromptTemplate(adapterType: string, adapterConfig: Record<string, unknown>) {
    if (!adapterSupportsInstructionsBundle(adapterType)) return;
    if (
      Object.prototype.hasOwnProperty.call(adapterConfig, "promptTemplate")
      || Object.prototype.hasOwnProperty.call(adapterConfig, "bootstrapPromptTemplate")
    ) {
      throw unprocessable(
        "New agents must use instructionsBundle/AGENTS.md instead of adapterConfig.promptTemplate or bootstrapPromptTemplate",
      );
    }
  }

  async function assertCanManageInstructionsPath(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type !== "board") {
      throw forbidden(
        "Only board-authenticated callers can manage instructions path or bundle configuration",
      );
    }
    await assertBoardCanManageAgentsForCompany(req, targetAgent.companyId);
  }

  function assertNoAgentInstructionsConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown> | null | undefined,
    path = "adapterConfig",
  ) {
    if (req.actor.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS
      .filter((key) => adapterConfig[key] !== undefined)
      .map((key) => `${path}.${key}`);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function adapterConfigTouchesInstructionsConfig(adapterConfig: Record<string, unknown>) {
    return KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => adapterConfig[key] !== undefined);
  }

  function assertNoAgentAdapterConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown>,
    path = "adapterConfig",
  ) {
    assertNoAgentInstructionsConfigMutation(req, adapterConfig, path);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path),
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkillEntries: AgentDesiredSkillEntry[] = [],
  ): AgentSkillSnapshot {
    const desiredSkills = desiredSkillEntries.map((entry) => entry.key);
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      desiredSkillEntries,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  function normalizeDesiredSkillSelections(
    requestedDesiredSkills: Array<string | AgentDesiredSkillEntry> | undefined,
  ): AgentDesiredSkillEntry[] | undefined {
    if (!requestedDesiredSkills) return undefined;
    const out = new Map<string, AgentDesiredSkillEntry>();
    for (const value of requestedDesiredSkills) {
      const entry = typeof value === "string"
        ? { key: value.trim(), versionId: null }
        : { key: value.key.trim(), versionId: value.versionId ?? null };
      if (!entry.key || out.has(entry.key)) continue;
      out.set(entry.key, entry);
    }
    return Array.from(out.values());
  }

  // Legacy hardcoded set — used as fallback when adapter module does not
  // declare requiresMaterializedRuntimeSkills explicitly.
  const LEGACY_MATERIALIZED_SKILLS_SET = new Set([
    "cursor",
    "gemini_local",
    "opencode_local",
    "pi_local",
  ]);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.requiresMaterializedRuntimeSkills !== undefined) {
      return adapter.requiresMaterializedRuntimeSkills;
    }
    return LEGACY_MATERIALIZED_SKILLS_SET.has(adapterType);
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
    options: {
      materializeMissing?: boolean;
    } = {},
  ) {
    const preference = readPaperclipSkillSyncPreference(config);
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: options.materializeMissing
        ?? shouldMaterializeRuntimeSkillsForAdapter(adapterType),
      versionSelections: skillVersionSelectionMap(preference.desiredSkillEntries),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: AgentDesiredSkillEntry[] | undefined,
  ) {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null as string[] | null,
        desiredSkillEntries: null as AgentDesiredSkillEntry[] | null,
        runtimeSkillEntries: null as Awaited<ReturnType<typeof companySkills.listRuntimeSkillEntries>> | null,
      };
    }

    const resolvedRequestedSkillEntries = await companySkills.resolveRequestedSkillEntries(
      companyId,
      requestedDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
      versionSelections: skillVersionSelectionMap(resolvedRequestedSkillEntries),
    });
    const desiredSkillEntries = resolvedRequestedSkillEntries.filter(
      (entry, index, entries) => entries.findIndex((candidate) => candidate.key === entry.key) === index,
    );
    const desiredSkills = desiredSkillEntries.map((entry) => entry.key);

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkillEntries),
      desiredSkills,
      desiredSkillEntries,
      runtimeSkillEntries,
    };
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const refresh = typeof req.query.refresh === "string"
      ? ["1", "true", "yes"].includes(req.query.refresh.toLowerCase())
      : false;
    const environmentId = asNonEmptyString(req.query.environmentId);
    const environment = environmentId ? await environmentsSvc.getById(environmentId) : null;
    if (environmentId && !environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    if (type === "opencode_local" && environment && environment.driver !== "local") {
      const adapter = requireServerAdapter(type);
      res.json(adapter.models ?? []);
      return;
    }
    const models = refresh
      ? await refreshAdapterModels(type)
      : await listAdapterModels(type);
    res.json(models);
  });

  router.get("/companies/:companyId/adapters/:type/model-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const profiles = await listAdapterModelProfiles(type);
    res.json(profiles);
  });

  router.get("/companies/:companyId/adapters/:type/detect-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);

    const detected = await detectAdapterModel(type);
    res.json(detected);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = assertKnownAdapterType(req.params.type as string);
      await assertCanCreateAgentsForCompany(req, companyId);

      const adapter = requireServerAdapter(type);

      const inputAdapterConfig =
        (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const requestedEnvironmentId =
        typeof req.body?.environmentId === "string" && req.body.environmentId.trim().length > 0
          ? (req.body.environmentId as string)
          : null;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode, adapterType: type },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
        undefined,
        { adapterType: type },
      );
      if (requiredPermissionBypass(type, runtimeAdapterConfig)) {
        permissionGovernanceError(
          "global_permission_bypass_unenforceable",
          "Global Claude/Codex permission and sandbox bypasses are disabled for environment probes",
        );
      }
      assertAdapterSecurityConfigFailClosed(type, runtimeAdapterConfig);

      const { executionTarget, environmentName, fallbackChecks, release } =
        await resolveAdapterTestExecutionContext({
          companyId,
          adapterType: type,
          environmentId: requestedEnvironmentId,
        });

      let releaseStatus: "released" | "failed" = "released";
      try {
        // If the caller explicitly selected an environment, never fall back to
        // probing the host when we couldn't resolve that environment's
        // execution target. Surface the diagnostic checks instead.
        if (requestedEnvironmentId && !executionTarget && fallbackChecks.length > 0) {
          const status: AdapterEnvironmentTestResult["status"] = fallbackChecks.some((c) => c.level === "error")
            ? "fail"
            : fallbackChecks.some((c) => c.level === "warn")
              ? "warn"
              : "pass";
          if (status === "fail") releaseStatus = "failed";
          const synthesized: AdapterEnvironmentTestResult = {
            adapterType: type,
            status,
            checks: fallbackChecks,
            testedAt: new Date().toISOString(),
          };
          res.json(synthesized);
          return;
        }

        const result = await adapter.testEnvironment({
          companyId,
          adapterType: type,
          config: runtimeAdapterConfig,
          executionTarget,
          environmentName,
        });

        if (result.status === "fail") releaseStatus = "failed";
        res.json(result);
      } catch (err) {
        releaseStatus = "failed";
        throw err;
      } finally {
        await release(releaseStatus);
      }
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);

    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const desiredSkillEntries = preference.desiredSkillEntries.filter(
        (entry, index, entries) => entries.findIndex((candidate) => candidate.key === entry.key) === index,
      );
      res.json(buildUnsupportedSkillSnapshot(agent.adapterType, desiredSkillEntries));
      return;
    }

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
      { materializeMissing: false },
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    res.json(snapshot);
  });

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCanUpdateAgent(req, agent);

      const requestedSkills = normalizeDesiredSkillSelections(req.body.desiredSkills);
      const {
        adapterConfig: nextAdapterConfig,
        desiredSkills,
        desiredSkillEntries,
        runtimeSkillEntries,
      } = await resolveDesiredSkillAssignment(
        agent.companyId,
        agent.adapterType,
        agent.adapterConfig as Record<string, unknown>,
        requestedSkills,
      );
      if (!desiredSkills || !desiredSkillEntries || !runtimeSkillEntries) {
        throw unprocessable("Skill sync requires desiredSkills.");
      }
      const actor = getActorInfo(req);
      const updated = await svc.update(agent.id, {
        adapterConfig: nextAdapterConfig,
      }, {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-sync",
        },
      });
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const adapter = findActiveServerAdapter(updated.adapterType);
      const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        updated.companyId,
        updated.adapterConfig,
      );
      const runtimeSkillConfig = {
        ...runtimeConfig,
        paperclipRuntimeSkills: runtimeSkillEntries,
      };
      const snapshot = adapter?.syncSkills
        ? await adapter.syncSkills({
            agentId: updated.id,
            companyId: updated.companyId,
            adapterType: updated.adapterType,
            config: runtimeSkillConfig,
          }, desiredSkills)
        : adapter?.listSkills
          ? await adapter.listSkills({
              agentId: updated.id,
              companyId: updated.companyId,
              adapterType: updated.adapterType,
              config: runtimeSkillConfig,
            })
          : buildUnsupportedSkillSnapshot(updated.adapterType, desiredSkillEntries);

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.skills_synced",
        entityType: "agent",
        entityId: updated.id,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          adapterType: updated.adapterType,
          desiredSkills,
          desiredSkillEntries,
          mode: snapshot.mode,
          supported: snapshot.supported,
          entryCount: snapshot.entries.length,
          warningCount: snapshot.warnings.length,
        },
      });

      res.json(snapshot);
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryParams = Object.keys(req.query).sort();
    if (unsupportedQueryParams.length > 0) {
      res.status(400).json({
        error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}`,
      });
      return;
    }
    const result = await filterAgentsForActor(req, await svc.list(companyId));
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    if (canReadConfigs) {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const trustPreset = await resolveAgentSelfTrustPreset(req, agent);
    if (trustPreset.kind === "denied") {
      res.status(403).json({ error: trustPreset.detail });
      return;
    }
    if (trustPreset.kind === "low_trust_review") {
      res.json(buildLowTrustSelfView(agent));
      return;
    }
    if (req.actor.keyScope?.kind === "task_bridge") {
      res.json({
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        keyScope: req.actor.keyScope,
      });
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const issuesSvc = issueService(db);
    const recoveryActionsSvc = issueRecoveryActionService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      assigneeAgentId: req.actor.agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });
    const issueIds = rows.map((issue) => issue.id);
    const [dependencyReadiness, recoveryActionByIssue] = await Promise.all([
      issuesSvc.listDependencyReadiness(req.actor.companyId, issueIds),
      recoveryActionsSvc.listActiveForIssues(req.actor.companyId, issueIds),
    ]);

    res.json(
      rows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
        activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
        dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
        unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
        unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
      })),
    );
  });

  router.get("/agents/me/inbox/mine", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const query = agentMineInboxQuerySchema.parse(req.query);
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });

    res.json(rows);
  });

  // Register the dynamic-id mutation guard after every static /agents/me
  // route. Otherwise Express resolves `me` through router.param("id") for
  // this middleware before the static self route can handle the request.
  router.use("/agents/:id", (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }

    const routePath = req.originalUrl.split("?", 1)[0] ?? "";
    if (
      req.method === "POST" &&
      (routePath.endsWith("/retirement-preflight") || routePath.endsWith("/retirement-postcheck"))
    ) {
      next();
      return;
    }

    const agentId = req.params.id as string;
    if (/\/agents\/[^/]+\/(?:permissions|keys)(?:\/|$)/.test(routePath)) {
      assertHistoricalAgentTombstoneAccessMutable(agentId);
    } else {
      assertHistoricalAgentTombstoneMutable(agentId);
    }
    next();
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    if (!(await assertAgentReadAllowed(req, res, agent))) return;
    const isSelf = req.actor.type === "agent" && req.actor.agentId === id;
    if (isSelf) {
      const trustPreset = await resolveAgentSelfTrustPreset(req, agent);
      if (trustPreset.kind === "denied") {
        res.status(403).json({ error: trustPreset.detail });
        return;
      }
      if (trustPreset.kind === "low_trust_review") {
        res.json(buildLowTrustSelfView(agent));
        return;
      }
    }
    const canReadSensitiveDetail = isSelf
      ? true
      : await actorCanReadConfigurationsForCompany(req, agent.companyId);
    if (!canReadSensitiveDetail) {
      res.json(await buildAgentDetail(agent, { restricted: true }));
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      ...hireInput
    } = req.body;
    hireInput.adapterType = assertKnownAdapterType(hireInput.adapterType);
    const rawHireAdapterConfig = (hireInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      hireInput.adapterType,
      rawHireAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawHireAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, hireInput.runtimeConfig);
    const hiredAgentId = randomUUID();
    const requestedAdapterConfig = applyCodexLocalKeyIsolation(
      companyId,
      hiredAgentId,
      hireInput.adapterType,
      applyCreateDefaultsByAdapterType(
        hireInput.adapterType,
        rawHireAdapterConfig,
      ),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType,
      requestedAdapterConfig,
      normalizeDesiredSkillSelections(Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined),
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: hireInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      hireInput.adapterType,
      normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    await assertPermissionBypassGoverned({
      agentId: hiredAgentId,
      companyId,
      adapterType: hireInput.adapterType,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      permissions: hireInput.permissions,
    });
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(companyId, {
      id: hiredAgentId,
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyAgentTaskAssignGrant(
      companyId,
      agent,
      actor.actorType === "user" ? actor.actorId : null,
      { allowPendingApproval: agent.status === "pending_approval" },
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    res.status(201).json({ agent, approval });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (company.requireBoardApprovalForNewAgents) {
      throw conflict(
        "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
      );
    }

    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      ...createInput
    } = req.body;
    createInput.adapterType = assertKnownAdapterType(createInput.adapterType);
    const rawCreateAdapterConfig = (createInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      createInput.adapterType,
      rawCreateAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawCreateAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, createInput.runtimeConfig);
    const agentId = randomUUID();
    const requestedAdapterConfig = applyCodexLocalKeyIsolation(
      companyId,
      agentId,
      createInput.adapterType,
      applyCreateDefaultsByAdapterType(
        createInput.adapterType,
        rawCreateAdapterConfig,
      ),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      createInput.adapterType,
      requestedAdapterConfig,
      normalizeDesiredSkillSelections(Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined),
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: createInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      createInput.adapterType,
      normalizeNewAgentRuntimeConfig(createInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    await assertPermissionBypassGoverned({
      agentId,
      companyId,
      adapterType: createInput.adapterType,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      permissions: createInput.permissions,
    });
    await assertAgentEnvironmentSelection(companyId, createInput.adapterType, createInput.defaultEnvironmentId);
    await assertAgentDefaultEnvironmentSelection(companyId, createInput.defaultEnvironmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(createInput.adapterType),
      allowedSandboxProviders: allowedSandboxProvidersForAgent(createInput.adapterType),
    });

    const createdAgent = await svc.create(companyId, {
      id: agentId,
      ...createInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyAgentTaskAssignGrant(
      companyId,
      agent,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    res.status(201).json(agent);
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageAgentPermissions(req, existing);

    const currentCanAssignTasks = await access.hasPermission(
      existing.companyId,
      "agent",
      existing.id,
      "tasks:assign",
    );
    const effectivePermissions = mergeAgentPermissionPatch(existing.permissions, req.body);
    const requestedCanAssignTasks = typeof req.body.canAssignTasks === "boolean"
      ? req.body.canAssignTasks
      : asRecord(existing.permissions)?.canAssignTasks === true || currentCanAssignTasks;
    const effectiveCanAssignTasks = existing.role === "ceo" || requestedCanAssignTasks;
    effectivePermissions.canAssignTasks = effectiveCanAssignTasks;
    await assertPermissionBypassGoverned({
      agentId: existing.id,
      companyId: existing.companyId,
      adapterType: existing.adapterType,
      adapterConfig: asRecord(existing.adapterConfig) ?? {},
      runtimeConfig: asRecord(existing.runtimeConfig) ?? {},
      permissions: effectivePermissions,
    });

    const agent = await svc.updatePermissions(id, effectivePermissions as Record<string, unknown> & { canCreateAgents: boolean });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canCreateSkills: agent.permissions?.canCreateSkills ?? true,
        canAssignTasks: effectiveCanAssignTasks,
        trustPreset: agent.permissions?.trustPreset ?? "standard",
      },
    });

    res.json(await buildAgentDetail(agent));
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    if (req.actor.type !== "board") {
      throw forbidden("Only board-authenticated callers can manage instructions path or bundle configuration");
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    res.json(await instructions.getBundle(existing));
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const patchData = { ...(req.body as Record<string, unknown>) };
    const lifecycleTransition = patchData.lifecycleTransition as AgentLifecycleTransition | undefined;
    delete patchData.lifecycleTransition;
    if (lifecycleTransition) assertBoard(req);
    const requestMetadata = Object.prototype.hasOwnProperty.call(patchData, "metadata")
      ? asRecord(patchData.metadata)
      : null;
    if (
      patchData.metadata === null
      && Object.prototype.hasOwnProperty.call(asRecord(existing.metadata) ?? {}, "lifecycle")
    ) {
      throw unprocessable("An existing lifecycle contract cannot be removed", {
        code: "agent_lifecycle_removal_forbidden",
      });
    }
    if (requestMetadata) {
      const mergedMetadata = {
        ...(asRecord(existing.metadata) ?? {}),
        ...requestMetadata,
      };
      if (lifecycleTransition?.mode === "reviewed_passed_revalidation") {
        for (const key of SERVER_MANAGED_AGENT_LIFECYCLE_GATE_KEYS) {
          delete mergedMetadata[key];
        }
      }
      patchData.metadata = mergedMetadata;
    }
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;
    if (hasOwn(patchData, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      assertNoAgentAdapterConfigMutation(req, adapterConfig);
      const changingInstructionsConfig = adapterConfigTouchesInstructionsConfig(adapterConfig);
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsPath(req, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    let requestedRuntimeConfig: Record<string, unknown> | null = null;
    if (hasOwn(patchData, "runtimeConfig")) {
      const runtimeConfig = asRecord(patchData.runtimeConfig);
      if (!runtimeConfig) {
        res.status(422).json({ error: "runtimeConfig must be an object" });
        return;
      }
      assertNoAgentRuntimeConfigAdapterConfigMutation(req, runtimeConfig);
      requestedRuntimeConfig = runtimeConfig;
    }
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (KNOWN_INSTRUCTIONS_BUNDLE_KEY_SET.has(key)) continue;
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCodexLocalKeyIsolation(
        existing.companyId,
        existing.id,
        requestedAdapterType,
        applyCreateDefaultsByAdapterType(
          requestedAdapterType,
          rawEffectiveAdapterConfig,
        ),
      );
      const normalizedEffectiveAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId: existing.companyId,
        adapterType: requestedAdapterType,
        adapterConfig: effectiveAdapterConfig,
      });
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (requestedRuntimeConfig) {
      const baseAdapterConfig = asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {};
      patchData.runtimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
        existing.companyId,
        requestedAdapterType,
        requestedRuntimeConfig,
        baseAdapterConfig,
      );
    }
    const lifecycleCandidate = {
      ...existing,
      ...patchData,
      adapterType: requestedAdapterType,
      adapterConfig: asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {},
      runtimeConfig: asRecord(patchData.runtimeConfig) ?? asRecord(existing.runtimeConfig) ?? {},
      permissions: existing.permissions,
      metadata: Object.prototype.hasOwnProperty.call(patchData, "metadata")
        ? patchData.metadata
        : existing.metadata,
    };
    if (
      lifecycleTransition
      || Boolean(requestMetadata && Object.prototype.hasOwnProperty.call(requestMetadata, "lifecycle"))
    ) {
      const transitionResult = validateAgentLifecyclePatchTransition({
        previousLifecycle: (asRecord(existing.metadata) ?? {}).lifecycle,
        nextLifecycle: (asRecord(lifecycleCandidate.metadata) ?? {}).lifecycle,
        transition: lifecycleTransition,
        currentAgentUpdatedAt: existing.updatedAt,
        nextAgentStatus: typeof lifecycleCandidate.status === "string"
          ? lifecycleCandidate.status
          : existing.status,
        fingerprintRelevantChange: ["adapterType", "adapterConfig", "runtimeConfig", "permissions"]
          .some((key) => Object.prototype.hasOwnProperty.call(patchData, key)),
      });
      if (!transitionResult.ok) {
        throw conflict("Agent lifecycle transition is not allowed through a board/config PATCH", {
          code: "agent_lifecycle_transition_forbidden",
          reason: transitionResult.reason,
        });
      }
    }
    const lifecycleGateRefresh = lifecycleTransition?.mode === "reviewed_passed_revalidation"
      ? null
      : await refreshLifecycleReceiptForPatch({
          existing,
          candidate: lifecycleCandidate,
          patchData,
          requestMetadata,
        });
    if (patchData.status === "idle") {
      await assertLifecycleGate(lifecycleCandidate);
    }
    await assertPermissionBypassGoverned({
      agentId: existing.id,
      companyId: existing.companyId,
      adapterType: requestedAdapterType,
      adapterConfig: asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {},
      runtimeConfig: asRecord(patchData.runtimeConfig) ?? asRecord(existing.runtimeConfig) ?? {},
      permissions: existing.permissions,
    });
    if (touchesAdapterConfiguration || Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")) {
      await assertAgentDefaultEnvironmentSelection(
        existing.companyId,
        Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")
          ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null)
          : existing.defaultEnvironmentId,
        {
          allowedDrivers: allowedEnvironmentDriversForAgent(requestedAdapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(requestedAdapterType),
        },
      );
    }

    const actor = getActorInfo(req);
    const updateOptions = {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
      ...(lifecycleTransition ? { lifecycleTransition } : {}),
    };
    const agent = lifecycleGateRefresh
      ? await svc.updateLifecycleGate(id, patchData, {
          ...updateOptions,
          lifecycleGate: lifecycleGateRefresh.lifecycleGate,
          expectedAgentUpdatedAt: existing.updatedAt.toISOString(),
        })
      : await svc.update(id, patchData, updateOptions);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        ...summarizeAgentUpdateDetails(patchData),
        ...(lifecycleTransition ? { lifecycleTransition } : {}),
      },
    });

    res.json(agent);
  });

  router.get(
    "/agents/:id/adapter-secrets/externalization-preflight",
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
      res.json(await adapterSecretExternalization.preflight(id, existing.companyId));
    },
  );

  router.post(
    "/agents/:id/adapter-secrets/externalization-proof",
    validate(adapterSecretExternalizationProofSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
      if (req.body.expectedCompanyId !== existing.companyId) {
        throw conflict("Agent company does not match adapter secret proof request", {
          code: "agent_adapter_secret_company_mismatch",
        });
      }
      res.json(await adapterSecretExternalization.proof(
        id,
        existing.companyId,
        req.body.expectedReceipt,
      ));
    },
  );

  router.post(
    "/agents/:id/adapter-secrets/externalize",
    validate(adapterSecretExternalizationSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
      if (req.body.expectedCompanyId !== existing.companyId) {
        throw conflict("Agent company does not match adapter secret externalization request", {
          code: "agent_adapter_secret_company_mismatch",
        });
      }
      const actor = getActorInfo(req);
      const result = await adapterSecretExternalization.externalize(
        id,
        req.body,
        { userId: actor.actorType === "user" ? actor.actorId : null },
      );

      await logActivity(db, {
        companyId: result.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.adapter_secrets_externalized",
        entityType: "agent",
        entityId: result.agentId,
        details: {
          createdSecretCount: result.createdSecretCount,
          createdSecretIds: result.createdSecretIds,
          removedHeaderCount: result.removedHeaderCount,
          removedHeaderPaths: result.removedHeaderPaths,
          secretRefCount: result.secretRefCount,
          secretRefPaths: result.secretRefPaths,
          secretIds: result.secretIds,
          configFingerprint: result.configFingerprint,
          preflightReceipt: result.preflightReceipt,
          proofReceipt: result.proof.receipt,
          updatedAt: result.updatedAt,
        },
      });

      res.json(result);
    },
  );

  router.get("/agents/:id/lifecycle-canary-preflight", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) return;
    await assertBoardCanManageAgentsForCompany(req, existing.companyId);

    const blockers: Array<{ code: string; message: string }> = [];
    if (existing.status !== "paused") {
      blockers.push({
        code: "agent_not_paused",
        message: "Lifecycle canary bootstrap requires a paused agent.",
      });
    }
    const metadata = asRecord(existing.metadata) ?? {};
    const lifecycleResult = agentLifecycleSchema.safeParse(metadata.lifecycle);
    let canaryIssueId: string | null = null;
    let configFingerprint: string | null = null;
    if (!lifecycleResult.success) {
      blockers.push({ code: "lifecycle_invalid", message: "The lifecycle contract is structurally invalid." });
    } else if (lifecycleResult.data.lastCanaryResult !== "pending") {
      blockers.push({
        code: "lifecycle_not_pending",
        message: "A failed or passed lifecycle requires an explicit reviewed PATCH before another pending canary.",
      });
      canaryIssueId = lifecycleResult.data.canaryIssueId;
    } else if (!lifecycleResult.data.canaryIssueId) {
      blockers.push({
        code: "canary_issue_missing",
        message: "Patch a reviewed canary issue UUID into the pending lifecycle contract first.",
      });
    } else {
      canaryIssueId = lifecycleResult.data.canaryIssueId;
      try {
        configFingerprint = computeAgentLifecycleConfigFingerprint(
          await buildLifecycleFingerprintInput(existing),
        );
      } catch (error) {
        blockers.push({
          code: "fingerprint_unavailable",
          message: error instanceof Error ? error.message : "Current lifecycle fingerprint could not be calculated.",
        });
      }
      const isolation = await heartbeat.inspectLifecycleCanaryIsolation({
        agentId: existing.id,
        companyId: existing.companyId,
        canaryIssueId,
      });
      blockers.push(...isolation.blockers);
    }

    res.json({
      agentId: existing.id,
      companyId: existing.companyId,
      canaryIssueId,
      ready: blockers.length === 0 && configFingerprint !== null,
      blockers,
      configFingerprint,
      agentUpdatedAt: existing.updatedAt.toISOString(),
    });
  });

  router.post("/agents/:id/pause", validate(pauseAgentSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    if (isAgentRetirementSource(id)) {
      throw conflict("This agent requires the gated retirement workflow", {
        code: "retirement_gated_termination_required",
        sourceAgentId: id,
      });
    }
    const pauseReason = req.body.reason as "manual" | "maintenance";
    const maintenanceOptions = pauseReason === "maintenance"
      ? { maintenanceOperationId: req.body.operationId as string }
      : undefined;
    const agent = await svc.pause(id, pauseReason, maintenanceOptions);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
      details: pauseReason === "maintenance"
        ? { pauseReason: agent.pauseReason, maintenanceOperationId: maintenanceOptions!.maintenanceOperationId }
        : { pauseReason: agent.pauseReason },
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", validate(resumeAgentSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: existing.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before resuming it",
      });
      return;
    }
    if (req.body.mode === "pending_canary") {
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
      const expectedAgentUpdatedAt = new Date(req.body.expectedAgentUpdatedAt);
      if (existing.updatedAt.getTime() !== expectedAgentUpdatedAt.getTime()) {
        throw conflict("Agent changed after lifecycle canary preflight", {
          code: "agent_lifecycle_canary_agent_changed",
          currentAgentUpdatedAt: existing.updatedAt.toISOString(),
        });
      }
      if (existing.status !== "paused") {
        throw conflict("Lifecycle canary bootstrap requires a paused agent", {
          code: "agent_lifecycle_canary_status_invalid",
        });
      }
      const metadata = asRecord(existing.metadata) ?? {};
      const lifecycleResult = agentLifecycleSchema.safeParse(metadata.lifecycle);
      if (!lifecycleResult.success || lifecycleResult.data.lastCanaryResult !== "pending") {
        throw conflict("Lifecycle canary bootstrap requires a pending lifecycle contract", {
          code: "agent_lifecycle_canary_lifecycle_invalid",
        });
      }
      if (lifecycleResult.data.canaryIssueId !== req.body.canaryIssueId) {
        throw conflict("Pending lifecycle canary issue does not match the requested issue", {
          code: "agent_lifecycle_canary_issue_mismatch",
        });
      }
      const fingerprintInput = await buildLifecycleFingerprintInput(existing);
      const currentConfigFingerprint = computeAgentLifecycleConfigFingerprint(fingerprintInput);
      if (currentConfigFingerprint !== req.body.expectedConfigFingerprint) {
        throw conflict("Expected lifecycle config fingerprint does not match current configuration", {
          code: "agent_lifecycle_canary_fingerprint_mismatch",
        });
      }
      const runId = randomUUID();
      let receipt;
      try {
        receipt = createAgentLifecycleCanaryReceipt({
          fingerprintInput,
          canaryIssueId: req.body.canaryIssueId,
          runId,
          expectedConfigFingerprint: req.body.expectedConfigFingerprint,
        });
      } catch (error) {
        throw conflict(
          error instanceof Error ? error.message : "Lifecycle canary bootstrap validation failed",
          { code: "agent_lifecycle_canary_policy_invalid" },
        );
      }
      const queued = await heartbeat.enqueueLifecycleCanary({
        agentId: existing.id,
        companyId: existing.companyId,
        canaryIssueId: req.body.canaryIssueId,
        receipt,
        expectedAgentUpdatedAt,
        requestedByUserId: req.actor.userId ?? "board",
        ...(req.body.systemReplacementProof
          ? { systemReplacementProof: req.body.systemReplacementProof }
          : {}),
      });
      res.status(202).json({
        agentId: existing.id,
        canaryIssueId: req.body.canaryIssueId,
        runId: queued.run.id,
        receiptExpiresAt: receipt.expiresAt,
      });
      return;
    }
    await assertLifecycleGate(existing);
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/clear-error", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: existing.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before clearing its error",
      });
      return;
    }

    await assertLifecycleGate(existing);

    const agent = await svc.clearError(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/approve", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.status !== "pending_approval") {
      res.status(409).json({ error: "Only pending approval agents can be approved" });
      return;
    }

    // Resolve the linked hire approval (clears it from the inbox) and run the
    // shared approval side effects: agent activation, budget policy, and the
    // hire-approved notification. Fall back to direct activation if no open
    // approval record exists (e.g. agents created before approvals were tracked).
    const decidedByUserId = req.actor.userId ?? "board";
    const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);

    let agent: Awaited<ReturnType<typeof svc.getById>> | null = null;
    if (openApproval) {
      await approvalsSvc.approve(openApproval.id, decidedByUserId);
      agent = await svc.getById(id);
    } else {
      const approval = await svc.activatePendingApproval(id);
      if (!approval) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!approval.activated) {
        res.status(409).json({ error: "Only pending approval agents can be approved" });
        return;
      }
      agent = approval.agent;
    }

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.approved",
      entityType: "agent",
      entityId: agent.id,
      details: { source: "agent_detail", approvalId: openApproval?.id ?? null },
    });

    res.json(agent);
  });

  router.post("/agents/:id/retirement-preflight", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) return;
    const parsed = z.union([
      agentRetirementPreflightRequestSchema,
      agentRetirementExecutionRecoveryRequestSchema,
      agentRetirementEvidenceSchema,
    ]).safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Retirement evidence is invalid", {
        code: "retirement_evidence_invalid",
        issues: parsed.error.issues,
      });
    }
    res.json(await retirement.preflight(id, parsed.data, {
      actorUserId: req.actor.userId ?? "board",
    }));
  });

  router.post("/agents/:id/retirement-cleanup", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) return;
    const parsed = agentRetirementCleanupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Retirement cleanup evidence is invalid", {
        code: "retirement_cleanup_invalid",
        issues: parsed.error.issues,
      });
    }
    res.json(await retirement.cleanup(id, parsed.data, {
      actorUserId: req.actor.userId ?? "board",
    }));
  });

  router.post("/agents/:id/retirement-postcheck", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) return;
    const parsed = agentRetirementTerminationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Retirement termination evidence is invalid", {
        code: "retirement_termination_invalid",
        issues: parsed.error.issues,
      });
    }
    res.json(await retirement.postcheck(id, parsed.data));
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    let authorizedRetirementAgent: Awaited<ReturnType<typeof svc.terminate>> = null;
    let retirementGated = false;
    if (isAgentRetirementSource(id)) {
      retirementGated = true;
      const parsed = agentRetirementTerminationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest("Retirement termination evidence is invalid", {
          code: "retirement_termination_invalid",
          issues: parsed.error.issues,
        });
      }
      const authorized = await retirement.terminateAuthorized(id, parsed.data, {
        actorUserId: req.actor.userId ?? "board",
      });
      authorizedRetirementAgent = await svc.getById(authorized.agent.id);
      if (!authorizedRetirementAgent) {
        throw notFound("Agent not found");
      }
    }

    // Terminating an agent that is still awaiting approval is the agent-detail
    // equivalent of rejecting the hire. When a linked hire approval is still
    // open, delegate to approvalsSvc.reject(), which both resolves the approval
    // (clearing the inbox "Approve/Reject" card) and terminates the agent.
    // Mirror the approve path's branch-or-fallback so we never terminate twice:
    // reject() already calls agentsSvc.terminate() internally.
    let agent: Awaited<ReturnType<typeof svc.terminate>> = authorizedRetirementAgent;
    if (!agent && existing.status === "pending_approval") {
      const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);
      if (openApproval) {
        await approvalsSvc.reject(openApproval.id, req.actor.userId ?? "board");
        agent = await svc.getById(id);
      }
    }
    if (!agent) {
      agent = await svc.terminate(id, {
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        source: "agent_terminate_route",
      });
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const companyAgentRows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        reportsTo: agentsTable.reportsTo,
        status: agentsTable.status,
      })
      .from(agentsTable)
      .where(eq(agentsTable.companyId, agent.companyId));
    const invalidOrgChainDescendantIds = listInvalidOrgChainDescendantIds(id, companyAgentRows);
    const cancellation = await heartbeat.cancelInvocationsForAgents(
      [id, ...invalidOrgChainDescendantIds],
      "Cancelled because the agent was terminated or became invalid-org-chain under a terminated manager",
    );

    if (!retirementGated) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent.termination_followup",
        entityType: "agent",
        entityId: agent.id,
        details: {
          invalidOrgChain: {
            descendantCount: invalidOrgChainDescendantIds.length,
            descendantIds: invalidOrgChainDescendantIds,
            state: invalidOrgChainDescendantIds.length > 0 ? "descendants_invalid_under_terminated_manager" : "none",
          },
          cancellation: {
            agentIds: cancellation.agentIds,
            runsCancelled: cancellation.runsCancelled,
            wakeupsCancelled: cancellation.wakeupsCancelled,
          },
        },
      });
    }

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    if (isAgentRetirementSource(id)) {
      throw conflict("Retirement sources must retain their tombstone and historical attribution", {
        code: "retirement_physical_delete_forbidden",
      });
    }
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const key = await svc.createApiKey(id, req.body.name, req.body.scope, {
      responsibleUserId: req.actor.userId ?? null,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        keyId: key.id,
        name: key.name,
        scope: key.scope,
        responsibleUserId: key.responsibleUserId,
      },
    });

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keyId = req.params.keyId as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }

    const key = await svc.getKeyById(keyId);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    const revoked = await svc.revokeKey(agent.id, keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.json({ ok: true });
  });

  // Shared handler body for the wakeup-style endpoints. The two routes differ
  // only in:
  //  - `source` — the modern /wakeup endpoint reads it from the request body
  //    (timer|assignment|on_demand|automation) while the legacy
  //    /heartbeat/invoke endpoint hardcodes "on_demand", since it has only
  //    ever produced on-demand invocations.
  //  - skipped-response shape — the modern endpoint surfaces the rich
  //    SkippedWakeupResponse; the legacy endpoint stays on the simpler
  //    { status: "skipped" } shape for backward compat.
  type HeartbeatSource = "timer" | "assignment" | "on_demand" | "automation";
  type WakeupRouteOpts = {
    source: HeartbeatSource | undefined;
    skippedResponse: (agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) => unknown | Promise<unknown>;
  };
  const handleWakeupRoute = async (
    req: Request,
    res: Response,
    opts: WakeupRouteOpts,
  ): Promise<void> => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    if (agent.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: agent.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before starting runs",
      });
      return;
    }

    const run = await heartbeat.wakeup(id, {
      source: opts.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json(await opts.skippedResponse(agent));
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  };

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    await handleWakeupRoute(req, res, {
      source: req.body.source,
      skippedResponse: (agent) => buildSkippedWakeupResponse(agent, req.body.payload ?? null),
    });
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    // Legacy endpoint. Hardcodes `source: "on_demand"` (the prior behavior
    // before the wakeup/invoke convergence). Reads scope fields directly off
    // the body without `validate(wakeAgentSchema)` because callers — including
    // the e2e suite — post an empty body, and the schema rejects undefined
    // / missing bodies. Only forwards fields the caller actually supplied so
    // an empty body produces the original fixed-arg `heartbeat.invoke()`
    // shape exactly.
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    if (agent.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: agent.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before starting runs",
      });
      return;
    }

    const body = (req.body ?? {}) as Partial<{
      reason: unknown;
      payload: unknown;
      idempotencyKey: unknown;
      forceFreshSession: unknown;
      triggerDetail: unknown;
    }>;
    const contextSnapshot: Record<string, unknown> = {
      triggeredBy: req.actor.type,
      actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
    };
    if (body.forceFreshSession === true) {
      contextSnapshot.forceFreshSession = true;
    }
    const wakeOpts: Parameters<typeof heartbeat.wakeup>[1] = {
      source: "on_demand",
      triggerDetail: typeof body.triggerDetail === "string" ? body.triggerDetail as "manual" | "system" | "ping" | "callback" : "manual",
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot,
    };
    if (typeof body.reason === "string" && body.reason.length > 0) {
      wakeOpts.reason = body.reason;
    }
    if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
      wakeOpts.payload = body.payload as Record<string, unknown>;
    }
    if (typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0) {
      wakeOpts.idempotencyKey = body.idempotencyKey;
    }
    const run = await heartbeat.wakeup(id, wakeOpts);

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const summary = req.query.summary === "true" || req.query.summary === "1";
    const runs = await heartbeat.list(companyId, agentId, limit, { summary });
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // `minCount` is a padding floor for callers that want a minimum number of
    // recent runs to render (e.g. dashboard cards). It must default to 0 so
    // callers asking for "live runs" get only actually-live runs — otherwise
    // every caller with no minCount param gets up to 50 historical runs
    // padded in and renders bogus "live" counts.
    const minCount = readLiveRunsQueryInt(req.query.minCount, 50, 0);
    const limit = readLiveRunsQueryInt(req.query.limit, 50, 50);

    const columns = {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
      contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      logBytes: heartbeatRuns.logBytes,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      continuationAttempt: heartbeatRuns.continuationAttempt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      nextAction: heartbeatRuns.nextAction,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      lastOutputBytes: heartbeatRuns.lastOutputBytes,
      processStartedAt: heartbeatRuns.processStartedAt,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRunsQuery = db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const liveRuns = await liveRunsQuery.limit(limit);
    const targetRunCount = Math.min(minCount, limit);

    if (targetRunCount > 0 && liveRuns.length < targetRunCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(targetRunCount - liveRuns.length);

      const rows = [...liveRuns, ...recentRuns];
      res.json(await Promise.all(rows.map(async (run) => ({
        ...heartbeat.decorateActiveRunStatus(run),
        outputSilence: await heartbeat.buildRunOutputSilence(run),
      }))));
      return;
    }

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...heartbeat.decorateActiveRunStatus(run),
      outputSilence: await heartbeat.buildRunOutputSilence(run),
    }))));
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const retryExhaustedReason = await heartbeat.getRetryExhaustedReason(runId);
    const decoratedRun = heartbeat.decorateActiveRunStatus(run);
    res.json(
      redactCurrentUserValue(
        { ...decoratedRun, retryExhaustedReason, outputSilence: await heartbeat.buildRunOutputSilence(run) },
        await getCurrentUserRedactionOptions(),
      ),
    );
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (existing) {
      assertCompanyAccess(req, existing.companyId);
    }
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.post("/heartbeat-runs/:runId/watchdog-decisions", async (req, res) => {
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (!existing) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
    if (!["snooze", "continue", "dismissed_false_positive"].includes(decision)) {
      res.status(400).json({ error: "Unsupported watchdog decision" });
      return;
    }
    const evaluationIssueId = typeof req.body?.evaluationIssueId === "string" ? req.body.evaluationIssueId : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 4000) : null;
    const snoozedUntil = decision === "snooze"
      ? new Date(String(req.body?.snoozedUntil ?? ""))
      : null;
    if (decision === "snooze" && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
      res.status(400).json({ error: "snoozedUntil must be a future ISO datetime" });
      return;
    }

    const row = await recovery.recordWatchdogDecision({
      runId: existing.id,
      actor: req.actor,
      decision: decision as "snooze" | "continue" | "dismissed_false_positive",
      evaluationIssueId,
      reason,
      snoozedUntil,
      createdByRunId: req.actor.runId ?? null,
    });

    res.json(row);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRunLogAccess(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    const result = await heartbeat.readLog(run, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) {
      res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    assertCompanyAccess(req, operation.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const identifier = normalizeIssueIdentifier(rawId);
    const issue = identifier ? await issueSvc.getByIdentifier(identifier) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
        contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
        logBytes: heartbeatRuns.logBytes,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        lastOutputBytes: heartbeatRuns.lastOutputBytes,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id }),
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    }))));
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const identifier = normalizeIssueIdentifier(rawId);
    const issue = identifier ? await issueSvc.getByIdentifier(identifier) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    const decoratedRun = heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id });
    res.json({
      ...decoratedRun,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    });
  });

  return router;
}

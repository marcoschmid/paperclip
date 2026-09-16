import { createHash } from "node:crypto";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  activityLog,
  agentPortfolioMaintenanceGates,
  agentWakeupRequests,
  agents,
  companySkills,
  heartbeatRuns,
  issues,
  routineTriggers,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
  agentLifecycleSystemReplacementProofSchema,
  agentLifecycleSchema,
  type PortfolioMaintenanceCoverage,
  type PortfolioMaintenanceExecutionGate,
  type PortfolioMaintenanceLifecycleGate,
  type PortfolioMaintenanceLiveRun,
  type PortfolioMaintenancePreflightResponse,
  type PortfolioMaintenanceGateReleaseResponse,
  type PortfolioMaintenanceQuiesceResponse,
  type PortfolioMaintenanceWake,
} from "@paperclipai/shared";
import { and, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { badRequest, conflict } from "../errors.js";
import { accessService } from "./access.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { withAgentStartLock } from "./agent-start-lock.js";
import {
  computeAgentLifecycleConfigFingerprint,
  hashAgentLifecycleContent,
  parseAgentLifecycleGate,
  resolveAgentLifecycleDesiredSkills,
  validateAgentLifecycleGate,
  type AgentLifecycleFingerprintInput,
} from "./agent-lifecycle.js";
import { heartbeatService } from "./heartbeat.js";
import { assertHistoricalAgentTombstoneMutable } from "./agent-retirement-historical-tombstones.js";
import { isProcessGroupAlive } from "./local-service-supervisor.js";
import { verifyStoredLocalProcessIdentity } from "./local-process-identity.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_RE = /^v1:sha256:[a-f0-9]{64}$/;
const ACTIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const HOME_OPS_AGENT_ID = "2f430983-3c02-4e58-90e3-821ae00f80c2";
const LIFECYCLE_CANARY_BINDING_KEYS = [
  "agentId",
  "canaryIssueId",
  "companyId",
  "configFingerprint",
  "receiptHash",
  "runId",
];
const SYSTEM_REPLACEMENT_RECEIPT_KEYS = [
  "canaryIssueId",
  "configFingerprint",
  "nonce",
  "observedRef",
  "observedSha256",
  "replacementSystemRef",
  "runId",
  "scenario",
  "schemaVersion",
  "sourceAgentId",
];
const LIFECYCLE_CANARY_CONTEXT_KEYS = new Set([
  "acceptedPlanWakeRouting",
  "executionWorkspaceId",
  "forceFreshSession",
  "issueId",
  "lifecycleCanary",
  "modelProfile",
  "paperclipContinuationSummary",
  "paperclipEnvironment",
  "paperclipHarnessCheckedOut",
  "paperclipIssue",
  "paperclipModelProfile",
  "paperclipPreviousSessionId",
  "paperclipRuntimePrimaryUrl",
  "paperclipRuntimeServiceIntents",
  "paperclipRuntimeServices",
  "paperclipSecrets",
  "paperclipSessionHandoffMarkdown",
  "paperclipSessionRotationReason",
  "paperclipTaskMarkdown",
  "paperclipWake",
  "paperclipWakeComment",
  "paperclipWorkspace",
  "paperclipWorkspaces",
  "projectId",
  "taskId",
  "taskKey",
  "wakeReason",
]);

const COVERAGE: PortfolioMaintenanceCoverage = {
  hiddenIssues: true,
  pluginOperations: true,
  wakesComplete: true,
  liveRunsComplete: true,
  wakeQuiesce: true,
  triggerCas: true,
};

type UnknownRecord = Record<string, unknown>;

export interface PortfolioMaintenanceAgentCandidate {
  id: string;
  companyId: string;
  name: string;
  status: string;
  pauseReason: string | null;
  adapterType: string;
  adapterConfig: UnknownRecord;
  runtimeConfig: UnknownRecord;
  permissions: UnknownRecord;
  metadata: UnknownRecord | null;
  updatedAt: Date;
}

interface PortfolioMaintenanceOptions {
  now?: () => Date;
  buildLifecycleFingerprintInput?: (
    agent: PortfolioMaintenanceAgentCandidate,
  ) => Promise<AgentLifecycleFingerprintInput>;
  readInstructionBundle?: (
    agent: PortfolioMaintenanceAgentCandidate,
    signal?: AbortSignal,
  ) => Promise<{ files: Record<string, string>; entryFile: string; warnings: string[] }>;
  instructionReadTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

interface PortfolioMaintenanceInstructionEvidence {
  agentId: string;
  agentConfigToken: string;
  entryFile: string;
  contextPackSha256: string;
  managedInstructionsSha256: string;
  bundleToken: string;
}

interface PortfolioMaintenanceSatisfiedRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  contextSnapshot: UnknownRecord | null;
  sessionIdBefore: string | null;
  finishedAt: Date | null;
}

interface SnapshotState {
  response: PortfolioMaintenancePreflightResponse;
  recoveryFingerprint: string;
  candidateAgents: PortfolioMaintenanceAgentCandidate[];
  instructionEvidence: PortfolioMaintenanceInstructionEvidence[];
  maintenanceGates: Array<{
    agentId: string;
    operationId: string;
    expectedSnapshotFingerprint: string;
    recoveryFingerprint: string;
    receiptId: string;
    stage: "fenced" | "quiesced";
  }>;
  agents: Array<{ id: string; status: string; pauseReason: string | null; updatedAt: string }>;
  routines: Array<{
    id: string;
    assigneeAgentId: string;
    status: string;
    latestRevisionId: string | null;
    updatedAt: string;
  }>;
  triggers: Array<{
    id: string;
    routineId: string;
    kind: string;
    enabled: boolean;
    cronExpression: string | null;
    timezone: string | null;
    updatedAt: string;
  }>;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown) {
  return `v1:sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sortedUniqueUuids(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && UUID_RE.test(entry))
    && new Set(value).size === value.length
    && stableStringify(value) === stableStringify([...value].sort(compareText));
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("portfolio_maintenance_instruction_read_timeout"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function instructionEvidenceDrift() {
  return conflict("Portfolio maintenance instruction evidence drifted", {
    code: "portfolio_maintenance_instruction_drift",
  });
}

function assertAgentIds(agentIds: readonly string[]) {
  if (agentIds.length < 1 || agentIds.length > 100) {
    throw badRequest("agentIds must contain between 1 and 100 agents");
  }
  if (agentIds.some((agentId) => !UUID_RE.test(agentId))) {
    throw badRequest("agentIds must contain UUIDs");
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw badRequest("agentIds must be unique");
  }
  if (agentIds.some((agentId, index) => index > 0 && agentIds[index - 1]! >= agentId)) {
    throw badRequest("agentIds must be sorted");
  }
}

function readIssueId(value: unknown) {
  const issueId = asRecord(value)?.issueId;
  return typeof issueId === "string" && UUID_RE.test(issueId) ? issueId : null;
}

function readSha256Reference(...values: unknown[]) {
  return values.find((value): value is string =>
    typeof value === "string" && /^(?:sha256:|v1:sha256:)[a-f0-9]{64}$/.test(value),
  ) ?? null;
}

function databaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  return databaseErrorCode(record.cause);
}

function operationEntityId(companyId: string, agentIds: readonly string[], operationId: string) {
  return sha256({ kind: "portfolio_maintenance_quiesce", companyId, agentIds, operationId });
}

function maintenanceReceiptId(input: {
  companyId: string;
  agentIds: readonly string[];
  operationId: string;
  expectedSnapshotFingerprint: string;
}) {
  return sha256({ kind: "portfolio_maintenance_gate_receipt", ...input });
}

async function withPortfolioAgentStartLocks<T>(agentIds: readonly string[], callback: () => Promise<T>): Promise<T> {
  const [agentId, ...rest] = agentIds;
  if (!agentId) return callback();
  return withAgentStartLock(agentId, () => withPortfolioAgentStartLocks(rest, callback));
}

function readStoredReceipt(
  details: unknown,
  input: {
    companyId: string;
    agentIds: readonly string[];
    operationId: string;
    expectedSnapshotFingerprint: string;
  },
): PortfolioMaintenanceQuiesceResponse | null {
  const receipt = asRecord(asRecord(details)?.receipt);
  if (!receipt) return null;
  if (
    receipt.schemaVersion !== PORTFOLIO_MAINTENANCE_SCHEMA_VERSION
    || receipt.companyId !== input.companyId
    || stableStringify(receipt.agentIds) !== stableStringify(input.agentIds)
    || receipt.operationId !== input.operationId
    || receipt.expectedSnapshotFingerprint !== input.expectedSnapshotFingerprint
    || receipt.receiptId !== maintenanceReceiptId(input)
    || receipt.stage !== "quiesced"
    || !canonicalTimestamp(receipt.quiescedAt)
    || !sortedUniqueUuids(receipt.cancelledWakeRequestIds)
    || !Array.isArray(receipt.remainingWakeRequestIds)
    || receipt.remainingWakeRequestIds.length !== 0
    || !Array.isArray(receipt.remainingLiveRunIds)
    || receipt.remainingLiveRunIds.length !== 0
  ) {
    return null;
  }
  return {
    schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
    companyId: receipt.companyId as string,
    agentIds: receipt.agentIds as string[],
    operationId: receipt.operationId as string,
    expectedSnapshotFingerprint: receipt.expectedSnapshotFingerprint as string,
    receiptId: receipt.receiptId as string,
    stage: "quiesced",
    quiescedAt: receipt.quiescedAt as string,
    cancelledWakeRequestIds: receipt.cancelledWakeRequestIds as string[],
    remainingWakeRequestIds: receipt.remainingWakeRequestIds as string[],
    remainingLiveRunIds: receipt.remainingLiveRunIds as string[],
  };
}

function readStoredGateRelease(
  details: unknown,
  input: {
    companyId: string;
    agentIds: readonly string[];
    receiptIds: readonly string[];
    expectedSnapshotFingerprint: string;
  },
): PortfolioMaintenanceGateReleaseResponse | null {
  const receipt = asRecord(asRecord(details)?.receipt);
  if (!receipt) return null;
  if (
    receipt.schemaVersion !== PORTFOLIO_MAINTENANCE_SCHEMA_VERSION
    || receipt.companyId !== input.companyId
    || stableStringify(receipt.agentIds) !== stableStringify(input.agentIds)
    || typeof receipt.receiptId !== "string"
    || !input.receiptIds.includes(receipt.receiptId)
    || receipt.expectedSnapshotFingerprint !== input.expectedSnapshotFingerprint
    || !canonicalTimestamp(receipt.releasedAt)
  ) return null;
  return {
    schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
    companyId: receipt.companyId as string,
    agentIds: receipt.agentIds as string[],
    receiptId: receipt.receiptId,
    expectedSnapshotFingerprint: receipt.expectedSnapshotFingerprint as string,
    releasedAt: receipt.releasedAt,
  };
}

export function portfolioMaintenanceService(db: Db, options: PortfolioMaintenanceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const instructions = agentInstructionsService();
  const instructionReadTimeoutMs = boundedTimeout(options.instructionReadTimeoutMs, 2_000, 10_000);
  const lockTimeoutMs = boundedTimeout(options.lockTimeoutMs, 2_000, 10_000);
  const statementTimeoutMs = boundedTimeout(options.statementTimeoutMs, 5_000, 30_000);
  const readInstructionBundle = options.readInstructionBundle
    ?? ((agent: PortfolioMaintenanceAgentCandidate, signal?: AbortSignal) =>
      instructions.exportFilesReadOnly(agent, { signal }));

  function agentConfigToken(agent: PortfolioMaintenanceAgentCandidate) {
    return sha256({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
    });
  }

  async function captureInstructionEvidence(
    agentRows: PortfolioMaintenanceAgentCandidate[],
  ): Promise<PortfolioMaintenanceInstructionEvidence[]> {
    try {
      return await withTimeout((signal) => Promise.all(agentRows.map(async (agent) => {
        const bundle = await readInstructionBundle(agent, signal);
        const contextPackSha256 = hashAgentLifecycleContent(bundle.files[bundle.entryFile] ?? "");
        const managedInstructionsSha256 = hashAgentLifecycleContent(bundle.files);
        const evidence = {
          agentId: agent.id,
          agentConfigToken: agentConfigToken(agent),
          entryFile: bundle.entryFile,
          contextPackSha256,
          managedInstructionsSha256,
        };
        return {
          ...evidence,
          bundleToken: sha256(evidence),
        };
      })), instructionReadTimeoutMs);
    } catch {
      throw conflict("Portfolio maintenance instruction evidence could not be read within the bounded window", {
        code: "portfolio_maintenance_instruction_read_timeout",
      });
    }
  }

  function assertInstructionEvidence(
    agentRows: PortfolioMaintenanceAgentCandidate[],
    evidence: PortfolioMaintenanceInstructionEvidence[],
  ) {
    const expected = agentRows.map((agent) => ({
      agentId: agent.id,
      agentConfigToken: agentConfigToken(agent),
    }));
    const actual = evidence.map((entry) => ({
      agentId: entry.agentId,
      agentConfigToken: entry.agentConfigToken,
    }));
    if (stableStringify(actual) !== stableStringify(expected)) throw instructionEvidenceDrift();
  }

  function instructionEvidenceMatches(
    left: PortfolioMaintenanceInstructionEvidence[],
    right: PortfolioMaintenanceInstructionEvidence[],
  ) {
    return stableStringify(left.map((entry) => ({ agentId: entry.agentId, bundleToken: entry.bundleToken })))
      === stableStringify(right.map((entry) => ({ agentId: entry.agentId, bundleToken: entry.bundleToken })));
  }

  async function setTransactionTimeouts(queryDb: Db) {
    await queryDb.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`));
    await queryDb.execute(sql.raw(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`));
  }

  const defaultBuildLifecycleFingerprintInput = async (
    queryDb: Db,
    agent: PortfolioMaintenanceAgentCandidate,
    instructionEvidence: PortfolioMaintenanceInstructionEvidence,
  ): Promise<AgentLifecycleFingerprintInput> => {
    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
    const metadata = asRecord(agent.metadata) ?? {};
    const desiredSkillEntries = readPaperclipSkillSyncPreference(adapterConfig).desiredSkillEntries;
    const [grants, skillCatalog] = await Promise.all([
      accessService(queryDb).listPrincipalGrants(agent.companyId, "agent", agent.id),
      desiredSkillEntries.length > 0
        ? queryDb
          .select({
            id: companySkills.id,
            key: companySkills.key,
            currentVersionId: companySkills.currentVersionId,
          })
          .from(companySkills)
          .where(and(
            eq(companySkills.companyId, agent.companyId),
            inArray(companySkills.key, desiredSkillEntries.map((entry) => entry.key)),
          ))
        : Promise.resolve([]),
    ]);
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
      desiredSkills: resolveAgentLifecycleDesiredSkills(desiredSkillEntries, skillCatalog),
      lifecycle: metadata.lifecycle,
      contextPackSha256: instructionEvidence.contextPackSha256,
      managedInstructionsSha256: instructionEvidence.managedInstructionsSha256,
      companyProfileSha256: readSha256Reference(
        adapterConfig.companyProfileSha256,
        runtimeConfig.companyProfileSha256,
      ),
    };
  };

  function exactCanaryRunEvidence(input: {
    agent: PortfolioMaintenanceAgentCandidate;
    lifecycle: { canaryIssueId: string | null };
    gate: NonNullable<ReturnType<typeof parseAgentLifecycleGate>>;
    run: PortfolioMaintenanceSatisfiedRun | null;
    canaryIssueExists: boolean;
  }) {
    const { agent, lifecycle, gate, run } = input;
    if (
      !run
      || !input.canaryIssueExists
      || !lifecycle.canaryIssueId
      || run.id !== gate.lastSatisfiedRunId
      || run.companyId !== agent.companyId
      || run.agentId !== agent.id
      || run.status !== "succeeded"
      || run.finishedAt === null
      || run.sessionIdBefore !== null
    ) return false;
    const context = asRecord(run.contextSnapshot);
    const binding = asRecord(context?.lifecycleCanary);
    if (!context || !binding) return false;
    if (Object.keys(context).some((key) => !LIFECYCLE_CANARY_CONTEXT_KEYS.has(key))) return false;
    const expectedBindingKeys = input.agent.id === HOME_OPS_AGENT_ID
      ? [...LIFECYCLE_CANARY_BINDING_KEYS, "systemReplacementReceipt"].sort()
      : LIFECYCLE_CANARY_BINDING_KEYS;
    if (stableStringify(Object.keys(binding).sort()) !== stableStringify(expectedBindingKeys)) return false;
    if (input.agent.id === HOME_OPS_AGENT_ID) {
      const receipt = asRecord(binding.systemReplacementReceipt);
      if (!receipt || stableStringify(Object.keys(receipt).sort()) !==
        stableStringify(SYSTEM_REPLACEMENT_RECEIPT_KEYS)) return false;
      const proof = agentLifecycleSystemReplacementProofSchema.safeParse({
        schemaVersion: receipt.schemaVersion,
        sourceAgentId: receipt.sourceAgentId,
        replacementSystemRef: receipt.replacementSystemRef,
        scenario: receipt.scenario,
        nonce: receipt.nonce,
        observedRef: receipt.observedRef,
        observedSha256: receipt.observedSha256,
      });
      if (!proof.success || receipt.runId !== run.id ||
        receipt.canaryIssueId !== lifecycle.canaryIssueId ||
        receipt.configFingerprint !== gate.configFingerprint) return false;
    }
    return context.forceFreshSession === true
      && context.issueId === lifecycle.canaryIssueId
      && context.taskId === lifecycle.canaryIssueId
      && context.taskKey === `lifecycle-canary:${lifecycle.canaryIssueId}`
      && context.wakeReason === "lifecycle_pending_canary"
      && binding.agentId === agent.id
      && binding.companyId === agent.companyId
      && binding.canaryIssueId === lifecycle.canaryIssueId
      && binding.runId === run.id
      && binding.configFingerprint === gate.configFingerprint
      && binding.receiptHash === gate.receiptHash;
  }

  async function projectLifecycleGate(
    queryDb: Db,
    agent: PortfolioMaintenanceAgentCandidate,
    validationNow: Date,
    instructionEvidence: PortfolioMaintenanceInstructionEvidence,
    satisfiedRun: PortfolioMaintenanceSatisfiedRun | null,
    canaryIssueExists: boolean,
  ): Promise<PortfolioMaintenanceLifecycleGate> {
    const metadata = asRecord(agent.metadata) ?? {};
    const lifecycleResult = agentLifecycleSchema.safeParse(metadata.lifecycle);
    const parsedGate = parseAgentLifecycleGate(metadata.lifecycleGate);
    let fingerprintInput: AgentLifecycleFingerprintInput | null = null;
    let currentConfigFingerprint: string | null = null;
    try {
      fingerprintInput = options.buildLifecycleFingerprintInput
        ? await options.buildLifecycleFingerprintInput(agent)
        : await defaultBuildLifecycleFingerprintInput(queryDb, agent, instructionEvidence);
      currentConfigFingerprint = computeAgentLifecycleConfigFingerprint(fingerprintInput);
    } catch {
      fingerprintInput = null;
      currentConfigFingerprint = null;
    }
    const validation = fingerprintInput
      ? validateAgentLifecycleGate({
        fingerprintInput,
        gate: metadata.lifecycleGate,
        now: validationNow,
      })
      : null;
    const valid = (agent.status === "idle" || agent.status === "paused")
      && lifecycleResult.success
      && lifecycleResult.data.lastCanaryResult === "passed"
      && typeof lifecycleResult.data.canaryIssueId === "string"
      && parsedGate !== null
      && typeof parsedGate.lastSatisfiedRunId === "string"
      && parsedGate.findingCount === 0
      && parsedGate.freshSessionRequired === false
      && currentConfigFingerprint === parsedGate.configFingerprint
      && validation?.ok === true
      && exactCanaryRunEvidence({
        agent,
        lifecycle: lifecycleResult.data,
        gate: parsedGate,
        run: satisfiedRun,
        canaryIssueExists,
      });

    return {
      agentId: agent.id,
      status: agent.status,
      lastCanaryResult: lifecycleResult.success ? lifecycleResult.data.lastCanaryResult : null,
      canaryIssueId: lifecycleResult.success ? lifecycleResult.data.canaryIssueId : null,
      currentConfigFingerprint,
      gateConfigFingerprint: parsedGate?.configFingerprint ?? null,
      lastSatisfiedRunId: parsedGate?.lastSatisfiedRunId ?? null,
      receiptHash: parsedGate?.receiptHash ?? null,
      validatedAt: parsedGate?.validatedAt ?? null,
      expiresAt: parsedGate?.expiresAt ?? null,
      valid,
    };
  }

  async function loadCandidateAgents(
    queryDb: Db,
    input: { companyId: string; agentIds: string[] },
  ): Promise<PortfolioMaintenanceAgentCandidate[]> {
    assertAgentIds(input.agentIds);
    const agentRows = await queryDb
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        permissions: agents.permissions,
        metadata: agents.metadata,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(and(
        eq(agents.companyId, input.companyId),
        inArray(agents.id, input.agentIds),
      ));
    if (agentRows.length !== input.agentIds.length) {
      throw badRequest("All portfolio maintenance agents must exist in the target company");
    }
    const sortedAgentRows = [...agentRows].sort((left, right) => compareText(left.id, right.id));
    if (stableStringify(sortedAgentRows.map((agent) => agent.id)) !== stableStringify(input.agentIds)) {
      throw badRequest("Portfolio maintenance agent coverage is incomplete");
    }
    return sortedAgentRows;
  }

  async function loadSnapshot(
    queryDb: Db,
    input: { companyId: string; agentIds: string[] },
    instructionEvidence: PortfolioMaintenanceInstructionEvidence[],
  ): Promise<SnapshotState> {
    const sortedAgentRows = await loadCandidateAgents(queryDb, input);
    assertInstructionEvidence(sortedAgentRows, instructionEvidence);
    const instructionEvidenceByAgent = new Map(
      instructionEvidence.map((entry) => [entry.agentId, entry]),
    );
    const parsedGates = sortedAgentRows.map((agent) => {
      const metadata = asRecord(agent.metadata) ?? {};
      return parseAgentLifecycleGate(metadata.lifecycleGate);
    });
    const parsedLifecycles = sortedAgentRows.map((agent) => {
      const metadata = asRecord(agent.metadata) ?? {};
      return agentLifecycleSchema.safeParse(metadata.lifecycle);
    });
    const satisfiedRunIds = parsedGates
      .map((gate) => gate?.lastSatisfiedRunId)
      .filter((runId): runId is string => typeof runId === "string");
    const canaryIssueIds = parsedLifecycles
      .map((lifecycle) => lifecycle.success ? lifecycle.data.canaryIssueId : null)
      .filter((issueId): issueId is string => typeof issueId === "string");

    const [
      issueRows,
      wakeRows,
      runRows,
      routineRows,
      satisfiedRunRows,
      canaryIssueRows,
      maintenanceGateRows,
      terminalProcessRows,
    ] = await Promise.all([
      queryDb
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          originKind: issues.originKind,
          hiddenAt: issues.hiddenAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, input.companyId),
          inArray(issues.assigneeAgentId, input.agentIds),
          notInArray(issues.status, ["done", "cancelled"]),
        )),
      queryDb
        .select({
          id: agentWakeupRequests.id,
          agentId: agentWakeupRequests.agentId,
          payload: agentWakeupRequests.payload,
          status: agentWakeupRequests.status,
          updatedAt: agentWakeupRequests.updatedAt,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, input.companyId),
          inArray(agentWakeupRequests.agentId, input.agentIds),
          inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
        )),
      queryDb
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.agentId, input.agentIds),
          inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
        )),
      queryDb
        .select({
          id: routines.id,
          assigneeAgentId: routines.assigneeAgentId,
          status: routines.status,
          latestRevisionId: routines.latestRevisionId,
          updatedAt: routines.updatedAt,
        })
        .from(routines)
        .where(and(
          eq(routines.companyId, input.companyId),
          inArray(routines.assigneeAgentId, input.agentIds),
        )),
      satisfiedRunIds.length > 0
        ? queryDb
          .select({
            id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            sessionIdBefore: heartbeatRuns.sessionIdBefore,
            finishedAt: heartbeatRuns.finishedAt,
          })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, satisfiedRunIds))
        : Promise.resolve([]),
      canaryIssueIds.length > 0
        ? queryDb
          .select({ id: issues.id })
          .from(issues)
          .where(and(
            eq(issues.companyId, input.companyId),
            inArray(issues.id, canaryIssueIds),
          ))
        : Promise.resolve([]),
      queryDb
        .select({
          agentId: agentPortfolioMaintenanceGates.agentId,
          operationId: agentPortfolioMaintenanceGates.operationId,
          expectedSnapshotFingerprint: agentPortfolioMaintenanceGates.expectedSnapshotFingerprint,
          recoveryFingerprint: agentPortfolioMaintenanceGates.recoveryFingerprint,
          receiptId: agentPortfolioMaintenanceGates.receiptId,
          stage: agentPortfolioMaintenanceGates.stage,
        })
        .from(agentPortfolioMaintenanceGates)
        .where(and(
          eq(agentPortfolioMaintenanceGates.companyId, input.companyId),
          inArray(agentPortfolioMaintenanceGates.agentId, input.agentIds),
        )),
      queryDb
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
          processStartedAt: heartbeatRuns.processStartedAt,
          processExecutable: heartbeatRuns.processExecutable,
          processCommandSha256: heartbeatRuns.processCommandSha256,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.agentId, input.agentIds),
          notInArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
          or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId)),
        )),
    ]);

    const sortedRoutines = routineRows
      .filter((routine): routine is typeof routine & { assigneeAgentId: string } => routine.assigneeAgentId !== null)
      .map((routine) => ({
        id: routine.id,
        assigneeAgentId: routine.assigneeAgentId,
        status: routine.status,
        latestRevisionId: routine.latestRevisionId,
        updatedAt: routine.updatedAt.toISOString(),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const triggerRows = sortedRoutines.length > 0
      ? await queryDb
        .select({
          id: routineTriggers.id,
          routineId: routineTriggers.routineId,
          kind: routineTriggers.kind,
          enabled: routineTriggers.enabled,
          cronExpression: routineTriggers.cronExpression,
          timezone: routineTriggers.timezone,
          updatedAt: routineTriggers.updatedAt,
        })
        .from(routineTriggers)
        .where(and(
          eq(routineTriggers.companyId, input.companyId),
          inArray(routineTriggers.routineId, sortedRoutines.map((routine) => routine.id)),
        ))
      : [];

    const validationNow = now();
    const satisfiedRunById = new Map(
      satisfiedRunRows.map((run) => [run.id, run as PortfolioMaintenanceSatisfiedRun]),
    );
    const canaryIssueIdSet = new Set(canaryIssueRows.map((issue) => issue.id));
    const lifecycleGates = await Promise.all(
      sortedAgentRows.map((agent, index) => {
        const evidence = instructionEvidenceByAgent.get(agent.id);
        if (!evidence) throw instructionEvidenceDrift();
        const gate = parsedGates[index];
        const lifecycle = parsedLifecycles[index];
        return projectLifecycleGate(
          queryDb,
          agent,
          validationNow,
          evidence,
          gate?.lastSatisfiedRunId ? satisfiedRunById.get(gate.lastSatisfiedRunId) ?? null : null,
          canaryIssueIdSet.has(lifecycle?.success ? lifecycle.data.canaryIssueId ?? "" : ""),
        );
      }),
    );
    const projectedIssues = issueRows
      .filter((issue): issue is typeof issue & { assigneeAgentId: string } => issue.assigneeAgentId !== null)
      .map((issue) => ({
        id: issue.id,
        companyId: input.companyId,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        originKind: issue.originKind,
        hidden: issue.hiddenAt !== null,
        updatedAt: issue.updatedAt.toISOString(),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const projectedWakes = wakeRows
      .map((wake): PortfolioMaintenanceWake => ({
        id: wake.id,
        agentId: wake.agentId,
        issueId: readIssueId(wake.payload),
        status: wake.status as PortfolioMaintenanceWake["status"],
        updatedAt: wake.updatedAt.toISOString(),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const projectedActiveRuns = runRows
      .map((run): PortfolioMaintenanceLiveRun => ({
        id: run.id,
        agentId: run.agentId,
        issueId: readIssueId(run.contextSnapshot),
        status: run.status as PortfolioMaintenanceLiveRun["status"],
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const terminalIdentityChecks = await Promise.all(terminalProcessRows.map(async (run) => {
      if (run.processPid === null) {
        return {
          run,
          verification: run.processGroupId && isProcessGroupAlive(run.processGroupId)
            ? { kind: "unproven" as const, reason: "missing_pid" }
            : { kind: "not_running" as const },
        };
      }
      const verification = await verifyStoredLocalProcessIdentity(run);
      if (
        verification.kind === "not_running"
        && run.processGroupId
        && isProcessGroupAlive(run.processGroupId)
      ) {
        return {
          run,
          verification: {
            kind: "unproven" as const,
            reason: "owner_pid_not_running_group_alive",
          },
        };
      }
      return { run, verification };
    }));
    const projectedOrphanRuns = terminalIdentityChecks
      .filter((entry) => entry.verification.kind === "verified")
      .map(({ run }): PortfolioMaintenanceLiveRun => ({
        id: run.id,
        agentId: run.agentId,
        issueId: readIssueId(run.contextSnapshot),
        status: "orphan_process",
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      }));
    const terminalIdentityBlockers = terminalIdentityChecks
      .filter((entry) => entry.verification.kind === "unproven")
      .map(({ run, verification }) => ({
        code: "terminal_process_identity_unproven",
        message: `Terminal run ${run.id} has a live PID/PGID without an exact Paperclip child identity (${verification.kind === "unproven" ? verification.reason : "unknown"}); manual intervention is required.`,
      }));
    const projectedRuns = [...projectedActiveRuns, ...projectedOrphanRuns]
      .sort((left, right) => compareText(left.id, right.id));
    const projectedTriggers = triggerRows
      .map((trigger) => ({
        id: trigger.id,
        routineId: trigger.routineId,
        kind: trigger.kind,
        enabled: trigger.enabled,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        updatedAt: trigger.updatedAt.toISOString(),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const projectedAgents = sortedAgentRows.map((agent) => ({
      id: agent.id,
      status: agent.status,
      pauseReason: agent.pauseReason,
      updatedAt: agent.updatedAt.toISOString(),
    }));
    const projectedMaintenanceGates = maintenanceGateRows
      .map((gate) => ({
        agentId: gate.agentId,
        operationId: gate.operationId,
        expectedSnapshotFingerprint: gate.expectedSnapshotFingerprint,
        recoveryFingerprint: gate.recoveryFingerprint,
        receiptId: gate.receiptId,
        stage: gate.stage as "fenced" | "quiesced",
      }))
      .sort((left, right) => compareText(left.agentId, right.agentId));
    const maintenanceGate: PortfolioMaintenanceExecutionGate | null = (() => {
      if (projectedMaintenanceGates.length === 0) return null;
      const exactCoverage = projectedMaintenanceGates.length === input.agentIds.length
        && stableStringify(projectedMaintenanceGates.map((gate) => gate.agentId)) === stableStringify(input.agentIds);
      const operationIds = new Set(projectedMaintenanceGates.map((gate) => gate.operationId));
      const expectedFingerprints = new Set(
        projectedMaintenanceGates.map((gate) => gate.expectedSnapshotFingerprint),
      );
      const recoveryFingerprints = new Set(
        projectedMaintenanceGates.map((gate) => gate.recoveryFingerprint),
      );
      const receiptIds = new Set(projectedMaintenanceGates.map((gate) => gate.receiptId));
      const stages = new Set(projectedMaintenanceGates.map((gate) => gate.stage));
      if (
        !exactCoverage
        || operationIds.size !== 1
        || expectedFingerprints.size !== 1
        || recoveryFingerprints.size !== 1
        || receiptIds.size !== 1
        || stages.size !== 1
      ) return null;
      const first = projectedMaintenanceGates[0]!;
      if (
        !UUID_RE.test(first.operationId)
        || !SNAPSHOT_RE.test(first.expectedSnapshotFingerprint)
        || !SNAPSHOT_RE.test(first.recoveryFingerprint)
        || !SNAPSHOT_RE.test(first.receiptId)
        || (first.stage !== "fenced" && first.stage !== "quiesced")
      ) return null;
      return {
        operationId: first.operationId,
        expectedSnapshotFingerprint: first.expectedSnapshotFingerprint,
        receiptId: first.receiptId,
        stage: first.stage,
      };
    })();
    const maintenanceGateCoverageInvalid = projectedMaintenanceGates.length > 0 && maintenanceGate === null;
    const instructionEvidenceProjection = instructionEvidence.map((entry) => ({
      agentId: entry.agentId,
      bundleToken: entry.bundleToken,
    }));
    const satisfiedRunEvidence = satisfiedRunRows
      .map((run) => ({
        id: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        status: run.status,
        finished: run.finishedAt !== null,
        freshSession: run.sessionIdBefore === null,
        contextFingerprint: sha256(run.contextSnapshot),
      }))
      .sort((left, right) => compareText(left.id, right.id));
    const fingerprintBase = {
      schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
      companyId: input.companyId,
      agentIds: input.agentIds,
      coverage: COVERAGE,
      agents: projectedAgents,
      instructionEvidence: instructionEvidenceProjection,
      satisfiedRunEvidence,
      lifecycleGates,
      issues: projectedIssues,
      wakes: projectedWakes,
      routines: sortedRoutines,
      triggers: projectedTriggers,
      terminalProcessIdentity: terminalIdentityChecks.map(({ run, verification }) => ({
        runId: run.id,
        kind: verification.kind,
        ...(verification.kind === "unproven" ? { reason: verification.reason } : {}),
      })),
    };
    // The public fingerprint includes the visible gate and liveness-projected
    // orphan processes.  The recovery fingerprint deliberately excludes the
    // gate itself and records terminal process rows independent of OS
    // liveness.  A phase-2 kill followed by rollback can therefore be retried,
    // while any database/config/instruction drift still fails closed.
    const recoveryFingerprint = sha256({
      ...fingerprintBase,
      liveRuns: projectedActiveRuns,
      terminalProcessRows: terminalProcessRows
        .map((run) => ({
          id: run.id,
          agentId: run.agentId,
          issueId: readIssueId(run.contextSnapshot),
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          processPid: run.processPid,
          processGroupId: run.processGroupId,
          processStartedAt: run.processStartedAt?.toISOString() ?? null,
          processExecutable: run.processExecutable,
          processCommandSha256: run.processCommandSha256,
        }))
        .sort((left, right) => compareText(left.id, right.id)),
    });
    const fingerprint = sha256({
      ...fingerprintBase,
      maintenanceGates: projectedMaintenanceGates.map((gate) => ({
        agentId: gate.agentId,
        operationId: gate.operationId,
        expectedSnapshotFingerprint: gate.expectedSnapshotFingerprint,
        receiptId: gate.receiptId,
        stage: gate.stage,
      })),
      liveRuns: projectedRuns,
    });
    const response: PortfolioMaintenancePreflightResponse = {
      schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
      companyId: input.companyId,
      agentIds: input.agentIds,
      ready: !maintenanceGateCoverageInvalid && terminalIdentityBlockers.length === 0,
      restoreReady: !maintenanceGateCoverageInvalid
        && terminalIdentityBlockers.length === 0
        && lifecycleGates.every((gate) => gate.valid),
      blockers: [
        ...(maintenanceGateCoverageInvalid ? [{
          code: "maintenance_gate_coverage_invalid",
          message: "Portfolio maintenance execution-gate coverage is partial or inconsistent.",
        }] : []),
        ...terminalIdentityBlockers,
      ],
      coverage: COVERAGE,
      snapshotFingerprint: fingerprint,
      maintenanceGate,
      lifecycleGates,
      issues: projectedIssues,
      wakes: projectedWakes,
      liveRuns: projectedRuns,
    };
    return {
      response,
      recoveryFingerprint,
      candidateAgents: sortedAgentRows,
      instructionEvidence,
      maintenanceGates: projectedMaintenanceGates,
      agents: projectedAgents,
      routines: sortedRoutines,
      triggers: projectedTriggers,
    };
  }

  return {
    preflight: async (input: { companyId: string; agentIds: string[] }) => {
      if (!UUID_RE.test(input.companyId)) throw badRequest("companyId must be a UUID");
      const candidates = await loadCandidateAgents(db, input);
      const beforeEvidence = await captureInstructionEvidence(candidates);
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await setTransactionTimeouts(txDb);
        const snapshot = await loadSnapshot(txDb, input, beforeEvidence);
        const afterEvidence = await captureInstructionEvidence(snapshot.candidateAgents);
        if (instructionEvidenceMatches(beforeEvidence, afterEvidence)) return snapshot.response;
        return {
          ...snapshot.response,
          ready: false,
          restoreReady: false,
          blockers: [{
            code: "instruction_bundle_drift",
            message: "Instruction bundle evidence changed while the maintenance snapshot was captured.",
          }],
        };
      }, { isolationLevel: "serializable", accessMode: "read only" });
    },

    quiesce: async (input: {
      companyId: string;
      agentIds: string[];
      operationId: string;
      expectedSnapshotFingerprint: string;
      actorUserId: string;
    }): Promise<PortfolioMaintenanceQuiesceResponse> => {
      if (!UUID_RE.test(input.companyId)) throw badRequest("companyId must be a UUID");
      if (!UUID_RE.test(input.operationId)) throw badRequest("operationId must be a UUID");
      assertAgentIds(input.agentIds);
      for (const agentId of input.agentIds) assertHistoricalAgentTombstoneMutable(agentId);
      if (!SNAPSHOT_RE.test(input.expectedSnapshotFingerprint)) {
        throw badRequest("expectedSnapshotFingerprint must be a v1 SHA-256 fingerprint");
      }
      const candidateAgents = await loadCandidateAgents(db, input);
      const beforeEvidence = await captureInstructionEvidence(candidateAgents);
      const entityId = operationEntityId(input.companyId, input.agentIds, input.operationId);
      const expectedReceiptId = maintenanceReceiptId(input);
      try {
        return await withPortfolioAgentStartLocks(input.agentIds, async () => {
          // Phase 1 is intentionally its own transaction. Once it commits, a
          // crash, client disconnect, or cleanup failure leaves a durable and
          // GET-recoverable fence instead of silently reopening execution.
          await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            await setTransactionTimeouts(txDb);
            const lockedAgents = await txDb
              .select({ id: agents.id })
              .from(agents)
              .where(and(
                eq(agents.companyId, input.companyId),
                inArray(agents.id, input.agentIds),
              ))
              .orderBy(agents.id)
              .for("update");
            if (
              lockedAgents.length !== input.agentIds.length
              || stableStringify(lockedAgents.map((agent) => agent.id)) !== stableStringify(input.agentIds)
            ) {
              throw conflict("Portfolio maintenance agent lock coverage drifted", {
                code: "portfolio_maintenance_drift",
              });
            }
            await tx.execute(sql.raw(
              "LOCK TABLE agent_portfolio_maintenance_gates, issues, routines, routine_triggers, activity_log, principal_permission_grants, company_skills IN SHARE ROW EXCLUSIVE MODE",
            ));
            const current = await loadSnapshot(txDb, input, beforeEvidence);
            const lockedEvidence = await captureInstructionEvidence(current.candidateAgents);
            if (!instructionEvidenceMatches(beforeEvidence, lockedEvidence)) {
              throw instructionEvidenceDrift();
            }
            const terminalIdentityBlocker = current.response.blockers.find(
              (blocker) => blocker.code === "terminal_process_identity_unproven",
            );
            if (terminalIdentityBlocker) {
              throw conflict("Terminal process identity requires manual intervention", {
                code: "portfolio_maintenance_process_identity_unproven",
                blocker: terminalIdentityBlocker,
                manualInterventionRequired: true,
              });
            }
            if (current.maintenanceGates.length > 0) {
              const gate = current.response.maintenanceGate;
              if (
                !gate
                || gate.operationId !== input.operationId
                || gate.expectedSnapshotFingerprint !== input.expectedSnapshotFingerprint
                || gate.receiptId !== expectedReceiptId
              ) {
                throw conflict("Portfolio maintenance agents have a different execution-gate intent", {
                  code: "portfolio_maintenance_gate_conflict",
                });
              }
              if (
                gate.stage === "fenced"
                && current.maintenanceGates[0]?.recoveryFingerprint !== current.recoveryFingerprint
              ) {
                throw conflict("Portfolio maintenance fenced state drifted from its persisted intent", {
                  code: "portfolio_maintenance_recovery_drift",
                });
              }
              return;
            }
            if (current.response.snapshotFingerprint !== input.expectedSnapshotFingerprint) {
              throw conflict("Portfolio maintenance snapshot fingerprint is stale", {
                code: "portfolio_maintenance_drift",
                currentSnapshotFingerprint: current.response.snapshotFingerprint,
              });
            }

            const gateIssuedAt = now();
            const gatedAgents = await txDb.insert(agentPortfolioMaintenanceGates).values(
              input.agentIds.map((agentId) => ({
                companyId: input.companyId,
                agentId,
                operationId: input.operationId,
                expectedSnapshotFingerprint: input.expectedSnapshotFingerprint,
                recoveryFingerprint: current.recoveryFingerprint,
                receiptId: expectedReceiptId,
                stage: "fenced",
                issuedByUserId: input.actorUserId,
                issuedAt: gateIssuedAt,
                updatedAt: gateIssuedAt,
              })),
            ).returning({ agentId: agentPortfolioMaintenanceGates.agentId });
            if (gatedAgents.length !== input.agentIds.length) {
              throw conflict("Portfolio maintenance execution gate coverage changed", {
                code: "portfolio_maintenance_gate_drift",
              });
            }
            // Symmetric MVCC boundary: a SERIALIZABLE writer whose statement
            // snapshot predates this fence must abort after waiting on the
            // agent row instead of observing an unchanged tuple version.
            const versionedAgents = await txDb
              .update(agents)
              .set({ updatedAt: sql`${agents.updatedAt}` })
              .where(and(
                eq(agents.companyId, input.companyId),
                inArray(agents.id, input.agentIds),
              ))
              .returning({ id: agents.id });
            if (versionedAgents.length !== input.agentIds.length) {
              throw conflict("Portfolio maintenance agent serialization boundary drifted", {
                code: "portfolio_maintenance_drift",
              });
            }
            const finalEvidence = await captureInstructionEvidence(current.candidateAgents);
            if (!instructionEvidenceMatches(beforeEvidence, finalEvidence)) {
              throw instructionEvidenceDrift();
            }
            await txDb.insert(activityLog).values({
              companyId: input.companyId,
              actorType: "user",
              actorId: input.actorUserId,
              action: "company.portfolio_maintenance_gate_established",
              entityType: "portfolio_maintenance",
              entityId,
              details: {
                intent: {
                  schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
                  companyId: input.companyId,
                  agentIds: input.agentIds,
                  operationId: input.operationId,
                  expectedSnapshotFingerprint: input.expectedSnapshotFingerprint,
                  recoveryFingerprint: current.recoveryFingerprint,
                  receiptId: expectedReceiptId,
                  stage: "fenced",
                },
              },
              createdAt: gateIssuedAt,
            });
          }, { isolationLevel: "serializable", accessMode: "read write" });

          // Phase 2 is idempotent and receipt-bound. Database triggers reject
          // generic active-state cleanup while the fence exists; only this
          // transaction's exact receipt may terminalize the inventoried work.
          return db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            await setTransactionTimeouts(txDb);
            const lockedAgents = await txDb
              .select({ id: agents.id })
              .from(agents)
              .where(and(
                eq(agents.companyId, input.companyId),
                inArray(agents.id, input.agentIds),
              ))
              .orderBy(agents.id)
              .for("update");
            if (
              lockedAgents.length !== input.agentIds.length
              || stableStringify(lockedAgents.map((agent) => agent.id)) !== stableStringify(input.agentIds)
            ) {
              throw conflict("Portfolio maintenance agent lock coverage drifted", {
                code: "portfolio_maintenance_drift",
              });
            }
            await tx.execute(sql.raw(
              "LOCK TABLE agent_portfolio_maintenance_gates, issues, routines, routine_triggers, activity_log, principal_permission_grants, company_skills IN SHARE ROW EXCLUSIVE MODE",
            ));
            const cleanupEvidence = await captureInstructionEvidence(candidateAgents);
            if (!instructionEvidenceMatches(beforeEvidence, cleanupEvidence)) {
              throw instructionEvidenceDrift();
            }
            const current = await loadSnapshot(txDb, input, cleanupEvidence);
            const terminalIdentityBlocker = current.response.blockers.find(
              (blocker) => blocker.code === "terminal_process_identity_unproven",
            );
            if (terminalIdentityBlocker) {
              throw conflict("Terminal process identity requires manual intervention", {
                code: "portfolio_maintenance_process_identity_unproven",
                blocker: terminalIdentityBlocker,
                manualInterventionRequired: true,
              });
            }
            const gate = current.response.maintenanceGate;
            if (
              !gate
              || gate.operationId !== input.operationId
              || gate.expectedSnapshotFingerprint !== input.expectedSnapshotFingerprint
              || gate.receiptId !== expectedReceiptId
            ) {
              throw conflict("Portfolio maintenance execution gate changed before cleanup", {
                code: "portfolio_maintenance_gate_drift",
              });
            }
            if (
              gate.stage === "fenced"
              && current.maintenanceGates[0]?.recoveryFingerprint !== current.recoveryFingerprint
            ) {
              throw conflict("Portfolio maintenance fenced state drifted before cleanup", {
                code: "portfolio_maintenance_recovery_drift",
              });
            }
            const existingAudit = await txDb
              .select({ details: activityLog.details })
              .from(activityLog)
              .where(and(
                eq(activityLog.companyId, input.companyId),
                eq(activityLog.action, "company.portfolio_maintenance_quiesced"),
                eq(activityLog.entityType, "portfolio_maintenance"),
                eq(activityLog.entityId, entityId),
              ))
              .then((rows) => rows[0] ?? null);
            if (gate.stage === "quiesced") {
              const receipt = readStoredReceipt(existingAudit?.details, input);
              if (receipt && current.response.wakes.length === 0 && current.response.liveRuns.length === 0) {
                return receipt;
              }
              throw conflict("Portfolio maintenance retry drifted from its audited quiesced state", {
                code: "portfolio_maintenance_gate_drift",
              });
            }
            if (existingAudit) {
              throw conflict("Portfolio maintenance cleanup audit appeared before the gate stage advanced", {
                code: "portfolio_maintenance_gate_drift",
              });
            }

            await txDb.execute(sql`select set_config(
              'paperclip.portfolio_maintenance_receipt',
              ${expectedReceiptId},
              true
            )`);
            const cancelledWakeRequestIds = current.response.wakes.map((wake) => wake.id);
            const activeRunIds = current.response.liveRuns
              .filter((run) => run.status !== "orphan_process")
              .map((run) => run.id);
            const orphanRunIds = current.response.liveRuns
              .filter((run) => run.status === "orphan_process")
              .map((run) => run.id);
            const cancelledRunIds = [...activeRunIds, ...orphanRunIds].sort(compareText);
            const quiescedAt = now();
            if (activeRunIds.length > 0) {
              const cancellation = await heartbeatService(txDb).cancelInvocationsForAgents(
                input.agentIds,
                "Cancelled by portfolio maintenance",
              );
              if (cancellation.runsCancelled !== activeRunIds.length) {
                throw conflict("Portfolio maintenance run coverage changed during cleanup", {
                  code: "portfolio_maintenance_drift",
                });
              }
            }
            if (orphanRunIds.length > 0) {
              const terminated = await heartbeatService(txDb).terminateTerminalOrphanProcesses(orphanRunIds);
              if (terminated.terminatedRunIds.length !== orphanRunIds.length) {
                throw conflict("Portfolio maintenance orphan process coverage changed during cleanup", {
                  code: "portfolio_maintenance_orphan_drift",
                });
              }
            }
            if (cancelledWakeRequestIds.length > 0) {
              await txDb
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: quiescedAt,
                  error: "Cancelled by portfolio maintenance",
                  updatedAt: quiescedAt,
                })
                .where(and(
                  eq(agentWakeupRequests.companyId, input.companyId),
                  inArray(agentWakeupRequests.id, cancelledWakeRequestIds),
                  inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
                ));
            }

            const finalEvidence = await captureInstructionEvidence(current.candidateAgents);
            if (!instructionEvidenceMatches(cleanupEvidence, finalEvidence)) {
              throw instructionEvidenceDrift();
            }
            const post = await loadSnapshot(txDb, input, finalEvidence);
            const remainingWakeRequestIds = post.response.wakes.map((wake) => wake.id);
            const remainingLiveRunIds = post.response.liveRuns.map((run) => run.id);
            if (remainingWakeRequestIds.length > 0 || remainingLiveRunIds.length > 0) {
              throw conflict("Portfolio maintenance cleanup did not reach a zero-active post-state", {
                code: "portfolio_maintenance_incomplete",
              });
            }
            const receipt: PortfolioMaintenanceQuiesceResponse = {
              schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
              companyId: input.companyId,
              agentIds: input.agentIds,
              operationId: input.operationId,
              expectedSnapshotFingerprint: input.expectedSnapshotFingerprint,
              receiptId: expectedReceiptId,
              stage: "quiesced",
              quiescedAt: quiescedAt.toISOString(),
              cancelledWakeRequestIds,
              remainingWakeRequestIds,
              remainingLiveRunIds,
            };
            const advancedGates = await txDb
              .update(agentPortfolioMaintenanceGates)
              .set({ stage: "quiesced", updatedAt: quiescedAt })
              .where(and(
                eq(agentPortfolioMaintenanceGates.companyId, input.companyId),
                eq(agentPortfolioMaintenanceGates.operationId, input.operationId),
                eq(agentPortfolioMaintenanceGates.receiptId, expectedReceiptId),
                eq(agentPortfolioMaintenanceGates.stage, "fenced"),
                inArray(agentPortfolioMaintenanceGates.agentId, input.agentIds),
              ))
              .returning({ agentId: agentPortfolioMaintenanceGates.agentId });
            if (advancedGates.length !== input.agentIds.length) {
              throw conflict("Portfolio maintenance execution gate stage CAS failed", {
                code: "portfolio_maintenance_gate_drift",
              });
            }
            await txDb.insert(activityLog).values({
              companyId: input.companyId,
              actorType: "user",
              actorId: input.actorUserId,
              action: "company.portfolio_maintenance_quiesced",
              entityType: "portfolio_maintenance",
              entityId,
              details: { receipt, cancelledRunIds },
              createdAt: quiescedAt,
            });
            return receipt;
          }, { isolationLevel: "serializable", accessMode: "read write" });
        });
      } catch (error) {
        const code = databaseErrorCode(error);
        if (["40001", "40P01", "55P03", "57014"].includes(code ?? "")) {
          throw conflict("Portfolio maintenance transaction drifted; rerun preflight", {
            code: "portfolio_maintenance_drift",
          });
        }
        throw error;
      }
    },

    releaseGate: async (input: {
      companyId: string;
      agentIds: string[];
      receiptIds: string[];
      expectedSnapshotFingerprint: string;
      actorUserId: string;
    }): Promise<PortfolioMaintenanceGateReleaseResponse> => {
      if (!UUID_RE.test(input.companyId)) throw badRequest("companyId must be a UUID");
      assertAgentIds(input.agentIds);
      for (const agentId of input.agentIds) assertHistoricalAgentTombstoneMutable(agentId);
      if (!SNAPSHOT_RE.test(input.expectedSnapshotFingerprint)) {
        throw badRequest("expectedSnapshotFingerprint must be a v1 SHA-256 fingerprint");
      }
      if (
        input.receiptIds.length < 1
        || input.receiptIds.length > 100
        || new Set(input.receiptIds).size !== input.receiptIds.length
        || input.receiptIds.some((receiptId) => !SNAPSHOT_RE.test(receiptId))
      ) {
        throw badRequest("receiptIds must contain unique v1 SHA-256 fingerprints");
      }
      const sortedReceiptIds = [...input.receiptIds].sort(compareText);
      if (stableStringify(sortedReceiptIds) !== stableStringify(input.receiptIds)) {
        throw badRequest("receiptIds must be sorted");
      }
      const candidates = await loadCandidateAgents(db, input);
      const beforeEvidence = await captureInstructionEvidence(candidates);
      try {
        return await withPortfolioAgentStartLocks(input.agentIds, () => db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await setTransactionTimeouts(txDb);
          const lockedAgents = await txDb
            .select({
              id: agents.id,
              status: agents.status,
              pauseReason: agents.pauseReason,
              updatedAt: agents.updatedAt,
            })
            .from(agents)
            .where(and(
              eq(agents.companyId, input.companyId),
              inArray(agents.id, input.agentIds),
            ))
            .orderBy(agents.id)
            .for("update");
          if (
            lockedAgents.length !== input.agentIds.length
            || stableStringify(lockedAgents.map((agent) => agent.id)) !== stableStringify(input.agentIds)
          ) {
            throw conflict("Portfolio maintenance agent lock coverage drifted", {
              code: "portfolio_maintenance_gate_drift",
            });
          }
          await tx.execute(sql.raw(
            "LOCK TABLE agent_portfolio_maintenance_gates, issues, routines, routine_triggers, activity_log, principal_permission_grants, company_skills IN SHARE ROW EXCLUSIVE MODE",
          ));
          const gateRows = await txDb
            .select({
              agentId: agentPortfolioMaintenanceGates.agentId,
              operationId: agentPortfolioMaintenanceGates.operationId,
              receiptId: agentPortfolioMaintenanceGates.receiptId,
              stage: agentPortfolioMaintenanceGates.stage,
            })
            .from(agentPortfolioMaintenanceGates)
            .where(and(
              eq(agentPortfolioMaintenanceGates.companyId, input.companyId),
              inArray(agentPortfolioMaintenanceGates.agentId, input.agentIds),
            ));
          if (gateRows.length === 0) {
            const releases = await txDb
              .select({ details: activityLog.details })
              .from(activityLog)
              .where(and(
                eq(activityLog.companyId, input.companyId),
                eq(activityLog.action, "company.portfolio_maintenance_gate_released"),
                eq(activityLog.entityType, "portfolio_maintenance_gate"),
              ));
            const stored = releases
              .map((row) => readStoredGateRelease(row.details, input))
              .find((receipt): receipt is PortfolioMaintenanceGateReleaseResponse => receipt !== null);
            if (stored) return stored;
            throw conflict("Portfolio maintenance execution gate is missing", {
              code: "portfolio_maintenance_gate_missing",
            });
          }
          const sortedGateRows = [...gateRows].sort((left, right) => compareText(left.agentId, right.agentId));
          if (
            sortedGateRows.length !== input.agentIds.length
            || stableStringify(sortedGateRows.map((gate) => gate.agentId)) !== stableStringify(input.agentIds)
            || new Set(sortedGateRows.map((gate) => gate.operationId)).size !== 1
            || new Set(sortedGateRows.map((gate) => gate.receiptId)).size !== 1
            || new Set(sortedGateRows.map((gate) => gate.stage)).size !== 1
            || sortedGateRows[0]?.stage !== "quiesced"
          ) {
            throw conflict("Portfolio maintenance execution gate coverage drifted", {
              code: "portfolio_maintenance_gate_drift",
            });
          }
          const receiptId = sortedGateRows[0]?.receiptId;
          if (!receiptId || !input.receiptIds.includes(receiptId)) {
            throw conflict("Portfolio maintenance execution gate receipt did not match", {
              code: "portfolio_maintenance_gate_receipt_mismatch",
            });
          }
          const lockedEvidence = await captureInstructionEvidence(candidates);
          if (!instructionEvidenceMatches(beforeEvidence, lockedEvidence)) throw instructionEvidenceDrift();
          const snapshot = await loadSnapshot(txDb, input, lockedEvidence);
          if (
            !snapshot.response.restoreReady
            || snapshot.response.wakes.length > 0
            || snapshot.response.liveRuns.length > 0
            || snapshot.agents.some((agent) => (
              agent.status !== "paused" || agent.pauseReason !== "maintenance"
            ))
            || snapshot.response.snapshotFingerprint !== input.expectedSnapshotFingerprint
            || snapshot.response.maintenanceGate?.stage !== "quiesced"
          ) {
            throw conflict("Portfolio maintenance gate release prerequisites are not satisfied", {
              code: "portfolio_maintenance_gate_release_not_ready",
            });
          }
          const finalEvidence = await captureInstructionEvidence(snapshot.candidateAgents);
          if (!instructionEvidenceMatches(beforeEvidence, finalEvidence)) throw instructionEvidenceDrift();
          const releasedAt = now();
          const deleted = await txDb
            .delete(agentPortfolioMaintenanceGates)
            .where(and(
              eq(agentPortfolioMaintenanceGates.companyId, input.companyId),
              eq(agentPortfolioMaintenanceGates.operationId, sortedGateRows[0]!.operationId),
              eq(agentPortfolioMaintenanceGates.receiptId, receiptId),
              inArray(agentPortfolioMaintenanceGates.agentId, input.agentIds),
              sql`exists (
                select 1
                from ${agents}
                where ${agents.id} = ${agentPortfolioMaintenanceGates.agentId}
                  and ${agents.companyId} = ${agentPortfolioMaintenanceGates.companyId}
                  and ${agents.status} = 'paused'
                  and ${agents.pauseReason} = 'maintenance'
              )`,
            ))
            .returning({ agentId: agentPortfolioMaintenanceGates.agentId });
          if (deleted.length !== input.agentIds.length) {
            throw conflict("Portfolio maintenance execution gate release CAS failed", {
              code: "portfolio_maintenance_gate_drift",
            });
          }
          const receipt: PortfolioMaintenanceGateReleaseResponse = {
            schemaVersion: PORTFOLIO_MAINTENANCE_SCHEMA_VERSION,
            companyId: input.companyId,
            agentIds: input.agentIds,
            receiptId,
            expectedSnapshotFingerprint: input.expectedSnapshotFingerprint,
            releasedAt: releasedAt.toISOString(),
          };
          await txDb.insert(activityLog).values({
            companyId: input.companyId,
            actorType: "user",
            actorId: input.actorUserId,
            action: "company.portfolio_maintenance_gate_released",
            entityType: "portfolio_maintenance_gate",
            entityId: sortedGateRows[0]!.operationId,
            details: { receipt },
            createdAt: releasedAt,
          });
          return receipt;
        }, { isolationLevel: "serializable", accessMode: "read write" }));
      } catch (error) {
        const code = databaseErrorCode(error);
        if (["40001", "40P01", "55P03", "57014"].includes(code ?? "")) {
          throw conflict("Portfolio maintenance gate release drifted; retry from the restore checkpoint", {
            code: "portfolio_maintenance_gate_drift",
          });
        }
        throw error;
      }
    },
  };
}

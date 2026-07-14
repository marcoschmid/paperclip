import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvalExecutionClaims,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
  approvalExecutionClaimConsumeRequestSchema,
  approvalExecutionClaimFinalizeRequestSchema,
  approvalExecutionClaimRecoveryRequestSchema,
  approvalExecutionClaimRecoveryReceiptSchema,
  approvalExecutionClaimRequestSchema,
  type ApprovalExecutionClaimConsumeRequest,
  type ApprovalExecutionClaimExecutionReceipt,
  type ApprovalExecutionClaimFinalizationReceipt,
  type ApprovalExecutionClaimFinalizeRequest,
  type ApprovalExecutionClaimReceipt,
  type ApprovalExecutionClaimRecoveryRequest,
  type ApprovalExecutionClaimRecoveryReceipt,
  type ApprovalExecutionClaimRequest,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

const APPROVAL_MAX_AGE_MS = 15 * 60 * 1_000;
const APPROVAL_CLOCK_SKEW_MS = 30 * 1_000;
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_EXECUTION_TTL_MS = 30 * 60 * 1_000;
const TERMINAL_ORIGIN_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const APPROVAL_WAKE_REASONS = new Set(["approval_approved", "issue_execution_deferred"]);
const PIPE_APPROVAL_KINDS = new Set(["media_pipe_quote", "research_pipe_quote"]);
const NON_EXECUTABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval", "error"]);
const BINDING_KEYS = [
  "agent_id",
  "company_id",
  "execution_run_id",
  "issue_id",
  "paperclip_run_id",
] as const;

type UnknownRecord = Record<string, unknown>;
type ClaimRow = typeof approvalExecutionClaims.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

interface ExecutionBindingRequest {
  executionRunId: string;
  originRunId: string;
  issueId: string;
  approvalPayloadSha256: string;
  callFingerprintSha256: string;
}

interface BaseExecutionInput {
  approvalId: string;
  companyId: string;
  agentId: string;
  executorRunId: string;
}

export interface ApprovalExecutionClaimInput extends BaseExecutionInput {
  request: ApprovalExecutionClaimRequest;
}

export interface ApprovalExecutionClaimConsumeInput extends BaseExecutionInput {
  request: ApprovalExecutionClaimConsumeRequest;
}

export interface ApprovalExecutionClaimFinalizeInput extends BaseExecutionInput {
  request: ApprovalExecutionClaimFinalizeRequest;
}

export interface ApprovalExecutionClaimRecoveryInput {
  approvalId: string;
  companyId: string;
  actorUserId: string;
  request: ApprovalExecutionClaimRecoveryRequest;
}

export interface ApprovalExecutionClaimServiceOptions {
  now?: () => Date;
  pendingTtlMs?: number;
  executionTtlMs?: number;
}

type TransactionDecision<T> = { ok: true; value: T } | { ok: false };

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function includesExactString(value: unknown, expected: string) {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function rejected() {
  return conflict("Approval execution claim rejected", {
    code: "approval_execution_claim_rejected",
  });
}

function databaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as UnknownRecord;
  if (typeof record.code === "string") return record.code;
  return databaseErrorCode(record.cause);
}

function exactBindingMatches(
  value: unknown,
  input: BaseExecutionInput & { request: ExecutionBindingRequest },
) {
  const binding = asRecord(value);
  if (!binding) return false;
  const keys = Object.keys(binding).sort();
  if (keys.length !== BINDING_KEYS.length || keys.some((key, index) => key !== BINDING_KEYS[index])) {
    return false;
  }
  return binding.company_id === input.companyId
    && binding.issue_id === input.request.issueId
    && binding.agent_id === input.agentId
    && binding.paperclip_run_id === input.request.originRunId
    && binding.execution_run_id === input.request.executionRunId;
}

function originContextMatches(value: unknown, issueId: string) {
  const context = asRecord(value);
  if (!context || context.issueId !== issueId) return false;
  return context.taskId === undefined || context.taskId === null || context.taskId === issueId;
}

function executorContextMatches(value: unknown, input: BaseExecutionInput & { request: ExecutionBindingRequest }) {
  const context = asRecord(value);
  if (!context) return false;
  return context.source === "approval.approved"
    && context.approvalId === input.approvalId
    && context.approvalStatus === "approved"
    && context.issueId === input.request.issueId
    && context.taskId === input.request.issueId
    && context.wakeReason === "approval_approved"
    && includesExactString(context.issueIds, input.request.issueId);
}

function wakeMatches(
  wake: typeof agentWakeupRequests.$inferSelect,
  input: BaseExecutionInput & { request: ExecutionBindingRequest },
  decidedByUserId: string,
) {
  const payload = asRecord(wake.payload);
  return wake.companyId === input.companyId
    && wake.agentId === input.agentId
    && wake.runId === input.executorRunId
    && wake.source === "automation"
    && wake.triggerDetail === "system"
    && APPROVAL_WAKE_REASONS.has(wake.reason ?? "")
    && wake.status === "claimed"
    && wake.requestedByActorType === "user"
    && wake.requestedByActorId === decidedByUserId
    && payload?.approvalId === input.approvalId
    && payload.approvalStatus === "approved"
    && payload.issueId === input.request.issueId
    && includesExactString(payload.issueIds, input.request.issueId);
}

function approvalIsFresh(input: {
  now: Date;
  decidedAt: Date | null;
  payloadCreatedAt: unknown;
}) {
  if (
    !input.decidedAt
    || typeof input.payloadCreatedAt !== "string"
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.payloadCreatedAt)
  ) return false;
  const createdAt = new Date(input.payloadCreatedAt);
  if (Number.isNaN(createdAt.getTime())) return false;
  const ageMs = input.now.getTime() - input.decidedAt.getTime();
  return ageMs >= -APPROVAL_CLOCK_SKEW_MS
    && ageMs <= APPROVAL_MAX_AGE_MS
    && createdAt.getTime() <= input.now.getTime() + APPROVAL_CLOCK_SKEW_MS
    && input.decidedAt.getTime() >= createdAt.getTime() - APPROVAL_CLOCK_SKEW_MS;
}

function validPipeApproval(
  approval: typeof approvals.$inferSelect,
  input: BaseExecutionInput & { request: ExecutionBindingRequest },
  currentTime: Date,
) {
  const payload = asRecord(approval.payload);
  const decidedByUserId = nonEmptyString(approval.decidedByUserId);
  if (
    approval.type !== "request_board_approval"
    || approval.status !== "approved"
    || !decidedByUserId
    || !payload
    || !PIPE_APPROVAL_KINDS.has(nonEmptyString(payload.kind) ?? "")
    || payload.approval_payload_sha256 !== input.request.approvalPayloadSha256
    || payload.execution_snapshot_sha256 !== input.request.callFingerprintSha256
    || !exactBindingMatches(payload.binding, input)
    || !approvalIsFresh({
      now: currentTime,
      decidedAt: approval.decidedAt,
      payloadCreatedAt: payload.created_at,
    })
  ) return null;
  return { payload, decidedByUserId };
}

async function trustedExecutorMatches(
  db: Db,
  run: HeartbeatRunRow,
  input: BaseExecutionInput & { request: ExecutionBindingRequest },
  decidedByUserId: string,
) {
  if (
    run.id !== input.executorRunId
    || run.companyId !== input.companyId
    || run.agentId !== input.agentId
    || run.status !== "running"
    || run.finishedAt !== null
    || run.invocationSource !== "automation"
    || run.triggerDetail !== "system"
    || !run.wakeupRequestId
    || !executorContextMatches(run.contextSnapshot, input)
  ) return false;
  const wake = await db.select()
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId),
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.runId, input.executorRunId),
    ))
    .then((rows) => rows[0] ?? null);
  return Boolean(wake && wakeMatches(wake, input, decidedByUserId));
}

function claimReceiptFromRow(row: ClaimRow, replayed: boolean): ApprovalExecutionClaimReceipt {
  return {
    schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
    approvalId: row.approvalId,
    companyId: row.companyId,
    agentId: row.agentId,
    issueId: row.issueId,
    originRunId: row.originRunId,
    executorRunId: row.executorRunId,
    executionRunId: row.executionRunId,
    approvalPayloadSha256: row.approvalPayloadSha256,
    callFingerprintSha256: row.callFingerprintSha256,
    status: "pending",
    claimedAt: row.claimedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    receiptSha256: row.receiptSha256,
    replayed,
  };
}

function claimMatches(row: ClaimRow, input: ApprovalExecutionClaimInput) {
  return row.approvalId === input.approvalId
    && row.companyId === input.companyId
    && row.agentId === input.agentId
    && row.issueId === input.request.issueId
    && row.originRunId === input.request.originRunId
    && row.executorRunId === input.executorRunId
    && row.executionRunId === input.request.executionRunId
    && row.approvalPayloadSha256 === input.request.approvalPayloadSha256
    && row.callFingerprintSha256 === input.request.callFingerprintSha256;
}

function consumeMatches(row: ClaimRow, input: ApprovalExecutionClaimConsumeInput) {
  return claimMatches(row, input)
    && row.receiptSha256 === input.request.receiptSha256;
}

function executionReceiptFromRow(row: ClaimRow): ApprovalExecutionClaimExecutionReceipt {
  if (!row.executionStartedAt || !row.executionExpiresAt || !row.executionReceiptSha256) throw rejected();
  return {
    schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
    approvalId: row.approvalId,
    companyId: row.companyId,
    agentId: row.agentId,
    issueId: row.issueId,
    originRunId: row.originRunId,
    executorRunId: row.executorRunId,
    executionRunId: row.executionRunId,
    approvalPayloadSha256: row.approvalPayloadSha256,
    callFingerprintSha256: row.callFingerprintSha256,
    claimReceiptSha256: row.receiptSha256,
    status: "executing",
    executionStartedAt: row.executionStartedAt.toISOString(),
    executionExpiresAt: row.executionExpiresAt.toISOString(),
    executionReceiptSha256: row.executionReceiptSha256,
  };
}

function finalizationReceiptFromRow(
  row: ClaimRow,
  replayed: boolean,
): ApprovalExecutionClaimFinalizationReceipt {
  if (
    (row.status !== "completed" && row.status !== "failed")
    || !row.executionReceiptSha256
    || !row.finishedAt
    || !row.finalizationReceiptSha256
  ) throw rejected();
  return {
    schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
    approvalId: row.approvalId,
    companyId: row.companyId,
    agentId: row.agentId,
    executorRunId: row.executorRunId,
    executionRunId: row.executionRunId,
    callFingerprintSha256: row.callFingerprintSha256,
    executionReceiptSha256: row.executionReceiptSha256,
    status: row.status,
    failureCode: row.failureCode as ApprovalExecutionClaimFinalizationReceipt["failureCode"],
    finishedAt: row.finishedAt.toISOString(),
    finalizationReceiptSha256: row.finalizationReceiptSha256,
    replayed,
  };
}

function recoveryReceiptFromActivity(
  activity: typeof activityLog.$inferSelect,
  claim: ClaimRow,
  input: ApprovalExecutionClaimRecoveryInput,
): ApprovalExecutionClaimRecoveryReceipt | null {
  if (
    activity.companyId !== input.companyId
    || activity.actorType !== "user"
    || activity.actorId !== input.actorUserId
    || activity.agentId !== null
    || activity.runId !== null
    || activity.action !== "approval.execution_claim_recovered"
    || activity.entityType !== "approval"
    || activity.entityId !== input.approvalId
    || claim.status !== "failed"
    || claim.failureCode !== "execution_lease_expired"
    || !claim.finalizationReceiptSha256
  ) return null;
  const details = asRecord(activity.details);
  const recovery = asRecord(details?.recovery);
  const recoveryReceiptSha256 = nonEmptyString(details?.recoveryReceiptSha256);
  if (!recovery || !recoveryReceiptSha256 || sha256(recovery) !== recoveryReceiptSha256) return null;
  const candidate = approvalExecutionClaimRecoveryReceiptSchema.safeParse({
    ...recovery,
    recoveryReceiptSha256,
    replayed: true,
  });
  if (!candidate.success) return null;
  const receipt = candidate.data;
  if (
    receipt.approvalId !== input.approvalId
    || receipt.companyId !== input.companyId
    || receipt.agentId !== claim.agentId
    || receipt.executorRunId !== claim.executorRunId
    || receipt.executionRunId !== input.request.executionRunId
    || receipt.callFingerprintSha256 !== input.request.callFingerprintSha256
    || receipt.executionReceiptSha256 !== input.request.executionReceiptSha256
    || receipt.finalizationReceiptSha256 !== claim.finalizationReceiptSha256
    || receipt.recoveredByUserId !== input.actorUserId
    || receipt.recoveryReason !== input.request.reason
    || receipt.recoveryEvidenceSha256 !== input.request.evidenceSha256
    || receipt.expectedUpdatedAt !== input.request.expectedUpdatedAt
    || claim.executionRunId !== input.request.executionRunId
    || claim.callFingerprintSha256 !== input.request.callFingerprintSha256
    || claim.executionReceiptSha256 !== input.request.executionReceiptSha256
  ) return null;
  return receipt;
}

async function revokePendingClaim(db: Db, row: ClaimRow, reason: string, currentTime: Date) {
  await db.update(approvalExecutionClaims).set({
    status: "revoked",
    revokedAt: currentTime,
    revocationReason: reason,
    updatedAt: currentTime,
  }).where(and(
    eq(approvalExecutionClaims.id, row.id),
    eq(approvalExecutionClaims.status, "pending"),
  ));
}

function boundedTtl(value: number | undefined, fallback: number) {
  if (!Number.isSafeInteger(value) || value! <= 0) return fallback;
  return Math.min(value!, 24 * 60 * 60 * 1_000);
}

export function approvalExecutionClaimService(
  db: Db,
  options: ApprovalExecutionClaimServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const pendingTtlMs = boundedTtl(options.pendingTtlMs, DEFAULT_PENDING_TTL_MS);
  const executionTtlMs = boundedTtl(options.executionTtlMs, DEFAULT_EXECUTION_TTL_MS);

  return {
    claim: async (rawInput: ApprovalExecutionClaimInput): Promise<ApprovalExecutionClaimReceipt> => {
      const input: ApprovalExecutionClaimInput = {
        ...rawInput,
        request: approvalExecutionClaimRequestSchema.parse(rawInput.request),
      };

      try {
        const decision = await db.transaction(async (tx): Promise<TransactionDecision<ApprovalExecutionClaimReceipt>> => {
          const txDb = tx as unknown as Db;
          // Canonical lifecycle lock order: Agent -> executor run -> approval.
          const agent = await txDb.select().from(agents).where(and(
            eq(agents.id, input.agentId),
            eq(agents.companyId, input.companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!agent || NON_EXECUTABLE_AGENT_STATUSES.has(agent.status)) return { ok: false };

          const executorRun = await txDb.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, input.executorRunId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!executorRun) return { ok: false };

          const approval = await txDb.select().from(approvals).where(and(
            eq(approvals.id, input.approvalId),
            eq(approvals.companyId, input.companyId),
            eq(approvals.requestedByAgentId, input.agentId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!approval) return { ok: false };

          const currentTime = now();
          const approvalEvidence = validPipeApproval(approval, input, currentTime);
          if (!approvalEvidence || !(await trustedExecutorMatches(
            txDb,
            executorRun,
            input,
            approvalEvidence.decidedByUserId,
          ))) return { ok: false };

          const existing = await txDb.select().from(approvalExecutionClaims)
            .where(eq(approvalExecutionClaims.approvalId, input.approvalId))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (existing) {
            if (!claimMatches(existing, input) || existing.status !== "pending") return { ok: false };
            if (existing.expiresAt.getTime() <= currentTime.getTime()) {
              await revokePendingClaim(txDb, existing, "claim_expired", currentTime);
              return { ok: false };
            }
            return { ok: true, value: claimReceiptFromRow(existing, true) };
          }

          const [issueLink, issue, originRun] = await Promise.all([
            txDb.select({ issueId: issueApprovals.issueId }).from(issueApprovals).where(and(
              eq(issueApprovals.approvalId, input.approvalId),
              eq(issueApprovals.issueId, input.request.issueId),
              eq(issueApprovals.companyId, input.companyId),
            )).then((rows) => rows[0] ?? null),
            txDb.select({
              id: issues.id,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
            }).from(issues).where(and(
              eq(issues.id, input.request.issueId),
              eq(issues.companyId, input.companyId),
            )).then((rows) => rows[0] ?? null),
            txDb.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.id, input.request.originRunId),
              eq(heartbeatRuns.companyId, input.companyId),
              eq(heartbeatRuns.agentId, input.agentId),
            )).then((rows) => rows[0] ?? null),
          ]);
          if (
            !issueLink
            || !issue
            || TERMINAL_ISSUE_STATUSES.has(issue.status)
            || issue.assigneeAgentId !== input.agentId
            || !originRun
            || input.request.originRunId === input.executorRunId
            || !TERMINAL_ORIGIN_RUN_STATUSES.has(originRun.status)
            || !originContextMatches(originRun.contextSnapshot, input.request.issueId)
          ) return { ok: false };

          const expiresAt = new Date(currentTime.getTime() + pendingTtlMs);
          const receiptBase = {
            schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
            approvalId: input.approvalId,
            companyId: input.companyId,
            agentId: input.agentId,
            issueId: input.request.issueId,
            originRunId: input.request.originRunId,
            executorRunId: input.executorRunId,
            executionRunId: input.request.executionRunId,
            approvalPayloadSha256: input.request.approvalPayloadSha256,
            callFingerprintSha256: input.request.callFingerprintSha256,
            status: "pending" as const,
            claimedAt: currentTime.toISOString(),
            expiresAt: expiresAt.toISOString(),
          };
          const receiptSha256 = sha256(receiptBase);
          const inserted = await txDb.insert(approvalExecutionClaims).values({
            approvalId: input.approvalId,
            companyId: input.companyId,
            agentId: input.agentId,
            issueId: input.request.issueId,
            originRunId: input.request.originRunId,
            executorRunId: input.executorRunId,
            executionRunId: input.request.executionRunId,
            approvalPayloadSha256: input.request.approvalPayloadSha256,
            callFingerprintSha256: input.request.callFingerprintSha256,
            receiptSha256,
            status: "pending",
            claimedAt: currentTime,
            expiresAt,
            updatedAt: currentTime,
          }).returning().then((rows) => rows[0] ?? null);
          if (!inserted) return { ok: false };

          await txDb.insert(activityLog).values({
            companyId: input.companyId,
            actorType: "agent",
            actorId: input.agentId,
            agentId: input.agentId,
            runId: input.executorRunId,
            action: "approval.execution_claimed",
            entityType: "approval",
            entityId: input.approvalId,
            details: {
              issueId: input.request.issueId,
              originRunId: input.request.originRunId,
              executorRunId: input.executorRunId,
              executionRunId: input.request.executionRunId,
              approvalPayloadSha256: input.request.approvalPayloadSha256,
              callFingerprintSha256: input.request.callFingerprintSha256,
              receiptSha256,
              expiresAt: expiresAt.toISOString(),
            },
          });
          return { ok: true, value: claimReceiptFromRow(inserted, false) };
        });
        if (!decision.ok) throw rejected();
        return decision.value;
      } catch (error) {
        if (databaseErrorCode(error) === "23505") throw rejected();
        throw error;
      }
    },

    consume: async (
      rawInput: ApprovalExecutionClaimConsumeInput,
    ): Promise<ApprovalExecutionClaimExecutionReceipt> => {
      const input: ApprovalExecutionClaimConsumeInput = {
        ...rawInput,
        request: approvalExecutionClaimConsumeRequestSchema.parse(rawInput.request),
      };
      const decision = await db.transaction(async (tx): Promise<TransactionDecision<ApprovalExecutionClaimExecutionReceipt>> => {
        const txDb = tx as unknown as Db;
        // The dispatch boundary always serializes Agent -> executor run -> claim.
        const agent = await txDb.select().from(agents).where(and(
          eq(agents.id, input.agentId),
          eq(agents.companyId, input.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!agent) return { ok: false };

        const executorRun = await txDb.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, input.executorRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!executorRun) return { ok: false };

        const claim = await txDb.select().from(approvalExecutionClaims).where(and(
          eq(approvalExecutionClaims.approvalId, input.approvalId),
          eq(approvalExecutionClaims.companyId, input.companyId),
          eq(approvalExecutionClaims.agentId, input.agentId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!claim || !consumeMatches(claim, input) || claim.status !== "pending") return { ok: false };

        const currentTime = now();
        if (claim.expiresAt.getTime() <= currentTime.getTime()) {
          await revokePendingClaim(txDb, claim, "claim_expired", currentTime);
          return { ok: false };
        }
        if (agent.status !== "running") {
          await revokePendingClaim(txDb, claim, "agent_not_running", currentTime);
          return { ok: false };
        }

        const approval = await txDb.select().from(approvals).where(and(
          eq(approvals.id, input.approvalId),
          eq(approvals.companyId, input.companyId),
          eq(approvals.requestedByAgentId, input.agentId),
        )).then((rows) => rows[0] ?? null);
        const approvalEvidence = approval ? validPipeApproval(approval, input, currentTime) : null;
        if (!approvalEvidence || !(await trustedExecutorMatches(
          txDb,
          executorRun,
          input,
          approvalEvidence.decidedByUserId,
        ))) {
          await revokePendingClaim(txDb, claim, "approval_or_executor_not_executable", currentTime);
          return { ok: false };
        }

        const [issueLink, issue, originRun] = await Promise.all([
          txDb.select({ issueId: issueApprovals.issueId }).from(issueApprovals).where(and(
            eq(issueApprovals.approvalId, input.approvalId),
            eq(issueApprovals.issueId, input.request.issueId),
            eq(issueApprovals.companyId, input.companyId),
          )).then((rows) => rows[0] ?? null),
          txDb.select({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          }).from(issues).where(and(
            eq(issues.id, input.request.issueId),
            eq(issues.companyId, input.companyId),
          )).then((rows) => rows[0] ?? null),
          txDb.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, input.request.originRunId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
          )).then((rows) => rows[0] ?? null),
        ]);
        if (
          !issueLink
          || !issue
          || TERMINAL_ISSUE_STATUSES.has(issue.status)
          || issue.assigneeAgentId !== input.agentId
          || !originRun
          || !TERMINAL_ORIGIN_RUN_STATUSES.has(originRun.status)
          || !originContextMatches(originRun.contextSnapshot, input.request.issueId)
        ) {
          await revokePendingClaim(txDb, claim, "execution_context_terminal_or_changed", currentTime);
          return { ok: false };
        }

        const executionExpiresAt = new Date(currentTime.getTime() + executionTtlMs);
        const executionBase = {
          schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
          approvalId: claim.approvalId,
          companyId: claim.companyId,
          agentId: claim.agentId,
          issueId: claim.issueId,
          originRunId: claim.originRunId,
          executorRunId: claim.executorRunId,
          executionRunId: claim.executionRunId,
          approvalPayloadSha256: claim.approvalPayloadSha256,
          callFingerprintSha256: claim.callFingerprintSha256,
          claimReceiptSha256: claim.receiptSha256,
          status: "executing" as const,
          executionStartedAt: currentTime.toISOString(),
          executionExpiresAt: executionExpiresAt.toISOString(),
        };
        const executionReceiptSha256 = sha256(executionBase);
        const executing = await txDb.update(approvalExecutionClaims).set({
          status: "executing",
          executionStartedAt: currentTime,
          executionExpiresAt,
          executionReceiptSha256,
          updatedAt: currentTime,
        }).where(and(
          eq(approvalExecutionClaims.id, claim.id),
          eq(approvalExecutionClaims.status, "pending"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!executing) return { ok: false };

        await txDb.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.executorRunId,
          action: "approval.execution_claim_consumed",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            issueId: claim.issueId,
            executionRunId: claim.executionRunId,
            callFingerprintSha256: claim.callFingerprintSha256,
            receiptSha256: claim.receiptSha256,
            executionReceiptSha256,
            executionExpiresAt: executionExpiresAt.toISOString(),
          },
        });
        return { ok: true, value: executionReceiptFromRow(executing) };
      });
      if (!decision.ok) throw rejected();
      return decision.value;
    },

    recoverExpired: async (
      rawInput: ApprovalExecutionClaimRecoveryInput,
    ): Promise<ApprovalExecutionClaimRecoveryReceipt> => {
      const input: ApprovalExecutionClaimRecoveryInput = {
        ...rawInput,
        request: approvalExecutionClaimRecoveryRequestSchema.parse(rawInput.request),
      };
      if (!nonEmptyString(input.actorUserId) || input.actorUserId.length > 200) throw rejected();
      const expectedUpdatedAt = new Date(input.request.expectedUpdatedAt);
      if (Number.isNaN(expectedUpdatedAt.getTime())) throw rejected();

      const decision = await db.transaction(async (tx): Promise<TransactionDecision<ApprovalExecutionClaimRecoveryReceipt>> => {
        const txDb = tx as unknown as Db;
        const discovered = await txDb.select({
          agentId: approvalExecutionClaims.agentId,
          executorRunId: approvalExecutionClaims.executorRunId,
        }).from(approvalExecutionClaims).where(and(
          eq(approvalExecutionClaims.approvalId, input.approvalId),
          eq(approvalExecutionClaims.companyId, input.companyId),
        )).then((rows) => rows[0] ?? null);
        if (!discovered) return { ok: false };

        // Preserve the lifecycle lock order used by consume/finalize.
        const agent = await txDb.select().from(agents).where(and(
          eq(agents.id, discovered.agentId),
          eq(agents.companyId, input.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!agent) return { ok: false };

        const executorRun = await txDb.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, discovered.executorRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, discovered.agentId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!executorRun) return { ok: false };

        const claim = await txDb.select().from(approvalExecutionClaims).where(and(
          eq(approvalExecutionClaims.approvalId, input.approvalId),
          eq(approvalExecutionClaims.companyId, input.companyId),
          eq(approvalExecutionClaims.agentId, discovered.agentId),
          eq(approvalExecutionClaims.executorRunId, discovered.executorRunId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!claim) return { ok: false };

        if (claim.status === "failed" && claim.failureCode === "execution_lease_expired") {
          const activities = await txDb.select().from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.action, "approval.execution_claim_recovered"),
            eq(activityLog.entityType, "approval"),
            eq(activityLog.entityId, input.approvalId),
          ));
          const matches = activities
            .map((activity) => recoveryReceiptFromActivity(activity, claim, input))
            .filter((receipt): receipt is ApprovalExecutionClaimRecoveryReceipt => receipt !== null);
          return matches.length === 1
            ? { ok: true, value: matches[0]! }
            : { ok: false };
        }

        const currentTime = now();
        if (
          claim.status !== "executing"
          || !claim.executionExpiresAt
          || claim.executionExpiresAt.getTime() > currentTime.getTime()
          || claim.executionRunId !== input.request.executionRunId
          || claim.callFingerprintSha256 !== input.request.callFingerprintSha256
          || claim.executionReceiptSha256 !== input.request.executionReceiptSha256
          || claim.updatedAt.getTime() !== expectedUpdatedAt.getTime()
        ) return { ok: false };

        const finalizationBase = {
          schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
          approvalId: claim.approvalId,
          companyId: claim.companyId,
          agentId: claim.agentId,
          executorRunId: claim.executorRunId,
          executionRunId: claim.executionRunId,
          callFingerprintSha256: claim.callFingerprintSha256,
          executionReceiptSha256: claim.executionReceiptSha256,
          status: "failed" as const,
          failureCode: "execution_lease_expired" as const,
          finishedAt: currentTime.toISOString(),
        };
        const finalizationReceiptSha256 = sha256(finalizationBase);
        const recoveryBase = {
          schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
          approvalId: claim.approvalId,
          companyId: claim.companyId,
          agentId: claim.agentId,
          executorRunId: claim.executorRunId,
          executionRunId: claim.executionRunId,
          callFingerprintSha256: claim.callFingerprintSha256,
          executionReceiptSha256: claim.executionReceiptSha256,
          finalizationReceiptSha256,
          status: "failed" as const,
          failureCode: "execution_lease_expired" as const,
          recoveredByUserId: input.actorUserId,
          recoveryReason: input.request.reason,
          recoveryEvidenceSha256: input.request.evidenceSha256,
          expectedUpdatedAt: input.request.expectedUpdatedAt,
          recoveredAt: currentTime.toISOString(),
        };
        const recoveryReceiptSha256 = sha256(recoveryBase);
        const recovered = await txDb.update(approvalExecutionClaims).set({
          status: "failed",
          finishedAt: currentTime,
          failureCode: "execution_lease_expired",
          finalizationReceiptSha256,
          updatedAt: currentTime,
        }).where(and(
          eq(approvalExecutionClaims.id, claim.id),
          eq(approvalExecutionClaims.status, "executing"),
          eq(approvalExecutionClaims.updatedAt, expectedUpdatedAt),
          eq(approvalExecutionClaims.executionReceiptSha256, input.request.executionReceiptSha256),
        )).returning().then((rows) => rows[0] ?? null);
        if (!recovered) return { ok: false };

        await txDb.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actorUserId,
          agentId: null,
          runId: null,
          action: "approval.execution_claim_recovered",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            recovery: recoveryBase,
            recoveryReceiptSha256,
          },
        });
        return {
          ok: true,
          value: {
            ...recoveryBase,
            recoveryReceiptSha256,
            replayed: false,
          },
        };
      });
      if (!decision.ok) throw rejected();
      return decision.value;
    },

    finalize: async (
      rawInput: ApprovalExecutionClaimFinalizeInput,
    ): Promise<ApprovalExecutionClaimFinalizationReceipt> => {
      const input: ApprovalExecutionClaimFinalizeInput = {
        ...rawInput,
        request: approvalExecutionClaimFinalizeRequestSchema.parse(rawInput.request),
      };
      const decision = await db.transaction(async (tx): Promise<TransactionDecision<ApprovalExecutionClaimFinalizationReceipt>> => {
        const txDb = tx as unknown as Db;
        // Match consume ordering so finalization cannot deadlock lifecycle writes.
        const agent = await txDb.select().from(agents).where(and(
          eq(agents.id, input.agentId),
          eq(agents.companyId, input.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!agent || agent.status === "terminated") return { ok: false };

        const executorRun = await txDb.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, input.executorRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!executorRun || executorRun.status !== "running" || executorRun.finishedAt !== null) return { ok: false };

        const claim = await txDb.select().from(approvalExecutionClaims).where(and(
          eq(approvalExecutionClaims.approvalId, input.approvalId),
          eq(approvalExecutionClaims.companyId, input.companyId),
          eq(approvalExecutionClaims.agentId, input.agentId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (
          !claim
          || claim.executorRunId !== input.executorRunId
          || claim.executionRunId !== input.request.executionRunId
          || claim.callFingerprintSha256 !== input.request.callFingerprintSha256
          || claim.executionReceiptSha256 !== input.request.executionReceiptSha256
        ) return { ok: false };

        if (claim.status === "completed" || claim.status === "failed") {
          const expectedFailureCode = input.request.outcome === "failed"
            ? input.request.failureCode ?? null
            : null;
          if (claim.status !== input.request.outcome || claim.failureCode !== expectedFailureCode) return { ok: false };
          return { ok: true, value: finalizationReceiptFromRow(claim, true) };
        }
        if (claim.status !== "executing") return { ok: false };

        const currentTime = now();
        const failureCode = input.request.outcome === "failed"
          ? input.request.failureCode ?? null
          : null;
        const finalizationBase = {
          schemaVersion: APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION,
          approvalId: claim.approvalId,
          companyId: claim.companyId,
          agentId: claim.agentId,
          executorRunId: claim.executorRunId,
          executionRunId: claim.executionRunId,
          callFingerprintSha256: claim.callFingerprintSha256,
          executionReceiptSha256: claim.executionReceiptSha256!,
          status: input.request.outcome,
          failureCode,
          finishedAt: currentTime.toISOString(),
        };
        const finalizationReceiptSha256 = sha256(finalizationBase);
        const finalized = await txDb.update(approvalExecutionClaims).set({
          status: input.request.outcome,
          finishedAt: currentTime,
          failureCode,
          finalizationReceiptSha256,
          updatedAt: currentTime,
        }).where(and(
          eq(approvalExecutionClaims.id, claim.id),
          eq(approvalExecutionClaims.status, "executing"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!finalized) return { ok: false };

        await txDb.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.executorRunId,
          action: "approval.execution_claim_finalized",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            executionRunId: claim.executionRunId,
            callFingerprintSha256: claim.callFingerprintSha256,
            executionReceiptSha256: claim.executionReceiptSha256,
            status: input.request.outcome,
            failureCode,
            finalizationReceiptSha256,
          },
        });
        return { ok: true, value: finalizationReceiptFromRow(finalized, false) };
      });
      if (!decision.ok) throw rejected();
      return decision.value;
    },
  };
}

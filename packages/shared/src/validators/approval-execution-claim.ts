import { z } from "zod";

export const APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION = "2.0.0" as const;

const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const executionRunIdSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const executionBindingSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  executionRunId: executionRunIdSchema,
  originRunId: z.string().uuid(),
  issueId: z.string().uuid(),
  approvalPayloadSha256: lowercaseSha256Schema,
  callFingerprintSha256: lowercaseSha256Schema,
}).strict();

export const approvalExecutionClaimRequestSchema = executionBindingSchema;

export const approvalExecutionClaimReceiptSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  approvalId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  issueId: z.string().uuid(),
  originRunId: z.string().uuid(),
  executorRunId: z.string().uuid(),
  executionRunId: executionRunIdSchema,
  approvalPayloadSha256: lowercaseSha256Schema,
  callFingerprintSha256: lowercaseSha256Schema,
  status: z.literal("pending"),
  claimedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  receiptSha256: lowercaseSha256Schema,
  replayed: z.boolean(),
}).strict();

export const approvalExecutionClaimConsumeRequestSchema = executionBindingSchema.extend({
  receiptSha256: lowercaseSha256Schema,
}).strict();

export const approvalExecutionClaimExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  approvalId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  issueId: z.string().uuid(),
  originRunId: z.string().uuid(),
  executorRunId: z.string().uuid(),
  executionRunId: executionRunIdSchema,
  approvalPayloadSha256: lowercaseSha256Schema,
  callFingerprintSha256: lowercaseSha256Schema,
  claimReceiptSha256: lowercaseSha256Schema,
  status: z.literal("executing"),
  executionStartedAt: z.string().datetime({ offset: true }),
  executionExpiresAt: z.string().datetime({ offset: true }),
  executionReceiptSha256: lowercaseSha256Schema,
}).strict();

export const APPROVAL_EXECUTION_FAILURE_CODES = [
  "provider_failed",
  "provider_dispatch_failed",
  "local_persistence_failed",
  "unknown_external_outcome",
  "execution_lease_expired",
] as const;

export const approvalExecutionClaimFinalizeRequestSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  executionRunId: executionRunIdSchema,
  callFingerprintSha256: lowercaseSha256Schema,
  executionReceiptSha256: lowercaseSha256Schema,
  outcome: z.enum(["completed", "failed"]),
  failureCode: z.enum(APPROVAL_EXECUTION_FAILURE_CODES).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "failed" && value.failureCode === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failureCode"],
      message: "failureCode is required for a failed execution",
    });
  }
  if (value.outcome === "completed" && value.failureCode !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failureCode"],
      message: "failureCode is only valid for a failed execution",
    });
  }
});

export const approvalExecutionClaimFinalizationReceiptSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  approvalId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  executorRunId: z.string().uuid(),
  executionRunId: executionRunIdSchema,
  callFingerprintSha256: lowercaseSha256Schema,
  executionReceiptSha256: lowercaseSha256Schema,
  status: z.enum(["completed", "failed"]),
  failureCode: z.enum(APPROVAL_EXECUTION_FAILURE_CODES).nullable(),
  finishedAt: z.string().datetime({ offset: true }),
  finalizationReceiptSha256: lowercaseSha256Schema,
  replayed: z.boolean(),
}).strict();

export const approvalExecutionClaimRecoveryRequestSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  executionRunId: executionRunIdSchema,
  callFingerprintSha256: lowercaseSha256Schema,
  executionReceiptSha256: lowercaseSha256Schema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(20).max(1_000),
  evidenceSha256: lowercaseSha256Schema,
}).strict();

export const approvalExecutionClaimRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(APPROVAL_EXECUTION_CLAIM_SCHEMA_VERSION),
  approvalId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  executorRunId: z.string().uuid(),
  executionRunId: executionRunIdSchema,
  callFingerprintSha256: lowercaseSha256Schema,
  executionReceiptSha256: lowercaseSha256Schema,
  finalizationReceiptSha256: lowercaseSha256Schema,
  status: z.literal("failed"),
  failureCode: z.literal("execution_lease_expired"),
  recoveredByUserId: z.string().trim().min(1).max(200),
  recoveryReason: z.string().trim().min(20).max(1_000),
  recoveryEvidenceSha256: lowercaseSha256Schema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  recoveredAt: z.string().datetime({ offset: true }),
  recoveryReceiptSha256: lowercaseSha256Schema,
  replayed: z.boolean(),
}).strict();

export type ApprovalExecutionClaimRequest = z.infer<typeof approvalExecutionClaimRequestSchema>;
export type ApprovalExecutionClaimReceipt = z.infer<typeof approvalExecutionClaimReceiptSchema>;
export type ApprovalExecutionClaimConsumeRequest = z.infer<typeof approvalExecutionClaimConsumeRequestSchema>;
export type ApprovalExecutionClaimExecutionReceipt = z.infer<typeof approvalExecutionClaimExecutionReceiptSchema>;
export type ApprovalExecutionClaimFinalizeRequest = z.infer<typeof approvalExecutionClaimFinalizeRequestSchema>;
export type ApprovalExecutionClaimFinalizationReceipt = z.infer<typeof approvalExecutionClaimFinalizationReceiptSchema>;
export type ApprovalExecutionClaimRecoveryRequest = z.infer<typeof approvalExecutionClaimRecoveryRequestSchema>;
export type ApprovalExecutionClaimRecoveryReceipt = z.infer<typeof approvalExecutionClaimRecoveryReceiptSchema>;

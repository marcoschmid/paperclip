import { z } from "zod";
import retirementAllowlistJson from "./agent-retirement-allowlist.json" with { type: "json" };
import historicalTombstonesJson from "./agent-retirement-historical-tombstones.json" with { type: "json" };
import retainedAgentsJson from "./agent-retirement-retained-agents.json" with { type: "json" };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprintSchema = z.string().regex(/^v1:sha256:[a-f0-9]{64}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const absolutePathSchema = z.string().trim().min(1).regex(/^\//);
const approvalNonceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const agentRetirementUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AGENT_RETIREMENT_APPROVAL_MARKER = "PAPERCLIP_RETIREMENT_APPROVAL_V1";

export interface AgentRetirementAllowlistEntry {
  sourceAgentId: string;
  companyId: string;
  sourceName: string;
  replacementAgentId: string | null;
  replacementSystemRef: string | null;
  canaryAgentId: string;
  decisionIssueId: string;
  retirementWave: number;
}

// A retirement wave is one human-approved, atomically registered plan scope.
// Earlier waves stay allowlisted so their audited plans remain verifiable.
export interface AgentRetirementWave {
  wave: number;
  sourceIds: readonly string[];
}

export interface AgentRetirementHistoricalTombstone {
  agentId: string;
  companyId: string;
  name: string;
  expectedStatus: "terminated";
  disposition: "preserve_tombstone";
  physicalDelete: false;
}

export interface AgentRetirementRetainedAgent {
  agentId: string;
  companyId: string;
  name: string;
}

export const AGENT_RETIREMENT_ALLOWLIST_ENTRIES: readonly AgentRetirementAllowlistEntry[] =
  Object.freeze(retirementAllowlistJson.map((entry) => Object.freeze({ ...entry })));

export const AGENT_RETIREMENT_ALLOWLIST: ReadonlyMap<string, AgentRetirementAllowlistEntry> = new Map(
  AGENT_RETIREMENT_ALLOWLIST_ENTRIES.map((entry) => [entry.sourceAgentId, entry]),
);

export function buildAgentRetirementWaves(
  entries: readonly Pick<AgentRetirementAllowlistEntry, "sourceAgentId" | "retirementWave">[],
): readonly AgentRetirementWave[] {
  const sourceIds = entries.map((entry) => entry.sourceAgentId);
  if (entries.length === 0 || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Retirement waves require unique allowlisted sources");
  }
  const invalid = entries.find((entry) => (
    typeof entry.retirementWave !== "number"
    || !Number.isSafeInteger(entry.retirementWave)
    || entry.retirementWave < 1
  ));
  if (invalid) {
    throw new Error(`Retirement wave of ${invalid.sourceAgentId} must be a positive integer`);
  }
  const waveNumbers = [...new Set(entries.map((entry) => entry.retirementWave))].sort((left, right) => left - right);
  if (waveNumbers.some((wave, index) => wave !== index + 1)) {
    throw new Error("Retirement waves must be numbered contiguously from 1");
  }
  return Object.freeze(waveNumbers.map((wave) => Object.freeze({
    wave,
    sourceIds: Object.freeze(entries
      .filter((entry) => entry.retirementWave === wave)
      .map((entry) => entry.sourceAgentId)
      .sort()),
  })));
}

export const AGENT_RETIREMENT_WAVES: readonly AgentRetirementWave[] =
  buildAgentRetirementWaves(AGENT_RETIREMENT_ALLOWLIST_ENTRIES);

export const AGENT_RETIREMENT_CURRENT_WAVE: AgentRetirementWave =
  AGENT_RETIREMENT_WAVES[AGENT_RETIREMENT_WAVES.length - 1]!;

export function agentRetirementApprovalScope(wave: AgentRetirementWave) {
  return `wave${wave.wave}_${wave.sourceIds.length}_allowlisted_sources_tombstone_only`;
}

export const AGENT_RETIREMENT_APPROVAL_SCOPE = agentRetirementApprovalScope(AGENT_RETIREMENT_CURRENT_WAVE);

export function normalizeAgentRetirementId(
  agentId: string | null | undefined,
): string | null {
  if (typeof agentId !== "string" || !agentRetirementUuidPattern.test(agentId)) return null;
  return agentId.toLowerCase();
}

export function getAgentRetirementSource(
  agentId: string | null | undefined,
): AgentRetirementAllowlistEntry | undefined {
  const normalized = normalizeAgentRetirementId(agentId);
  return normalized === null ? undefined : AGENT_RETIREMENT_ALLOWLIST.get(normalized);
}

export function isAgentRetirementSource(
  agentId: string | null | undefined,
): agentId is string {
  return getAgentRetirementSource(agentId) !== undefined;
}

export const AGENT_RETIREMENT_HISTORICAL_TOMBSTONES: readonly AgentRetirementHistoricalTombstone[] =
  Object.freeze(historicalTombstonesJson.map((entry) => Object.freeze({
    ...entry,
    expectedStatus: "terminated" as const,
    disposition: "preserve_tombstone" as const,
    physicalDelete: false as const,
  })));

export const AGENT_RETIREMENT_HISTORICAL_TOMBSTONE_IDS: ReadonlySet<string> = new Set(
  AGENT_RETIREMENT_HISTORICAL_TOMBSTONES.map((entry) => entry.agentId),
);

export const AGENT_RETIREMENT_RETAINED_AGENTS: readonly AgentRetirementRetainedAgent[] =
  Object.freeze(retainedAgentsJson.map((entry) => Object.freeze({ ...entry })));

export const agentRetirementApprovalBindingSchema = z.object({
  approvalNonce: approvalNonceSchema,
  manifestSha256: sha256Schema,
  backupSha256: sha256Schema,
  restoreReceiptSha256: sha256Schema,
}).strict();

export type AgentRetirementApprovalBinding = z.infer<typeof agentRetirementApprovalBindingSchema>;

export function formatAgentRetirementApprovalComment(
  raw: AgentRetirementApprovalBinding,
  scope: string = AGENT_RETIREMENT_APPROVAL_SCOPE,
) {
  const value = agentRetirementApprovalBindingSchema.parse(raw);
  return [
    AGENT_RETIREMENT_APPROVAL_MARKER,
    "issue=TEC-355",
    `scope=${scope}`,
    `approvalNonce=${value.approvalNonce}`,
    `manifestSha256=${value.manifestSha256}`,
    `backupSha256=${value.backupSha256}`,
    `restoreReceiptSha256=${value.restoreReceiptSha256}`,
  ].join("\n");
}

export function parseAgentRetirementApprovalComment(
  body: string,
  scope: string = AGENT_RETIREMENT_APPROVAL_SCOPE,
): AgentRetirementApprovalBinding | null {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  if (
    lines.length !== 7
    || lines[0] !== AGENT_RETIREMENT_APPROVAL_MARKER
    || lines[1] !== "issue=TEC-355"
    || lines[2] !== `scope=${scope}`
  ) return null;
  const parsed = agentRetirementApprovalBindingSchema.safeParse({
    approvalNonce: lines[3]?.replace(/^approvalNonce=/, ""),
    manifestSha256: lines[4]?.replace(/^manifestSha256=/, ""),
    backupSha256: lines[5]?.replace(/^backupSha256=/, ""),
    restoreReceiptSha256: lines[6]?.replace(/^restoreReceiptSha256=/, ""),
  });
  if (!parsed.success || formatAgentRetirementApprovalComment(parsed.data, scope) !== body) return null;
  return parsed.data;
}

export const agentRetirementHumanGateSchema = z.object({
  issueIdentifier: z.literal("TEC-355"),
  issueId: z.string().uuid(),
  commentId: z.string().uuid(),
  approvedAt: dateTimeSchema,
  approvalNonce: approvalNonceSchema,
  manifestSha256: sha256Schema,
  backupSha256: sha256Schema,
  restoreReceiptSha256: sha256Schema,
  approvedTextSha256: sha256Schema,
}).strict();

export const agentRetirementReplacementEvidenceSchema = z.object({
  replacementAgentId: z.string().uuid().nullable(),
  replacementSystemRef: z.string().trim().min(1).nullable(),
  canaryAgentId: z.string().uuid(),
  canaryIssueId: z.string().uuid(),
  canaryRunId: z.string().uuid(),
  configFingerprint: fingerprintSchema,
  systemCanaryReceiptSha256: sha256Schema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.replacementAgentId === null) === (value.replacementSystemRef === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use exactly one replacement reference",
      path: ["replacementAgentId"],
    });
  }
  if (value.replacementAgentId && value.canaryAgentId !== value.replacementAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent replacements require their own final-fingerprint canary",
      path: ["canaryAgentId"],
    });
  }
  if (value.replacementSystemRef !== null && !value.systemCanaryReceiptSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "System replacements require a bound canary receipt hash",
      path: ["systemCanaryReceiptSha256"],
    });
  }
  if (value.replacementAgentId !== null && value.systemCanaryReceiptSha256 != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent replacements must not declare a system canary receipt",
      path: ["systemCanaryReceiptSha256"],
    });
  }
});

const agentRetirementEvidenceObjectSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  source: z.object({
    sourceAgentId: z.string().uuid(),
    companyId: z.string().uuid(),
    decision: z.literal("terminate"),
    physicalDelete: z.literal(false),
  }).strict(),
  expectedUpdatedAt: dateTimeSchema,
  sourceExport: z.object({
    sourceAgentId: z.string().uuid(),
    path: absolutePathSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
    capturedAt: dateTimeSchema,
  }).strict(),
  backupRestore: z.object({
    dumpPath: absolutePathSchema,
    dumpSha256: sha256Schema,
    dumpSizeBytes: z.number().int().positive(),
    dumpCapturedAt: dateTimeSchema,
    masterKeyBackupPath: absolutePathSchema,
    masterKeyBackupSha256: sha256Schema,
    masterKeyBackupSizeBytes: z.number().int().positive(),
    masterKeyFingerprintSha256: sha256Schema,
    masterKeyCapturedAt: dateTimeSchema,
    restoreEvidencePath: absolutePathSchema,
    restoreEvidenceSha256: sha256Schema,
    restoreEvidenceSizeBytes: z.number().int().positive(),
    restoreVerifiedAt: dateTimeSchema,
    restoreStateSha256: sha256Schema,
  }).strict(),
  replacement: agentRetirementReplacementEvidenceSchema,
  humanGate: agentRetirementHumanGateSchema,
}).strict();

function refineRetirementEvidence(
  value: z.infer<typeof agentRetirementEvidenceObjectSchema>,
  ctx: z.RefinementCtx,
) {
  if (value.source.sourceAgentId !== value.sourceExport.sourceAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Source export must bind the retirement source",
      path: ["sourceExport", "sourceAgentId"],
    });
  }
  if (value.humanGate.backupSha256 !== value.backupRestore.dumpSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Approval must bind the exact database backup",
      path: ["humanGate", "backupSha256"],
    });
  }
  if (value.humanGate.restoreReceiptSha256 !== value.backupRestore.restoreEvidenceSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Approval must bind the exact restore receipt",
      path: ["humanGate", "restoreReceiptSha256"],
    });
  }
  if (Date.parse(value.humanGate.approvedAt) <= Date.parse(value.backupRestore.restoreVerifiedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Approval must be authored after backup restore verification",
      path: ["humanGate", "approvedAt"],
    });
  }
}

export const agentRetirementEvidenceSchema = agentRetirementEvidenceObjectSchema
  .superRefine(refineRetirementEvidence);

export const agentRetirementEvidenceBySourceIdSchema = z.record(
  z.string().uuid(),
  agentRetirementEvidenceSchema,
).superRefine((value, ctx) => {
  // Shape only: the service binds a bundle to the exact source set of one wave.
  if (Object.keys(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Evidence bundle must contain at least one retirement source",
      path: [],
    });
  }
  for (const [sourceId, evidence] of Object.entries(value)) {
    if (evidence.source.sourceAgentId !== sourceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Evidence bundle key must match its retirement source",
        path: [sourceId, "source", "sourceAgentId"],
      });
    }
  }
});

export const agentRetirementPlanSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("paperclip_retirement_plan"),
  manifestFingerprint: fingerprintSchema,
  sourceIds: z.array(z.string().uuid()).min(1).refine(
    (sourceIds) => new Set(sourceIds).size === sourceIds.length,
    "Retirement plan sources must be unique",
  ),
  evidenceSha256: sha256Schema,
  approvalCommentId: z.string().uuid(),
  approvalFingerprint: fingerprintSchema,
  validatedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  commonArtifactFingerprint: fingerprintSchema,
  receiptId: fingerprintSchema,
}).strict();

export const agentRetirementPreflightRequestSchema = z.object({
  evidence: agentRetirementEvidenceSchema,
  plan: agentRetirementPlanSchema,
  evidenceBySourceId: agentRetirementEvidenceBySourceIdSchema.nullable(),
  claimExecution: z.boolean(),
  executionClaimReceiptId: fingerprintSchema.nullable(),
}).strict();

export const agentRetirementExecutionRecoveryRequestSchema = z.object({
  evidence: agentRetirementEvidenceSchema,
  planClaimReceiptId: fingerprintSchema,
  executionClaimReceiptId: fingerprintSchema.nullable(),
  recoveryRequestReceiptId: fingerprintSchema.nullable(),
  recoverExecution: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (!value.recoverExecution && value.executionClaimReceiptId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Resuming a recovered execution requires its exact claim receipt",
      path: ["executionClaimReceiptId"],
    });
  }
  if (value.recoverExecution && value.recoveryRequestReceiptId === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Starting an execution recovery requires a durable request receipt",
      path: ["recoveryRequestReceiptId"],
    });
  }
});

export const agentRetirementCleanupSchema = agentRetirementEvidenceObjectSchema
  .extend({ preflightFingerprint: fingerprintSchema })
  .strict()
  .superRefine(refineRetirementEvidence);

export const agentRetirementCleanupRequestSchema = z.object({
  evidence: agentRetirementEvidenceSchema,
  planClaimReceiptId: fingerprintSchema,
  executionClaimReceiptId: fingerprintSchema,
  preflightFingerprint: fingerprintSchema,
}).strict();

export const agentRetirementTerminationSchema = z.object({
  cleanupReceiptId: fingerprintSchema,
  preflightFingerprint: fingerprintSchema,
  expectedUpdatedAt: dateTimeSchema,
  humanGate: agentRetirementHumanGateSchema,
  planClaimReceiptId: fingerprintSchema,
  executionClaimReceiptId: fingerprintSchema,
}).strict();

export const agentRetirementTerminationReceiptSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  ok: z.literal(true),
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  status: z.literal("terminated"),
  cleanupReceiptId: fingerprintSchema,
  preflightFingerprint: fingerprintSchema,
  activityId: z.string().uuid(),
  terminatedAt: dateTimeSchema,
  tombstone: z.object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    name: z.string().trim().min(1),
    status: z.literal("terminated"),
    updatedAt: dateTimeSchema,
  }).strict(),
}).strict();

export const agentRetirementDependencyCountsSchema = z.object({
  nonterminalIssues: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  activeWakeups: z.number().int().nonnegative(),
  activeRoutines: z.number().int().nonnegative(),
  enabledTriggers: z.number().int().nonnegative(),
  activeRoutineRuns: z.number().int().nonnegative(),
  activeDocumentLocks: z.number().int().nonnegative(),
  activePlanDecompositions: z.number().int().nonnegative(),
  activeProjectLeads: z.number().int().nonnegative(),
  operativeGoals: z.number().int().nonnegative(),
  activeRuntimeServices: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  activeIssueWatchdogs: z.number().int().nonnegative(),
  activeRecoveryActions: z.number().int().nonnegative(),
  unclearedPipelineAgentLeases: z.number().int().nonnegative(),
  activePipelineApprovers: z.number().int().nonnegative(),
  activeHireApprovalReferences: z.number().int().nonnegative(),
  outstandingEnvironmentLeases: z.number().int().nonnegative(),
  runningWorkspaceOperations: z.number().int().nonnegative(),
  liveDescendants: z.number().int().nonnegative(),
  activeApiKeys: z.number().int().nonnegative(),
  principalPermissionGrants: z.number().int().nonnegative(),
  companyMemberships: z.number().int().nonnegative(),
  agentMemberships: z.number().int().nonnegative(),
}).strict();

export const agentRetirementBlockerSchema = z.object({
  code: z.string().trim().min(1),
  path: z.string().trim().min(1),
  count: z.number().int().nonnegative(),
  cleanupEligible: z.boolean(),
}).strict();

export const agentRetirementPreflightResponseSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  ok: z.boolean(),
  cleanupEligible: z.boolean(),
  blockers: z.array(agentRetirementBlockerSchema),
  dependencyCounts: agentRetirementDependencyCountsSchema,
  fingerprint: fingerprintSchema,
  observedUpdatedAt: dateTimeSchema,
  claimState: z.enum(["unclaimed", "unstarted_expired", "started", "cleaned", "termination_ready", "terminated"]),
  planClaimReceiptId: fingerprintSchema.nullable(),
  executionClaimReceiptId: fingerprintSchema.nullable(),
  executionStartedAt: dateTimeSchema.nullable(),
  executionExpiresAt: dateTimeSchema.nullable(),
}).strict();

export const agentRetirementCleanupResponseSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  ok: z.literal(true),
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  receiptId: fingerprintSchema,
  preflightFingerprint: fingerprintSchema,
  revokedKeyCount: z.number().int().nonnegative(),
  deletedGrantCount: z.number().int().nonnegative(),
  deactivatedCompanyMembershipCount: z.number().int().nonnegative(),
  deletedAgentMembershipCount: z.number().int().nonnegative(),
  deletedSecretBindingCount: z.number().int().nonnegative(),
  deletedUserSecretDeclarationCount: z.number().int().nonnegative(),
  deletedSkillStarCount: z.number().int().nonnegative(),
  cleanedAt: dateTimeSchema,
  executionClaimReceiptId: fingerprintSchema.nullable(),
}).strict();

export type AgentRetirementEvidence = z.infer<typeof agentRetirementEvidenceSchema>;
export type AgentRetirementEvidenceBySourceId = z.infer<typeof agentRetirementEvidenceBySourceIdSchema>;
export type AgentRetirementPlan = z.infer<typeof agentRetirementPlanSchema>;
export type AgentRetirementPreflightRequest = z.infer<typeof agentRetirementPreflightRequestSchema>;
export type AgentRetirementExecutionRecoveryRequest = z.infer<
  typeof agentRetirementExecutionRecoveryRequestSchema
>;
export type AgentRetirementCleanup = z.infer<typeof agentRetirementCleanupSchema>;
export type AgentRetirementCleanupRequest = z.infer<typeof agentRetirementCleanupRequestSchema>;
export type AgentRetirementTermination = z.infer<typeof agentRetirementTerminationSchema>;
export type AgentRetirementTerminationReceipt = z.infer<
  typeof agentRetirementTerminationReceiptSchema
>;
export type AgentRetirementDependencyCounts = z.infer<typeof agentRetirementDependencyCountsSchema>;
export type AgentRetirementBlocker = z.infer<typeof agentRetirementBlockerSchema>;
export type AgentRetirementPreflightResponse = z.infer<typeof agentRetirementPreflightResponseSchema>;
export type AgentRetirementCleanupResponse = z.infer<typeof agentRetirementCleanupResponseSchema>;

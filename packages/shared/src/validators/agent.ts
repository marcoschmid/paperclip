import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";

const LIFECYCLE_SCHEMA_VERSION = "1.0.0" as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const lifecycleNonEmptyStringSchema = z.string().trim().min(1);
const lifecycleDateTimeSchema = z.string().datetime({ offset: true });
const lifecycleFingerprintSchema = z.string().regex(/^v1:sha256:[a-f0-9]{64}$/);

function addUniqueArrayIssue(values: string[], ctx: z.RefinementCtx, path: string) {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${path} must contain unique values`,
      path: [path],
    });
  }
}

export const agentLifecycleOwnerSchema = z.discriminatedUnion("ownerType", [
  z.object({
    ownerType: z.literal("agent"),
    ownerAgentId: z.string().uuid(),
  }).strict(),
  z.object({
    ownerType: z.literal("board_user"),
    ownerUserId: lifecycleNonEmptyStringSchema,
  }).strict(),
  z.object({
    ownerType: z.literal("board_role"),
    ownerRoleSlug: lifecycleNonEmptyStringSchema,
  }).strict(),
]);

export const agentLifecycleServiceLevelSchema = z.object({
  availabilityClass: z.enum(["routine", "business_hours", "on_demand"]),
  triageTargetMinutes: z.number().int().positive().nullable(),
  completionTargetMinutes: z.number().int().positive().nullable(),
  targetExceptionReason: lifecycleNonEmptyStringSchema.nullable(),
}).strict();

export const agentLifecyclePauseSchema = z.object({
  reasonCode: lifecycleNonEmptyStringSchema,
  reasonDetail: lifecycleNonEmptyStringSchema,
  outcome: lifecycleNonEmptyStringSchema.optional(),
  repairIssueId: z.string().uuid(),
  startedAt: lifecycleDateTimeSchema,
  expiresAt: lifecycleDateTimeSchema,
  exceptionApprovedByUserId: lifecycleNonEmptyStringSchema.optional(),
  exceptionReason: lifecycleNonEmptyStringSchema.optional(),
}).strict().superRefine((pause, ctx) => {
  const startedAt = new Date(pause.startedAt).getTime();
  const expiresAt = new Date(pause.expiresAt).getTime();
  const hasApprover = pause.exceptionApprovedByUserId !== undefined;
  const hasReason = pause.exceptionReason !== undefined;
  if (pause.reasonCode === "canary_failed" && !pause.outcome) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A failed canary pause requires its exact outcome",
      path: ["outcome"],
    });
  }
  if (expiresAt <= startedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pause expiry must be after its start", path: ["expiresAt"] });
  }
  if (expiresAt <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pause has expired", path: ["expiresAt"] });
  }
  if (hasApprover !== hasReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Pause extensions require both approver and reason",
      path: [hasApprover ? "exceptionReason" : "exceptionApprovedByUserId"],
    });
  }
  const maxDuration = hasApprover && hasReason ? 90 * DAY_MS : 30 * DAY_MS;
  if (expiresAt - startedAt > maxDuration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Pause window exceeds ${maxDuration === 90 * DAY_MS ? 90 : 30} days`,
      path: ["expiresAt"],
    });
  }
});

const permissionExceptionScopeSchema = z.object({
  cwdRoots: z.array(lifecycleNonEmptyStringSchema.refine((value) => value.startsWith("/"), {
    message: "cwdRoots entries must be absolute paths",
  })).min(1),
  tools: z.array(lifecycleNonEmptyStringSchema).min(1),
  networkHosts: z.array(lifecycleNonEmptyStringSchema),
  bypasses: z.array(z.enum(["claude_permission_mode", "codex_approvals_and_sandbox"])).min(1),
}).strict();

const approvedLifecyclePermissionExceptionSchema = z.object({
  kind: z.literal("approved"),
  exceptionIssueId: z.string().uuid(),
  owner: agentLifecycleOwnerSchema,
  scope: permissionExceptionScopeSchema,
  justification: lifecycleNonEmptyStringSchema,
  evidence: z.object({
    canaryIssueId: z.string().uuid(),
    runId: z.string().uuid(),
    configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.literal("passed"),
  }).strict(),
  approvedAt: lifecycleDateTimeSchema,
  expiresAt: lifecycleDateTimeSchema,
}).strict().superRefine((exception, ctx) => {
  const approvedAt = new Date(exception.approvedAt).getTime();
  const expiresAt = new Date(exception.expiresAt).getTime();
  if (expiresAt <= approvedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Permission exception expiry must follow approval", path: ["expiresAt"] });
  }
  if (expiresAt <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Permission exception has expired", path: ["expiresAt"] });
  }
  if (expiresAt - approvedAt > 30 * DAY_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Permission exception exceeds 30 days", path: ["expiresAt"] });
  }
});

export const agentLifecyclePermissionExceptionSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  approvedLifecyclePermissionExceptionSchema,
]);

export const agentLifecycleSchema = z.object({
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  owner: agentLifecycleOwnerSchema,
  purpose: lifecycleNonEmptyStringSchema,
  acceptedTaskTypes: z.array(lifecycleNonEmptyStringSchema).min(1),
  rejectedTaskTypes: z.array(lifecycleNonEmptyStringSchema).min(1),
  taskSources: z.array(lifecycleNonEmptyStringSchema).min(1),
  operatingMode: z.enum(["scheduled", "issue_routed", "manual_assignment_only"]),
  serviceLevel: agentLifecycleServiceLevelSchema,
  canaryIssueId: z.string().uuid().nullable(),
  lastCanaryAt: lifecycleDateTimeSchema.nullable(),
  lastCanaryResult: z.enum(["pending", "passed", "failed"]),
  canaryFreshnessDays: z.number().int().min(1).max(90),
  reviewAt: lifecycleDateTimeSchema,
  retirementCriterion: lifecycleNonEmptyStringSchema,
  decisionIssueId: z.string().uuid(),
  replacementAgentId: z.string().uuid().optional(),
  replacementSystemRef: lifecycleNonEmptyStringSchema.optional(),
  pause: agentLifecyclePauseSchema.optional(),
}).strict().superRefine((lifecycle, ctx) => {
  addUniqueArrayIssue(lifecycle.acceptedTaskTypes, ctx, "acceptedTaskTypes");
  addUniqueArrayIssue(lifecycle.rejectedTaskTypes, ctx, "rejectedTaskTypes");
  addUniqueArrayIssue(lifecycle.taskSources, ctx, "taskSources");

  const manual = lifecycle.operatingMode === "manual_assignment_only";
  const serviceLevel = lifecycle.serviceLevel;
  if (manual) {
    if (
      serviceLevel.availabilityClass !== "on_demand"
      || serviceLevel.triageTargetMinutes !== null
      || serviceLevel.completionTargetMinutes !== null
      || serviceLevel.targetExceptionReason === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manual assignment requires on-demand availability and a documented null-target exception",
        path: ["serviceLevel"],
      });
    }
  } else if (
    serviceLevel.triageTargetMinutes === null
    || serviceLevel.completionTargetMinutes === null
    || serviceLevel.targetExceptionReason !== null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Scheduled and issue-routed agents require numeric targets without an exception",
      path: ["serviceLevel"],
    });
  }

  if (lifecycle.lastCanaryResult === "pending") {
    if (lifecycle.lastCanaryAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pending canaries cannot carry completed timestamp evidence",
        path: ["lastCanaryResult"],
      });
    }
  } else if (lifecycle.canaryIssueId === null || lifecycle.lastCanaryAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Completed canaries require issue and timestamp evidence",
      path: ["lastCanaryResult"],
    });
  }
  if (lifecycle.lastCanaryAt && new Date(lifecycle.lastCanaryAt).getTime() > Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Canary timestamp cannot be in the future", path: ["lastCanaryAt"] });
  }
  if (new Date(lifecycle.reviewAt).getTime() <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Lifecycle review is overdue", path: ["reviewAt"] });
  }
  if (lifecycle.replacementAgentId && lifecycle.replacementSystemRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use exactly one replacement reference",
      path: ["replacementAgentId"],
    });
  }
});

export const agentLifecycleTransitionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("reviewed_failed_repair"),
    repairIssueId: z.string().uuid(),
    expectedAgentUpdatedAt: lifecycleDateTimeSchema,
  }).strict(),
  z.object({
    mode: z.literal("reviewed_passed_revalidation"),
    canaryIssueId: z.string().uuid(),
    decisionIssueId: z.string().uuid(),
    reasonCode: z.literal("runtime_evidence_invalidated"),
    expectedAgentUpdatedAt: lifecycleDateTimeSchema,
  }).strict(),
]);

export const agentLifecycleGateSchema = z.object({
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  configFingerprint: lifecycleFingerprintSchema,
  validatedAt: lifecycleDateTimeSchema,
  expiresAt: lifecycleDateTimeSchema,
  findingCount: z.literal(0),
  receiptHash: lifecycleFingerprintSchema,
  freshSessionRequired: z.boolean(),
  lastSatisfiedRunId: z.string().uuid().optional(),
}).strict().superRefine((gate, ctx) => {
  const validatedAt = new Date(gate.validatedAt).getTime();
  const expiresAt = new Date(gate.expiresAt).getTime();
  if (expiresAt <= validatedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Lifecycle receipt expiry must follow validation", path: ["expiresAt"] });
  }
});

export const agentLifecycleCanaryGateSchema = z.object({
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  canaryIssueId: z.string().uuid(),
  runId: z.string().uuid(),
  configFingerprint: lifecycleFingerprintSchema,
  issuedAt: lifecycleDateTimeSchema,
  expiresAt: lifecycleDateTimeSchema,
  receiptHash: lifecycleFingerprintSchema,
}).strict().superRefine((gate, ctx) => {
  const issuedAt = new Date(gate.issuedAt).getTime();
  const expiresAt = new Date(gate.expiresAt).getTime();
  if (expiresAt <= issuedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Canary receipt expiry must follow issuance", path: ["expiresAt"] });
  }
  if (expiresAt - issuedAt > 15 * 60 * 1_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Canary receipt cannot exceed 15 minutes", path: ["expiresAt"] });
  }
});

const agentMetadataInputSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  for (const key of ["lifecycleGate", "lifecycleCanaryGate", "canaryGate"] as const) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `metadata.${key} is server-calculated`,
      path: [key],
    });
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, "lifecycle")) return;
  const result = agentLifecycleSchema.safeParse(metadata.lifecycle);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({ ...issue, path: ["lifecycle", ...issue.path] });
  }
});

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown());

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: agentMetadataInputSchema.optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    lifecycleTransition: agentLifecycleTransitionSchema.optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const agentLifecycleSystemReplacementProofSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  sourceAgentId: z.literal("0e989281-9933-47b9-87e5-b6da87d4d0a9"),
  replacementSystemRef: z.literal("workspace:projects/kaffee"),
  scenario: z.literal("workspace-project-binding"),
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  observedRef: z.literal("workspace:projects/kaffee:PROJECT.md"),
  observedSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const pauseAgentSchema = z.union([
  z.object({
    reason: z.literal("manual").optional().default("manual"),
  }).strict(),
  z.object({
    reason: z.literal("maintenance"),
    operationId: z.string().uuid(),
  }).strict(),
]);

export type PauseAgent = z.infer<typeof pauseAgentSchema>;

export const resumeAgentSchema = z.union([
  z.object({ mode: z.literal("normal").optional() }).strict(),
  z.object({
    mode: z.literal("pending_canary"),
    canaryIssueId: z.string().uuid(),
    expectedConfigFingerprint: lifecycleFingerprintSchema,
    expectedAgentUpdatedAt: lifecycleDateTimeSchema,
    systemReplacementProof: agentLifecycleSystemReplacementProofSchema.optional(),
  }).strict(),
]);

export type ResumeAgent = z.infer<typeof resumeAgentSchema>;
export type AgentLifecycleSystemReplacementProof = z.infer<
  typeof agentLifecycleSystemReplacementProofSchema
>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().uuid().optional().nullable(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  parentIssueId: z.string().uuid().optional().nullable(),
  parentIssueIds: z.array(z.string().uuid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   */
  environmentId: z.string().uuid().optional().nullable(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean().optional(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;

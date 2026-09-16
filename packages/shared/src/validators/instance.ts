import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";
import { shapeWithoutDefaults } from "./partial.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  // Execution policy. Absent/"any" = unrestricted; "kubernetes" forces the
  // Kubernetes sandbox provider and denies local/ssh execution (cloud_tenant).
  executionMode: z.enum(["kubernetes", "any"]).optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = z
  .object(shapeWithoutDefaults(instanceGeneralSettingsSchema.shape))
  .partial()
  .strict();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableNativeRunner: z.boolean().default(false),
  enableManagedSandboxOnly: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enableApps: z.boolean().default(false),
  enablePipelines: z.boolean().default(false),
  enableCases: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableClassicTaskInterface: z.boolean().default(false),
  enableTaskWatchdogs: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableSmokeLab: z.boolean().default(false),
  enableBuiltInAgents: z.boolean().default(false),
  enableBetaSkills: z.boolean().default(false),
  enableSummaries: z.boolean().default(false),
  enableStatusCards: z.boolean().default(false),
  enableDecisions: z.boolean().default(false),
  enableGoalsSidebarLink: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  enableSimplifiedEnglishInteractions: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().default(true),
  enableOwnerInstanceAdmin: z.boolean().default(false),
  // Kill switch for the sandbox duplex command-stream bridge. Default off. When
  // off the host keeps the file bridge for every run with no manifest change and
  // no redeploy. The host reads this per run before it selects the transport.
  enableSandboxDuplexBridge: z.boolean().default(false),
  enableWorktreeRunExecution: z.boolean().default(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().default(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().default(null),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = z
  .object(
    shapeWithoutDefaults(
      instanceExperimentalSettingsSchema
        .omit({
          worktreeRunExecutionActivatedAt: true,
          worktreeRunExecutionActivationInstanceId: true,
        })
        .shape,
    ),
  )
  .partial()
  .strip();

export const managedSettingMetadataSchema = z.object({
  managed: z.literal(true),
  managedBy: z.literal("paperclip-cloud"),
}).strict();

// Response shape of the experimental settings endpoints: on cloud-managed
// instances every overlaid key is listed in `managedKeys`; self-hosted
// responses omit the field entirely.
export const instanceExperimentalSettingsWithManagedSchema = instanceExperimentalSettingsSchema.extend({
  managedKeys: z.record(z.string(), managedSettingMetadataSchema).optional(),
}).strict();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().guid().nullable().optional(),
}).strict();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export const staleWakeupMaintenanceClassificationSchema = z.enum([
  "request_not_found",
  "status_not_eligible",
  "run_already_linked",
  "requested_after_cutoff",
  "eligible_no_resolvable_issue",
  "eligible_terminal_issue",
  "issue_not_terminal",
]);

const staleWakeupMaintenanceSelectionShape = {
  requestIds: z.array(z.string().uuid().transform((value) => value.toLowerCase())).min(1).max(500),
  staleBefore: z.string().datetime({ offset: true }),
};

function requireUniqueWakeupRequestIds(
  value: { requestIds: string[] },
  ctx: z.RefinementCtx,
) {
  if (new Set(value.requestIds).size !== value.requestIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestIds"],
      message: "requestIds must be unique",
    });
  }
}

export const staleWakeupMaintenancePreviewRequestSchema = z.object({
  ...staleWakeupMaintenanceSelectionShape,
}).strict().superRefine(requireUniqueWakeupRequestIds);

export const staleWakeupMaintenanceRunRequestSchema = z.object({
  ...staleWakeupMaintenanceSelectionShape,
  reason: z.string().trim().min(1).max(1000),
}).strict().superRefine(requireUniqueWakeupRequestIds);

/** @deprecated Use the operation-specific preview/run request schema. */
export const staleWakeupMaintenanceRequestSchema = staleWakeupMaintenanceRunRequestSchema;

export const staleWakeupMaintenanceClassificationItemSchema = z.object({
  requestId: z.string().uuid(),
  eligible: z.boolean(),
  classification: staleWakeupMaintenanceClassificationSchema,
  wakeupStatus: z.string().nullable(),
  runId: z.string().uuid().nullable(),
  requestedAt: z.string().datetime().nullable(),
  issueId: z.string().nullable(),
  issueStatus: z.string().nullable(),
}).strict();

export const staleWakeupMaintenancePreviewSchema = z.object({
  staleBefore: z.string().datetime(),
  generatedAt: z.string().datetime(),
  totals: z.object({
    requested: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict(),
  classifications: z.array(staleWakeupMaintenanceClassificationItemSchema),
}).strict();

export const staleWakeupMaintenanceRunSchema = z.object({
  staleBefore: z.string().datetime(),
  completedAt: z.string().datetime(),
  totals: z.object({
    requested: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict(),
  cancelledRequestIds: z.array(z.string().uuid()),
  skipped: z.array(staleWakeupMaintenanceClassificationItemSchema),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
// The patch schema removes each default so an absent key stays absent. Declare
// the type from the full settings type, so every field keeps its precise type.
export type PatchInstanceGeneralSettings = Partial<InstanceGeneralSettings>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = Partial<
  Omit<
    InstanceExperimentalSettings,
    "worktreeRunExecutionActivatedAt" | "worktreeRunExecutionActivationInstanceId"
  >
>;
export type PatchInstanceSettings = z.infer<typeof patchInstanceSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;
export type StaleWakeupMaintenanceClassification = z.infer<
  typeof staleWakeupMaintenanceClassificationSchema
>;
export type StaleWakeupMaintenancePreviewRequest = z.infer<
  typeof staleWakeupMaintenancePreviewRequestSchema
>;
export type StaleWakeupMaintenanceRunRequest = z.infer<
  typeof staleWakeupMaintenanceRunRequestSchema
>;
/** @deprecated Use StaleWakeupMaintenanceRunRequest. */
export type StaleWakeupMaintenanceRequest = StaleWakeupMaintenanceRunRequest;
export type StaleWakeupMaintenanceClassificationItem = z.infer<
  typeof staleWakeupMaintenanceClassificationItemSchema
>;
export type StaleWakeupMaintenancePreview = z.infer<typeof staleWakeupMaintenancePreviewSchema>;
export type StaleWakeupMaintenanceRun = z.infer<typeof staleWakeupMaintenanceRunSchema>;

export const instanceSettingsSchema = z.object({
  id: z.string().guid(),
  defaultEnvironmentId: z.string().guid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsWithManagedSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();

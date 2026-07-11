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

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enablePipelines: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableTaskWatchdogs: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableCloudSync: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().uuid().nullable().optional(),
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
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
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
  id: z.string().uuid(),
  defaultEnvironmentId: z.string().uuid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();

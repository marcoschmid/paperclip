import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  normalizeCodexModel,
} from "../index.js";

const SKIP_GIT_REPO_CHECK_FLAG = "--skip-git-repo-check";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

export const CODEX_MANAGED_RUNTIME_POLICY_VERSION = "codex-managed-v2";

export const CODEX_MANAGED_RUNTIME_DISABLED_FEATURES = [
  "apps",
  "enable_mcp_apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "hooks",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "non_prefixed_mcp_tool_names",
  "workspace_dependencies",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "auth_elicitation",
] as const;

export const CODEX_LIFECYCLE_CANARY_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "code_mode_host",
] as const;

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

const ALLOWED_CODEX_EXTRA_ARGS = new Set(["--skip-git-repo-check"]);
const CODEX_SECURITY_POLICY_KEYS = [
  "sandbox",
  "sandboxMode",
  "approvalPolicy",
  "askForApproval",
  "profile",
  "config",
  "configOverrides",
] as const;

export function assertCodexPermissionConfigIsFailClosed(config: unknown) {
  const record = asRecord(config);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const globalBypassFlag = "--dangerously-bypass-approvals-and-sandbox";
  const allConfiguredArgs = [
    ...asStringArray(record.extraArgs),
    ...asStringArray(record.args),
  ];
  if (
    bypass
    || allConfiguredArgs.some(
      (arg) => arg === globalBypassFlag || arg.startsWith(`${globalBypassFlag}=`),
    )
  ) {
    throw new Error("The global Codex approvals and sandbox bypass is disabled.");
  }
  const directSecurityPolicyKey = CODEX_SECURITY_POLICY_KEYS.find(
    (key) => record[key] !== undefined && record[key] !== null,
  );
  if (directSecurityPolicyKey) {
    throw new Error(
      `Codex security policy key ${directSecurityPolicyKey} cannot be configured directly.`,
    );
  }
  const unsupported = allConfiguredArgs.find((arg) => !ALLOWED_CODEX_EXTRA_ARGS.has(arg));
  if (unsupported) {
    throw new Error(
      `Codex extraArgs/args contains unsupported security-sensitive token ${JSON.stringify(unsupported)}; only --skip-git-repo-check is allowed.`,
    );
  }
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
    managedRuntime?: boolean;
    lifecyclePendingCanary?: boolean;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const model = normalizeCodexModel(asString(record.model, ""));
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = asBoolean(record.search, false) && !options.lifecyclePendingCanary;
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const extraArgs = readExtraArgs(record);
  assertCodexPermissionConfigIsFailClosed(record);

  const args = ["exec", "--json"];
  // Codex rejects a repeated `--skip-git-repo-check` ("cannot be used multiple
  // times"). The adapter injects this flag for sandbox execution, so when an
  // operator's extraArgs already carry it the injection would abort the run
  // with exit code 2. Skip the injection in that case and let the operator's
  // copy stand.
  if (options.skipGitRepoCheck && !extraArgs.includes(SKIP_GIT_REPO_CHECK_FLAG)) {
    args.push(SKIP_GIT_REPO_CHECK_FLAG);
  }
  if (options.managedRuntime) {
    for (const feature of CODEX_MANAGED_RUNTIME_DISABLED_FEATURES) {
      args.push("--disable", feature);
    }
  }
  if (options.lifecyclePendingCanary) {
    args.push("--sandbox", "read-only", "--ephemeral");
    for (const feature of CODEX_LIFECYCLE_CANARY_DISABLED_FEATURES) {
      args.push("--disable", feature);
    }
  }
  if (search) args.unshift("--search");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}

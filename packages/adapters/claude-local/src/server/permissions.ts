const GLOBAL_CLAUDE_PERMISSION_BYPASS_FLAG = "--dangerously-skip-permissions";
const ALLOWED_CLAUDE_EXTRA_ARGS = new Set(["--no-session-persistence"]);
// Remote sandbox runs are non-interactive, so the runtime owns one immutable
// tool scope. Agent configuration may not replace or extend this list.
export const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function containsGlobalClaudePermissionBypass(args: string[]) {
  return args.some(
    (arg) => arg === GLOBAL_CLAUDE_PERMISSION_BYPASS_FLAG
      || arg.startsWith(`${GLOBAL_CLAUDE_PERMISSION_BYPASS_FLAG}=`),
  );
}

function assertClaudeExtraArgsAreAllowlisted(args: string[]) {
  const unsupported = args.find((arg) => !ALLOWED_CLAUDE_EXTRA_ARGS.has(arg));
  if (unsupported) {
    throw new Error(
      `Claude extraArgs/args contains unsupported security-sensitive token ${JSON.stringify(unsupported)}; only --no-session-persistence is allowed.`,
    );
  }
}

export function assertClaudePermissionConfigIsFailClosed(config: unknown) {
  const record = typeof config === "object" && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const extraArgs = readStringArray(record.extraArgs);
  const legacyArgs = readStringArray(record.args);
  if (
    record.dangerouslySkipPermissions === true
    || containsGlobalClaudePermissionBypass(extraArgs)
    || containsGlobalClaudePermissionBypass(legacyArgs)
  ) {
    throw new Error("The global Claude permission bypass is disabled; only Board-managed permission scopes may authorize tools.");
  }
  if (readStringArray(record.allowedTools).length > 0) {
    throw new Error("Claude allowedTools requires a Board-managed tool scope and cannot be configured free-form.");
  }
  assertClaudeExtraArgsAreAllowlisted(extraArgs);
  assertClaudeExtraArgsAreAllowlisted(legacyArgs);
}

function shouldUseAllowedTools(input: { targetIsRemote: boolean; localProcessUid?: number | null }): boolean {
  // Claude Code refuses `--dangerously-skip-permissions` when the process runs
  // as root. Use the same explicit allowlist that remote targets use so local
  // Docker/root probes and executions fail safe instead of hard-failing before
  // auth/runtime validation can complete.
  return input.targetIsRemote || input.localProcessUid === 0;
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  assertClaudePermissionConfigIsFailClosed(input);
  return shouldUseAllowedTools(input) ? ["--allowedTools", SANDBOX_ALLOWED_TOOLS] : [];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  assertClaudePermissionConfigIsFailClosed(input);
  return shouldUseAllowedTools(input) ? ["--allowedTools", SANDBOX_ALLOWED_TOOLS] : [];
}

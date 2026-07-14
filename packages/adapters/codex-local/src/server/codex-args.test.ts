import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("pins the complete managed runtime extension surface closed without disabling normal shell tools", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.6" },
      { managedRuntime: true },
    );

    const disabledFeatures = result.args.flatMap((arg, index, args) =>
      arg === "--disable" ? [args[index + 1]] : []
    );
    expect(disabledFeatures).toEqual([
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
    ]);
    expect(disabledFeatures).not.toContain("shell_tool");
    expect(disabledFeatures).not.toContain("unified_exec");
    expect(result.args).not.toContain("--ephemeral");
    expect(result.args).not.toContain("read-only");
  });

  it("makes lifecycle canaries ephemeral and read-only with all command hosts disabled", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.6", search: true },
      { managedRuntime: true, lifecyclePendingCanary: true },
    );

    expect(result.args).toEqual(expect.arrayContaining([
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--disable",
      "shell_tool",
      "unified_exec",
      "shell_snapshot",
      "code_mode_host",
    ]));
    expect(result.args).not.toContain("--search");
  });

  it.each([
    { dangerouslyBypassApprovalsAndSandbox: true },
    { dangerouslyBypassSandbox: true },
    { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
    { args: ["--dangerously-bypass-approvals-and-sandbox"] },
  ])("rejects the global Codex approvals and sandbox bypass", (config) => {
    expect(() => buildCodexExecArgs(config)).toThrow(
      "global Codex approvals and sandbox bypass is disabled",
    );
  });

  it.each([
    ["--sandbox", "danger-full-access"],
    ["--sandbox=danger-full-access"],
    ["-s", "danger-full-access"],
    ["--ask-for-approval", "never"],
    ["--ask-for-approval=never"],
    ["-a", "never"],
    ["-c", 'sandbox_mode="danger-full-access"'],
    ["--config", 'approval_policy="never"'],
    ["--config=approval_policy=\"never\""],
    ["--profile", "unsafe"],
    ["--profile=unsafe"],
    ["--full-auto"],
  ])("rejects sandbox/approval-affecting Codex argument form %j", (...args) => {
    expect(() => buildCodexExecArgs({ extraArgs: args })).toThrow("Codex extraArgs/args");
  });

  it.each([
    { sandbox: "danger-full-access" },
    { sandboxMode: "danger-full-access" },
    { approvalPolicy: "never" },
    { profile: "unsafe" },
    { config: { approval_policy: "never" } },
  ])("rejects direct security-policy config keys", (config) => {
    expect(() => buildCodexExecArgs(config)).toThrow("Codex security policy");
  });

  it("allows only the explicit fail-closed Codex extra-argument allowlist", () => {
    expect(() => buildCodexExecArgs({ extraArgs: ["--skip-git-repo-check"] })).not.toThrow();
    expect(() => buildCodexExecArgs({ extraArgs: ["--no-alt-screen"] }))
      .toThrow("Codex extraArgs/args");
  });

  it("enables Codex fast mode overrides for GPT-5.6", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.6",
      fastMode: true,
    });

    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toContain("gpt-5.6");
    expect(result.args).toContain('service_tier="fast"');
  });

  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for GPT-5.5", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "future-codex-model",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "future-codex-model",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides when model is omitted (CLI default)", () => {
    const result = buildCodexExecArgs({
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex-spark",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.6, gpt-5.5, gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex-spark",
      "-",
    ]);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.5",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-",
    ]);
  });
});

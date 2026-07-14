import { describe, expect, it } from "vitest";
import {
  assertClaudePermissionConfigIsFailClosed,
  buildClaudeExecutionPermissionArgs,
  buildClaudeProbePermissionArgs,
} from "./permissions.js";

describe("claude-local remote permission args", () => {
  it("defaults omitted skip-permissions to fail closed for probes and execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ targetIsRemote: false })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ targetIsRemote: false })).toEqual([]);
    expect(buildClaudeExecutionPermissionArgs({ targetIsRemote: true })).toEqual([
      "--allowedTools",
      expect.any(String),
    ]);
    expect(buildClaudeProbePermissionArgs({ targetIsRemote: true })).toEqual([
      "--allowedTools",
      expect.any(String),
    ]);
  });

  it("uses the immutable runtime scope for remote sandboxes and ignores no config scope", () => {
    const execution = buildClaudeExecutionPermissionArgs({ targetIsRemote: true });
    const probe = buildClaudeProbePermissionArgs({ targetIsRemote: true });
    expect(execution).toEqual(probe);
    expect(execution[1]?.split(" ")).toContain("Read");
    expect(execution[1]?.split(" ")).toContain("Bash");
  });

  it("rejects free-form allowedTools for probes and execution", () => {
    expect(() => buildClaudeExecutionPermissionArgs({ allowedTools: ["Read"], targetIsRemote: true }))
      .toThrow("Board-managed tool scope");
    expect(() => buildClaudeProbePermissionArgs({ allowedTools: ["Read"], targetIsRemote: false }))
      .toThrow("Board-managed tool scope");
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: false })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: false })).toEqual([]);
  });

  it("rejects the global Claude bypass even when requested explicitly", () => {
    expect(() => buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false }))
      .toThrow("global Claude permission bypass is disabled");
    expect(() => buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true }))
      .toThrow("global Claude permission bypass is disabled");
  });

  it.each(["extraArgs", "args"])("rejects global Claude bypass smuggling through %s", (key) => {
    expect(() => assertClaudePermissionConfigIsFailClosed({
      [key]: ["--verbose", "--dangerously-skip-permissions"],
    })).toThrow("global Claude permission bypass is disabled");
  });

  it.each([
    ["--permission-mode", "bypassPermissions"],
    ["--permission-mode=bypassPermissions"],
    ["--allow-dangerously-skip-permissions"],
    ["--allow-dangerously-skip-permissions=true"],
    ["--allowedTools", "Read"],
    ["--tools=Read,Bash"],
  ])("rejects permission-affecting Claude argument form %j", (...args) => {
    expect(() => assertClaudePermissionConfigIsFailClosed({ extraArgs: args }))
      .toThrow("Claude extraArgs/args");
  });

  it("allows only the explicit fail-closed Claude extra-argument allowlist", () => {
    expect(() => assertClaudePermissionConfigIsFailClosed({
      extraArgs: ["--no-session-persistence"],
    })).not.toThrow();
    expect(() => assertClaudePermissionConfigIsFailClosed({ extraArgs: ["--verbose"] }))
      .toThrow("Claude extraArgs/args");
  });
});

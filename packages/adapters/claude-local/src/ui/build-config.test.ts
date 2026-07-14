import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "claude_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  } as CreateConfigValues;
}

describe("buildClaudeLocalConfig", () => {
  it("persists fail-closed when skip-permissions is omitted", () => {
    const config = buildClaudeLocalConfig(makeValues());

    expect(config.dangerouslySkipPermissions).toBe(false);
  });

  it("cannot enable the blocked global bypass through create values", () => {
    const config = buildClaudeLocalConfig(makeValues({ dangerouslySkipPermissions: true }));

    expect(config.dangerouslySkipPermissions).toBe(false);
  });
});

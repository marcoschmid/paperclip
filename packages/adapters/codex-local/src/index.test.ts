import { describe, expect, it } from "vitest";
import {
  agentConfigurationDoc,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  modelProfiles,
  models,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises the GPT-5.6 family and uses the current generation by default", () => {
    const modelIds = models.map((model) => model.id);

    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6");
    expect(modelIds.slice(0, 4)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
  });

  it("uses Luna low as the cheap status-only recovery lane", () => {
    expect(modelProfiles).toContainEqual(
      expect.objectContaining({
        key: "cheap",
        adapterConfig: {
          model: "gpt-5.6-luna",
          modelReasoningEffort: "low",
        },
      }),
    );
  });

  it("defaults the global approvals and sandbox bypass to false", () => {
    expect(DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX).toBe(false);
    expect(agentConfigurationDoc).toContain(
      "dangerouslyBypassApprovalsAndSandbox (boolean, optional, default false)",
    );
    expect(agentConfigurationDoc).toContain("Paperclip rejects true");
  });
});

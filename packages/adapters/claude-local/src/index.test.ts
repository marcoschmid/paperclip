import { describe, expect, it } from "vitest";
import { agentConfigurationDoc, modelProfiles, models } from "./index.js";

describe("claude local adapter metadata", () => {
  it("advertises Sonnet 5 while keeping specialist frontier models available", () => {
    const modelIds = models.map((model) => model.id);

    expect(modelIds).toContain("claude-sonnet-5");
    expect(modelIds).toContain("claude-opus-4-8");
    expect(modelIds).toContain("claude-fable-5");
  });

  it("uses Sonnet 5 low as the cheap status-only recovery lane", () => {
    expect(modelProfiles).toContainEqual(
      expect.objectContaining({
        key: "cheap",
        adapterConfig: {
          model: "claude-sonnet-5",
          effort: "low",
        },
      }),
    );
  });

  it("documents skip-permissions as fail-closed by default", () => {
    expect(agentConfigurationDoc).toContain("dangerouslySkipPermissions (boolean, optional, default false)");
    expect(agentConfigurationDoc).toContain("Paperclip rejects true");
    expect(agentConfigurationDoc).toContain("allowedTools (string[], legacy)");
    expect(agentConfigurationDoc).toContain("Board-managed manifest");
  });
});

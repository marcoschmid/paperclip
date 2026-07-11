import { describe, expect, it } from "vitest";

import {
  sanitizeWorkspaceOperationMetadataForStorage,
  sanitizeWorkspaceOperationTextForStorage,
} from "../services/workspace-operations.js";

describe("workspace operation persistence redaction", () => {
  it("redacts credentials from excerpts, commands, errors, and metadata", () => {
    const token = "pcp_workspace_operation_persistence_secret";

    expect(sanitizeWorkspaceOperationTextForStorage(`command ${token}`, { enabled: false }))
      .not.toContain(token);
    expect(JSON.stringify(sanitizeWorkspaceOperationMetadataForStorage({
      output: token,
      accessToken: "opaque-access-token",
      safe: "visible",
    }, { enabled: false }))).not.toContain(token);
    expect(sanitizeWorkspaceOperationMetadataForStorage({
      accessToken: "opaque-access-token",
      safe: "visible",
    }, { enabled: false })).toEqual({
      accessToken: "***REDACTED***",
      safe: "visible",
    });
  });
});

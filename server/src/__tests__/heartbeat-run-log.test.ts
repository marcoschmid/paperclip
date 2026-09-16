import { describe, expect, it } from "vitest";
import {
  compactRunLogChunk,
  sanitizeHeartbeatResultJsonForStorage,
  sanitizeHeartbeatRunPatchForStorage,
  sanitizeHeartbeatTaskSessionParamsForStorage,
} from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts pcp-prefixed credentials in otherwise unstructured output", () => {
    const token = "pcp_agent_super_secret_value";
    const compacted = compactRunLogChunk(`adapter output: ${token}`);

    expect(compacted).not.toContain(token);
    expect(compacted).toContain("***REDACTED***");
  });

  it("deep-sanitizes adapter result JSON before persistence and downstream comments", () => {
    const token = "pcp_board_result_json_secret";
    const sanitized = sanitizeHeartbeatResultJsonForStorage({
      output: { summary: token, nested: [token] },
      safe: "visible",
    });

    expect(JSON.stringify(sanitized)).not.toContain(token);
    expect(sanitized.safe).toBe("visible");
  });

  it("preserves only a valid ACPX routing session key while sanitizing task-session secrets", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const sessionKey = `paperclip:${companyId}:${agentId}:issue-123:fingerprint`;
    const rawToken = "pcp_task_session_secret";
    const input = {
      companyId,
      agentId,
      adapterType: "acpx_local",
      sessionParamsJson: {
        sessionKey,
        gatewayToken: rawToken,
        output: rawToken,
      },
    };

    const sanitized = sanitizeHeartbeatTaskSessionParamsForStorage(input);

    expect(sanitized).toMatchObject({
      sessionKey,
      gatewayToken: "***REDACTED***",
      output: "***REDACTED***",
    });
    expect(input.sessionParamsJson).toMatchObject({ sessionKey, gatewayToken: rawToken });
  });

  it("does not preserve foreign or credential-bearing ACPX session keys", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    for (const sessionKey of [
      "paperclip:other-company:other-agent:task:fingerprint",
      `paperclip:${companyId}:${agentId}:pcp_embedded_secret:fingerprint`,
    ]) {
      const sanitized = sanitizeHeartbeatTaskSessionParamsForStorage({
        companyId,
        agentId,
        adapterType: "acpx_local",
        sessionParamsJson: { sessionKey },
      });
      expect(sanitized?.sessionKey).toBe("***REDACTED***");
    }
  });

  it("preserves a valid ACPX routing key in persisted explicit-resume context", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const sessionKey = `paperclip:${companyId}:${agentId}:issue-123:fingerprint`;
    const rawToken = "pcp_explicit_resume_secret";

    const sanitized = sanitizeHeartbeatRunPatchForStorage({
      companyId,
      agentId,
      contextSnapshot: {
        resumeSessionParams: {
          sessionKey,
          gatewayToken: rawToken,
          output: rawToken,
        },
      },
    });

    expect(sanitized?.contextSnapshot).toMatchObject({
      resumeSessionParams: {
        sessionKey,
        gatewayToken: "***REDACTED***",
        output: "***REDACTED***",
      },
    });
  });

  it("does not add resume params to unrelated persisted run contexts", () => {
    const sanitized = sanitizeHeartbeatRunPatchForStorage({
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      contextSnapshot: { issueId: "issue-123" },
    });

    expect(sanitized?.contextSnapshot).toEqual({ issueId: "issue-123" });
    expect(sanitized?.contextSnapshot).not.toHaveProperty("resumeSessionParams");
  });

  it("preserves explicit-resume routing identity on identity-aware context updates", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const sessionKey = `paperclip:${companyId}:${agentId}:issue-123:fingerprint`;

    const sanitized = sanitizeHeartbeatRunPatchForStorage({
      contextSnapshot: {
        resumeSessionParams: {
          sessionKey,
          gatewayToken: "pcp_coalesced_resume_secret",
        },
      },
    }, { companyId, agentId });

    expect(sanitized?.contextSnapshot).toMatchObject({
      resumeSessionParams: {
        sessionKey,
        gatewayToken: "***REDACTED***",
      },
    });
  });

  it("sanitizes run errors, excerpts, context, and result JSON at the persistence boundary", () => {
    const token = "pcp_run_persistence_secret";
    const sanitized = sanitizeHeartbeatRunPatchForStorage({
      error: `failed ${token}`,
      stdoutExcerpt: token,
      stderrExcerpt: token,
      contextSnapshot: { nested: token },
      resultJson: { nested: token },
    });

    expect(JSON.stringify(sanitized)).not.toContain(token);
  });
});

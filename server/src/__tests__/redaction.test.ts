import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  redactEventPayload,
  redactSensitiveText,
  sanitizeLogArguments,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts Paperclip tokens in arbitrary nested result strings while preserving secret refs", () => {
    const token = "pcp_board_super_secret_value";
    const result = redactEventPayload({
      output: {
        message: `completed with ${token}`,
        items: [token, { summary: token }],
      },
      binding: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
    });

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result?.binding).toEqual({
      type: "secret_ref",
      secretId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("sanitizes unexpected fields on secret reference bindings", () => {
    const token = "pcp_secret_ref_escape_value";
    const result = redactEventPayload({
      binding: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
        plaintext: token,
        metadata: { output: token },
      },
      userBinding: {
        type: "user_secret_ref",
        key: "OPENAI_API_KEY",
        leaked: token,
      },
    });

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result?.binding).toMatchObject({
      type: "secret_ref",
      secretId: "11111111-1111-1111-1111-111111111111",
      plaintext: REDACTED_EVENT_VALUE,
    });
    expect(result?.userBinding).toMatchObject({
      type: "user_secret_ref",
      key: "OPENAI_API_KEY",
      leaked: REDACTED_EVENT_VALUE,
    });
  });

  it("preserves numeric token telemetry while redacting credential token fields", () => {
    const result = redactEventPayload({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 10,
      tokenCount: 160,
      token: "opaque-session-token",
      accessToken: "opaque-access-token",
    });

    expect(result).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 10,
      tokenCount: 160,
      token: REDACTED_EVENT_VALUE,
      accessToken: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts provider-specific token, auth, and session-key fields", () => {
    const result = sanitizeRecord({
      gatewayToken: "gateway-secret",
      publicShareToken: "share-secret",
      leaseToken: "lease-secret",
      bridgeToken: "bridge-secret",
      "x-openclaw-auth": "openclaw-secret",
      "x-hermes-session-key": "hermes-secret",
      totalInputTokens: 42,
    });

    expect(result).toEqual({
      gatewayToken: REDACTED_EVENT_VALUE,
      publicShareToken: REDACTED_EVENT_VALUE,
      leaseToken: REDACTED_EVENT_VALUE,
      bridgeToken: REDACTED_EVENT_VALUE,
      "x-openclaw-auth": REDACTED_EVENT_VALUE,
      "x-hermes-session-key": REDACTED_EVENT_VALUE,
      totalInputTokens: 42,
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts private-key blocks and passwords embedded in connection URIs", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "opaque-private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const uri = "postgresql://paperclip:opaque-db-password@127.0.0.1:5432/paperclip";

    const result = redactSensitiveText(`key=${pem}\ndatabase=${uri}`);

    expect(result).not.toContain("opaque-private-key-material");
    expect(result).not.toContain("opaque-db-password");
    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).toContain("postgresql://paperclip:");
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });

  it("sanitizes arbitrary structured logger arguments and Error details", () => {
    const token = "pcp_structured_logger_secret";
    const error = new Error(`adapter failed with ${token}`);
    const args = sanitizeLogArguments([
      { err: error, nested: { accessToken: "opaque-access-token", output: token } },
      `failed: ${token}`,
    ]);

    expect(JSON.stringify(args)).not.toContain(token);
    expect(args[0]).toMatchObject({
      err: { name: "Error", message: `adapter failed with ${REDACTED_EVENT_VALUE}` },
      nested: { accessToken: REDACTED_EVENT_VALUE, output: REDACTED_EVENT_VALUE },
    });
    expect(args[1]).toBe(`failed: ${REDACTED_EVENT_VALUE}`);
  });

  it("bounds cyclic logger objects and sanitizes top-level arrays and URLs", () => {
    const token = "pcp_logger_cycle_secret";
    const cyclic: Record<string, unknown> = { output: token };
    cyclic.self = cyclic;
    class SecretCarrier {
      toJSON() {
        return { token };
      }
    }

    const args = sanitizeLogArguments([
      cyclic,
      [token, { nested: token }],
      new URL("postgresql://paperclip:opaque-password@localhost/paperclip"),
      new SecretCarrier(),
    ]);

    expect(JSON.stringify(args)).not.toContain(token);
    expect(args[0]).toMatchObject({ output: REDACTED_EVENT_VALUE, self: "[Circular]" });
    expect(args[1]).toEqual([REDACTED_EVENT_VALUE, { nested: REDACTED_EVENT_VALUE }]);
    expect(String(args[2])).not.toContain("opaque-password");
    expect(JSON.stringify(args[3])).not.toContain(token);
  });

  it("does not trust spoofed native HTTP constructor names", () => {
    const secret = "opaque-gateway-secret";
    const spoofedRequest = {
      constructor: { name: "IncomingMessage" },
      gatewayToken: secret,
    };

    const stored = sanitizeRecord({ req: spoofedRequest });
    const logged = sanitizeLogArguments([{ req: spoofedRequest }]);

    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
    expect(stored).toMatchObject({ req: { gatewayToken: REDACTED_EVENT_VALUE } });
    expect(logged).toMatchObject([{ req: { gatewayToken: REDACTED_EVENT_VALUE } }]);
  });
});

import { describe, expect, it } from "vitest";

import {
  redactHttpHeaders,
  redactHttpErrorPayload,
  redactHttpPayload,
  redactHttpUrl,
  serializeHttpRequest,
  serializeHttpResponse,
} from "../middleware/http-log-redaction.js";

const SECRET = "pcp_cli_auth_super_secret_value";

describe("HTTP log redaction", () => {
  it("redacts credential query values and Paperclip tokens embedded in paths", () => {
    expect(redactHttpUrl(`/api/cli-auth/poll?token=${SECRET}&keep=visible`)).toBe(
      "/api/cli-auth/poll?token=%5BREDACTED%5D&keep=visible",
    );
    expect(redactHttpUrl(`/invite/${SECRET}`)).toBe("/invite/%5BREDACTED%5D");
  });

  it("redacts credential-shaped values in otherwise safe URL fields and fragments", () => {
    const value = redactHttpUrl(
      "/callback?state=sk-live-example&target=postgresql%3A%2F%2Fuser%3Aopaque-db-password%40localhost%2Fdb#pcp_fragment_secret",
    );

    expect(value).not.toContain("sk-live-example");
    expect(value).not.toContain("opaque-db-password");
    expect(value).not.toContain("pcp_fragment_secret");
  });

  it("redacts every supported credential header and token-bearing referers", () => {
    const headers = redactHttpHeaders({
      authorization: `Bearer ${SECRET}`,
      cookie: `session=${SECRET}`,
      "set-cookie": [`session=${SECRET}; HttpOnly`],
      "x-api-key": SECRET,
      "x-paperclip-token": SECRET,
      "x-paperclip-api-key": SECRET,
      "x-board-api-key": SECRET,
      "x-agent-token": SECRET,
      "proxy-authorization": "opaque-proxy-credential",
      "x-auth-token": "opaque-auth-token",
      "x-access-token": "opaque-access-token",
      "x-api-token": "opaque-api-token",
      "x-goog-api-key": "opaque-google-api-key",
      "x-amz-security-token": "opaque-aws-session-token",
      "x-openclaw-token": "opaque-openclaw-token",
      "x-openclaw-auth": "opaque-openclaw-auth",
      "x-paperclip-cloud-tenant-token": "opaque-cloud-token",
      "x-paperclip-dev-server-status-token": "opaque-dev-status-token",
      "x-hermes-session-key": "opaque-hermes-session-key",
      referer: `http://localhost:3347/invite/${SECRET}`,
      "user-agent": "paperclip-test",
    });

    for (const key of [
      "authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "x-paperclip-token",
      "x-paperclip-api-key",
      "x-board-api-key",
      "x-agent-token",
      "proxy-authorization",
      "x-auth-token",
      "x-access-token",
      "x-api-token",
      "x-goog-api-key",
      "x-amz-security-token",
      "x-openclaw-token",
      "x-openclaw-auth",
      "x-paperclip-cloud-tenant-token",
      "x-paperclip-dev-server-status-token",
      "x-hermes-session-key",
    ]) {
      expect(headers[key]).toBe("[REDACTED]");
    }
    expect(String(headers.referer)).not.toContain(SECRET);
    expect(headers["user-agent"]).toBe("paperclip-test");
  });

  it("redacts provider-specific token query fields", () => {
    const serialized = serializeHttpRequest({
      method: "GET",
      url: "/gateway?gatewayToken=opaque-gateway-token&keep=visible",
      query: {
        gatewayToken: "opaque-gateway-token",
        publicShareToken: "opaque-share-token",
        keep: "visible",
      },
    });

    expect(JSON.stringify(serialized)).not.toContain("opaque-gateway-token");
    expect(JSON.stringify(serialized)).not.toContain("opaque-share-token");
    expect(serialized).toMatchObject({
      query: {
        gatewayToken: "[REDACTED]",
        publicShareToken: "[REDACTED]",
        keep: "visible",
      },
    });
  });

  it("serializes 2xx requests without raw URL, query, cookie, or token values", () => {
    const serialized = serializeHttpRequest({
      id: 42,
      method: "GET",
      url: `/api/cli-auth/poll?token=${SECRET}`,
      query: { token: SECRET, keep: "visible" },
      headers: { cookie: `session=${SECRET}` },
      socket: { remoteAddress: "127.0.0.1", remotePort: 1234 },
    });

    expect(JSON.stringify(serialized)).not.toContain(SECRET);
    expect(serialized).toMatchObject({
      id: 42,
      method: "GET",
      query: { token: "[REDACTED]", keep: "visible" },
      remoteAddress: "127.0.0.1",
      remotePort: 1234,
    });
  });

  it("serializes response cookies without exposing session tokens", () => {
    const serialized = serializeHttpResponse({
      statusCode: 200,
      getHeaders: () => ({ "set-cookie": [`session=${SECRET}; HttpOnly`], "content-type": "application/json" }),
    });

    expect(JSON.stringify(serialized)).not.toContain(SECRET);
    expect(serialized).toMatchObject({
      statusCode: 200,
      headers: { "set-cookie": "[REDACTED]", "content-type": "application/json" },
    });
  });

  it("recursively redacts opaque HTTP credential fields without relying on a pcp prefix", () => {
    const value = redactHttpPayload({
      token: "opaque-token",
      nested: {
        code: "one-time-code",
        apiKey: "opaque-api-key",
        accessToken: "opaque-access-token",
        refreshToken: "opaque-refresh-token",
        sessionToken: "opaque-session-token",
        clientSecret: "opaque-client-secret",
        passwordConfirmation: "opaque-password-confirmation",
        privateKey: "opaque-private-key",
      },
      cursor: "next-page-cursor",
    });

    expect(value).toEqual({
      token: "[REDACTED]",
      nested: {
        code: "[REDACTED]",
        apiKey: "[REDACTED]",
        accessToken: "[REDACTED]",
        refreshToken: "[REDACTED]",
        sessionToken: "[REDACTED]",
        clientSecret: "[REDACTED]",
        passwordConfirmation: "[REDACTED]",
        privateKey: "[REDACTED]",
      },
      cursor: "next-page-cursor",
    });
  });

  it("preserves diagnostic application error codes while still redacting nested credentials", () => {
    expect(redactHttpErrorPayload({
      code: "invalid_configuration",
      details: { code: "provider_timeout", accessToken: "opaque-access-token" },
    })).toEqual({
      code: "invalid_configuration",
      details: { code: "provider_timeout", accessToken: "[REDACTED]" },
    });
  });
});

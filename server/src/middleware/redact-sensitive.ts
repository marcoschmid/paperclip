// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

import { redactSensitiveText } from "../redaction.js";

const SENSITIVE_KEYS = new Set<string>([
  "credential",
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-paperclip-token",
  "x-paperclip-api-key",
  "x-board-api-key",
  "x-agent-token",
  "private_key",
  "privatekey",
  // The Claude setup-token login fields. `browserCode` carries the one-time
  // sign-in code and `authorization_code` carries the OAuth code; neither may
  // reach a log line.
  "browsercode",
  "authorization_code",
  "authorizationcode",
  // The workspace login handoff ticket (PAP-17572). It is a signed bearer
  // credential carried as a query parameter, so it must never reach a log line
  // even though the exchange itself answers 302.
  "ticket",
  "proxy-authorization",
  "x-auth-token",
  "x-access-token",
  "x-api-token",
  "x-goog-api-key",
  "x-amz-security-token",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const URLISH_KEYS = new Set<string>([
  "href",
  "locator",
  "source",
  "source_locator",
  "sourcelocator",
  "source_url",
  "sourceurl",
  "uri",
  "url",
  // The Claude setup-token login URL. A structured `loginUrl` that reaches a log
  // sink keeps its origin and path only; the OAuth query, fragment, and any
  // credentials are stripped (SR-5 backstop).
  "loginurl",
  "login_url",
]);

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  const normalized = lower.replace(/[^a-z0-9]/g, "");
  if (normalized === "token" || normalized === "code") return false;
  return normalized.endsWith("token")
    || normalized.endsWith("auth")
    || normalized.endsWith("sessionkey");
}

function isUrlishKey(key: string): boolean {
  return URLISH_KEYS.has(key.toLowerCase());
}

function stripSecretBearingUrlParts(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof entry === "string" && isUrlishKey(key)) {
      out[key] = stripSecretBearingUrlParts(entry);
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}

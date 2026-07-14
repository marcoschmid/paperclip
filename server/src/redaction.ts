import { IncomingMessage, ServerResponse } from "node:http";
import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CANONICAL_NUMERIC_SCHEMA_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PAPERCLIP_TOKEN_TEXT_RE = /pcp_[A-Za-z0-9_-]+/gi;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const URI_USERINFO_PASSWORD_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "pcp_",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";
const CIRCULAR_EVENT_VALUE = "[Circular]";
const MAX_DEPTH_EVENT_VALUE = "[Max depth reached]";

type SanitizeLimits = {
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayItems: number;
  maxStringChars: number;
};

type SanitizeState = {
  seen: WeakSet<object>;
  limits: SanitizeLimits;
  preserveNativeHttpObjects: boolean;
};

const STORAGE_SANITIZE_LIMITS: SanitizeLimits = {
  maxDepth: 12,
  maxObjectKeys: 1_000,
  maxArrayItems: 1_000,
  maxStringChars: 2_000_000,
};

const LOG_SANITIZE_LIMITS: SanitizeLimits = {
  maxDepth: 8,
  maxObjectKeys: 200,
  maxArrayItems: 200,
  maxStringChars: 128_000,
};

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".") || input.includes("://");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPinoNativeHttpObject(value: unknown) {
  return value instanceof IncomingMessage || value instanceof ServerResponse;
}

function normalizedCredentialKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isNumericTokenTelemetry(key: string, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const normalized = normalizedCredentialKey(key);
  return /^(?:raw)?(?:input|output|cachedinput|totalinput|totaloutput|totalcachedinput)tokens$/.test(normalized)
    || normalized === "tokencount";
}

function isHarmlessSchemaVersion(key: string, value: unknown): value is string {
  return key === "schemaVersion"
    && typeof value === "string"
    && CANONICAL_NUMERIC_SCHEMA_VERSION_RE.test(value);
}

function isSensitivePayloadKey(key: string, value: unknown) {
  if (isNumericTokenTelemetry(key, value)) return false;
  const normalized = normalizedCredentialKey(key);
  if ([
    "authorization",
    "proxyauthorization",
    "bearer",
    "jwt",
    "token",
    "password",
    "passwd",
    "credential",
    "cookie",
    "setcookie",
    "connectionstring",
    "plaintext",
  ].includes(normalized)) return true;
  return normalized.endsWith("token")
    || normalized.endsWith("auth")
    || normalized.endsWith("sessionkey")
    || /(?:apikey(?:ref|plain)?|accesstoken|refreshtoken|authtoken|sessiontoken|idtoken|securitytoken|apitoken)$/.test(normalized)
    || /(?:client)?secret(?:ref|plain)?$/.test(normalized)
    || /password(?:confirmation|confirm)?$/.test(normalized)
    || /privatekey(?:ref|plain)?$/.test(normalized)
    || /credential(?:s)?$/.test(normalized)
    || /cookie$/.test(normalized);
}

function truncateSanitizedString(value: string, maxChars: number) {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}[truncated ${redacted.length - maxChars} chars]`;
}

function sanitizeValue(value: unknown, state: SanitizeState, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateSanitizedString(value, state.limits.maxStringChars);
  if (typeof value !== "object") return value;
  if (depth > state.limits.maxDepth) return MAX_DEPTH_EVENT_VALUE;
  if (state.seen.has(value)) return CIRCULAR_EVENT_VALUE;
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const limited = value.slice(0, state.limits.maxArrayItems)
        .map((entry) => sanitizeValue(entry, state, depth + 1));
      if (value.length > limited.length) {
        limited.push(`[truncated ${value.length - limited.length} array items]`);
      }
      return limited;
    }
    if (value instanceof Error) {
      return sanitizeRecordInternal({
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
        ...Object.fromEntries(Object.entries(value)),
      }, state, depth + 1);
    }
    if (value instanceof URL) {
      return truncateSanitizedString(value.toString(), state.limits.maxStringChars);
    }
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
    if (isSecretRefBinding(value)) {
      return sanitizeBindingRecord(value, state, depth + 1, ["type", "secretId", "version"]);
    }
    if (isUserSecretRefBinding(value)) {
      return sanitizeBindingRecord(value, state, depth + 1, ["type", "key", "version"]);
    }
    if (isPlainBinding(value)) {
      return { type: "plain", value: sanitizeValue(value.value, state, depth + 1) };
    }
    if (!isPlainObject(value)) {
      const typeName = value.constructor?.name || "Object";
      return `[${typeName}]`;
    }
    return sanitizeRecordInternal(value, state, depth + 1);
  } finally {
    state.seen.delete(value);
  }
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeBindingRecord(
  value: Record<string, unknown>,
  state: SanitizeState,
  depth: number,
  preservedKeys: string[],
) {
  const preserved = new Set(preservedKeys);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, state.limits.maxObjectKeys)) {
    result[key] = preserved.has(key)
      ? sanitizeValue(entry, state, depth + 1)
      : isSensitivePayloadKey(key, entry)
        ? REDACTED_EVENT_VALUE
        : sanitizeValue(entry, state, depth + 1);
  }
  return result;
}

function sanitizeCommandArgs(args: unknown[], state: SanitizeState, depth: number): unknown[] {
  let redactNext = false;
  return args.slice(0, state.limits.maxArrayItems).map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg, state, depth + 1);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

function sanitizeRecordInternal(
  record: Record<string, unknown>,
  state: SanitizeState,
  depth: number,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(record);
  for (const [key, value] of entries.slice(0, state.limits.maxObjectKeys)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value, state, depth + 1);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    // Numeric schema identifiers such as `1.0.0` collide with the broad JWT
    // shape below. Preserve only this exact, non-credential field and the
    // canonical numeric form; aliases and token-shaped values stay redacted.
    if (isHarmlessSchemaVersion(key, value)) {
      redacted[key] = value;
      continue;
    }
    if (isSensitivePayloadKey(key, value)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value, state, depth + 1);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value, state, depth + 1);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (state.preserveNativeHttpObjects && (key === "req" || key === "res") && isPinoNativeHttpObject(value)) {
      redacted[key] = value;
      continue;
    }
    redacted[key] = sanitizeValue(value, state, depth + 1);
  }
  if (entries.length > state.limits.maxObjectKeys) {
    redacted.__paperclipRedactionTruncatedKeys = entries.length - state.limits.maxObjectKeys;
  }
  return redacted;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return sanitizeRecordInternal(record, {
    seen: new WeakSet<object>([record]),
    limits: STORAGE_SANITIZE_LIMITS,
    preserveNativeHttpObjects: false,
  }, 0);
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function sanitizeLogArguments(args: unknown[]): unknown[] {
  const state: SanitizeState = {
    seen: new WeakSet<object>(),
    limits: LOG_SANITIZE_LIMITS,
    preserveNativeHttpObjects: true,
  };
  return args.slice(0, LOG_SANITIZE_LIMITS.maxArrayItems).map((value) => {
    if (isPinoNativeHttpObject(value)) return value;
    return sanitizeValue(value, state, 0);
  });
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(PRIVATE_KEY_BLOCK_RE, (_match, keyType: string) =>
        `-----BEGIN ${keyType}-----\n${REDACTED_EVENT_VALUE}\n-----END ${keyType}-----`)
      .replace(URI_USERINFO_PASSWORD_RE, `$1$2:${REDACTED_EVENT_VALUE}@`)
      .replace(PAPERCLIP_TOKEN_TEXT_RE, REDACTED_EVENT_VALUE)
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}

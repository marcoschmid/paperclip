export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
] as const;
import { redactSensitiveText } from "../redaction.js";
import { isSensitiveKey, redactSensitive } from "./redact-sensitive.js";

const REDACTED = "[REDACTED]";
const PAPERCLIP_TOKEN_RE = /pcp_[A-Za-z0-9_-]+/gi;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-paperclip-token",
  "x-paperclip-api-key",
  "x-paperclip-maintenance-lease",
  "x-board-api-key",
  "x-agent-token",
]);

function isSensitiveHttpKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "token" || normalized === "code" || isSensitiveKey(key);
}

function redactTokenText(value: string): string {
  return redactSensitiveText(value.replace(PAPERCLIP_TOKEN_RE, REDACTED));
}

export function redactHttpUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const parsed = new URL(value, "http://paperclip.invalid");
    const decodedPathname = (() => {
      try {
        return decodeURIComponent(parsed.pathname);
      } catch {
        return parsed.pathname;
      }
    })();
    parsed.pathname = redactTokenText(decodedPathname);
    for (const [key, entry] of parsed.searchParams.entries()) {
      if (isSensitiveHttpKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      } else {
        parsed.searchParams.set(key, redactTokenText(entry));
      }
    }
    if (parsed.hash) parsed.hash = redactTokenText(parsed.hash);
    const pathname = parsed.pathname.replaceAll(REDACTED, "%5BREDACTED%5D");
    return isAbsolute
      ? `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`
      : `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return redactTokenText(value);
  }
}

export function redactHttpHeaders(
  headers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!headers) return {};
  const redacted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(normalizedName) || isSensitiveHttpKey(normalizedName)) {
      redacted[name] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      redacted[name] = normalizedName === "referer" || normalizedName === "referrer"
        ? redactHttpUrl(value)
        : redactTokenText(value);
      continue;
    }
    if (Array.isArray(value)) {
      redacted[name] = value.map((entry) => typeof entry === "string" ? redactTokenText(entry) : entry);
      continue;
    }
    redacted[name] = value;
  }
  return redacted;
}

function redactHttpPayloadInternal(value: unknown, depth: number, redactCode: boolean): unknown {
  if (depth > 6) return undefined;
  if (value === null || typeof value !== "object") {
    return redactSensitive(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHttpPayloadInternal(entry, depth + 1, redactCode));
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    redacted[key] = isSensitiveHttpKey(key) && (redactCode || normalizedKey !== "code")
      ? REDACTED
      : redactHttpPayloadInternal(entry, depth + 1, redactCode);
  }
  return redacted;
}

export function redactHttpPayload(value: unknown): unknown {
  return redactHttpPayloadInternal(value, 0, true);
}

export function redactHttpErrorPayload(value: unknown): unknown {
  return redactHttpPayloadInternal(value, 0, false);
}

export const redactHttpQuery = redactHttpPayload;

type RequestLike = {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  originalUrl?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: Record<string, unknown> | null;
  remoteAddress?: unknown;
  remotePort?: unknown;
  socket?: { remoteAddress?: unknown; remotePort?: unknown } | null;
};

export function serializeHttpRequest(req: RequestLike): Record<string, unknown> {
  const rawUrl = typeof req.originalUrl === "string"
    ? req.originalUrl
    : typeof req.url === "string"
      ? req.url
      : undefined;
  return {
    ...(req.id !== undefined ? { id: req.id } : {}),
    ...(req.method !== undefined ? { method: req.method } : {}),
    ...(rawUrl !== undefined ? { url: redactHttpUrl(rawUrl) } : {}),
    ...(req.query !== undefined ? { query: redactHttpQuery(req.query) } : {}),
    ...(req.params !== undefined ? { params: redactHttpPayload(req.params) } : {}),
    headers: redactHttpHeaders(req.headers),
    remoteAddress: req.remoteAddress ?? req.socket?.remoteAddress,
    remotePort: req.remotePort ?? req.socket?.remotePort,
  };
}

type ResponseLike = {
  statusCode?: unknown;
  headers?: Record<string, unknown> | null;
  getHeaders?: () => Record<string, unknown>;
};

export function serializeHttpResponse(res: ResponseLike): Record<string, unknown> {
  const headers = typeof res.getHeaders === "function" ? res.getHeaders() : res.headers;
  return {
    ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}),
    headers: redactHttpHeaders(headers),
  };
}

import path from "node:path";
import * as fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import {
  redactHttpPayload,
  redactHttpErrorPayload,
  redactHttpQuery,
  redactHttpUrl,
  serializeHttpRequest,
  serializeHttpResponse,
} from "./http-log-redaction.js";
import { redactSensitiveText, sanitizeLogArguments } from "../redaction.js";
import { rotateLogFileAtStartup } from "./log-file-rotation.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
fs.chmodSync(logDir, 0o700);

const logFile = path.join(logDir, "server.log");
rotateLogFileAtStartup(logFile, {
  maxBytes: Number(process.env.PAPERCLIP_LOG_MAX_BYTES) || 100 * 1024 * 1024,
  retentionFiles: Number(process.env.PAPERCLIP_LOG_RETENTION_FILES) || 5,
});
const logFileDescriptor = fs.openSync(logFile, "a", 0o600);
fs.closeSync(logFileDescriptor);
fs.chmodSync(logFile, 0o600);

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  hooks: {
    logMethod(inputArgs, method) {
      return Reflect.apply(method, this, sanitizeLogArguments(inputArgs));
    },
  },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['set-cookie']",
    "req.headers['x-api-key']",
    "req.headers['x-paperclip-token']",
    "req.headers['x-paperclip-api-key']",
    "req.headers['x-board-api-key']",
    "req.headers['x-agent-token']",
    "req.headers['x-openclaw-token']",
    "req.headers['x-openclaw-auth']",
    "req.headers['x-paperclip-cloud-tenant-token']",
    "req.headers['x-paperclip-dev-server-status-token']",
    "req.headers['x-hermes-session-key']",
    "req.query.gatewayToken",
    "res.headers['set-cookie']",
  ],
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req: serializeHttpRequest,
    res: serializeHttpResponse,
  },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${redactHttpUrl(req.url) ?? ""} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${redactHttpUrl(req.url) ?? ""} ${res.statusCode} — ${redactSensitiveText(errMsg)}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: redactHttpErrorPayload(ctx.error),
          reqBody: redactHttpPayload(ctx.reqBody),
          reqParams: redactHttpPayload(ctx.reqParams),
          reqQuery: redactHttpQuery(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactHttpPayload(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactHttpPayload(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactHttpQuery(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});

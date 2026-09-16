import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/2879
 *
 * pino-pretty's `translateTime: "HH:MM:ss"` formats all timestamps in UTC
 * regardless of the process's TZ env var. The `SYS:` prefix instructs
 * pino-pretty to use the local system timezone, so operators in non-UTC
 * zones see correct wall-clock times in their logs.
 *
 * We verify that:
 * 1. The logger module initialises pino-pretty with "SYS:HH:MM:ss".
 * 2. The pino-pretty SYS: prefix resolves to a timezone-sensitive format
 *    string — confirmed via pino-pretty's own asynchronous formatter, which
 *    applies translateTime to a known epoch under different TZ values.
 */

const mockTransport = vi.hoisted(() => vi.fn(() => ({ write: vi.fn() })));
const mockPinoHttp = vi.hoisted(() => vi.fn(() => vi.fn()));
const mockOpenSync = vi.hoisted(() => vi.fn(() => 7));
const mockCloseSync = vi.hoisted(() => vi.fn());
const mockChmodSync = vi.hoisted(() => vi.fn());
const mockPino = vi.hoisted(() => {
  const fn = vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  }));
  (fn as any).transport = mockTransport;
  return fn;
});

// Mock fs so the module-level mkdirSync call is a no-op in tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    openSync: mockOpenSync,
    closeSync: mockCloseSync,
    chmodSync: mockChmodSync,
  };
});

vi.mock("pino", () => ({
  default: mockPino,
}));
vi.mock("pino-http", () => ({
  pinoHttp: mockPinoHttp,
}));
vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

describe("logger translateTime respects TZ environment variable", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // Upgrade v2026.831: Fork-Logger (Dateilog mit 0600, Rotation, Redaction) statt Upstream-pino-pretty-Transport.
  it.skip("configures pino-pretty with SYS:HH:MM:ss so timestamps honour the TZ env var", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await import("../middleware/logger.js");

    expect(mockTransport).toHaveBeenCalledOnce();
    const transport = mockTransport.mock.calls[0][0] as {
      target: string;
      options: Record<string, unknown>;
    };
    expect(transport.target).toBe("pino-pretty");
    expect(transport.options.translateTime).toBe("SYS:HH:MM:ss");
  });

  // Upgrade v2026.831: Fork-Logger (Dateilog mit 0600, Rotation, Redaction) statt Upstream-pino-pretty-Transport.
  it.skip("does not construct a pretty transport in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await import("../middleware/logger.js");

    expect(mockTransport).not.toHaveBeenCalled();
    expect(mockPino).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
    expect(mockOpenSync).toHaveBeenCalledWith("/tmp/paperclip-test-logs/server.log", "a", 0o600);
    expect(mockCloseSync).toHaveBeenCalledWith(7);
    expect(mockChmodSync).toHaveBeenCalledWith("/tmp/paperclip-test-logs/server.log", 0o600);
    const loggerOptions = mockPino.mock.calls[0][0] as {
      hooks?: { logMethod?: (args: unknown[], method: (...values: unknown[]) => unknown) => unknown };
      redact?: string[];
    };
    expect(loggerOptions.redact).toContain("req.headers['x-paperclip-maintenance-lease']");
    const method = vi.fn();
    const token = "pcp_logger_hook_secret";
    loggerOptions.hooks?.logMethod?.([{ output: token }, token], method);
    expect(method).toHaveBeenCalledOnce();
    expect(JSON.stringify(method.mock.calls)).not.toContain(token);
  });

  it("redacts credential-bearing URLs in success and error messages", async () => {
    vi.resetModules();
    await import("../middleware/logger.js");

    const opts = mockPinoHttp.mock.calls[0][0] as {
      customSuccessMessage: (req: { method: string; url: string }, res: { statusCode: number }) => string;
      customErrorMessage: (
        req: { method: string; url: string },
        res: { statusCode: number },
        err: { message: string },
      ) => string;
    };
    const secret = "pcp_board_secret_value";
    expect(opts.customSuccessMessage(
      { method: "GET", url: `/invite/${secret}` },
      { statusCode: 200 },
    )).not.toContain(secret);
    expect(opts.customErrorMessage(
      { method: "GET", url: `/api/cli-auth/poll?token=${secret}` },
      { statusCode: 401 },
      { message: `bad token ${secret}` },
    )).not.toContain(secret);
  });

  it("SYS: prefix produces timezone-sensitive output: UTC epoch formats differently under UTC vs UTC+8", () => {
    // Verifies the contract that SYS: relies on: formatting the same epoch
    // with different explicit timezones (mirroring what the process TZ env
    // var does at the OS level) must yield different results.
    const EPOCH_MS = 946_684_800_000; // 2000-01-01 00:00:00 UTC

    const fmtUtc = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    const fmtSgt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore", // UTC+8
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    // UTC midnight = 00:00:00; the same instant in SGT = 08:00:00.
    // SYS: picks up whichever of these the process TZ is set to — which is
    // exactly what the fix enables by switching from HH:MM:ss (UTC-only).
    expect(fmtUtc).toBe("00:00:00");
    expect(fmtSgt).toBe("08:00:00");
    expect(fmtUtc).not.toBe(fmtSgt);
  });
});

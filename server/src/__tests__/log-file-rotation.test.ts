import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { rotateLogFileAtStartup } from "../middleware/log-file-rotation.js";

function permissionBits(mode: number) {
  return mode & 0o777;
}

describe("server log startup rotation", () => {
  it("rotates oversized logs with bounded retention and private modes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-log-rotation-"));
    const logFile = path.join(dir, "server.log");
    await writeFile(logFile, "first-oversized-log", { mode: 0o644 });

    rotateLogFileAtStartup(logFile, { maxBytes: 8, retentionFiles: 2 });
    await expect(readFile(`${logFile}.1`, "utf8")).resolves.toBe("first-oversized-log");
    expect(permissionBits((await stat(`${logFile}.1`)).mode)).toBe(0o600);

    await writeFile(logFile, "second-oversized-log", { mode: 0o644 });
    rotateLogFileAtStartup(logFile, { maxBytes: 8, retentionFiles: 2 });
    await expect(readFile(`${logFile}.1`, "utf8")).resolves.toBe("second-oversized-log");
    await expect(readFile(`${logFile}.2`, "utf8")).resolves.toBe("first-oversized-log");

    await writeFile(logFile, "third-oversized-log", { mode: 0o644 });
    rotateLogFileAtStartup(logFile, { maxBytes: 8, retentionFiles: 2 });
    await expect(readFile(`${logFile}.2`, "utf8")).resolves.toBe("second-oversized-log");
  });

  it("falls back from non-finite options and clamps huge retention values", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-log-rotation-bounds-"));
    const invalidLog = path.join(dir, "invalid.log");
    const hugeLog = path.join(dir, "huge.log");
    await writeFile(invalidLog, "small", { mode: 0o644 });
    await writeFile(hugeLog, "oversized", { mode: 0o644 });

    expect(rotateLogFileAtStartup(invalidLog, {
      maxBytes: Number.POSITIVE_INFINITY,
      retentionFiles: Number.POSITIVE_INFINITY,
    })).toBe(false);
    expect(rotateLogFileAtStartup(hugeLog, {
      maxBytes: 1,
      retentionFiles: Number.MAX_SAFE_INTEGER,
    })).toBe(true);
    await expect(readFile(`${hugeLog}.1`, "utf8")).resolves.toBe("oversized");
  });
});

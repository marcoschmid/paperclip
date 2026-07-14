import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSpawnedLocalProcessIdentity,
  verifyStoredLocalProcessIdentity,
} from "../services/local-process-identity.js";

describe("local Paperclip child-process identity", () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (typeof child?.pid === "number") {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Test cleanup is best effort.
      }
    }
    child = null;
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "requires exact start time, executable, command fingerprint, and process group",
    async () => {
      child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once("data", () => resolve());
        child!.once("error", reject);
      });
      const identity = await captureSpawnedLocalProcessIdentity({
        pid: child.pid!,
        processGroupId: child.pid!,
        startedAt: new Date().toISOString(),
      });
      const stored = {
        processPid: identity.pid,
        processGroupId: identity.processGroupId,
        processStartedAt: new Date(identity.processStartedAt),
        processExecutable: identity.processExecutable,
        processCommandSha256: identity.processCommandSha256,
      };

      await expect(verifyStoredLocalProcessIdentity(stored)).resolves.toMatchObject({ kind: "verified" });
      for (const mutation of [
        { processStartedAt: new Date(stored.processStartedAt.getTime() - 1_000) },
        { processExecutable: `${stored.processExecutable}-recycled` },
        { processCommandSha256: `v1:sha256:${"0".repeat(64)}` },
        { processGroupId: stored.processGroupId + 1 },
      ]) {
        await expect(verifyStoredLocalProcessIdentity({ ...stored, ...mutation })).resolves.toEqual({
          kind: "unproven",
          reason: "stored_identity_mismatch",
        });
        expect(() => process.kill(child!.pid!, 0)).not.toThrow();
      }
    },
  );
});

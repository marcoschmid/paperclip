import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const COMMAND_SHA256_RE = /^v1:sha256:[a-f0-9]{64}$/;
const PS_TIMEOUT_MS = 1_000;
const PS_MAX_BUFFER = 256 * 1024;
const SPAWN_CLOCK_TOLERANCE_MS = 15_000;

export interface LocalProcessIdentity {
  pid: number;
  processGroupId: number;
  processStartedAt: string;
  processExecutable: string;
  processCommandSha256: string;
}

export type LocalProcessInspection =
  | { kind: "not_running" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "running"; identity: LocalProcessIdentity };

export type StoredLocalProcessIdentity = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  processExecutable: string | null;
  processCommandSha256: string | null;
};

export type StoredLocalProcessIdentityVerification =
  | { kind: "not_running" }
  | { kind: "unproven"; reason: string }
  | { kind: "verified"; identity: LocalProcessIdentity };

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function processLiveness(pid: number): "running" | "not_running" | "ambiguous" {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") return "not_running";
    if (code === "EPERM") return "running";
    return "ambiguous";
  }
}

function psExecutable() {
  if (process.platform === "darwin") return "/bin/ps";
  if (process.platform === "linux") return "/usr/bin/ps";
  return null;
}

function readPsField(executable: string, pid: number, field: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-p", String(pid), "-o", `${field}=`],
      {
        encoding: "utf8",
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const value = stdout.trim();
        if (!value) {
          reject(new Error(`ps returned an empty ${field} field`));
          return;
        }
        resolve(value);
      },
    );
  });
}

function commandSha256(command: string) {
  return `v1:sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

/**
 * Inspect an OS process without trusting PID liveness as ownership evidence.
 * The start time is deliberately read twice around the other fields so a PID
 * recycle during inspection fails closed instead of producing a mixed tuple.
 */
export async function inspectLocalProcessIdentity(pid: number): Promise<LocalProcessInspection> {
  if (!validPid(pid)) return { kind: "ambiguous", reason: "invalid_pid" };
  const liveness = processLiveness(pid);
  if (liveness === "not_running") return { kind: "not_running" };
  if (liveness === "ambiguous") return { kind: "ambiguous", reason: "liveness_unknown" };
  const executable = psExecutable();
  if (!executable) return { kind: "ambiguous", reason: "unsupported_platform" };

  try {
    const startBefore = await readPsField(executable, pid, "lstart");
    const [groupRaw, processExecutable, command] = await Promise.all([
      readPsField(executable, pid, "pgid"),
      readPsField(executable, pid, "comm"),
      readPsField(executable, pid, "command"),
    ]);
    const startAfter = await readPsField(executable, pid, "lstart");
    if (startBefore !== startAfter) {
      return { kind: "ambiguous", reason: "pid_recycled_during_inspection" };
    }
    const processGroupId = Number(groupRaw);
    const parsedStartedAt = new Date(startBefore);
    if (!validPid(processGroupId) || Number.isNaN(parsedStartedAt.getTime())) {
      return { kind: "ambiguous", reason: "process_identity_parse_failed" };
    }
    return {
      kind: "running",
      identity: {
        pid,
        processGroupId,
        processStartedAt: parsedStartedAt.toISOString(),
        processExecutable,
        processCommandSha256: commandSha256(command),
      },
    };
  } catch {
    const after = processLiveness(pid);
    if (after === "not_running") return { kind: "not_running" };
    return { kind: "ambiguous", reason: "process_identity_read_failed" };
  }
}

export async function captureSpawnedLocalProcessIdentity(input: {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
}): Promise<LocalProcessIdentity> {
  const inspected = await inspectLocalProcessIdentity(input.pid);
  if (inspected.kind !== "running") {
    throw new Error(`Could not capture strong child-process identity: ${inspected.kind}`);
  }
  const declaredStartedAt = Date.parse(input.startedAt);
  const observedStartedAt = Date.parse(inspected.identity.processStartedAt);
  if (
    !validPid(input.processGroupId)
    || inspected.identity.processGroupId !== input.processGroupId
    || !Number.isFinite(declaredStartedAt)
    || Math.abs(observedStartedAt - declaredStartedAt) > SPAWN_CLOCK_TOLERANCE_MS
  ) {
    throw new Error("Spawned child-process identity did not match its process boundary");
  }
  return inspected.identity;
}

export async function verifyStoredLocalProcessIdentity(
  stored: StoredLocalProcessIdentity,
): Promise<StoredLocalProcessIdentityVerification> {
  if (!validPid(stored.processPid)) return { kind: "unproven", reason: "missing_pid" };
  const inspected = await inspectLocalProcessIdentity(stored.processPid);
  if (inspected.kind === "not_running") return inspected;
  if (inspected.kind === "ambiguous") return { kind: "unproven", reason: inspected.reason };
  if (
    !validPid(stored.processGroupId)
    || !(stored.processStartedAt instanceof Date)
    || Number.isNaN(stored.processStartedAt.getTime())
    || typeof stored.processExecutable !== "string"
    || stored.processExecutable.length === 0
    || !COMMAND_SHA256_RE.test(stored.processCommandSha256 ?? "")
  ) {
    return { kind: "unproven", reason: "stored_identity_incomplete" };
  }
  const observed = inspected.identity;
  if (
    observed.processGroupId !== stored.processGroupId
    || observed.processStartedAt !== stored.processStartedAt.toISOString()
    || observed.processExecutable !== stored.processExecutable
    || observed.processCommandSha256 !== stored.processCommandSha256
  ) {
    return { kind: "unproven", reason: "stored_identity_mismatch" };
  }
  return { kind: "verified", identity: observed };
}

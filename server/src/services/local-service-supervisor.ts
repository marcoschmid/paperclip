import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  verifyStoredLocalProcessIdentity,
  type StoredLocalProcessIdentityVerification,
} from "./local-process-identity.js";

const execFileAsync = promisify(execFile);

export interface LocalServiceRegistryRecord {
  version: 1 | 2;
  serviceKey: string;
  profileKind: string;
  serviceName: string;
  command: string;
  cwd: string;
  envFingerprint: string;
  port: number | null;
  url: string | null;
  pid: number;
  processGroupId: number | null;
  processStartedAt?: string | null;
  processExecutable?: string | null;
  processCommandSha256?: string | null;
  provider: "local_process";
  runtimeServiceId: string | null;
  reuseKey: string | null;
  startedAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown> | null;
}

export interface LocalServiceIdentityInput {
  companyId?: string | null;
  profileKind: string;
  serviceName: string;
  cwd: string;
  command: string;
  envFingerprint: string;
  port: number | null;
  scope: Record<string, unknown> | null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeServiceKeySegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function getRuntimeServicesDir() {
  const testOverride = process.env.PAPERCLIP_TEST_RUNTIME_SERVICES_DIR?.trim();
  if (testOverride) return path.resolve(testOverride);
  return path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
}

function getRuntimeServiceLogsDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "runtime-service-logs");
}

export function resolveLocalServiceLogPath(serviceKey: string) {
  if (!/^[a-z0-9._-]+$/.test(serviceKey)) {
    throw new Error("Invalid local service key for log path");
  }
  return path.resolve(getRuntimeServiceLogsDir(), `${serviceKey}.log`);
}

/**
 * Open a managed service's durable append-only output file.
 *
 * The returned descriptor is intended to be passed directly to spawn(). The
 * child receives its own duplicate, so the caller can close this handle as soon
 * as spawn returns without tying the service's stdio lifetime to Paperclip's.
 */
export async function openLocalServiceLogFile(serviceKey: string) {
  await fs.mkdir(getRuntimeServiceLogsDir(), { recursive: true });
  const logPath = resolveLocalServiceLogPath(serviceKey);
  const handle = await fs.open(logPath, "a+", 0o600);
  const startOffset = (await handle.stat()).size;
  return { handle, logPath, startOffset };
}

function getRuntimeServiceRegistryPath(serviceKey: string) {
  return path.resolve(getRuntimeServicesDir(), `${serviceKey}.json`);
}

function expectedRegistryFilename(serviceKey: string) {
  return `${serviceKey}.json`;
}

function normalizeRegistryRecord(raw: unknown): LocalServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (
    (rec.version !== 1 && rec.version !== 2) ||
    typeof rec.serviceKey !== "string" ||
    typeof rec.profileKind !== "string" ||
    typeof rec.serviceName !== "string" ||
    typeof rec.command !== "string" ||
    typeof rec.cwd !== "string" ||
    typeof rec.envFingerprint !== "string" ||
    typeof rec.pid !== "number"
  ) {
    return null;
  }

  return {
    version: rec.version,
    serviceKey: rec.serviceKey,
    profileKind: rec.profileKind,
    serviceName: rec.serviceName,
    command: rec.command,
    cwd: rec.cwd,
    envFingerprint: rec.envFingerprint,
    port: typeof rec.port === "number" ? rec.port : null,
    url: typeof rec.url === "string" ? rec.url : null,
    pid: rec.pid,
    processGroupId: typeof rec.processGroupId === "number" ? rec.processGroupId : null,
    processStartedAt: typeof rec.processStartedAt === "string" ? rec.processStartedAt : null,
    processExecutable: typeof rec.processExecutable === "string" ? rec.processExecutable : null,
    processCommandSha256:
      typeof rec.processCommandSha256 === "string" ? rec.processCommandSha256 : null,
    provider: "local_process",
    runtimeServiceId: typeof rec.runtimeServiceId === "string" ? rec.runtimeServiceId : null,
    reuseKey: typeof rec.reuseKey === "string" ? rec.reuseKey : null,
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : new Date().toISOString(),
    lastSeenAt: typeof rec.lastSeenAt === "string" ? rec.lastSeenAt : new Date().toISOString(),
    metadata:
      rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
        ? (rec.metadata as Record<string, unknown>)
        : null,
  };
}

async function safeReadRegistryRecord(filePath: string) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeRegistryRecord(raw);
  } catch {
    return null;
  }
}

async function strictReadRegistryRecord(
  filePath: string,
  options?: { allowMissing?: boolean },
): Promise<LocalServiceRegistryRecord | null> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      options?.allowMissing === true &&
      (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(`Local service registry file is unreadable: ${filePath}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Local service registry contains invalid or corrupt JSON: ${filePath}`, {
      cause: error,
    });
  }
  const record = normalizeRegistryRecord(raw);
  if (!record) {
    throw new Error(`Local service registry contains invalid record data: ${filePath}`);
  }
  const expectedFilename = expectedRegistryFilename(record.serviceKey);
  if (path.basename(filePath) !== expectedFilename) {
    throw new Error(
      `Local service registry filename is not bound to its service key: ${path.basename(filePath)} != ${expectedFilename}`,
    );
  }
  return record;
}

function filterRegistryRecords(
  records: LocalServiceRegistryRecord[],
  filter?: { profileKind?: string; metadata?: Record<string, unknown> },
) {
  return records
    .filter((record) => {
      if (filter?.profileKind && record.profileKind !== filter.profileKind) return false;
      if (!filter?.metadata) return true;
      return Object.entries(filter.metadata).every(([key, value]) => record.metadata?.[key] === value);
    })
    .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
}

function assertUniqueStrictRegistryEvidence(records: LocalServiceRegistryRecord[]) {
  const recordsByRuntimeServiceId = new Map<string, LocalServiceRegistryRecord[]>();
  const recordsByServiceKey = new Map<string, LocalServiceRegistryRecord[]>();
  const recordsByPid = new Map<number, LocalServiceRegistryRecord[]>();
  const recordsByProcessIdentity = new Map<string, LocalServiceRegistryRecord[]>();
  const recordsByProcessGroup = new Map<number, LocalServiceRegistryRecord[]>();
  for (const record of records) {
    const serviceKeyMatches = recordsByServiceKey.get(record.serviceKey) ?? [];
    serviceKeyMatches.push(record);
    recordsByServiceKey.set(record.serviceKey, serviceKeyMatches);
    if (record.runtimeServiceId) {
      const matches = recordsByRuntimeServiceId.get(record.runtimeServiceId) ?? [];
      matches.push(record);
      recordsByRuntimeServiceId.set(record.runtimeServiceId, matches);
    }
    if (Number.isInteger(record.pid) && record.pid > 0) {
      const pidMatches = recordsByPid.get(record.pid) ?? [];
      pidMatches.push(record);
      recordsByPid.set(record.pid, pidMatches);
    }
    if (
      record.processGroupId !== null &&
      Number.isInteger(record.processGroupId) &&
      record.processGroupId > 0
    ) {
      const groupMatches = recordsByProcessGroup.get(record.processGroupId) ?? [];
      groupMatches.push(record);
      recordsByProcessGroup.set(record.processGroupId, groupMatches);
    }
    if (
      record.version === 2 &&
      record.processStartedAt &&
      record.processExecutable &&
      record.processCommandSha256
    ) {
      const identityKey = [
        record.pid,
        record.processStartedAt,
        record.processExecutable,
        record.processCommandSha256,
      ].join("\u0000");
      const identityMatches = recordsByProcessIdentity.get(identityKey) ?? [];
      identityMatches.push(record);
      recordsByProcessIdentity.set(identityKey, identityMatches);
    }
  }
  for (const [serviceKey, matches] of recordsByServiceKey) {
    if (matches.length <= 1) continue;
    throw new Error(`Duplicate local service registry evidence for service key ${serviceKey}`);
  }
  for (const [runtimeServiceId, matches] of recordsByRuntimeServiceId) {
    if (matches.length <= 1) continue;
    throw new Error(
      `Duplicate local service registry evidence for runtime service ${runtimeServiceId}: ${matches.map((record) => record.serviceKey).join(", ")}`,
    );
  }
  for (const [pid, matches] of recordsByPid) {
    if (matches.length <= 1) continue;
    throw new Error(
      `Duplicate local service registry pid ${pid}: ${matches.map((record) => record.serviceKey).join(", ")}`,
    );
  }
  for (const matches of recordsByProcessIdentity.values()) {
    if (matches.length <= 1) continue;
    throw new Error(
      `Duplicate local service registry process identity for pid ${matches[0]!.pid}: ${matches.map((record) => record.serviceKey).join(", ")}`,
    );
  }
  for (const [processGroupId, matches] of recordsByProcessGroup) {
    if (matches.length <= 1) continue;
    throw new Error(
      `Duplicate local service registry process group ${processGroupId}: ${matches.map((record) => record.serviceKey).join(", ")}`,
    );
  }
}

export function createLocalServiceKey(input: LocalServiceIdentityInput) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        companyId: input.companyId ?? null,
        profileKind: input.profileKind,
        serviceName: input.serviceName,
        cwd: path.resolve(input.cwd),
        command: input.command,
        envFingerprint: input.envFingerprint,
        port: input.port,
        scope: input.scope ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  return `${sanitizeServiceKeySegment(input.profileKind, "service")}-${sanitizeServiceKeySegment(input.serviceName, "service")}-${digest}`;
}

export async function writeLocalServiceRegistryRecord(
  record: LocalServiceRegistryRecord,
  options?: { mode?: "create" | "replace" },
) {
  const registryDir = getRuntimeServicesDir();
  const registryPath = getRuntimeServiceRegistryPath(record.serviceKey);
  const temporaryPath = path.resolve(
    registryDir,
    `.${path.basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to both umask and pre-existing directory modes.
  // The registry contains command/cwd and strong process identity, so enforce
  // the least-privileged mode on every write.
  await fs.chmod(registryDir, 0o700);
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(record, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.chmod(temporaryPath, 0o600);
    if (options?.mode === "create") {
      try {
        // Hard-linking a private temporary inode publishes the complete JSON
        // atomically and, unlike rename, can never replace existing evidence.
        await fs.link(temporaryPath, registryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
          throw new Error(
            `Local service registry already exists; refusing to overwrite evidence: ${record.serviceKey}`,
            { cause: error },
          );
        }
        throw error;
      }
      await fs.rm(temporaryPath, { force: true });
    } else {
      await fs.rename(temporaryPath, registryPath);
    }
    // A rename replaces the old inode, but keep this explicit for platforms
    // whose creation-mode semantics differ and for defense in depth.
    await fs.chmod(registryPath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeLocalServiceRegistryRecord(serviceKey: string) {
  await fs.rm(getRuntimeServiceRegistryPath(serviceKey), { force: true });
}

export async function readLocalServiceRegistryRecord(serviceKey: string) {
  return await safeReadRegistryRecord(getRuntimeServiceRegistryPath(serviceKey));
}

export async function listLocalServiceRegistryRecords(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const entries = await fs.readdir(getRuntimeServicesDir(), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => safeReadRegistryRecord(path.resolve(getRuntimeServicesDir(), entry.name))),
    );

    return filterRegistryRecords(
      records.filter((record): record is LocalServiceRegistryRecord => record !== null),
      filter,
    );
  } catch {
    return [];
  }
}

export async function listLocalServiceRegistryRecordsStrict(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(getRuntimeServicesDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw new Error(
      `Local service registry directory is unreadable: ${getRuntimeServicesDir()}`,
      { cause: error },
    );
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const record = await strictReadRegistryRecord(
          path.resolve(getRuntimeServicesDir(), entry.name),
        );
        if (!record) {
          throw new Error(`Local service registry unexpectedly disappeared: ${entry.name}`);
        }
        return record;
      }),
  );
  assertUniqueStrictRegistryEvidence(records);
  return filterRegistryRecords(records, filter);
}

export async function findLocalServiceRegistryRecordByRuntimeServiceId(input: {
  runtimeServiceId: string;
  profileKind?: string;
}) {
  const records = await listLocalServiceRegistryRecordsStrict(
    input.profileKind ? { profileKind: input.profileKind } : undefined,
  );
  const matches = records.filter((entry) => entry.runtimeServiceId === input.runtimeServiceId);
  if (matches.length > 1) {
    throw new Error(
      `Duplicate local service registry evidence for runtime service ${input.runtimeServiceId}`,
    );
  }
  const record = matches[0] ?? null;
  if (!record) return null;
  const verification = await verifyLocalServiceRegistryRecordIdentity(record);
  if (verification.kind === "not_running") {
    if (isProcessGroupAlive(record.processGroupId)) {
      throw new Error(
        `Local service registry leader ${record.pid} is not running but process group ${record.processGroupId} is still alive for ${record.serviceKey}`,
      );
    }
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }
  if (!(await doesLocalServiceRecordMatchCwd(record))) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }
  if (verification.kind !== "verified") {
    throw new Error(
      `Local service registry identity for ${record.serviceKey} is unproven: ${verification.reason}`,
    );
  }
  return record;
}

export function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    // ESRCH heisst: die Gruppe existiert nicht mehr. Jeder andere Fehler
    // (etwa EPERM) belegt, dass noch ein Prozess existiert.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return false;
    return true;
  }

  if (process.platform === "linux") {
    const liveMember = readLinuxProcessGroupActivity(processGroupId);
    if (liveMember !== null) return liveMember;
  }
  return true;
}

function readLinuxProcessGroupActivity(processGroupId: number): boolean | null {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }

  let foundMember = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = fsSync.readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) continue;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const state = fields[0];
      const memberProcessGroupId = Number.parseInt(fields[2] ?? "", 10);
      if (memberProcessGroupId !== processGroupId) continue;
      foundMember = true;
      if (state !== "Z" && state !== "X") return true;
    } catch {
      // The process can exit while /proc is scanned.
    }
  }

  // kill(-pgid, 0) also succeeds for a group that contains only zombies. Such
  // processes cannot run or own a listener and are waiting only for their
  // parent to reap them, so termination is complete for service-control use.
  return foundMember ? false : null;
}

function tokenizeCommandLine(value: string) {
  return value.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
}

function normalizeCommandToken(value: string) {
  const unquoted = value.replace(/^["']|["']$/g, "");
  const basename = path.basename(unquoted.replace(/\\/g, "/"));
  const launcher = basename.replace(/\.(?:cjs|mjs|js|cmd|exe)$/i, "");
  return /^(?:bun|node|nodejs|npm|npx|pnpm|yarn)$/i.test(launcher) ? launcher : unquoted;
}

/**
 * Return whether the configured shell command has a stable argv that can be
 * compared with the operating system's process command line.
 *
 * Managed local services are started through `shell -lc`. Once a command uses
 * shell control syntax, the surviving process-group leader can be the result of
 * that program rather than the configured shell expression. In that case a
 * literal argv comparison is not evidence that the process belongs to a
 * different service; adoption instead relies on the listener, process group,
 * and workspace cwd checks.
 */
export function isLocalServiceCommandLineComparable(recordedCommand: string) {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of recordedCommand) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ([";", "|", "&", "<", ">", "\n"].includes(character)) {
      return false;
    }
  }

  return true;
}

/**
 * Compare a configured service command with the argv exposed by the OS.
 *
 * Package-manager launchers commonly replace `pnpm dev` with
 * `node /path/to/pnpm.cjs dev` after the shell starts. A literal substring
 * check rejects that surviving process even though the executable and all
 * configured arguments are still present. Normalize executable paths and
 * script extensions, then require the configured argv to remain contiguous.
 */
export function doesLocalServiceCommandLineMatch(input: {
  commandLine: string;
  recordedCommand: string;
  serviceName: string;
}) {
  const normalize = (value: string) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  const normalizedCommandLine = normalize(input.commandLine);
  const normalizedRecordedCommand = normalize(input.recordedCommand);
  if (
    normalizedCommandLine.includes(normalizedRecordedCommand)
    || normalizedCommandLine.includes(input.serviceName)
  ) {
    return true;
  }

  const actualTokens = tokenizeCommandLine(input.commandLine).map(normalizeCommandToken);
  const recordedTokens = tokenizeCommandLine(input.recordedCommand).map(normalizeCommandToken);
  if (recordedTokens.length === 0 || recordedTokens.length > actualTokens.length) return false;

  return actualTokens.some((_, start) => recordedTokens.every(
    (token, offset) => actualTokens[start + offset] === token,
  ));
}

export async function verifyLocalServiceRegistryRecordIdentity(
  record: Pick<
    LocalServiceRegistryRecord,
    "pid" | "processGroupId" | "processStartedAt" | "processExecutable" | "processCommandSha256"
  >,
  verifier: typeof verifyStoredLocalProcessIdentity = verifyStoredLocalProcessIdentity,
): Promise<StoredLocalProcessIdentityVerification> {
  const processStartedAt = typeof record.processStartedAt === "string"
    ? new Date(record.processStartedAt)
    : null;
  return await verifier({
    processPid: record.pid,
    processGroupId: record.processGroupId,
    processStartedAt:
      processStartedAt && !Number.isNaN(processStartedAt.getTime()) ? processStartedAt : null,
    processExecutable: record.processExecutable ?? null,
    processCommandSha256: record.processCommandSha256 ?? null,
  });
}

export async function assertLocalServiceRegistryRecordIdentity(
  record: Pick<
    LocalServiceRegistryRecord,
    "pid" | "processGroupId" | "processStartedAt" | "processExecutable" | "processCommandSha256"
  >,
  verifier: typeof verifyStoredLocalProcessIdentity = verifyStoredLocalProcessIdentity,
) {
  const verification = await verifyLocalServiceRegistryRecordIdentity(record, verifier);
  if (verification.kind !== "verified") {
    throw new Error(
      `Local service process identity is not verified: ${
        verification.kind === "unproven" ? verification.reason : "not_running"
      }`,
    );
  }
}

export async function findAdoptableLocalService(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
}) {
  const record = await readLocalServiceRegistryRecord(input.serviceKey);
  if (!record) return null;

  const verification = await verifyLocalServiceRegistryRecordIdentity(record);
  if (verification.kind === "not_running") {
    // Tolerant callers may decline adoption, but a live detached group is still
    // material evidence. Preserve it for strict reconciliation/cleanup.
    if (isProcessGroupAlive(record.processGroupId)) return null;
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (verification.kind !== "verified") return null;
  if (!(await doesLocalServiceRecordMatchCwd(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (input.command && record.command !== input.command) return null;
  if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
  if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
  if (input.port !== undefined && input.port !== null && record.port !== input.port) return null;
  return record;
}

export async function readLocalServiceProcessGroupId(pid: number) {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function isLocalServiceProcessOwnedBy(pid: number, ownerProcessId: number) {
  if (pid === ownerProcessId) return true;
  if (process.platform !== "win32") {
    return (await readLocalServiceProcessGroupId(pid)) === ownerProcessId;
  }

  try {
    const script = [
      `$currentProcessId = ${pid}`,
      "while ($currentProcessId -gt 0) {",
      "  $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $currentProcessId\" -ErrorAction SilentlyContinue",
      "  if ($null -eq $process) { break }",
      "  $parentProcessId = [int]$process.ParentProcessId",
      "  Write-Output $parentProcessId",
      "  if ($parentProcessId -eq $currentProcessId) { break }",
      "  $currentProcessId = $parentProcessId",
      "}",
    ].join("\n");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .some((ancestorPid) => ancestorPid === ownerProcessId);
  } catch {
    return false;
  }
}

export async function findAdoptableLocalServiceStrict(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
}) {
  const record = await strictReadRegistryRecord(
    getRuntimeServiceRegistryPath(input.serviceKey),
    { allowMissing: true },
  );
  if (!record) return null;

  const verification = await verifyLocalServiceRegistryRecordIdentity(record);
  if (verification.kind === "not_running") {
    if (isProcessGroupAlive(record.processGroupId)) {
      throw new Error(
        `Local service registry leader ${record.pid} is not running but process group ${record.processGroupId} is still alive for ${record.serviceKey}`,
      );
    }
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (verification.kind !== "verified") {
    throw new Error(
      `Local service registry identity for ${record.serviceKey} is unproven: ${verification.reason}`,
    );
  }
  const identityMismatch =
    (input.profileKind && record.profileKind !== input.profileKind) ||
    (input.serviceName && record.serviceName !== input.serviceName) ||
    (input.command && record.command !== input.command) ||
    (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) ||
    (input.envFingerprint && record.envFingerprint !== input.envFingerprint) ||
    (input.port !== undefined && input.port !== null && record.port !== input.port);
  if (identityMismatch) {
    throw new Error(
      `Local service registry ${record.serviceKey} does not match its expected reconciliation identity`,
    );
  }
  return record;
}

export async function touchLocalServiceRegistryRecord(
  serviceKey: string,
  patch?: Partial<Omit<LocalServiceRegistryRecord, "serviceKey" | "version">>,
) {
  const existing = await readLocalServiceRegistryRecord(serviceKey);
  if (!existing) return null;
  const next: LocalServiceRegistryRecord = {
    ...existing,
    ...patch,
    version: existing.version,
    serviceKey,
    lastSeenAt: patch?.lastSeenAt ?? new Date().toISOString(),
  };
  await writeLocalServiceRegistryRecord(next);
  return next;
}

export async function terminateLocalService(
  record: Pick<LocalServiceRegistryRecord, "pid" | "processGroupId"> &
    Partial<Pick<LocalServiceRegistryRecord, "port">>,
  opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    verifyBeforeSignal?: () => Promise<void>;
    signalWithinFence?: (
      signal: NodeJS.Signals,
      sendSignal: () => void,
    ) => Promise<void>;
  },
) {
  const signal = opts?.signal ?? "SIGTERM";
  const targetProcessGroup = process.platform !== "win32" && record.processGroupId && record.processGroupId > 0;

  const targetIsGone = async () => {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(record.processGroupId)
      : isPidAlive(record.pid);
    if (targetAlive) return false;
    if (!record.port) return true;
    const portOwnerPid = await readLocalServicePortOwner(record.port);
    if (!portOwnerPid) return true;
    const ownerProcessId = targetProcessGroup ? record.processGroupId! : record.pid;
    return !(await isLocalServiceProcessOwnedBy(portOwnerPid, ownerProcessId));
  };

  const waitUntilGone = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await targetIsGone()) return true;
      await delay(100);
    } while (Date.now() < deadline);
    return await targetIsGone();
  };

  const sendSignal = async (nextSignal: NodeJS.Signals) => {
    let attempted = false;
    let delivered = false;
    const send = () => {
      if (attempted) throw new Error("Local service signal fence attempted the same signal more than once");
      attempted = true;
      try {
        if (targetProcessGroup) {
          process.kill(-record.processGroupId!, nextSignal);
        } else {
          process.kill(record.pid, nextSignal);
        }
        delivered = true;
      } catch (error) {
        delivered = false;
        throw new Error(
          `Local service signal ${nextSignal} was not delivered to the exact ${
            targetProcessGroup ? `process group ${record.processGroupId}` : `pid ${record.pid}`
          }`,
          { cause: error },
        );
      }
    };

    if (opts?.signalWithinFence) {
      // Fence-Pfad (Fork): Identitaet ist bewiesen, ein fehlgeschlagenes Signal ist ein Fehler.
      await opts.signalWithinFence(nextSignal, send);
      if (!attempted) {
        throw new Error("Local service signal fence returned without sending its authorized signal");
      }
    } else {
      await opts?.verifyBeforeSignal?.();
      try {
        send();
      } catch (error) {
        // Ohne Fence (Upstream-Aufrufer): ein bereits beendeter Prozess ist kein Fehler.
        const code = ((error as Error & { cause?: NodeJS.ErrnoException }).cause)?.code;
        if (code === "ESRCH") return false;
        throw error;
      }
    }
    return delivered;
  };

  if (!opts?.signalWithinFence && await targetIsGone()) return;
  if (!(await sendSignal(signal))) return;

  const deadline = Date.now() + (opts?.forceAfterMs ?? 2_000);
  while (Date.now() < deadline) {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(record.processGroupId)
      : isPidAlive(record.pid);
    if (!targetAlive) {
      return;
    }
    await delay(100);
  }

  const stillAlive = targetProcessGroup
    ? isProcessGroupAlive(record.processGroupId)
    : isPidAlive(record.pid);
  if (!stillAlive) return;
  await sendSignal("SIGKILL");
}

export async function readLocalServicePortOwner(port: number) {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-anv", "-p", "tcp"]);
      const portSuffix = new RegExp(`[.:]${port}$`);
      for (const line of stdout.split("\n")) {
        const columns = line.trim().split(/\s+/);
        if (!columns[0]?.startsWith("tcp") || columns[5] !== "LISTEN") continue;
        if (!portSuffix.test(columns[3] ?? "")) continue;
        const processColumn = columns.find((column) => /:\d+$/.test(column));
        const pid = processColumn ? Number.parseInt(processColumn.slice(processColumn.lastIndexOf(":") + 1), 10) : NaN;
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    } catch {
      return null;
    }
  }
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"]);
      for (const line of stdout.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
        const localAddress = columns[1] ?? "";
        const separatorIndex = localAddress.lastIndexOf(":");
        const localPort = Number.parseInt(localAddress.slice(separatorIndex + 1), 10);
        const state = columns.at(-2)?.toUpperCase();
        const pid = Number.parseInt(columns.at(-1) ?? "", 10);
        if (localPort === port && state === "LISTENING" && Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
      return null;
    }
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const firstPid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value > 0);
    return firstPid ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a running process's working directory.
 *
 * Linux reads it straight off procfs. macOS has no procfs, so it asks `lsof`
 * for the process's `cwd` descriptor — the same tool this module already shells
 * out to for port ownership, so this adds no new dependency. `-d cwd` narrows
 * the output to the working directory.
 *
 * `-F0n` terminates each field with NUL instead of a newline. The parser does
 * not trim the path or split it on newlines. That matters because the caller
 * compares this value against a workspace root: a directory name may contain
 * leading or trailing spaces, or even a newline, and changing the path would
 * report a different directory than the one the process runs in.
 *
 * Returning a real path on macOS is what lets `adoptLocalServiceFromPortOwner`
 * verify a listener actually belongs to the workspace. While this returned
 * null off Linux, that check could never pass, so port-owner adoption always
 * failed there and still-running services were reconciled to `stopped`.
 */
export async function readLocalServiceProcessCwd(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-F0n"]);
      // Each field ends with NUL. The newline that ends a field set carries
      // into the next field, so drop it before reading the `n` tag; anything
      // after the tag is the path exactly as lsof reported it.
      const cwdField = stdout
        .split("\0")
        .map((field) => field.replace(/^\n+/, ""))
        .find((field) => field.startsWith("n"));
      return cwdField ? cwdField.slice(1) || null : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function isLocalServiceProcessInWorkspace(processCwd: string, workspaceCwd: string) {
  try {
    const [resolvedProcessCwd, resolvedWorkspaceCwd] = await Promise.all([
      fs.realpath(processCwd),
      fs.realpath(workspaceCwd),
    ]);
    const relativePath = path.relative(resolvedWorkspaceCwd, resolvedProcessCwd);
    return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
  } catch {
    return false;
  }
}

export async function isLocalServiceRegistryCwdCompatible(processCwd: string | null, workspaceCwd: string) {
  if (!processCwd) return process.platform !== "linux" && process.platform !== "darwin";
  return isLocalServiceProcessInWorkspace(processCwd, workspaceCwd);
}

async function doesLocalServiceRecordMatchCwd(record: LocalServiceRegistryRecord) {
  if (!record.port) return true;
  const ownerPid = await readLocalServicePortOwner(record.port);
  if (!ownerPid) return false;
  if (!(await isLocalServiceProcessOwnedBy(ownerPid, record.processGroupId ?? record.pid))) {
    return false;
  }
  const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
  return isLocalServiceRegistryCwdCompatible(ownerCwd, record.cwd);
}

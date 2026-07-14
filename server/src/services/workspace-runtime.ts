import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterRuntimeServiceReport } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  executionWorkspaces,
  projectWorkspaces,
  workspaceRuntimeServices,
  workspaceRuntimeStartClaims,
} from "@paperclipai/db";
import {
  listWorkspaceServiceCommandDefinitions,
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type WorkspaceRuntimeDesiredState,
  type WorkspaceRuntimeServiceStateMap,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { asNumber, asString, parseObject, renderTemplate } from "../adapters/utils.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import {
  assertLocalServiceRegistryRecordIdentity,
  createLocalServiceKey,
  findAdoptableLocalServiceStrict,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  isPidAlive,
  isProcessGroupAlive,
  listLocalServiceRegistryRecordsStrict,
  readLocalServicePortOwner,
  removeLocalServiceRegistryRecord,
  terminateLocalService,
  touchLocalServiceRegistryRecord,
  verifyLocalServiceRegistryRecordIdentity,
  writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "./local-service-supervisor.js";
import {
  captureSpawnedLocalProcessIdentity,
  verifyStoredLocalProcessIdentity,
  type LocalProcessIdentity,
} from "./local-process-identity.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";
import { readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { isHistoricalAgentTombstoneId } from "./agent-retirement-historical-tombstones.js";
import { lockAgentLifecycleReference } from "./agent-lifecycle-fence.js";
import { withAgentStartLock } from "./agent-start-lock.js";
import { logger } from "../middleware/logger.js";
import {
  failWorkspaceRuntimeStartClaim,
  finalizeWorkspaceRuntimeStartClaim,
  lockWorkspaceRuntimeStartClaimFence,
  reserveWorkspaceRuntimeStartClaim,
  terminalizeWorkspaceRuntimeStartClaim,
  waitForWorkspaceRuntimeStartClaim,
} from "./workspace-runtime-start-claims.js";

export function resolveShell(): string {
  const fallback = process.platform === "win32" ? "sh" : "/bin/sh";
  const shell = process.env.SHELL?.trim();
  if (!shell) return fallback;
  if (path.isAbsolute(shell) && !existsSync(shell)) return fallback;
  return shell;
}

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  workMode?: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string | null;
  name: string;
  companyId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
  baseRefSha?: string | null;
}

export class WorkspaceRuntimeValidationFailure extends Error {
  code = "workspace_validation_failed" as const;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceRuntimeValidationFailure";
    this.resultJson = resultJson;
  }
}

export interface RuntimeServiceRef {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  reused: boolean;
}

interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
  serviceKey: string;
  profileKind: string;
  processGroupId: number | null;
  startClaimId?: string | null;
  startFinalizationState?: "pending" | "running" | "terminalizing";
  exitLatch?: {
    exit: { code: number | null; signal: NodeJS.Signals | null; at: string } | null;
  } | null;
  processIdentity?: LocalProcessIdentity | null;
  ownerLifecycleStatusAtStart?: string | null;
}

type StoppedRuntimeServiceReuseCandidate = {
  id: string;
  port: number | null;
};

const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
const runtimeServicesByReuseKey = new Map<string, string>();
const runtimeServiceLeasesByRun = new Map<string, string[]>();
const DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES = 256 * 1024;

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

export async function resetRuntimeServicesForTests() {
  for (const record of runtimeServicesById.values()) {
    clearIdleTimer(record);
  }
  runtimeServicesById.clear();
  runtimeServicesByReuseKey.clear();
  runtimeServiceLeasesByRun.clear();
}

function runtimeServiceReuseMapKey(companyId: string, reuseKey: string) {
  return `${companyId}\u0000${reuseKey}`;
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

type WorkspaceLinkMismatch = {
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findWorkspaceRoot(startCwd: string) {
  let current = path.resolve(startCwd);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isLinkedGitWorktreeCheckout(rootDir: string) {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    if (!existsSync(dirPath)) return;

    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

function findServerWorkspaceLinkMismatches(rootDir: string): WorkspaceLinkMismatch[] {
  const serverPackageJsonPath = path.join(rootDir, "server", "package.json");
  if (!existsSync(serverPackageJsonPath)) return [];

  const serverPackageJson = readJsonFile(serverPackageJsonPath);
  const dependencies = {
    ...(serverPackageJson.dependencies as Record<string, unknown> | undefined),
    ...(serverPackageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;
    const normalizedExpectedPath = existsSync(expectedPath) ? path.resolve(realpathSync(expectedPath)) : path.resolve(expectedPath);

    const linkPath = path.join(rootDir, "server", "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === normalizedExpectedPath) continue;

    mismatches.push({
      packageName,
      expectedPath: normalizedExpectedPath,
      actualPath,
    });
  }

  return mismatches;
}

export async function ensureServerWorkspaceLinksCurrent(
  startCwd: string,
  opts?: {
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  const workspaceRoot = findWorkspaceRoot(startCwd);
  if (!workspaceRoot) return;
  if (!isLinkedGitWorktreeCheckout(workspaceRoot)) return;

  const mismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (mismatches.length === 0) return;

  if (opts?.onLog) {
    await opts.onLog("stdout", "[runtime] detected stale workspace package links for server; relinking dependencies...\n");
    for (const mismatch of mismatches) {
      await opts.onLog(
        "stdout",
        `[runtime]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}\n`,
      );
    }
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(workspaceRoot, "server", "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all server package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

function stableRuntimeServiceId(input: {
  adapterType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.reportId)) {
    return input.reportId.toLowerCase();
  }
  const digest = createHash("sha256")
    .update(
      stableStringify({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        reportId: input.reportId,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  // workspace_runtime_services.id is UUID-backed. Keep adapter-derived ids
  // deterministic while setting the UUID version/variant bits explicitly.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "paperclip-work";
}

function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

function formatCommandForDisplay(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout.append(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
  };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

function formatShortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "unknown";
}

function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

function parseRemoteTrackingRef(ref: string): { remote: string; branch: string } | null {
  const trimmed = ref.trim();
  const refsRemotesPrefix = "refs/remotes/";
  const normalized = trimmed.startsWith(refsRemotesPrefix)
    ? trimmed.slice(refsRemotesPrefix.length)
    : trimmed;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) return null;
  const remote = normalized.slice(0, slashIndex);
  const branch = normalized.slice(slashIndex + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  return { remote, branch };
}

async function refreshRemoteTrackingBaseRef(repoRoot: string, baseRef: string): Promise<string[]> {
  const remoteTracking = parseRemoteTrackingRef(baseRef);
  if (!remoteTracking) return [];

  const remoteExists = await runGit(["remote", "get-url", remoteTracking.remote], repoRoot)
    .then(() => true)
    .catch(() => false);
  if (!remoteExists) return [];

  try {
    await runGit([
      "fetch",
      "--prune",
      remoteTracking.remote,
      `+refs/heads/${remoteTracking.branch}:refs/remotes/${remoteTracking.remote}/${remoteTracking.branch}`,
    ], repoRoot);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Could not refresh base ref ${baseRef} before preparing the execution workspace: ${message}`];
  }
}

async function resolveBaseRefSha(repoRoot: string, baseRef: string): Promise<string | null> {
  return await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot).catch(() => null);
}

function readRecordedBaseRefSha(metadata: Record<string, unknown> | null | undefined): string | null {
  const snapshot = parseObject(metadata?.baseRefSnapshot);
  const resolvedSha = snapshot.resolvedSha;
  return typeof resolvedSha === "string" && resolvedSha.trim().length > 0 ? resolvedSha.trim() : null;
}

export async function inspectExecutionWorkspaceBaseDrift(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string | null;
  recordedBaseRefSha?: string | null;
  skipRefresh?: boolean;
}): Promise<{
  warnings: string[];
  currentBaseRefSha: string | null;
  branchBaseRefSha: string | null;
}> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    return { warnings: [], currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const warnings = input.skipRefresh ? [] : await refreshRemoteTrackingBaseRef(input.repoRoot, baseRef);
  const currentBaseRefSha = await resolveBaseRefSha(input.repoRoot, baseRef);
  if (!currentBaseRefSha) {
    warnings.push(`Could not resolve base ref ${baseRef} while checking execution workspace freshness.`);
    return { warnings, currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const branchBaseRefSha = await runGit(["merge-base", "HEAD", baseRef], input.worktreePath).catch(() => null);
  if (!branchBaseRefSha) {
    warnings.push(`Could not compare execution workspace ${input.branchName ?? "branch"} against base ref ${baseRef}.`);
    return { warnings, currentBaseRefSha, branchBaseRefSha: null };
  }

  if (branchBaseRefSha !== currentBaseRefSha) {
    const behindCountRaw = await runGit(["rev-list", "--count", `HEAD..${baseRef}`], input.worktreePath).catch(() => "");
    const behindCount = Number.parseInt(behindCountRaw, 10);
    const behindText = Number.isFinite(behindCount) && behindCount > 0
      ? `${behindCount} commit${behindCount === 1 ? "" : "s"}`
      : "newer commits";
    const recordedText = input.recordedBaseRefSha
      ? `recorded base ${formatShortSha(input.recordedBaseRefSha)}`
      : `merge-base ${formatShortSha(branchBaseRefSha)}`;
    warnings.push(
      `Execution workspace branch ${input.branchName ? `"${input.branchName}"` : "HEAD"} is behind ${baseRef} by ${behindText}: ${recordedText}, current base ${formatShortSha(currentBaseRefSha)}. Refresh or rebase the workspace before relying on recent base-branch fixes.`,
    );
  }

  return { warnings, currentBaseRefSha, branchBaseRefSha };
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
    .then(() => true)
    .catch(() => false);
}

async function remoteExists(repoRoot: string, remote: string): Promise<boolean> {
  return runGit(["remote", "get-url", remote], repoRoot)
    .then(() => true)
    .catch(() => false);
}

const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

function fingerprintWorkspaceBranchIncoherence(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

async function inspectGitWorktreeBranchIncoherence(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const plainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const eligible = cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const safeRepairReason = eligible
    ? "clean worktree and expected branch points at the current HEAD"
    : cleanliness !== "clean"
      ? "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
      : !registeredBranchMatchesHead
        ? "registered worktree branch does not match HEAD"
      : !expectedBranchExists
        ? "expected branch does not exist"
        : !sameHead
          ? "expected branch and current HEAD differ"
          : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    sourceIssueId: input.sourceIssue?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    sourceIssueId: input.sourceIssue?.id ?? null,
    sourceIdentifier: input.sourceIssue?.identifier ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    statusEntryCount: statusLines?.length ?? null,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  return new WorkspaceRuntimeValidationFailure(
    `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`,
    {
      workspaceValidation: evidence,
    },
  );
}

export async function ensureGitWorktreeBranchCoherent(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return;

  const currentBranch = input.actualBranchName !== undefined
    ? input.actualBranchName
    : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) return;

  const evidence = await inspectGitWorktreeBranchIncoherence({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
  });

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["checkout", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceIssueId: evidence.sourceIssueId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
    .catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = "clean worktree checked out the recorded branch";
}

// Resolve the authoritative base ref for a fresh worktree. A configured local
// branch is mapped to its `origin/<branch>` counterpart so unpushed local
// divergence never leaks into the task branch; remote-tracking refs, SHAs, and
// tags are used verbatim, and an unset/`HEAD` base falls back to the detected
// default branch (which already prefers `origin/master`).
async function resolveAuthoritativeBaseRef(
  repoRoot: string,
  configuredBaseRef: string | null,
): Promise<{ baseRef: string; warnings: string[]; refreshed: boolean }> {
  const warnings: string[] = [];
  const detectOrHead = async () => (await detectDefaultBranch(repoRoot)) ?? "HEAD";

  const configured = configuredBaseRef?.trim();
  if (!configured || configured === "HEAD") {
    return { baseRef: await detectOrHead(), warnings, refreshed: false };
  }

  if (parseRemoteTrackingRef(configured)) {
    return { baseRef: configured, warnings, refreshed: false };
  }

  if (await localBranchExists(repoRoot, configured)) {
    const remoteCandidate = `origin/${configured}`;
    // Refresh here and keep the warnings; the caller skips its own refresh of
    // the returned ref (see `refreshed`) so we never fetch the same ref twice.
    warnings.push(...await refreshRemoteTrackingBaseRef(repoRoot, remoteCandidate));
    if (await resolveBaseRefSha(repoRoot, remoteCandidate)) {
      return { baseRef: remoteCandidate, warnings, refreshed: true };
    }
    if (await remoteExists(repoRoot, "origin")) {
      warnings.push(
        `Configured base ref "${configured}" is a local branch with no matching origin/${configured}; basing the execution workspace on the local ref, which may include unpushed commits.`,
      );
    }
    return { baseRef: configured, warnings, refreshed: false };
  }

  return { baseRef: configured, warnings, refreshed: false };
}

// Auto-refresh a reused worktree to the latest base only when it is provably
// unstarted: no task commits past the base and a clean tree (including untracked
// files). This pulls an idle worktree forward to the freshest `origin/master`
// after a long planning phase without ever destroying in-progress work. Only
// remote-tracking bases are eligible; local-only bases keep warn-only drift.
async function refreshUnstartedWorktreeToBase(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string;
  currentBaseRefSha: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ refreshed: boolean; baseRefSha: string | null }> {
  if (!parseRemoteTrackingRef(input.baseRef)) {
    return { refreshed: false, baseRefSha: null };
  }

  const headSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  if (!headSha) {
    return { refreshed: false, baseRefSha: null };
  }
  if (headSha === input.currentBaseRefSha) {
    return { refreshed: false, baseRefSha: input.currentBaseRefSha };
  }

  const commitsPastBaseRaw = await runGit(
    ["rev-list", "--count", `${input.currentBaseRefSha}..HEAD`],
    input.worktreePath,
  ).catch(() => null);
  const commitsPastBase = commitsPastBaseRaw === null ? null : Number.parseInt(commitsPastBaseRaw, 10);
  if (commitsPastBase === null || !Number.isFinite(commitsPastBase) || commitsPastBase > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  // Force `--untracked-files=all` so untracked files are counted regardless of a
  // local `status.showUntrackedFiles=no`; otherwise the clean-tree guard could
  // pass and the `reset --hard` below would destroy untracked work.
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    input.worktreePath,
  ).catch(() => null);
  if (status === null || status.trim().length > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  await recordGitOperation(input.recorder, {
    phase: "worktree_prepare",
    args: ["reset", "--hard", input.currentBaseRefSha],
    cwd: input.worktreePath,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      previousHeadSha: headSha,
      baseRefSha: input.currentBaseRefSha,
      refreshedUnstartedWorktree: true,
    },
    successMessage: `Refreshed unstarted git worktree at ${input.worktreePath} to ${input.baseRef} (${formatShortSha(input.currentBaseRefSha)})\n`,
    failureLabel: `git reset --hard ${input.currentBaseRefSha}`,
  });

  return { refreshed: true, baseRefSha: input.currentBaseRefSha };
}


type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

export type ManagedGitWorktreeBranchInspection = {
  valid: boolean;
  reason: string | null;
  reasonCode:
    | "missing_worktree"
    | "not_a_git_checkout"
    | "not_registered"
    | "wrong_repository_root"
    | "branch_mismatch"
    | null;
  repoRoot: string | null;
  worktreePath: string;
  expectedBranchName: string | null;
  actualBranchName: string | null;
};

function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

async function resolveGitOwnerRepoRoot(cwd: string): Promise<string> {
  const checkoutRoot = path.resolve(await runGit(["rev-parse", "--show-toplevel"], cwd));
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], checkoutRoot).catch(() => null);
  if (!commonDir) return checkoutRoot;
  return path.dirname(path.resolve(checkoutRoot, commonDir));
}

async function findRegisteredGitWorktreeByBranch(repoRoot: string, branchName: string): Promise<string | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedBranchRef = `refs/heads/${branchName}`;
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (entry.branch !== expectedBranchRef) continue;
    return path.resolve(entry.worktree);
  }

  return null;
}

async function findRegisteredGitWorktreeByPath(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (await resolvePathForWorktreeComparison(entry.worktree) === expectedPath) {
      return entry;
    }
  }
  return null;
}

async function isGitCheckout(cwd: string): Promise<boolean> {
  return Boolean(await runGit(["rev-parse", "--git-dir"], cwd).catch(() => null));
}

async function detectDefaultBranch(repoRoot: string): Promise<string | null> {
  const originMasterRef = "origin/master";
  await refreshRemoteTrackingBaseRef(repoRoot, originMasterRef);
  if (await resolveBaseRefSha(repoRoot, originMasterRef)) {
    return originMasterRef;
  }

  // Try the explicit remote HEAD first (set by git clone or git remote set-head)
  try {
    const remoteHead = await runGit(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    if (remoteHead) {
      await refreshRemoteTrackingBaseRef(repoRoot, remoteHead);
      if (await resolveBaseRefSha(repoRoot, remoteHead)) return remoteHead;
    }
  } catch {
    // Not set — fall through to heuristic
  }

  // Fallback: check for common default branch names on the remote
  for (const candidate of ["origin/master", "origin/main", "main", "master"]) {
    try {
      await refreshRemoteTrackingBaseRef(repoRoot, candidate);
      await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot);
      return candidate;
    } catch {
      // Not found — try next
    }
  }

  return null;
}

async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).then((realPath) => path.resolve(realPath)).catch(() => resolved);
}

async function listLinkedGitWorktreePaths(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length).trim();
    if (!worktree) continue;
    paths.add(await resolvePathForWorktreeComparison(worktree));
  }
  return paths;
}

export async function inspectManagedGitWorktreeBranch(input: {
  worktreePath: string;
  expectedBranchName: string | null | undefined;
  repoRoot?: string | null;
}): Promise<ManagedGitWorktreeBranchInspection> {
  const worktreePath = await resolvePathForWorktreeComparison(input.worktreePath);
  const expectedBranchName = asString(input.expectedBranchName, "").trim() || null;
  const base = {
    worktreePath,
    expectedBranchName,
    actualBranchName: null,
  };

  if (!await directoryExists(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: `worktree path "${worktreePath}" does not exist`,
      reasonCode: "missing_worktree",
      repoRoot: input.repoRoot ? path.resolve(input.repoRoot) : null,
    };
  }

  const repoRoot = input.repoRoot
    ? path.resolve(input.repoRoot)
    : await resolveGitOwnerRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) {
    return {
      ...base,
      valid: false,
      reason: "path is not a git checkout",
      reasonCode: "not_a_git_checkout",
      repoRoot: null,
    };
  }

  const listedWorktrees = await listLinkedGitWorktreePaths(repoRoot).catch(() => null);
  if (!listedWorktrees?.has(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: "path is not registered in `git worktree list`",
      reasonCode: "not_registered",
      repoRoot,
    };
  }

  const worktreeTopLevel = await runGit(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!worktreeTopLevel || path.resolve(worktreeTopLevel) !== worktreePath) {
    return {
      ...base,
      valid: false,
      reason: "git resolves this path to a different repository root",
      reasonCode: "wrong_repository_root",
      repoRoot,
    };
  }

  const actualBranchName = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    worktreePath,
  ).catch(() => null);
  if (expectedBranchName && actualBranchName !== expectedBranchName) {
    return {
      ...base,
      valid: false,
      reason: `worktree HEAD is on "${actualBranchName ?? "<detached>"}" instead of "${expectedBranchName}"`,
      reasonCode: "branch_mismatch",
      repoRoot,
      actualBranchName,
    };
  }

  return {
    ...base,
    valid: true,
    reason: null,
    reasonCode: null,
    repoRoot,
    actualBranchName,
  };
}

async function validateLinkedGitWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
}): Promise<
  | { valid: true }
  | {
    valid: false;
    reason: string;
    reasonCode: Exclude<ManagedGitWorktreeBranchInspection["reasonCode"], null>;
    actualBranchName?: string | null;
  }
> {
  const inspection = await inspectManagedGitWorktreeBranch({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
  });
  return inspection.valid
    ? { valid: true }
    : {
        valid: false,
        reason: inspection.reason ?? "unknown git worktree mismatch",
        reasonCode: inspection.reasonCode ?? "not_a_git_checkout",
        actualBranchName: inspection.actualBranchName,
      };
}

export function formatManagedGitWorktreeBranchInspection(input: ManagedGitWorktreeBranchInspection) {
  return {
    valid: input.valid,
    reason: input.reason,
    reasonCode: input.reasonCode,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
  };
}

async function terminateSpawnedChildProcessClosed(input: {
  child: ChildProcess;
  processIdentity: LocalProcessIdentity;
  db?: Db;
  companyId: string;
  ownerAgentId: string | null;
  owner: RuntimeOwnerSnapshot | null;
  serviceKey: string;
  runtimeServiceId: string;
  startClaimId: string | null;
  profileKind: string;
  terminate: typeof terminateLocalService;
  ownerStartLockHeld: boolean;
}) {
  try {
    const snapshot = await capturePrePersistRuntimeSignalSnapshot(input);
    await input.terminate({
      pid: input.processIdentity.pid,
      processGroupId: input.processIdentity.processGroupId,
    }, {
      signalWithinFence: async (_signal, sendSignal) => {
        await sendPrePersistRuntimeSignal({
          db: input.db,
          expected: snapshot,
          ownerStartLockHeld: input.ownerStartLockHeld,
          sendSignal,
        });
      },
    });
    await waitForExactLocalProcessExit({
      pid: input.processIdentity.pid,
      processGroupId: input.processIdentity.processGroupId,
      label: "Spawned runtime process",
    });
  } catch (error) {
    throw new RuntimeCleanupQuarantinedError(
      `Spawned runtime process ${input.processIdentity.pid} cleanup was quarantined before exact exit proof`,
      error,
    );
  }
}

function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PAPERCLIP_WORKSPACE_CWD = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_BRANCH = input.branchName;
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.PAPERCLIP_WORKSPACE_SOURCE = input.base.source;
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.PAPERCLIP_PROJECT_ID = input.base.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.PAPERCLIP_AGENT_ID = input.agent.id ?? "";
  env.PAPERCLIP_AGENT_NAME = input.agent.name;
  env.PAPERCLIP_COMPANY_ID = input.agent.companyId;
  env.PAPERCLIP_ISSUE_ID = input.issue?.id ?? "";
  env.PAPERCLIP_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.PAPERCLIP_ISSUE_TITLE = input.issue?.title ?? "";
  env.PAPERCLIP_ISSUE_WORK_MODE = input.issue?.workMode ?? "";
  return env;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveRepoManagedWorkspaceCommand(command: string, repoRoot: string) {
  const patterns = [
    /^(?<prefix>(?:bash|sh|zsh)\s+)(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
    /^(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (!match?.groups) continue;

    const relativePath = match.groups.relative;
    const repoManagedPath = path.join(repoRoot, relativePath.slice(2));
    if (!existsSync(repoManagedPath)) continue;

    const prefix = match.groups.prefix ?? "";
    const suffix = match.groups.suffix ?? "";
    return `${prefix}${quoteShellArg(repoManagedPath)}${suffix}`;
  }

  return command;
}

async function runWorkspaceCommand(input: {
  command: string;
  resolvedCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}) {
  const shell = resolveShell();
  const proc = await executeProcess({
    command: shell,
    args: ["-c", input.resolvedCommand ?? input.command],
    cwd: input.cwd,
    env: input.env,
  });
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}

async function recordGitOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "worktree_prepare" | "worktree_cleanup";
    args: string[];
    cwd: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    failureLabel?: string | null;
  },
): Promise<string> {
  if (!recorder) {
    return runGit(input.args, input.cwd);
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  await recorder.recordOperation({
    phase: input.phase,
    command: formatCommandForDisplay("git", input.args),
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const result = await executeProcess({
        command: "git",
        args: input.args,
        cwd: input.cwd,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      details.length > 0
        ? `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed: ${details}`
        : `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed with exit code ${code ?? -1}`,
    );
  }
  return stdout.trim();
}

async function recordWorkspaceCommandOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "workspace_provision" | "workspace_teardown";
    command: string;
    resolvedCommand?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
  },
) {
  if (!recorder) {
    await runWorkspaceCommand(input);
    return null;
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  const operation = await recorder.recordOperation({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const shell = resolveShell();
      const result = await executeProcess({
        command: shell,
        args: ["-c", input.resolvedCommand ?? input.command],
        cwd: input.cwd,
        env: input.env,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code === 0) return operation;

  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${code ?? -1}`,
  );
}

async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const provisionCommand = asString(input.strategy.provisionCommand, "").trim();
  if (!provisionCommand) return;
  const resolvedProvisionCommand = resolveRepoManagedWorkspaceCommand(provisionCommand, input.repoRoot);

  await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: provisionCommand,
    resolvedCommand: resolvedProvisionCommand,
    cwd: input.worktreePath,
    env: buildWorkspaceCommandEnv({
      base: input.base,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      issue: input.issue,
      agent: input.agent,
      created: input.created,
    }),
    label: `Execution workspace provision command "${provisionCommand}"`,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      created: input.created,
      resolvedCommand: resolvedProvisionCommand === provisionCommand ? null : resolvedProvisionCommand,
    },
    successMessage: `Provisioned workspace at ${input.worktreePath}\n`,
  });
}

function buildExecutionWorkspaceCleanupEnv(input: {
  workspace: {
    cwd: string | null;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
  };
  projectWorkspaceCwd?: string | null;
}) {
  const env: NodeJS.ProcessEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  env.PAPERCLIP_WORKSPACE_CWD = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_PATH = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH =
    input.workspace.providerRef ?? input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_BRANCH = input.workspace.branchName ?? "";
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.workspace.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.workspace.baseRef ?? "";
  env.PAPERCLIP_PROJECT_ID = input.workspace.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.workspace.projectWorkspaceId ?? "";
  env.PAPERCLIP_ISSUE_ID = input.workspace.sourceIssueId ?? "";
  return env;
}

async function resolveGitRepoRootForWorkspaceCleanup(
  worktreePath: string,
  projectWorkspaceCwd: string | null,
): Promise<string | null> {
  if (projectWorkspaceCwd) {
    const resolvedProjectWorkspaceCwd = path.resolve(projectWorkspaceCwd);
    const gitDir = await runGit(["rev-parse", "--git-common-dir"], resolvedProjectWorkspaceCwd)
      .catch(() => null);
    if (gitDir) {
      const resolvedGitDir = path.resolve(resolvedProjectWorkspaceCwd, gitDir);
      return path.dirname(resolvedGitDir);
    }
  }

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath).catch(() => null);
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(worktreePath, gitDir);
  return path.dirname(resolvedGitDir);
}

export async function realizeExecutionWorkspace(input: {
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      baseRefSha: null,
    };
  }

  const repoRoot = await resolveGitOwnerRepoRoot(input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  const branchName = sanitizeBranchName(renderedBranch);
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".paperclip", "worktrees");
  const worktreePath = path.join(worktreeParentDir, branchName);
  const configuredBaseRef = typeof rawStrategy.baseRef === "string" && rawStrategy.baseRef.length > 0
    ? rawStrategy.baseRef
    : input.base.repoRef ?? null;
  const {
    baseRef,
    warnings: baseRefResolutionWarnings,
    refreshed: baseRefAlreadyRefreshed,
  } = await resolveAuthoritativeBaseRef(repoRoot, configuredBaseRef);
  const baseRefreshWarnings = [
    ...baseRefResolutionWarnings,
    ...(baseRefAlreadyRefreshed ? [] : await refreshRemoteTrackingBaseRef(repoRoot, baseRef)),
  ];
  const currentBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);

  await fs.mkdir(worktreeParentDir, { recursive: true });

  async function reuseExistingWorktree(reusablePath: string) {
    const refresh = currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reusablePath,
          branchName,
          baseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reusablePath,
      branchName,
      baseRef,
      recordedBaseRefSha: null,
      skipRefresh: true,
    });
    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_prepare",
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath: reusablePath,
          branchName,
          baseRef,
          currentBaseRefSha: baseDrift.currentBaseRefSha,
          branchBaseRefSha: baseDrift.branchBaseRefSha,
          created: false,
          reused: true,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system: `Reused existing git worktree at ${reusablePath}\n`,
        }),
      });
    }
    await provisionExecutionWorktree({
      strategy: rawStrategy,
      base: input.base,
      repoRoot,
      worktreePath: reusablePath,
      branchName,
      issue: input.issue,
      agent: input.agent,
      created: false,
      recorder: input.recorder ?? null,
    });
    return {
      ...input.base,
      repoRef: baseRef,
      strategy: "git_worktree" as const,
      cwd: reusablePath,
      branchName,
      worktreePath: reusablePath,
      warnings: [...baseRefreshWarnings, ...baseDrift.warnings],
      created: false,
      baseRefSha: refresh.baseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha,
    };
  }

  async function validateReusableWorktree(reusablePath: string) {
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reusablePath,
      expectedBranchName: branchName,
    }).catch(() => null);
    if (validation && !validation.valid && validation.reasonCode === "branch_mismatch") {
      await ensureGitWorktreeBranchCoherent({
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: branchName,
        actualBranchName: validation.actualBranchName ?? null,
        sourceIssue: input.issue,
        executionWorkspaceId: null,
        recorder: input.recorder ?? null,
      });
      return await validateLinkedGitWorktree({
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: branchName,
      }).catch(() => null);
    }
    return validation;
  }

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const validation = await validateReusableWorktree(worktreePath);
    if (validation?.valid) {
      return await reuseExistingWorktree(worktreePath);
    }
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a reusable git worktree${reason}.`);
  }

  const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
  if (registeredBranchWorktree) {
    const validation = await validateReusableWorktree(registeredBranchWorktree);
    if (validation?.valid) {
      return await reuseExistingWorktree(registeredBranchWorktree);
    }
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Registered worktree for branch "${branchName}" at "${registeredBranchWorktree}" is not reusable${reason}.`);
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: currentBaseRefSha,
        created: true,
      },
      successMessage: `Created git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (!gitErrorIncludes(error, "already exists")) {
      throw error;
    }
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["worktree", "add", worktreePath, branchName],
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath,
          branchName,
          baseRef,
          baseRefSha: currentBaseRefSha,
          created: false,
          reusedExistingBranch: true,
        },
        successMessage: `Attached existing branch ${branchName} at ${worktreePath}\n`,
        failureLabel: `git worktree add ${worktreePath}`,
      });
    } catch (attachError) {
      if (!gitErrorIncludes(attachError, "already checked out")) {
        throw attachError;
      }
      const reusablePath = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
      if (!reusablePath || !await isGitCheckout(reusablePath)) {
        throw attachError;
      }
      return await reuseExistingWorktree(reusablePath);
    }
  }
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
    recorder: input.recorder ?? null,
  });

  return {
    ...input.base,
    repoRef: baseRef,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: baseRefreshWarnings,
    created: true,
    baseRefSha: currentBaseRefSha,
  };
}

export async function ensurePersistedExecutionWorkspaceAvailable(input: {
  base: ExecutionWorkspaceInput;
  workspace: {
    id?: string | null;
    mode: string | null | undefined;
    strategyType: string | null | undefined;
    cwd: string | null | undefined;
    providerRef: string | null | undefined;
    projectId: string | null | undefined;
    projectWorkspaceId: string | null | undefined;
    repoUrl: string | null | undefined;
    baseRef: string | null | undefined;
    branchName: string | null | undefined;
    metadata?: Record<string, unknown> | null;
    config?: {
      provisionCommand?: string | null;
    } | null;
  };
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<RealizedExecutionWorkspace | null> {
  const cwd = asString(input.workspace.cwd ?? input.workspace.providerRef, "").trim();
  if (!cwd) return null;

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  const realized: RealizedExecutionWorkspace = {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (input.workspace.providerRef ?? cwd) : null,
    warnings: [],
    created: false,
    baseRefSha: readRecordedBaseRefSha(input.workspace.metadata),
  };
  const provisionCommand = asString(input.workspace.config?.provisionCommand, "").trim();

  if (strategy !== "git_worktree") {
    if (!await directoryExists(cwd)) {
      return null;
    }
    return realized;
  }
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], input.base.baseCwd);
  const recordedBaseRefSha = readRecordedBaseRefSha(input.workspace.metadata);
  if (await directoryExists(cwd)) {
    const reuseBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
    const reuseWorktreePath = realized.worktreePath ?? cwd;
    if (await isGitCheckout(reuseWorktreePath)) {
      await ensureGitWorktreeBranchCoherent({
        repoRoot,
        worktreePath: reuseWorktreePath,
        expectedBranchName: realized.branchName,
        sourceIssue: input.issue,
        executionWorkspaceId: input.workspace.id ?? null,
        recorder: input.recorder ?? null,
      });
    }
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reuseWorktreePath,
      expectedBranchName: realized.branchName,
    });
    if (!validation.valid) {
      throw new WorkspaceRuntimeValidationFailure(
        `Persisted git worktree "${reuseWorktreePath}" is not reusable (${validation.reason}).`,
        {
          workspaceValidation: {
            reason: "git_worktree_not_reusable",
            reasonCode: validation.reasonCode,
            worktreePath: reuseWorktreePath,
            executionWorkspaceId: input.workspace.id ?? null,
          },
        },
      );
    }
    const baseRefreshWarnings = reuseBaseRef
      ? await refreshRemoteTrackingBaseRef(repoRoot, reuseBaseRef)
      : [];
    const currentBaseRefSha = reuseBaseRef ? await resolveBaseRefSha(repoRoot, reuseBaseRef) : null;
    const refresh = reuseBaseRef && currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reuseWorktreePath,
          branchName: realized.branchName,
          baseRef: reuseBaseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reuseWorktreePath,
      branchName: realized.branchName,
      baseRef: reuseBaseRef,
      recordedBaseRefSha,
      skipRefresh: true,
    });
    realized.warnings = [...baseRefreshWarnings, ...baseDrift.warnings];
    realized.baseRefSha = refresh.baseRefSha ?? recordedBaseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha;
    if (provisionCommand) {
      await provisionExecutionWorktree({
        strategy: {
          type: "git_worktree",
          provisionCommand,
        },
        base: input.base,
        repoRoot,
        worktreePath: realized.worktreePath ?? cwd,
        branchName: realized.branchName ?? "",
        issue: input.issue,
        agent: input.agent,
        created: false,
        recorder: input.recorder ?? null,
      });
    }
    return realized;
  }

  const worktreePath = realized.worktreePath ?? cwd;
  const branchName = asString(input.workspace.branchName, "").trim();
  if (!branchName) {
    throw new Error(`Execution workspace "${cwd}" is missing and cannot be restored because no branch name is recorded.`);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(["worktree", "prune"], repoRoot).catch(() => {});
  const restoreBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
  const restoreRefreshWarnings = restoreBaseRef ? await refreshRemoteTrackingBaseRef(repoRoot, restoreBaseRef) : [];
  const restoreCurrentBaseRefSha = restoreBaseRef ? await resolveBaseRefSha(repoRoot, restoreBaseRef) : null;

  let created = false;
  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", worktreePath, branchName],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
        currentBaseRefSha: restoreCurrentBaseRefSha,
        created: false,
        restored: true,
      },
      successMessage: `Reattached missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (
      !gitErrorIncludes(error, "invalid reference")
      && !gitErrorIncludes(error, "not a commit")
      && !gitErrorIncludes(error, "unknown revision")
    ) {
      throw error;
    }
    const baseRef = input.workspace.baseRef ?? await detectDefaultBranch(repoRoot) ?? "HEAD";
    const recreatedBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: recreatedBaseRefSha,
        created: true,
        restored: true,
      },
      successMessage: `Recreated missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    created = true;
  }

  const baseDrift = await inspectExecutionWorkspaceBaseDrift({
    repoRoot,
    worktreePath,
    branchName,
    baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
    recordedBaseRefSha,
    skipRefresh: true,
  });

  await provisionExecutionWorktree({
    strategy: {
      type: "git_worktree",
      ...(provisionCommand ? { provisionCommand } : {}),
    },
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created,
    recorder: input.recorder ?? null,
  });

  return {
    ...realized,
    cwd: worktreePath,
    worktreePath,
    warnings: [...restoreRefreshWarnings, ...baseDrift.warnings],
    created,
    baseRefSha:
      recordedBaseRefSha
      ?? (created ? restoreCurrentBaseRefSha : baseDrift.branchBaseRefSha)
      ?? baseDrift.currentBaseRefSha,
  };
}

export async function cleanupExecutionWorkspaceArtifacts(input: {
  workspace: {
    id: string;
    cwd: string | null;
    providerType: string;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectWorkspace?: {
    cwd: string | null;
    cleanupCommand: string | null;
  } | null;
  cleanupCommand?: string | null;
  teardownCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const warnings: string[] = [];
  const workspacePath = input.workspace.providerRef ?? input.workspace.cwd;
  const repoRoot = input.workspace.providerType === "git_worktree" && workspacePath
    ? await resolveGitRepoRootForWorkspaceCleanup(
      workspacePath,
      input.projectWorkspace?.cwd ?? null,
    )
    : null;
  const cleanupEnv = buildExecutionWorkspaceCleanupEnv({
    workspace: input.workspace,
    projectWorkspaceCwd: input.projectWorkspace?.cwd ?? null,
  });
  const createdByRuntime = input.workspace.metadata?.createdByRuntime === true;
  const cleanupCommands = [
    input.cleanupCommand ?? null,
    input.projectWorkspace?.cleanupCommand ?? null,
    input.teardownCommand ?? null,
  ]
    .map((value) => asString(value, "").trim())
    .filter(Boolean);

  for (const command of cleanupCommands) {
    try {
      const resolvedCommand = repoRoot
        ? resolveRepoManagedWorkspaceCommand(command, repoRoot)
        : command;
      await recordWorkspaceCommandOperation(input.recorder, {
        phase: "workspace_teardown",
        command,
        resolvedCommand,
        cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd(),
        env: cleanupEnv,
        label: `Execution workspace cleanup command "${command}"`,
        metadata: {
          workspaceId: input.workspace.id,
          workspacePath,
          branchName: input.workspace.branchName,
          providerType: input.workspace.providerType,
          resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
        },
        successMessage: `Completed cleanup command "${command}"\n`,
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    const worktreeExists = await directoryExists(workspacePath);
    if (worktreeExists) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root for "${workspacePath}".`);
      } else {
        try {
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: ["worktree", "remove", "--force", workspacePath],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "worktree_remove",
            },
            successMessage: `Removed git worktree ${workspacePath}\n`,
            failureLabel: `git worktree remove ${workspacePath}`,
          });
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (createdByRuntime && input.workspace.branchName) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root to delete branch "${input.workspace.branchName}".`);
      } else {
        try {
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: ["branch", "-d", input.workspace.branchName],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "branch_delete",
            },
            successMessage: `Deleted branch ${input.workspace.branchName}\n`,
            failureLabel: `git branch -d ${input.workspace.branchName}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped deleting branch "${input.workspace.branchName}": ${message}`);
        }
      }
    }
  } else if (input.workspace.providerType === "local_fs" && createdByRuntime && workspacePath) {
    const projectWorkspaceCwd = input.projectWorkspace?.cwd ? path.resolve(input.projectWorkspace.cwd) : null;
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const containsProjectWorkspace = projectWorkspaceCwd
      ? (
          resolvedWorkspacePath === projectWorkspaceCwd ||
          projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
        )
      : false;
    if (containsProjectWorkspace) {
      warnings.push(`Refusing to remove path "${workspacePath}" because it contains the project workspace.`);
    } else {
      await fs.rm(resolvedWorkspacePath, { recursive: true, force: true });
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "workspace_teardown",
          cwd: projectWorkspaceCwd ?? process.cwd(),
          metadata: {
            workspaceId: input.workspace.id,
            workspacePath: resolvedWorkspacePath,
            cleanupAction: "remove_local_fs",
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: `Removed local workspace directory ${resolvedWorkspacePath}\n`,
          }),
        });
      }
    }
  }

  const cleaned =
    !workspacePath ||
    !(await directoryExists(workspacePath));

  return {
    cleanedPath: workspacePath,
    cleaned,
    warnings,
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function buildTemplateData(input: {
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  port: number | null;
}) {
  return {
    workspace: {
      cwd: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      worktreePath: input.workspace.worktreePath ?? "",
      repoUrl: input.workspace.repoUrl ?? "",
      repoRef: input.workspace.repoRef ?? "",
      env: input.adapterEnv,
    },
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    port: input.port ?? "",
  };
}

function renderRuntimeServiceEnv(input: {
  envConfig: Record<string, unknown>;
  templateData: ReturnType<typeof buildTemplateData>;
}) {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.envConfig)) {
    if (typeof value !== "string") continue;
    rendered[key] = renderTemplate(value, input.templateData);
  }
  return rendered;
}

function resolveRuntimeServiceReuseIdentity(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): {
  serviceName: string;
  lifecycle: RuntimeServiceRef["lifecycle"];
  command: string;
  serviceCwd: string;
  envConfig: Record<string, unknown>;
  envFingerprint: string;
  explicitPort: number;
  identityPort: number | null;
  reuseKey: string | null;
} {
  const serviceName = asString(input.service.name, "service");
  const lifecycle = asString(input.service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
  const command = asString(input.service.command, "");
  const serviceCwdTemplate = asString(input.service.cwd, ".");
  const portConfig = parseObject(input.service.port);
  const envConfig = parseObject(input.service.env);
  const explicitPort = asNumber(portConfig.value, asNumber(input.service.port, 0));
  const identityPort = explicitPort > 0 ? explicitPort : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: identityPort,
  });
  const serviceCwd = resolveConfiguredPath(renderTemplate(serviceCwdTemplate, templateData), input.workspace.cwd);
  const renderedEnv = renderRuntimeServiceEnv({
    envConfig,
    templateData,
  });
  const envFingerprint = createHash("sha256").update(stableStringify(renderedEnv)).digest("hex");
  const reuseKey =
    lifecycle === "shared"
      ? createHash("sha256")
          .update(
            stableStringify({
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              serviceName,
              command,
              cwd: serviceCwd,
              port: identityPort,
              env: renderedEnv,
            }),
          )
          .digest("hex")
      : null;

  return {
    serviceName,
    lifecycle,
    command,
    serviceCwd,
    envConfig,
    envFingerprint,
    explicitPort,
    identityPort,
    reuseKey,
  };
}

function resolveWorkspaceCommandExecution(input: {
  command: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
}) {
  const name =
    asString(input.command.name, "")
    || asString(input.command.label, "")
    || asString(input.command.title, "")
    || "workspace command";
  const command = asString(input.command.command, "");
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: null,
  });
  const cwd = resolveConfiguredPath(
    renderTemplate(asString(input.command.cwd, "."), templateData),
    input.workspace.cwd,
  );
  const env = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
    ...renderRuntimeServiceEnv({
      envConfig: parseObject(input.command.env),
      templateData,
    }),
  } as Record<string, string>;

  return {
    name,
    command,
    cwd,
    env,
  };
}

export async function runWorkspaceJobForControl(input: {
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  command: Record<string, unknown>;
  adapterEnv?: Record<string, string>;
  recorder?: WorkspaceOperationRecorder | null;
  metadata?: Record<string, unknown> | null;
}) {
  const resolved = resolveWorkspaceCommandExecution({
    command: input.command,
    workspace: input.workspace,
    agent: input.actor,
    issue: input.issue,
    adapterEnv: input.adapterEnv ?? {},
  });
  if (!resolved.command) {
    throw new Error(`Workspace job "${resolved.name}" is missing command`);
  }

  await ensureServerWorkspaceLinksCurrent(resolved.cwd);
  return await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: resolved.command,
    cwd: resolved.cwd,
    env: resolved.env,
    label: `Workspace job "${resolved.name}"`,
    metadata: {
      workspaceCommandKind: "job",
      workspaceCommandName: resolved.name,
      ...(input.metadata ?? {}),
    },
    successMessage: `Completed workspace job "${resolved.name}"\n`,
  });
}

function resolveServiceScopeId(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
}): {
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
} {
  const scopeTypeRaw = asString(input.service.reuseScope, input.service.lifecycle === "shared" ? "project_workspace" : "run");
  const scopeType =
    scopeTypeRaw === "project_workspace" ||
    scopeTypeRaw === "execution_workspace" ||
    scopeTypeRaw === "agent"
      ? scopeTypeRaw
      : "run";
  if (scopeType === "project_workspace") return { scopeType, scopeId: input.workspace.workspaceId ?? input.workspace.projectId };
  if (scopeType === "execution_workspace") {
    return { scopeType, scopeId: input.executionWorkspaceId ?? input.workspace.cwd };
  }
  if (scopeType === "agent") return { scopeType, scopeId: input.agent.id };
  return { scopeType: "run" as const, scopeId: input.runId };
}

function looksLikeWorkspaceDevServerCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)/.test(normalized);
}

export function resolveWorkspaceRuntimeReadinessTimeoutSec(service: Record<string, unknown>) {
  const readiness = parseObject(service.readiness);
  const explicitTimeoutSec = asNumber(readiness.timeoutSec, 0);
  if (explicitTimeoutSec > 0) {
    return Math.max(1, explicitTimeoutSec);
  }
  return looksLikeWorkspaceDevServerCommand(asString(service.command, "")) ? 90 : 30;
}

async function waitForReadiness(input: {
  service: Record<string, unknown>;
  url: string | null;
}) {
  const readiness = parseObject(input.service.readiness);
  const readinessType = asString(readiness.type, "");
  if (readinessType !== "http" || !input.url) return;
  const timeoutSec = resolveWorkspaceRuntimeReadinessTimeoutSec(input.service);
  const intervalMs = Math.max(100, asNumber(readiness.intervalMs, 500));
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "service did not become ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(input.url);
      if (response.ok) return;
      lastError = `received HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`Readiness check failed for ${input.url}: ${lastError}`);
}

function isPaperclipDevRuntimeService(input: { serviceName?: string | null; command?: string | null }) {
  const serviceName = (input.serviceName ?? "").trim().toLowerCase();
  const command = (input.command ?? "").trim().toLowerCase();
  return (
    serviceName === "paperclip-dev"
    || serviceName === "paperclip-dev-once"
    || (command.includes("dev:once") && command.includes("tailscale-auth"))
  );
}

function resolveRuntimeServiceHealthUrl(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url || !isPaperclipDevRuntimeService(input ?? {})) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/health";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

async function isRuntimeServiceUrlHealthy(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url) return true;
  const healthUrl = resolveRuntimeServiceHealthUrl(url, input);
  if (!healthUrl) return true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

async function upsertRuntimeServiceRecord(
  db: Db,
  values: typeof workspaceRuntimeServices.$inferInsert,
) {
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        executionWorkspaceId: values.executionWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

function runtimeServiceStatusNeedsActiveOwner(status: string) {
  return status === "starting" || status === "running";
}

async function assertRuntimeServiceOwnerActive(input: {
  db: Db;
  companyId: string;
  ownerAgentId: string;
}) {
  await input.db.transaction(async (tx) => {
    await lockAgentLifecycleReference(tx as unknown as Db, {
      companyId: input.companyId,
      agentId: input.ownerAgentId,
      mode: "active",
    });
  });
}

async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  if (record.ownerAgentId && runtimeServiceStatusNeedsActiveOwner(record.status)) {
    // Agent -> runtime is the canonical row-lock order. The lifecycle check
    // and active runtime upsert share one transaction, so a cross-process
    // termination either wins first (and this write is rejected) or observes
    // the committed runtime dependency after it acquires the agent lock.
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockAgentLifecycleReference(txDb, {
        companyId: record.companyId,
        agentId: record.ownerAgentId!,
        mode: "active",
      });
      await upsertRuntimeServiceRecord(txDb, values);
    });
    return;
  }
  await upsertRuntimeServiceRecord(db, values);
}

async function findStoppedRuntimeServiceReuseCandidate(input: {
  db?: Db;
  companyId: string;
  reuseKey: string | null;
}): Promise<StoppedRuntimeServiceReuseCandidate | null> {
  if (!input.db || !input.reuseKey) return null;
  const row = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      port: workspaceRuntimeServices.port,
      ownerAgentId: workspaceRuntimeServices.ownerAgentId,
      ownerStatus: agents.status,
      ownerCompanyId: agents.companyId,
    })
    .from(workspaceRuntimeServices)
    .leftJoin(agents, eq(workspaceRuntimeServices.ownerAgentId, agents.id))
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, input.companyId),
        eq(workspaceRuntimeServices.reuseKey, input.reuseKey),
        eq(workspaceRuntimeServices.provider, "local_process"),
        eq(workspaceRuntimeServices.status, "stopped"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt))
    .then((rows) => rows.find((candidate) =>
      (
        candidate.ownerAgentId === null ||
        (
          candidate.ownerStatus !== null &&
          candidate.ownerStatus !== "terminated" &&
          candidate.ownerCompanyId === input.companyId
        )
      ) &&
      !isHistoricalAgentTombstoneId(candidate.ownerAgentId)
    ) ?? null);

  return row ? { id: row.id, port: row.port } : null;
}

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
}

type PersistedRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeStartClaimRow = typeof workspaceRuntimeStartClaims.$inferSelect;
type RuntimeOwnerSnapshot = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;

class RuntimeCleanupQuarantinedError extends Error {
  readonly preserveDurableRuntimeState = true;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RuntimeCleanupQuarantinedError";
  }
}

class RuntimeRegistryPublicationCollisionError extends Error {
  readonly record: RuntimeServiceRecord;
  readonly primary: Error;

  constructor(primary: Error, record: RuntimeServiceRecord) {
    super(primary.message, { cause: primary });
    this.name = "RuntimeRegistryPublicationCollisionError";
    this.primary = primary;
    this.record = record;
  }
}

function errorChainHasCode(error: unknown, code: string) {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as NodeJS.ErrnoException).code === code) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function isRuntimeCleanupQuarantined(error: unknown): boolean {
  if (error instanceof RuntimeCleanupQuarantinedError) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => isRuntimeCleanupQuarantined(entry));
  }
  if (error instanceof Error && error.cause) return isRuntimeCleanupQuarantined(error.cause);
  return false;
}

function dateFingerprint(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function runtimeRowSignalFingerprint(row: PersistedRuntimeServiceRow) {
  return stableStringify({
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId,
    executionWorkspaceId: row.executionWorkspaceId,
    issueId: row.issueId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    serviceName: row.serviceName,
    status: row.status,
    lifecycle: row.lifecycle,
    reuseKey: row.reuseKey,
    command: row.command,
    cwd: row.cwd,
    port: row.port,
    url: row.url,
    provider: row.provider,
    providerRef: row.providerRef,
    ownerAgentId: row.ownerAgentId,
    startedByRunId: row.startedByRunId,
    lastUsedAt: dateFingerprint(row.lastUsedAt),
    startedAt: dateFingerprint(row.startedAt),
    stoppedAt: dateFingerprint(row.stoppedAt),
    stopPolicy: row.stopPolicy,
    healthStatus: row.healthStatus,
    createdAt: dateFingerprint(row.createdAt),
    updatedAt: dateFingerprint(row.updatedAt),
  });
}

function claimSignalFingerprint(row: RuntimeStartClaimRow) {
  return stableStringify({
    id: row.id,
    companyId: row.companyId,
    serviceKey: row.serviceKey,
    claimId: row.claimId,
    status: row.status,
    runtimeServiceId: row.runtimeServiceId,
    ownerAgentId: row.ownerAgentId,
    failureCode: row.failureCode,
    claimedAt: dateFingerprint(row.claimedAt),
    expiresAt: dateFingerprint(row.expiresAt),
    finalizedAt: dateFingerprint(row.finalizedAt),
    updatedAt: dateFingerprint(row.updatedAt),
  });
}

function registrySignalFingerprint(record: LocalServiceRegistryRecord) {
  const { lastSeenAt: _lastSeenAt, ...binding } = record;
  return stableStringify({
    ...binding,
    metadata: record.metadata,
  });
}

function assertRuntimeRowSignalSnapshot(
  expected: PersistedRuntimeServiceRow,
  actual: PersistedRuntimeServiceRow | null,
) {
  if (!actual || runtimeRowSignalFingerprint(actual) !== runtimeRowSignalFingerprint(expected)) {
    throw new Error(`Persisted runtime service ${expected.id} changed before signal`);
  }
}

function assertRuntimeClaimSignalSnapshot(
  expected: RuntimeStartClaimRow,
  actual: RuntimeStartClaimRow | null,
) {
  if (!actual || claimSignalFingerprint(actual) !== claimSignalFingerprint(expected)) {
    throw new Error(`Workspace runtime start claim ${expected.claimId} changed before signal`);
  }
}

function assertRuntimeRegistrySignalSnapshot(
  expected: LocalServiceRegistryRecord,
  actual: LocalServiceRegistryRecord,
) {
  if (registrySignalFingerprint(actual) !== registrySignalFingerprint(expected)) {
    throw new Error(`Local service registry ${expected.serviceKey} changed before signal`);
  }
}

function assertPersistedRuntimeRegistryClaimBinding(input: {
  row: PersistedRuntimeServiceRow;
  claim: RuntimeStartClaimRow;
  registry: LocalServiceRegistryRecord;
  allowedClaimStatuses?: ReadonlySet<string>;
}) {
  const { row, claim, registry } = input;
  const metadata = registry.metadata ?? {};
  const providerPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
  const allowedClaimStatuses = input.allowedClaimStatuses ?? new Set(["running"]);
  if (
    registry.version !== 2 ||
    claim.companyId !== row.companyId ||
    !allowedClaimStatuses.has(claim.status) ||
    claim.runtimeServiceId !== row.id ||
    claim.ownerAgentId !== row.ownerAgentId ||
    registry.runtimeServiceId !== row.id ||
    registry.serviceKey !== claim.serviceKey ||
    registry.profileKind !== "workspace-runtime" ||
    registry.provider !== "local_process" ||
    row.provider !== "local_process" ||
    registry.serviceName !== row.serviceName ||
    registry.command !== row.command ||
    !row.cwd ||
    path.resolve(registry.cwd) !== path.resolve(row.cwd) ||
    (row.reuseKey !== null && registry.envFingerprint !== row.reuseKey) ||
    registry.reuseKey !== row.reuseKey ||
    registry.port !== row.port ||
    registry.url !== row.url ||
    Date.parse(registry.startedAt) !== row.startedAt.getTime() ||
    !providerPid ||
    (providerPid !== registry.pid && providerPid !== registry.processGroupId) ||
    metadata.companyId !== row.companyId ||
    metadata.ownerAgentId !== row.ownerAgentId ||
    metadata.projectId !== (row.projectId ?? null) ||
    metadata.projectWorkspaceId !== (row.projectWorkspaceId ?? null) ||
    metadata.executionWorkspaceId !== (row.executionWorkspaceId ?? null) ||
    metadata.issueId !== (row.issueId ?? null) ||
    metadata.scopeType !== row.scopeType ||
    metadata.scopeId !== (row.scopeId ?? null) ||
    metadata.startClaimId !== claim.claimId
  ) {
    throw new Error(`Local service registry does not match the exact runtime row and claim for ${row.id}`);
  }
}

function assertMemoryRuntimeBinding(
  record: RuntimeServiceRecord,
  row: PersistedRuntimeServiceRow,
) {
  if (
    record.id !== row.id ||
    record.companyId !== row.companyId ||
    record.projectId !== (row.projectId ?? null) ||
    record.projectWorkspaceId !== (row.projectWorkspaceId ?? null) ||
    record.executionWorkspaceId !== (row.executionWorkspaceId ?? null) ||
    record.issueId !== (row.issueId ?? null) ||
    record.scopeType !== row.scopeType ||
    record.scopeId !== (row.scopeId ?? null) ||
    record.serviceName !== row.serviceName ||
    record.lifecycle !== row.lifecycle ||
    record.reuseKey !== (row.reuseKey ?? null) ||
    record.command !== (row.command ?? null) ||
    record.cwd !== (row.cwd ?? null) ||
    record.port !== (row.port ?? null) ||
    record.url !== (row.url ?? null) ||
    record.provider !== row.provider ||
    record.providerRef !== (row.providerRef ?? null) ||
    record.ownerAgentId !== (row.ownerAgentId ?? null) ||
    record.startedByRunId !== (row.startedByRunId ?? null) ||
    Date.parse(record.startedAt) !== row.startedAt.getTime()
  ) {
    throw new Error(`In-memory runtime service ${record.id} does not match its persisted binding`);
  }
}

async function readUniqueStrictRuntimeRegistry(input: {
  runtimeServiceId: string;
  serviceKey: string;
  profileKind: string;
}) {
  const matches = (await listLocalServiceRegistryRecordsStrict({
    profileKind: input.profileKind,
  })).filter((candidate) => (
    candidate.runtimeServiceId === input.runtimeServiceId ||
    candidate.serviceKey === input.serviceKey
  ));
  if (
    matches.length !== 1 ||
    matches[0]!.runtimeServiceId !== input.runtimeServiceId ||
    matches[0]!.serviceKey !== input.serviceKey
  ) {
    throw new Error(`Runtime service ${input.runtimeServiceId} has no unique strict registry binding`);
  }
  return matches[0]!;
}

async function readRuntimeOwnerSnapshot(input: {
  db: Db;
  companyId: string;
  ownerAgentId: string | null;
}): Promise<RuntimeOwnerSnapshot | null> {
  if (!input.ownerAgentId) return null;
  const owner = await input.db.select({
    id: agents.id,
    companyId: agents.companyId,
    status: agents.status,
  }).from(agents).where(eq(agents.id, input.ownerAgentId)).then((rows) => rows[0] ?? null);
  if (!owner || owner.companyId !== input.companyId) {
    throw new Error(`Workspace runtime signal owner ${input.ownerAgentId} changed company binding`);
  }
  return owner;
}

type DurableRuntimeSignalSnapshot = {
  row: PersistedRuntimeServiceRow;
  claim: RuntimeStartClaimRow;
  registry: LocalServiceRegistryRecord;
  owner: RuntimeOwnerSnapshot | null;
};

async function captureDurableRuntimeSignalSnapshot(record: RuntimeServiceRecord) {
  if (!record.db) throw new Error(`Runtime service ${record.id} has no durable signal database`);
  const [row, registry, owner] = await Promise.all([
    record.db.select().from(workspaceRuntimeServices).where(and(
      eq(workspaceRuntimeServices.id, record.id),
      eq(workspaceRuntimeServices.companyId, record.companyId),
    )).then((rows) => rows[0] ?? null),
    readUniqueStrictRuntimeRegistry({
      runtimeServiceId: record.id,
      serviceKey: record.serviceKey,
      profileKind: record.profileKind,
    }),
    readRuntimeOwnerSnapshot({
      db: record.db,
      companyId: record.companyId,
      ownerAgentId: record.ownerAgentId,
    }),
  ]);
  if (!row) throw new Error(`Runtime service ${record.id} has no persisted signal binding`);
  assertMemoryRuntimeBinding(record, row);
  const claim = await record.db.select().from(workspaceRuntimeStartClaims).where(and(
    eq(workspaceRuntimeStartClaims.companyId, record.companyId),
    eq(workspaceRuntimeStartClaims.serviceKey, registry.serviceKey),
  )).then((rows) => rows[0] ?? null);
  if (!claim) throw new Error(`Runtime service ${record.id} has no exact start-claim signal binding`);
  assertPersistedRuntimeRegistryClaimBinding({ row, claim, registry });
  const verification = await verifyLocalServiceRegistryRecordIdentity(registry);
  if (verification.kind === "unproven") {
    throw new Error(`Runtime service ${record.id} has unproven OS identity: ${verification.reason}`);
  }
  if (verification.kind === "not_running" && isProcessGroupAlive(registry.processGroupId)) {
    throw new Error(`Runtime service ${record.id} lost its recorded PID while its process group remains alive`);
  }
  return { row, claim, registry, owner } satisfies DurableRuntimeSignalSnapshot;
}

async function sendDurableRuntimeSignal(input: {
  db: Db;
  expected: DurableRuntimeSignalSnapshot;
  ownerStartLockHeld?: boolean;
  sendSignal: () => void;
}) {
  const execute = async () => {
    await input.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      if (input.expected.owner) {
        const lockedOwner = await lockAgentLifecycleReference(txDb, {
          companyId: input.expected.owner.companyId,
          agentId: input.expected.owner.id,
          mode: "cleanup",
          allowMissingCleanup: false,
        });
        if (
          !lockedOwner ||
          lockedOwner.companyId !== input.expected.owner.companyId ||
          lockedOwner.status !== input.expected.owner.status
        ) {
          throw new Error(`Workspace runtime signal owner ${input.expected.owner.id} changed lifecycle before signal`);
        }
      }
      await lockWorkspaceRuntimeStartClaimFence(txDb, {
        companyId: input.expected.row.companyId,
        serviceKey: input.expected.registry.serviceKey,
      });
      const lockedClaim = await txDb.select().from(workspaceRuntimeStartClaims).where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.expected.row.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.expected.registry.serviceKey),
      )).for("update").then((rows) => rows[0] ?? null);
      assertRuntimeClaimSignalSnapshot(input.expected.claim, lockedClaim);
      const lockedRuntime = await txDb.select().from(workspaceRuntimeServices).where(and(
        eq(workspaceRuntimeServices.id, input.expected.row.id),
        eq(workspaceRuntimeServices.companyId, input.expected.row.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      assertRuntimeRowSignalSnapshot(input.expected.row, lockedRuntime);
      const freshRegistry = await readUniqueStrictRuntimeRegistry({
        runtimeServiceId: input.expected.row.id,
        serviceKey: input.expected.registry.serviceKey,
        profileKind: input.expected.registry.profileKind,
      });
      assertRuntimeRegistrySignalSnapshot(input.expected.registry, freshRegistry);
      assertPersistedRuntimeRegistryClaimBinding({
        row: lockedRuntime!,
        claim: lockedClaim!,
        registry: freshRegistry,
        allowedClaimStatuses: new Set([input.expected.claim.status]),
      });
      await assertLocalServiceRegistryRecordIdentity(freshRegistry);
      input.sendSignal();
    });
  };
  const ownerAgentId = input.expected.owner?.id ?? null;
  if (ownerAgentId && !input.ownerStartLockHeld) {
    await withAgentStartLock(ownerAgentId, execute);
    return;
  }
  await execute();
}

const localRuntimeSignalLocks = new Map<string, Promise<void>>();

async function withLocalRuntimeSignalLock<T>(serviceKey: string, run: () => Promise<T>) {
  const previous = localRuntimeSignalLocks.get(serviceKey) ?? Promise.resolve();
  const current = previous.then(run);
  const marker = current.then(() => undefined, () => undefined);
  localRuntimeSignalLocks.set(serviceKey, marker);
  try {
    return await current;
  } finally {
    if (localRuntimeSignalLocks.get(serviceKey) === marker) localRuntimeSignalLocks.delete(serviceKey);
  }
}

async function waitForExactLocalProcessExit(input: {
  pid: number;
  processGroupId: number | null;
  label: string;
}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(input.pid) && !isProcessGroupAlive(input.processGroupId)) return;
    await delay(20);
  }
  throw new Error(
    `${input.label} ${input.pid}${input.processGroupId ? ` group ${input.processGroupId}` : ""} remained alive after exact cleanup`,
  );
}

type PrePersistRuntimeSignalSnapshot = {
  companyId: string;
  serviceKey: string;
  runtimeServiceId: string;
  startClaimId: string | null;
  ownerAgentId: string | null;
  owner: RuntimeOwnerSnapshot | null;
  claim: RuntimeStartClaimRow | null;
  priorRuntime: PersistedRuntimeServiceRow | null;
  registry: LocalServiceRegistryRecord | null;
  registryPolicy: "exact_or_absent" | "preserve_foreign";
  processExpectation: "live" | "absent";
  processIdentity: LocalProcessIdentity;
  child: ChildProcess | null;
};

async function readOptionalStrictRegistryByServiceKey(input: {
  serviceKey: string;
  profileKind: string;
}) {
  const matches = (await listLocalServiceRegistryRecordsStrict({
    profileKind: input.profileKind,
  })).filter((candidate) => candidate.serviceKey === input.serviceKey);
  if (matches.length > 1) {
    throw new Error(`Local service registry ${input.serviceKey} is not unique before signal`);
  }
  return matches[0] ?? null;
}

function requireStrongRegistryProcessIdentity(record: LocalServiceRegistryRecord): LocalProcessIdentity {
  if (
    record.version !== 2 ||
    typeof record.processStartedAt !== "string" ||
    typeof record.processExecutable !== "string" ||
    typeof record.processCommandSha256 !== "string" ||
    !record.processGroupId
  ) {
    throw new Error(`Local service registry ${record.serviceKey} has no complete strong process identity`);
  }
  return {
    pid: record.pid,
    processGroupId: record.processGroupId,
    processStartedAt: record.processStartedAt,
    processExecutable: record.processExecutable,
    processCommandSha256: record.processCommandSha256,
  };
}

function assertPrePersistRegistryBinding(input: {
  snapshot: PrePersistRuntimeSignalSnapshot;
  registry: LocalServiceRegistryRecord;
}) {
  const { snapshot, registry } = input;
  const metadata = registry.metadata ?? {};
  if (
    registry.version !== 2 ||
    registry.serviceKey !== snapshot.serviceKey ||
    registry.profileKind !== "workspace-runtime" ||
    registry.runtimeServiceId !== snapshot.runtimeServiceId ||
    registry.pid !== snapshot.processIdentity.pid ||
    registry.processGroupId !== snapshot.processIdentity.processGroupId ||
    registry.processStartedAt !== snapshot.processIdentity.processStartedAt ||
    registry.processExecutable !== snapshot.processIdentity.processExecutable ||
    registry.processCommandSha256 !== snapshot.processIdentity.processCommandSha256 ||
    metadata.companyId !== snapshot.companyId ||
    metadata.ownerAgentId !== snapshot.ownerAgentId ||
    metadata.startClaimId !== snapshot.startClaimId
  ) {
    throw new Error(`Pre-persist registry ${snapshot.serviceKey} changed its exact spawn binding`);
  }
}

function assertExactSpawnReceipt(snapshot: PrePersistRuntimeSignalSnapshot) {
  if (snapshot.child && (
    !snapshot.child.pid ||
    snapshot.child.pid !== snapshot.processIdentity.processGroupId ||
    snapshot.processIdentity.processGroupId <= 0
  )) {
    throw new Error(`Spawned runtime ${snapshot.runtimeServiceId} lost its exact locally-owned child handle`);
  }
  if (!snapshot.child && !snapshot.claim) {
    throw new Error(`Runtime ${snapshot.runtimeServiceId} has neither durable claim nor exact child ownership`);
  }
}

function assertExactSpawnAbsent(snapshot: PrePersistRuntimeSignalSnapshot) {
  assertExactSpawnReceipt(snapshot);
  if (
    isPidAlive(snapshot.processIdentity.pid) ||
    isProcessGroupAlive(snapshot.processIdentity.processGroupId)
  ) {
    throw new Error(
      `Spawned runtime ${snapshot.runtimeServiceId} does not have conclusive PID and process-group absence`,
    );
  }
}

async function verifyExactSpawnIdentity(snapshot: PrePersistRuntimeSignalSnapshot) {
  assertExactSpawnReceipt(snapshot);
  const verification = await verifyStoredLocalProcessIdentity({
    processPid: snapshot.processIdentity.pid,
    processGroupId: snapshot.processIdentity.processGroupId,
    processStartedAt: new Date(snapshot.processIdentity.processStartedAt),
    processExecutable: snapshot.processIdentity.processExecutable,
    processCommandSha256: snapshot.processIdentity.processCommandSha256,
  });
  if (verification.kind !== "verified") {
    throw new Error(
      `Spawned runtime ${snapshot.runtimeServiceId} strong OS identity changed before signal: ${
        verification.kind === "unproven" ? verification.reason : verification.kind
      }`,
    );
  }
}

async function capturePrePersistRuntimeSignalSnapshot(input: {
  db?: Db;
  companyId: string;
  ownerAgentId: string | null;
  owner: RuntimeOwnerSnapshot | null;
  serviceKey: string;
  runtimeServiceId: string;
  startClaimId: string | null;
  profileKind: string;
  processIdentity: LocalProcessIdentity;
  child: ChildProcess | null;
  registryPolicy?: "exact_or_absent" | "preserve_foreign";
  processExpectation?: "live" | "absent";
}) {
  const registryPolicy = input.registryPolicy ?? "exact_or_absent";
  const processExpectation = input.processExpectation ?? "live";
  const registry = registryPolicy === "preserve_foreign"
    ? null
    : await readOptionalStrictRegistryByServiceKey({
        serviceKey: input.serviceKey,
        profileKind: input.profileKind,
      });
  const claim = input.db && input.startClaimId
    ? await input.db.select().from(workspaceRuntimeStartClaims).where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      )).then((rows) => rows[0] ?? null)
    : null;
  const priorRuntime = input.db
    ? await input.db.select().from(workspaceRuntimeServices).where(and(
        eq(workspaceRuntimeServices.id, input.runtimeServiceId),
        eq(workspaceRuntimeServices.companyId, input.companyId),
      )).then((rows) => rows[0] ?? null)
    : null;
  if (input.db && input.startClaimId) {
    if (
      !claim ||
      claim.claimId !== input.startClaimId ||
      claim.status !== "starting" ||
      claim.runtimeServiceId !== null ||
      claim.ownerAgentId !== input.ownerAgentId
    ) {
      throw new Error(`Pre-persist runtime ${input.runtimeServiceId} lost its exact starting claim`);
    }
    if (priorRuntime && priorRuntime.status !== "stopped") {
      throw new Error(`Pre-persist runtime ${input.runtimeServiceId} gained an active runtime row`);
    }
  }
  const snapshot: PrePersistRuntimeSignalSnapshot = {
    companyId: input.companyId,
    serviceKey: input.serviceKey,
    runtimeServiceId: input.runtimeServiceId,
    startClaimId: input.startClaimId,
    ownerAgentId: input.ownerAgentId,
    owner: input.owner,
    claim,
    priorRuntime,
    registry,
    registryPolicy,
    processExpectation,
    processIdentity: input.processIdentity,
    child: input.child,
  };
  if (registry) assertPrePersistRegistryBinding({ snapshot, registry });
  if (processExpectation === "absent") {
    assertExactSpawnAbsent(snapshot);
  } else {
    await verifyExactSpawnIdentity(snapshot);
  }
  return snapshot;
}

async function sendPrePersistRuntimeSignal(input: {
  db?: Db;
  expected: PrePersistRuntimeSignalSnapshot;
  ownerStartLockHeld: boolean;
  sendSignal: () => void;
}) {
  const execute = async () => {
    await withLocalRuntimeSignalLock(input.expected.serviceKey, async () => {
      const verifyAndSend = async (targetDb?: Db) => {
        if (targetDb && input.expected.owner) {
          const lockedOwner = await lockAgentLifecycleReference(targetDb, {
            companyId: input.expected.companyId,
            agentId: input.expected.owner.id,
            mode: "cleanup",
            allowMissingCleanup: false,
          });
          if (
            !lockedOwner ||
            lockedOwner.companyId !== input.expected.owner.companyId ||
            lockedOwner.status !== input.expected.owner.status
          ) {
            throw new Error(
              `Pre-persist runtime owner ${input.expected.owner.id} changed lifecycle before signal`,
            );
          }
        }
        if (targetDb && input.expected.claim) {
          await lockWorkspaceRuntimeStartClaimFence(targetDb, {
            companyId: input.expected.companyId,
            serviceKey: input.expected.serviceKey,
          });
          const lockedClaim = await targetDb.select().from(workspaceRuntimeStartClaims).where(and(
            eq(workspaceRuntimeStartClaims.companyId, input.expected.companyId),
            eq(workspaceRuntimeStartClaims.serviceKey, input.expected.serviceKey),
          )).for("update").then((rows) => rows[0] ?? null);
          assertRuntimeClaimSignalSnapshot(input.expected.claim, lockedClaim);
          const lockedRuntime = await targetDb.select().from(workspaceRuntimeServices).where(and(
            eq(workspaceRuntimeServices.id, input.expected.runtimeServiceId),
            eq(workspaceRuntimeServices.companyId, input.expected.companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (input.expected.priorRuntime) {
            assertRuntimeRowSignalSnapshot(input.expected.priorRuntime, lockedRuntime);
          } else if (lockedRuntime) {
            throw new Error(`Pre-persist runtime ${input.expected.runtimeServiceId} gained a runtime row before signal`);
          }
        }
        if (input.expected.registryPolicy === "exact_or_absent") {
          const freshRegistry = await readOptionalStrictRegistryByServiceKey({
            serviceKey: input.expected.serviceKey,
            profileKind: "workspace-runtime",
          });
          if (input.expected.registry) {
            if (!freshRegistry) {
              throw new Error(`Pre-persist registry ${input.expected.serviceKey} disappeared before signal`);
            }
            assertRuntimeRegistrySignalSnapshot(input.expected.registry, freshRegistry);
            assertPrePersistRegistryBinding({ snapshot: input.expected, registry: freshRegistry });
            await assertLocalServiceRegistryRecordIdentity(freshRegistry);
          } else if (freshRegistry) {
            throw new Error(`Pre-persist registry ${input.expected.serviceKey} appeared before signal`);
          }
        }
        await verifyExactSpawnIdentity(input.expected);
        input.sendSignal();
      };
      if (input.db) {
        await input.db.transaction(async (tx) => verifyAndSend(tx as unknown as Db));
      } else {
        await verifyAndSend();
      }
    });
  };
  const ownerAgentId = input.expected.owner?.id ?? null;
  if (ownerAgentId && !input.ownerStartLockHeld) {
    await withAgentStartLock(ownerAgentId, execute);
    return;
  }
  await execute();
}

async function assertPrePersistTerminalizationEvidence(
  expected: PrePersistRuntimeSignalSnapshot,
) {
  assertExactSpawnAbsent(expected);
  if (expected.registryPolicy === "preserve_foreign") return;
  const freshRegistry = await readOptionalStrictRegistryByServiceKey({
    serviceKey: expected.serviceKey,
    profileKind: "workspace-runtime",
  });
  if (expected.registry) {
    if (!freshRegistry) {
      throw new Error(`Pre-persist registry ${expected.serviceKey} disappeared before terminalization`);
    }
    assertRuntimeRegistrySignalSnapshot(expected.registry, freshRegistry);
    assertPrePersistRegistryBinding({ snapshot: expected, registry: freshRegistry });
    return;
  }
  if (freshRegistry) {
    throw new Error(`Pre-persist registry ${expected.serviceKey} appeared before terminalization`);
  }
}

async function removeExactRuntimeRegistryAfterTerminalization(input: {
  db?: Db;
  companyId: string;
  ownerAgentId: string | null;
  serviceKey: string;
  profileKind: string;
  expectedRegistry: LocalServiceRegistryRecord;
  expectedClaim?: {
    claimId: string;
    status: "starting" | "running" | "stopped" | "failed";
    runtimeServiceId: string | null;
  };
  expectNoClaim?: boolean;
  ownerStartLockHeld?: boolean;
}) {
  const removeIfExact = async (targetDb?: Db) => {
    if (targetDb && input.ownerAgentId) {
      const owner = await lockAgentLifecycleReference(targetDb, {
        companyId: input.companyId,
        agentId: input.ownerAgentId,
        mode: "cleanup",
        allowMissingCleanup: false,
      });
      if (!owner || owner.companyId !== input.companyId) {
        throw new Error(`Runtime registry cleanup owner ${input.ownerAgentId} changed company binding`);
      }
    }
    if (targetDb && (input.expectedClaim || input.expectNoClaim)) {
      await lockWorkspaceRuntimeStartClaimFence(targetDb, {
        companyId: input.companyId,
        serviceKey: input.serviceKey,
      });
      const lockedClaim = await targetDb.select().from(workspaceRuntimeStartClaims).where(and(
        eq(workspaceRuntimeStartClaims.companyId, input.companyId),
        eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
      )).for("update").then((rows) => rows[0] ?? null);
      if (input.expectNoClaim) {
        if (lockedClaim) {
          throw new Error(`Runtime registry ${input.serviceKey} gained a claim before exact removal`);
        }
      } else if (
        !lockedClaim ||
        lockedClaim.claimId !== input.expectedClaim!.claimId ||
        lockedClaim.status !== input.expectedClaim!.status ||
        lockedClaim.runtimeServiceId !== input.expectedClaim!.runtimeServiceId
      ) {
        throw new Error(`Runtime registry ${input.serviceKey} terminal claim changed before exact removal`);
      }
    }
    const freshRegistry = await readOptionalStrictRegistryByServiceKey({
      serviceKey: input.serviceKey,
      profileKind: input.profileKind,
    });
    if (!freshRegistry) return;
    assertRuntimeRegistrySignalSnapshot(input.expectedRegistry, freshRegistry);
    await removeLocalServiceRegistryRecord(input.serviceKey);
  };

  const execute = async () => withLocalRuntimeSignalLock(input.serviceKey, async () => {
    if (input.db) {
      await input.db.transaction(async (tx) => removeIfExact(tx as unknown as Db));
    } else {
      await removeIfExact();
    }
  });
  if (input.ownerAgentId && !input.ownerStartLockHeld) {
    await withAgentStartLock(input.ownerAgentId, execute);
    return;
  }
  await execute();
}

export function normalizeAdapterManagedRuntimeServices(input: {
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
  now?: Date;
}): RuntimeServiceRef[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  return input.reports.map((report) => {
    const scopeType = report.scopeType ?? "run";
    const scopeId =
      report.scopeId ??
      (scopeType === "project_workspace"
        ? input.workspace.workspaceId
        : scopeType === "execution_workspace"
          ? input.executionWorkspaceId ?? input.workspace.cwd
          : scopeType === "agent"
            ? input.agent.id
            : input.runId) ??
      null;
    const serviceName = asString(report.serviceName, "").trim() || "service";
    const status = report.status ?? "running";
    const lifecycle = report.lifecycle ?? "ephemeral";
    const healthStatus =
      report.healthStatus ??
      (status === "running" ? "healthy" : status === "failed" ? "unhealthy" : "unknown");
    return {
      id: stableRuntimeServiceId({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType,
        scopeId,
        serviceName,
        reportId: report.id ?? null,
        providerRef: report.providerRef ?? null,
        reuseKey: report.reuseKey ?? null,
      }),
      companyId: input.agent.companyId,
      projectId: report.projectId ?? input.workspace.projectId,
      projectWorkspaceId: report.projectWorkspaceId ?? input.workspace.workspaceId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueId: report.issueId ?? input.issue?.id ?? null,
      serviceName,
      status,
      lifecycle,
      scopeType,
      scopeId,
      reuseKey: report.reuseKey ?? null,
      command: report.command ?? null,
      cwd: report.cwd ?? null,
      port: report.port ?? null,
      url: report.url ?? null,
      provider: "adapter_managed",
      providerRef: report.providerRef ?? null,
      ownerAgentId: input.agent.id ?? null,
      startedByRunId: input.runId,
      lastUsedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === "running" || status === "starting" ? null : nowIso,
      stopPolicy: report.stopPolicy ?? null,
      healthStatus,
      reused: false,
    };
  });
}

type StartLocalRuntimeServiceInput = {
  db?: Db;
  runId: string;
  leaseRunId?: string | null;
  startedByRunId?: string | null;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  adapterEnv: Record<string, string>;
  service: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  reuseKey: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  startClaimId?: string | null;
  terminate?: typeof terminateLocalService;
  afterSpawnedBeforeReadiness?: (input: {
    serviceKey: string;
    runtimeServiceId: string;
    pid: number;
    processGroupId: number;
  }) => Promise<void>;
};

function resolveLocalRuntimeServiceKey(input: Pick<
  StartLocalRuntimeServiceInput,
  "agent" | "issue" | "workspace" | "adapterEnv" | "service" | "reuseKey" | "scopeType" | "scopeId" | "executionWorkspaceId"
>) {
  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  return createLocalServiceKey({
    companyId: input.agent.companyId,
    profileKind: "workspace-runtime",
    serviceName: identity.serviceName,
    cwd: identity.serviceCwd,
    command: identity.command,
    envFingerprint: input.reuseKey ?? identity.envFingerprint,
    port: identity.identityPort,
    scope: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      reuseKey: input.reuseKey,
    },
  });
}

async function startLocalRuntimeService(input: StartLocalRuntimeServiceInput): Promise<RuntimeServiceRecord> {
  const leaseRunId = input.leaseRunId === undefined ? input.runId : input.leaseRunId;
  const startedByRunId = input.startedByRunId === undefined ? input.runId : input.startedByRunId;
  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  const serviceName = identity.serviceName;
  const lifecycle = identity.lifecycle;
  const command = identity.command;
  if (!command) throw new Error(`Runtime service "${serviceName}" is missing command`);
  const portConfig = parseObject(input.service.port);
  const envConfig = identity.envConfig;
  const envFingerprint = identity.envFingerprint;
  const serviceIdentityFingerprint = input.reuseKey ?? envFingerprint;
  const explicitPort = identity.explicitPort;
  const identityPort = identity.identityPort;
  const stoppedReuseCandidate = await findStoppedRuntimeServiceReuseCandidate({
    db: input.db,
    companyId: input.agent.companyId,
    reuseKey: input.reuseKey,
  });
  let reusableStoppedPort: number | null = null;
  if (asString(portConfig.type, "") === "auto" && stoppedReuseCandidate?.port) {
    const ownerPid = await readLocalServicePortOwner(stoppedReuseCandidate.port);
    reusableStoppedPort = ownerPid ? null : stoppedReuseCandidate.port;
  }
  const port =
    asString(portConfig.type, "") === "auto"
      ? (reusableStoppedPort ?? await allocatePort())
      : explicitPort > 0
        ? explicitPort
        : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port,
  });
  const serviceCwd =
    port === identityPort
      ? identity.serviceCwd
      : resolveConfiguredPath(renderTemplate(asString(input.service.cwd, "."), templateData), input.workspace.cwd);
  const env: Record<string, string> = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
  } as Record<string, string>;
  for (const [key, value] of Object.entries(renderRuntimeServiceEnv({ envConfig, templateData }))) {
    env[key] = value;
  }
  if (port) {
    const portEnvKey = asString(portConfig.envKey, "PORT");
    env[portEnvKey] = String(port);
  }

  const expose = parseObject(input.service.expose);
  const readiness = parseObject(input.service.readiness);
  const urlTemplate =
    asString(expose.urlTemplate, "") ||
    asString(readiness.urlTemplate, "");
  const url = urlTemplate ? renderTemplate(urlTemplate, templateData) : null;
  const stopPolicy = parseObject(input.service.stopPolicy);
  const serviceKey = resolveLocalRuntimeServiceKey(input);
  const ownerLifecycleAtStart = input.db
    ? await readRuntimeOwnerSnapshot({
        db: input.db,
        companyId: input.agent.companyId,
        ownerAgentId: input.agent.id,
      })
    : null;
  if (
    ownerLifecycleAtStart?.status === "terminated" ||
    ownerLifecycleAtStart?.status === "pending_approval"
  ) {
    throw new Error(`Runtime service owner ${ownerLifecycleAtStart.id} changed lifecycle before start`);
  }
  const adoptedRecord = await findAdoptableLocalServiceStrict({
    serviceKey,
    profileKind: "workspace-runtime",
    serviceName,
    command,
    cwd: serviceCwd,
    envFingerprint: serviceIdentityFingerprint,
    port: identityPort,
    url,
  });
  if (adoptedRecord) {
    if (adoptedRecord.metadata?.companyId !== input.agent.companyId) {
      throw new Error(
        `Local service registry ${adoptedRecord.serviceKey} has no matching company binding (cross-tenant adoption forbidden)`,
      );
    }
    const adoptedUrl = adoptedRecord.url ?? url;
    if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName, command }))) {
      try {
        if (!input.db || !input.startClaimId || !adoptedRecord.runtimeServiceId) {
          throw new Error(
            `Unhealthy adopted runtime ${adoptedRecord.serviceKey} has no exact durable cleanup binding`,
          );
        }
        const snapshot = await capturePrePersistRuntimeSignalSnapshot({
          db: input.db,
          companyId: input.agent.companyId,
          ownerAgentId: input.agent.id,
          owner: ownerLifecycleAtStart,
          serviceKey,
          runtimeServiceId: adoptedRecord.runtimeServiceId,
          startClaimId: input.startClaimId,
          profileKind: "workspace-runtime",
          processIdentity: requireStrongRegistryProcessIdentity(adoptedRecord),
          child: null,
        });
        await (input.terminate ?? terminateLocalService)(adoptedRecord, {
          signalWithinFence: async (_signal, sendSignal) => {
            await sendPrePersistRuntimeSignal({
              db: input.db,
              expected: snapshot,
              ownerStartLockHeld: Boolean(input.agent.id),
              sendSignal,
            });
          },
        });
        await waitForExactLocalProcessExit({
          pid: adoptedRecord.pid,
          processGroupId: adoptedRecord.processGroupId,
          label: "Unhealthy adopted runtime process",
        });
        await removeExactRuntimeRegistryAfterTerminalization({
          db: input.db,
          companyId: input.agent.companyId,
          ownerAgentId: input.agent.id,
          serviceKey,
          profileKind: "workspace-runtime",
          expectedRegistry: adoptedRecord,
          expectedClaim: {
            claimId: input.startClaimId,
            status: "starting",
            runtimeServiceId: null,
          },
          ownerStartLockHeld: Boolean(input.agent.id),
        });
      } catch (error) {
        throw new RuntimeCleanupQuarantinedError(
          `Unhealthy adopted runtime ${adoptedRecord.serviceKey} cleanup was quarantined`,
          error,
        );
      }
    } else {
      const adoptedRuntimeServiceId = adoptedRecord.runtimeServiceId ?? randomUUID();
      if (!adoptedRecord.runtimeServiceId) {
        await touchLocalServiceRegistryRecord(adoptedRecord.serviceKey, {
          runtimeServiceId: adoptedRuntimeServiceId,
        });
      }
      return {
        id: adoptedRuntimeServiceId,
        companyId: input.agent.companyId,
        projectId: input.workspace.projectId,
        projectWorkspaceId: input.workspace.workspaceId,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        issueId: input.issue?.id ?? null,
        serviceName,
        status: "running",
        lifecycle,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        reuseKey: input.reuseKey,
        command,
        cwd: serviceCwd,
        port: adoptedRecord.port ?? port,
        url: adoptedRecord.url ?? url,
        provider: "local_process",
        // Persist the detached process-group boundary. The verified listener
        // pid can differ from the shell leader; startup absence checks must
        // never forget still-live sibling processes after registry loss.
        providerRef: String(adoptedRecord.processGroupId ?? adoptedRecord.pid),
        ownerAgentId: input.agent.id ?? null,
        startedByRunId,
        lastUsedAt: new Date().toISOString(),
        startedAt: adoptedRecord.startedAt,
        stoppedAt: null,
        stopPolicy,
        healthStatus: "healthy",
        reused: true,
        db: input.db,
        child: null,
        leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
        idleTimer: null,
        envFingerprint,
        serviceKey,
        profileKind: "workspace-runtime",
        processGroupId: adoptedRecord.processGroupId ?? null,
      };
    }
  }
  if (identityPort) {
    const ownerPid = await readLocalServicePortOwner(identityPort);
    if (ownerPid) {
      throw new Error(
        `Runtime service "${serviceName}" could not start because port ${identityPort} is already in use by pid ${ownerPid}`,
      );
    }
  }

  await ensureServerWorkspaceLinksCurrent(serviceCwd, {
    onLog: input.onLog,
  });

  const runtimeServiceId = stoppedReuseCandidate?.id ?? randomUUID();
  const shell = resolveShell();
  const spawnedAt = new Date().toISOString();
  const child = spawn(shell, ["-lc", command], {
    cwd: serviceCwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitLatch: NonNullable<RuntimeServiceRecord["exitLatch"]> = { exit: null };
  child.once("exit", (code, signal) => {
    exitLatch.exit ??= { code, signal, at: new Date().toISOString() };
  });
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      reject(err);
    });
  });
  let stderrExcerpt = "";
  let stdoutExcerpt = "";
  child.stdout?.on("data", async (chunk) => {
    const text = String(chunk);
    stdoutExcerpt = (stdoutExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stdout", `[service:${serviceName}] ${text}`);
  });
  child.stderr?.on("data", async (chunk) => {
    const text = String(chunk);
    stderrExcerpt = (stderrExcerpt + text).slice(-4096);
    if (input.onLog) await input.onLog("stderr", `[service:${serviceName}] ${text}`);
  });

  let spawnedProcessIdentity: LocalProcessIdentity | null = null;
  let processIdentity: LocalProcessIdentity;
  try {
    if (!child.pid) {
      throw new Error("Spawned runtime service did not expose a process id");
    }
    spawnedProcessIdentity = await Promise.race([
      captureSpawnedLocalProcessIdentity({
        pid: child.pid,
        processGroupId: process.platform === "win32" ? null : child.pid,
        startedAt: spawnedAt,
      }),
      spawnErrorPromise,
    ]);
    await input.afterSpawnedBeforeReadiness?.({
      serviceKey,
      runtimeServiceId,
      pid: spawnedProcessIdentity.pid,
      processGroupId: spawnedProcessIdentity.processGroupId,
    });
    await Promise.race([
      waitForReadiness({ service: input.service, url }),
      spawnErrorPromise,
    ]);
    if (!child.pid) {
      throw new Error("Spawned runtime service did not expose a process id");
    }
    // The detached shell is the process-group leader, but a long-running
    // service may be a child (and the leader may exit after launching it).
    // Capture the actual listener identity when available while retaining the
    // original PGID as the group-wide termination boundary.
    const serviceProcessId = port ? await readLocalServicePortOwner(port) : null;
    processIdentity = await captureSpawnedLocalProcessIdentity({
      pid: serviceProcessId ?? child.pid,
      processGroupId: process.platform === "win32" ? null : child.pid,
      startedAt: spawnedAt,
    });
  } catch (err) {
    const primary = new Error(
      `Failed to start runtime service "${serviceName}": ${err instanceof Error ? err.message : String(err)}${stderrExcerpt ? ` | stderr: ${stderrExcerpt.trim()}` : ""}`,
    );
    if (!spawnedProcessIdentity) {
      const pid = child.pid;
      if (!pid || (!isPidAlive(pid) && !isProcessGroupAlive(process.platform === "win32" ? null : pid))) {
        throw primary;
      }
      throw new AggregateError(
        [primary, new RuntimeCleanupQuarantinedError(
          `Spawned runtime process ${pid} cleanup was quarantined because strong spawn identity was unavailable`,
          err,
        )],
        `${primary.message}; spawned-process cleanup was quarantined without strong identity`,
      );
    }
    try {
      await terminateSpawnedChildProcessClosed({
        child,
        processIdentity: spawnedProcessIdentity,
        db: input.db,
        companyId: input.agent.companyId,
        ownerAgentId: input.agent.id,
        owner: ownerLifecycleAtStart,
        serviceKey,
        runtimeServiceId,
        startClaimId: input.startClaimId ?? null,
        profileKind: "workspace-runtime",
        terminate: input.terminate ?? terminateLocalService,
        ownerStartLockHeld: Boolean(input.db && input.agent.id),
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        `${primary.message}; spawned-process cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw primary;
  }

  const record: RuntimeServiceRecord = {
    id: runtimeServiceId,
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName,
    status: "running",
    lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command,
    cwd: serviceCwd,
    port,
    url,
    provider: "local_process",
    providerRef: child.pid ? String(child.pid) : null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId,
    lastUsedAt: new Date().toISOString(),
    startedAt: spawnedAt,
    stoppedAt: null,
    stopPolicy,
    healthStatus: "healthy",
    reused: false,
    db: input.db,
    child,
    leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
    idleTimer: null,
    envFingerprint,
    serviceKey,
    profileKind: "workspace-runtime",
    processGroupId: child.pid ?? null,
    startClaimId: input.startClaimId ?? null,
    startFinalizationState: input.startClaimId ? "pending" : "running",
    exitLatch,
    processIdentity,
    ownerLifecycleStatusAtStart: ownerLifecycleAtStart?.status ?? null,
  };

  if (child.pid) {
    try {
      await writeLocalServiceRegistryRecord({
        version: 2,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName,
        command,
        cwd: serviceCwd,
        envFingerprint: serviceIdentityFingerprint,
        port,
        url,
        pid: processIdentity.pid,
        processGroupId: child.pid,
        processStartedAt: processIdentity.processStartedAt,
        processExecutable: processIdentity.processExecutable,
        processCommandSha256: processIdentity.processCommandSha256,
        provider: "local_process",
        runtimeServiceId: record.id,
        reuseKey: input.reuseKey,
        startedAt: record.startedAt,
        lastSeenAt: record.lastUsedAt,
        metadata: {
          companyId: record.companyId,
          ownerAgentId: record.ownerAgentId,
          projectId: record.projectId,
          projectWorkspaceId: record.projectWorkspaceId,
          executionWorkspaceId: record.executionWorkspaceId,
          issueId: record.issueId,
          scopeType: record.scopeType,
          scopeId: record.scopeId,
          startClaimId: input.startClaimId ?? null,
        },
      }, { mode: "create" });
    } catch (error) {
      const primary = new Error(
        `Failed to publish runtime service "${serviceName}" registry evidence: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (input.db && input.startClaimId && errorChainHasCode(error, "EEXIST")) {
        // The colliding registry belongs to an unknown/foreign process and is
        // immutable evidence. Carry the exact locally spawned record to the
        // claim-aware failed-start path; it must signal only this child and
        // must never parse, signal, replace, or remove the foreign registry.
        throw new RuntimeRegistryPublicationCollisionError(primary, record);
      }
      try {
        await terminateSpawnedChildProcessClosed({
          child,
          processIdentity,
          db: input.db,
          companyId: input.agent.companyId,
          ownerAgentId: input.agent.id,
          owner: ownerLifecycleAtStart,
          serviceKey,
          runtimeServiceId,
          startClaimId: input.startClaimId ?? null,
          profileKind: "workspace-runtime",
          terminate: input.terminate ?? terminateLocalService,
          ownerStartLockHeld: Boolean(input.db && input.agent.id),
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [primary, cleanupError],
          `${primary.message}; spawned-process cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw primary;
    }
  }

  return record;
}

function scheduleIdleStop(record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(record.id).catch(() => undefined);
  }, idleSeconds * 1000);
}

type RuntimeServiceStopDependencies = {
  terminateLocalService?: typeof terminateLocalService;
  afterStopClassifiedBeforeSignal?: (record: RuntimeServiceRef) => Promise<void>;
  afterStopTerminalizedBeforeRegistryRemove?: (record: RuntimeServiceRef) => Promise<void>;
};

function removeRuntimeServiceFromMemory(record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const ownsMemorySlot = runtimeServicesById.get(record.id) === record;
  if (ownsMemorySlot) {
    runtimeServicesById.delete(record.id);
  }
  if (
    ownsMemorySlot &&
    record.reuseKey &&
    runtimeServicesByReuseKey.get(runtimeServiceReuseMapKey(record.companyId, record.reuseKey)) === record.id
  ) {
    runtimeServicesByReuseKey.delete(runtimeServiceReuseMapKey(record.companyId, record.reuseKey));
  }
}

async function persistStoppedRuntimeAfterExit(input: {
  record: RuntimeServiceRecord;
  snapshot: DurableRuntimeSignalSnapshot;
}) {
  const { record, snapshot } = input;
  const now = new Date();
  await terminalizeWorkspaceRuntimeStartClaim({
    db: record.db!,
    companyId: snapshot.row.companyId,
    serviceKey: snapshot.claim.serviceKey,
    claimId: snapshot.claim.claimId,
    runtimeServiceId: snapshot.row.id,
    expectedStatus: snapshot.claim.status as "running",
    expectedRuntimeServiceId: snapshot.row.id,
    terminalStatus: "stopped",
    failureCode: null,
    persist: async (txDb) => {
      const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
        eq(workspaceRuntimeServices.id, snapshot.row.id),
        eq(workspaceRuntimeServices.companyId, snapshot.row.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      assertRuntimeRowSignalSnapshot(snapshot.row, locked);
      const updated = await txDb.update(workspaceRuntimeServices).set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      }).where(and(
        eq(workspaceRuntimeServices.id, snapshot.row.id),
        eq(workspaceRuntimeServices.companyId, snapshot.row.companyId),
        eq(workspaceRuntimeServices.status, snapshot.row.status),
      )).returning({ id: workspaceRuntimeServices.id });
      if (updated.length !== 1) {
        throw new Error(`Runtime service ${snapshot.row.id} stop terminalization CAS failed`);
      }
    },
  });
}

async function stopRuntimeService(
  serviceId: string,
  dependencies?: RuntimeServiceStopDependencies,
) {
  const record = runtimeServicesById.get(serviceId);
  if (!record) return;
  const terminate = dependencies?.terminateLocalService ?? terminateLocalService;
  let durableSnapshot: DurableRuntimeSignalSnapshot | null = null;
  let localSnapshot: PrePersistRuntimeSignalSnapshot | null = null;
  if (record.db) {
    durableSnapshot = await captureDurableRuntimeSignalSnapshot(record);
  } else {
    if (!record.child || !record.processIdentity) {
      throw new Error(`Runtime service ${record.id} has no exact locally-owned spawn identity`);
    }
    localSnapshot = await capturePrePersistRuntimeSignalSnapshot({
      companyId: record.companyId,
      ownerAgentId: record.ownerAgentId,
      owner: null,
      serviceKey: record.serviceKey,
      runtimeServiceId: record.id,
      startClaimId: null,
      profileKind: record.profileKind,
      processIdentity: record.processIdentity,
      child: record.child,
    });
  }
  await dependencies?.afterStopClassifiedBeforeSignal?.(toRuntimeServiceRef(record));

  const target = durableSnapshot?.registry ?? localSnapshot?.registry ?? null;
  if (!target) {
    throw new Error(`Runtime service ${record.id} has no exact registry evidence for stop`);
  }
  const targetAlive = isPidAlive(target.pid) || isProcessGroupAlive(target.processGroupId);
  if (targetAlive) {
    try {
      await terminate(target, {
        signalWithinFence: async (_signal, sendSignal) => {
          const sendSignalAndLatchTerminalization = () => {
            sendSignal();
            // Latch synchronously after the OS accepted the signal, while the
            // durable fence transaction is still holding Claim+Runtime locks.
            record.startFinalizationState = "terminalizing";
          };
          if (durableSnapshot) {
            await sendDurableRuntimeSignal({
              db: record.db!,
              expected: durableSnapshot,
              sendSignal: sendSignalAndLatchTerminalization,
            });
          } else {
            await sendPrePersistRuntimeSignal({
              expected: localSnapshot!,
              ownerStartLockHeld: false,
              sendSignal: sendSignalAndLatchTerminalization,
            });
          }
        },
      });
      await waitForExactLocalProcessExit({
        pid: target.pid,
        processGroupId: target.processGroupId,
        label: "Runtime service process",
      });
    } catch (error) {
      throw new RuntimeCleanupQuarantinedError(
        `Runtime service ${record.id} stop was quarantined before exact exit proof`,
        error,
      );
    }
  }

  if (durableSnapshot) {
    await persistStoppedRuntimeAfterExit({ record, snapshot: durableSnapshot });
  }
  await dependencies?.afterStopTerminalizedBeforeRegistryRemove?.(toRuntimeServiceRef(record));
  await removeExactRuntimeRegistryAfterTerminalization({
    db: record.db,
    companyId: record.companyId,
    ownerAgentId: record.ownerAgentId,
    serviceKey: record.serviceKey,
    profileKind: record.profileKind,
    expectedRegistry: target,
    expectedClaim: durableSnapshot
      ? {
          claimId: durableSnapshot.claim.claimId,
          status: "stopped",
          runtimeServiceId: durableSnapshot.row.id,
        }
      : undefined,
  });
  const stoppedAt = new Date().toISOString();
  record.status = "stopped";
  record.healthStatus = "unknown";
  record.lastUsedAt = stoppedAt;
  record.stoppedAt = stoppedAt;
  record.startFinalizationState = "terminalizing";
  removeRuntimeServiceFromMemory(record);
}

async function terminalizeExitedRuntimeService(record: RuntimeServiceRecord) {
  const current = runtimeServicesById.get(record.id);
  if (!current || current.startFinalizationState === "pending" || current.startFinalizationState === "terminalizing") {
    return;
  }
  try {
    const registry = await readUniqueStrictRuntimeRegistry({
      runtimeServiceId: current.id,
      serviceKey: current.serviceKey,
      profileKind: current.profileKind,
    });
    const verification = await verifyLocalServiceRegistryRecordIdentity(registry);
    if (verification.kind === "verified") {
      // The shell leader may exit after launching a background descendant. The
      // strict registry identifies that still-live listener, so retain the
      // running durable binding and continue as an adopted/detached service.
      current.child = null;
      return;
    }
    if (verification.kind === "unproven" || isProcessGroupAlive(registry.processGroupId)) {
      current.child = null;
      logger.error(
        {
          runtimeServiceId: current.id,
          serviceKey: current.serviceKey,
          verification: verification.kind,
          processGroupId: registry.processGroupId,
        },
        "workspace runtime child exited but total process-group absence is unproven; preserving durable evidence",
      );
      return;
    }

    const exit = current.exitLatch?.exit;
    const terminalStatus = exit?.code === 0 || exit?.signal === "SIGTERM" ? "stopped" : "failed";
    const terminalAt = exit?.at ?? new Date().toISOString();
    const terminalRecord: RuntimeServiceRecord = {
      ...current,
      status: terminalStatus,
      healthStatus: terminalStatus === "failed" ? "unhealthy" : "unknown",
      lastUsedAt: terminalAt,
      stoppedAt: terminalAt,
      startFinalizationState: "terminalizing",
    };

    if (current.db && current.startClaimId) {
      const snapshot = await captureDurableRuntimeSignalSnapshot(current);
      await terminalizeWorkspaceRuntimeStartClaim({
        db: current.db,
        companyId: current.companyId,
        serviceKey: current.serviceKey,
        claimId: current.startClaimId,
        runtimeServiceId: current.id,
        expectedStatus: "running",
        expectedRuntimeServiceId: current.id,
        terminalStatus,
        failureCode: terminalStatus === "failed" ? "runtime_process_exited" : null,
        persist: async (txDb) => {
          const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
            eq(workspaceRuntimeServices.id, current.id),
            eq(workspaceRuntimeServices.companyId, current.companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          assertRuntimeRowSignalSnapshot(snapshot.row, locked);
          const freshRegistry = await readUniqueStrictRuntimeRegistry({
            runtimeServiceId: current.id,
            serviceKey: current.serviceKey,
            profileKind: current.profileKind,
          });
          assertRuntimeRegistrySignalSnapshot(snapshot.registry, freshRegistry);
          assertPersistedRuntimeRegistryClaimBinding({
            row: locked!,
            claim: snapshot.claim,
            registry: freshRegistry,
          });
          const freshVerification = await verifyLocalServiceRegistryRecordIdentity(freshRegistry);
          if (freshVerification.kind !== "not_running" || isProcessGroupAlive(freshRegistry.processGroupId)) {
            throw new Error("Runtime process or process group became live before atomic exit terminalization");
          }
          await upsertRuntimeServiceRecord(txDb, toPersistedWorkspaceRuntimeService(terminalRecord));
        },
      });
    } else {
      await withLocalRuntimeSignalLock(current.serviceKey, async () => {
        const freshRegistry = await readUniqueStrictRuntimeRegistry({
          runtimeServiceId: current.id,
          serviceKey: current.serviceKey,
          profileKind: current.profileKind,
        });
        assertRuntimeRegistrySignalSnapshot(registry, freshRegistry);
        const freshVerification = await verifyLocalServiceRegistryRecordIdentity(freshRegistry);
        if (freshVerification.kind !== "not_running" || isProcessGroupAlive(freshRegistry.processGroupId)) {
          throw new Error("Runtime process or process group became live before local exit terminalization");
        }
      });
    }
    await removeExactRuntimeRegistryAfterTerminalization({
      db: current.db,
      companyId: current.companyId,
      ownerAgentId: current.ownerAgentId,
      serviceKey: current.serviceKey,
      profileKind: current.profileKind,
      expectedRegistry: registry,
      expectedClaim: current.db && current.startClaimId
        ? {
            claimId: current.startClaimId,
            status: terminalStatus,
            runtimeServiceId: current.id,
          }
        : undefined,
    });
    Object.assign(current, terminalRecord);
    removeRuntimeServiceFromMemory(current);
  } catch (error) {
    current.child = null;
    logger.error(
      { err: error, runtimeServiceId: current.id, startClaimId: current.startClaimId ?? null },
      "failed to prove and atomically terminalize exited workspace runtime service; preserving evidence",
    );
  }
}

function registerRuntimeService(db: Db | undefined, record: RuntimeServiceRecord) {
  record.db = db;
  runtimeServicesById.set(record.id, record);
  if (record.reuseKey) {
    runtimeServicesByReuseKey.set(runtimeServiceReuseMapKey(record.companyId, record.reuseKey), record.id);
  }

  record.child?.on("exit", () => {
    void terminalizeExitedRuntimeService(record);
  });
}

async function withRuntimeServiceOwnerStartFence<T>(input: {
  db?: Db;
  agent: ExecutionWorkspaceAgentRef;
  run: () => Promise<T>;
}) {
  if (!input.db || !input.agent.id) return input.run();
  return withAgentStartLock(input.agent.id, async () => {
    // This short transaction performs the pre-spawn check. It is deliberately
    // released before external process creation; the final active-row upsert
    // repeats the check atomically to catch cross-process lifecycle drift.
    await assertRuntimeServiceOwnerActive({
      db: input.db!,
      companyId: input.agent.companyId,
      ownerAgentId: input.agent.id!,
    });
    return input.run();
  });
}

function assertRuntimeRegistryBinding(input: {
  record: RuntimeServiceRecord;
  registry: Awaited<ReturnType<typeof findLocalServiceRegistryRecordByRuntimeServiceId>>;
  startClaimId: string;
}) {
  const { record, registry } = input;
  if (!registry) throw new Error("Started runtime service has no verified registry process identity");
  const metadata = registry.metadata ?? {};
  const mismatch =
    registry.runtimeServiceId !== record.id ||
    registry.serviceKey !== record.serviceKey ||
    registry.profileKind !== record.profileKind ||
    registry.serviceName !== record.serviceName ||
    registry.command !== record.command ||
    !record.cwd ||
    path.resolve(registry.cwd) !== path.resolve(record.cwd) ||
    (record.reuseKey !== null && registry.envFingerprint !== record.reuseKey) ||
    registry.reuseKey !== record.reuseKey ||
    registry.port !== record.port ||
    metadata.companyId !== record.companyId ||
    metadata.ownerAgentId !== record.ownerAgentId ||
    metadata.projectId !== record.projectId ||
    metadata.projectWorkspaceId !== record.projectWorkspaceId ||
    metadata.executionWorkspaceId !== record.executionWorkspaceId ||
    metadata.issueId !== record.issueId ||
    metadata.scopeType !== record.scopeType ||
    metadata.scopeId !== record.scopeId ||
    metadata.startClaimId !== input.startClaimId;
  if (mismatch) {
    throw new Error("Started runtime service registry does not match its exact runtime and claim binding");
  }
}

async function assertStartedRuntimeServiceReadyForFinalization(input: {
  record: RuntimeServiceRecord;
  startClaimId: string;
}) {
  if (input.record.exitLatch?.exit) {
    throw new Error("Started runtime service exited before start-claim finalization");
  }
  const matches = (await listLocalServiceRegistryRecordsStrict({
    profileKind: input.record.profileKind,
  })).filter((candidate) => candidate.runtimeServiceId === input.record.id);
  if (matches.length !== 1) {
    throw new Error("Started runtime service has no unique registry process identity");
  }
  const registry = matches[0]!;
  assertRuntimeRegistryBinding({ ...input, registry });
  await assertLocalServiceRegistryRecordIdentity(registry!);
  if (!isPidAlive(registry!.pid) && !isProcessGroupAlive(registry!.processGroupId)) {
    throw new Error("Started runtime service process is not running before start-claim finalization");
  }
  if (input.record.exitLatch?.exit) {
    throw new Error("Started runtime service exited before start-claim finalization");
  }
}

async function failStartedRuntimeServiceClosed(input: {
  record: RuntimeServiceRecord;
  cause: unknown;
  terminate: typeof terminateLocalService;
  claim?: {
    companyId: string;
    serviceKey: string;
    claimId: string;
  };
  preserveForeignRegistryEvidence?: boolean;
}): Promise<never> {
  const primary = input.cause instanceof Error ? input.cause : new Error(String(input.cause));
  const { record } = input;
  const claimWasRunning = record.startFinalizationState === "running";
  if (!record.child || !record.processIdentity) {
    throw new AggregateError(
      [primary, new RuntimeCleanupQuarantinedError(
        `Failed-start runtime service ${record.id} has no exact locally-owned child and spawn identity`,
        primary,
      )],
      `Runtime service start failed and cleanup was quarantined without exact spawn ownership: ${primary.message}`,
    );
  }

  const expectedOwner = record.ownerAgentId && record.ownerLifecycleStatusAtStart
    ? {
        id: record.ownerAgentId,
        companyId: record.companyId,
        status: record.ownerLifecycleStatusAtStart as RuntimeOwnerSnapshot["status"],
      }
    : null;
  let durableSnapshot: DurableRuntimeSignalSnapshot | null = null;
  let prePersistSnapshot: PrePersistRuntimeSignalSnapshot | null = null;
  let registryForRemoval: LocalServiceRegistryRecord | null = null;
  try {
    if (record.db && input.claim && claimWasRunning) {
      durableSnapshot = await captureDurableRuntimeSignalSnapshot(record);
      if (
        expectedOwner &&
        (!durableSnapshot.owner || durableSnapshot.owner.status !== expectedOwner.status)
      ) {
        throw new Error(`Failed-start runtime owner ${expectedOwner.id} changed lifecycle before signal`);
      }
    } else {
      const processExpectation =
        !isPidAlive(record.processIdentity.pid) &&
        !isProcessGroupAlive(record.processIdentity.processGroupId)
          ? "absent"
          : "live";
      prePersistSnapshot = await capturePrePersistRuntimeSignalSnapshot({
        db: record.db,
        companyId: record.companyId,
        ownerAgentId: record.ownerAgentId,
        owner: expectedOwner,
        serviceKey: record.serviceKey,
        runtimeServiceId: record.id,
        startClaimId: input.claim?.claimId ?? record.startClaimId ?? null,
        profileKind: record.profileKind,
        processIdentity: record.processIdentity,
        child: record.child,
        registryPolicy: input.preserveForeignRegistryEvidence
          ? "preserve_foreign"
          : "exact_or_absent",
        processExpectation,
      });
    }
    const registry = durableSnapshot?.registry ?? prePersistSnapshot?.registry ?? (
      input.preserveForeignRegistryEvidence
        ? {
            pid: record.processIdentity.pid,
            processGroupId: record.processIdentity.processGroupId,
          }
        : null
    );
    if (!registry) {
      throw new Error(`Failed-start runtime service ${record.id} lost its exact registry identity`);
    }
    registryForRemoval = input.preserveForeignRegistryEvidence
      ? null
      : (durableSnapshot?.registry ?? prePersistSnapshot?.registry ?? null);
    if (isPidAlive(registry.pid) || isProcessGroupAlive(registry.processGroupId)) {
      await input.terminate(registry, {
        signalWithinFence: async (_signal, sendSignal) => {
          const sendSignalAndLatchTerminalization = () => {
            sendSignal();
            record.startFinalizationState = "terminalizing";
          };
          if (durableSnapshot) {
            await sendDurableRuntimeSignal({
              db: record.db!,
              expected: durableSnapshot,
              ownerStartLockHeld: true,
              sendSignal: sendSignalAndLatchTerminalization,
            });
          } else {
            await sendPrePersistRuntimeSignal({
              db: record.db,
              expected: prePersistSnapshot!,
              ownerStartLockHeld: Boolean(record.db && record.ownerAgentId),
              sendSignal: sendSignalAndLatchTerminalization,
            });
          }
        },
      });
      await waitForExactLocalProcessExit({
        pid: registry.pid,
        processGroupId: registry.processGroupId,
        label: "Failed-start runtime process",
      });
    }
  } catch (error) {
    const cleanupFailure = error instanceof Error ? error : new Error(String(error));
    throw new AggregateError(
      [primary, new RuntimeCleanupQuarantinedError(
        `Failed-start runtime service ${record.id} cleanup was quarantined before exact exit proof`,
        cleanupFailure,
      )],
      `Runtime service start failed lifecycle validation and cleanup was quarantined: ${primary.message}; ${cleanupFailure.message}`,
    );
  }

  const terminalAt = new Date().toISOString();
  const terminalRecord: RuntimeServiceRecord = {
    ...record,
    status: "failed",
    healthStatus: "unhealthy",
    lastUsedAt: terminalAt,
    stoppedAt: terminalAt,
    startFinalizationState: "terminalizing",
  };
  if (record.db && input.claim) {
    const expectedRuntime = durableSnapshot?.row ?? prePersistSnapshot?.priorRuntime ?? null;
    await terminalizeWorkspaceRuntimeStartClaim({
      db: record.db,
      companyId: input.claim.companyId,
      serviceKey: input.claim.serviceKey,
      claimId: input.claim.claimId,
      runtimeServiceId: record.id,
      expectedStatus: claimWasRunning ? "running" : "starting",
      expectedRuntimeServiceId: claimWasRunning ? record.id : null,
      terminalStatus: "failed",
      failureCode: record.exitLatch?.exit
        ? "child_exited_before_finalization"
        : "finalization_failed",
      persist: async (txDb) => {
        const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
          eq(workspaceRuntimeServices.id, record.id),
          eq(workspaceRuntimeServices.companyId, record.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (prePersistSnapshot) {
          await assertPrePersistTerminalizationEvidence(prePersistSnapshot);
        }
        if (expectedRuntime) {
          assertRuntimeRowSignalSnapshot(expectedRuntime, locked);
          await upsertRuntimeServiceRecord(txDb, toPersistedWorkspaceRuntimeService(terminalRecord));
        } else {
          if (locked) {
            throw new Error(`Failed-start runtime ${record.id} gained a runtime row before terminalization`);
          }
          await txDb.insert(workspaceRuntimeServices)
            .values(toPersistedWorkspaceRuntimeService(terminalRecord));
        }
      },
    });
  }

  if (registryForRemoval) {
    await removeExactRuntimeRegistryAfterTerminalization({
      db: record.db,
      companyId: record.companyId,
      ownerAgentId: record.ownerAgentId,
      serviceKey: record.serviceKey,
      profileKind: record.profileKind,
      expectedRegistry: registryForRemoval,
      expectedClaim: input.claim
        ? {
            claimId: input.claim.claimId,
            status: "failed",
            runtimeServiceId: claimWasRunning ? record.id : null,
          }
        : undefined,
      ownerStartLockHeld: Boolean(record.db && record.ownerAgentId),
    });
  } else if (!input.preserveForeignRegistryEvidence) {
    throw new Error(`Failed-start runtime service ${record.id} lost registry removal evidence`);
  }
  Object.assign(record, terminalRecord);
  removeRuntimeServiceFromMemory(record);
  throw primary;
}

async function loadClaimedRuntimeService(input: {
  db: Db;
  companyId: string;
  serviceKey: string;
  claimId: string;
  runtimeServiceId: string;
  leaseRunId: string | null;
}) {
  const claim = await input.db
    .select()
    .from(workspaceRuntimeStartClaims)
    .where(and(
      eq(workspaceRuntimeStartClaims.companyId, input.companyId),
      eq(workspaceRuntimeStartClaims.serviceKey, input.serviceKey),
    ))
    .then((rows) => rows[0] ?? null);
  if (
    !claim ||
    claim.claimId !== input.claimId ||
    claim.status !== "running" ||
    claim.runtimeServiceId !== input.runtimeServiceId
  ) {
    throw new Error("Running workspace runtime start claim binding is not exact");
  }
  const existingMemory = runtimeServicesById.get(input.runtimeServiceId);
  if (existingMemory) {
    if (
      existingMemory.companyId !== input.companyId ||
      existingMemory.serviceKey !== input.serviceKey ||
      existingMemory.startClaimId !== input.claimId ||
      existingMemory.ownerAgentId !== claim.ownerAgentId
    ) {
      throw new Error("Workspace runtime start claim resolved to a conflicting in-memory service");
    }
    if (input.leaseRunId) existingMemory.leaseRunIds.add(input.leaseRunId);
    existingMemory.lastUsedAt = new Date().toISOString();
    return existingMemory;
  }
  const row = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(and(
      eq(workspaceRuntimeServices.id, input.runtimeServiceId),
      eq(workspaceRuntimeServices.companyId, input.companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (
    !row ||
    row.provider !== "local_process" ||
    row.status !== "running" ||
    row.ownerAgentId !== claim.ownerAgentId
  ) {
    throw new Error("Running workspace runtime start claim has no matching active runtime row");
  }
  const registry = await findLocalServiceRegistryRecordByRuntimeServiceId({
    runtimeServiceId: row.id,
    profileKind: "workspace-runtime",
  });
  if (!registry || registry.serviceKey !== input.serviceKey) {
    throw new Error("Running workspace runtime start claim has no matching strict registry evidence");
  }
  if (registry.metadata?.companyId !== input.companyId) {
    throw new Error("Workspace runtime start claim registry has a cross-tenant company binding");
  }
  const adoptedUrl = registry.url ?? row.url ?? null;
  if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, {
    serviceName: row.serviceName,
    command: row.command,
  }))) {
    throw new Error("Claimed workspace runtime service is not healthy enough to adopt");
  }
  const record: RuntimeServiceRecord = {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    serviceName: row.serviceName,
    status: "running",
    lifecycle: row.lifecycle as RuntimeServiceRecord["lifecycle"],
    scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
    scopeId: row.scopeId ?? null,
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: registry.port ?? row.port ?? null,
    url: adoptedUrl,
    provider: "local_process",
    providerRef: String(registry.processGroupId ?? registry.pid),
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: new Date().toISOString(),
    startedAt: row.startedAt.toISOString(),
    stoppedAt: null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: "healthy",
    reused: true,
    db: input.db,
    child: null,
    leaseRunIds: input.leaseRunId ? new Set([input.leaseRunId]) : new Set(),
    idleTimer: null,
    envFingerprint: row.reuseKey ?? "",
    serviceKey: registry.serviceKey,
    profileKind: "workspace-runtime",
    processGroupId: registry.processGroupId ?? null,
    startClaimId: claim.claimId,
    startFinalizationState: "running",
    exitLatch: null,
  };
  assertRuntimeRegistryBinding({ record, registry, startClaimId: claim.claimId });
  registerRuntimeService(input.db, record);
  await touchLocalServiceRegistryRecord(registry.serviceKey, {
    runtimeServiceId: row.id,
    lastSeenAt: record.lastUsedAt,
  });
  return record;
}

async function startAndPersistLocalRuntimeService(input: StartLocalRuntimeServiceInput & {
  afterStartedBeforePersist?: (record: RuntimeServiceRef) => Promise<void>;
  terminate?: typeof terminateLocalService;
}) {
  const db = input.db;
  if (!db) {
    const record = await startLocalRuntimeService(input);
    registerRuntimeService(undefined, record);
    try {
      await input.afterStartedBeforePersist?.(toRuntimeServiceRef(record));
      await persistRuntimeServiceRecord(undefined, record);
      return record;
    } catch (error) {
      return await failStartedRuntimeServiceClosed({
        record,
        cause: error,
        terminate: input.terminate ?? terminateLocalService,
      });
    }
  }

  const serviceKey = resolveLocalRuntimeServiceKey(input);
  const reservation = await reserveWorkspaceRuntimeStartClaim({
    db,
    companyId: input.agent.companyId,
    serviceKey,
    ownerAgentId: input.agent.id,
  });
  if (reservation.kind === "running") {
    return await loadClaimedRuntimeService({
      db,
      companyId: input.agent.companyId,
      serviceKey,
      claimId: reservation.claimId,
      runtimeServiceId: reservation.runtimeServiceId,
      leaseRunId: input.leaseRunId === undefined ? input.runId : input.leaseRunId,
    });
  }
  if (reservation.kind === "pending") {
    const finalized = await waitForWorkspaceRuntimeStartClaim({
      db,
      companyId: input.agent.companyId,
      serviceKey,
      observedClaimId: reservation.claimId,
      // A competing process owns the same durable claim while it performs the
      // configured readiness probe and atomic DB finalization. The waiter must
      // never time out before the legitimate starter's own readiness budget.
      waitMs: resolveWorkspaceRuntimeReadinessTimeoutSec(input.service) * 1_000 + 10_000,
    });
    return await loadClaimedRuntimeService({
      db,
      companyId: input.agent.companyId,
      serviceKey,
      claimId: finalized.claimId,
      runtimeServiceId: finalized.runtimeServiceId,
      leaseRunId: input.leaseRunId === undefined ? input.runId : input.leaseRunId,
    });
  }

  let record: RuntimeServiceRecord | null = null;
  let failure: unknown = null;
  try {
    record = await startLocalRuntimeService({ ...input, startClaimId: reservation.claimId });
    registerRuntimeService(db, record);
    await input.afterStartedBeforePersist?.(toRuntimeServiceRef(record));
    await finalizeWorkspaceRuntimeStartClaim({
      db,
      companyId: input.agent.companyId,
      serviceKey,
      claimId: reservation.claimId,
      runtimeServiceId: record.id,
      ownerAgentId: record.ownerAgentId,
      assertReady: async () => {
        await assertStartedRuntimeServiceReadyForFinalization({
          record: record!,
          startClaimId: reservation.claimId,
        });
      },
      persist: async (txDb) => {
        await upsertRuntimeServiceRecord(txDb, toPersistedWorkspaceRuntimeService(record!));
      },
    });
    record.startFinalizationState = "running";
    if (record.exitLatch?.exit) {
      throw new Error("Started runtime service exited during start-claim finalization");
    }
    return record;
  } catch (error) {
    const registryPublicationCollision = error instanceof RuntimeRegistryPublicationCollisionError
      ? error
      : null;
    if (registryPublicationCollision) {
      record = registryPublicationCollision.record;
      failure = registryPublicationCollision.primary;
    } else {
      failure = error;
    }
    if (record) {
      try {
        await failStartedRuntimeServiceClosed({
          record,
          cause: failure,
          terminate: input.terminate ?? terminateLocalService,
          claim: {
            companyId: input.agent.companyId,
            serviceKey,
            claimId: reservation.claimId,
          },
          preserveForeignRegistryEvidence: Boolean(registryPublicationCollision),
        });
      } catch (cleanupError) {
        failure = cleanupError;
      }
    } else if (!isRuntimeCleanupQuarantined(error)) {
      await failWorkspaceRuntimeStartClaim({
        db,
        companyId: input.agent.companyId,
        serviceKey,
        claimId: reservation.claimId,
        failureCode: "start_failed",
      });
    }
    throw failure;
  }
}

function readRuntimeServiceEntries(config: Record<string, unknown>) {
  return listWorkspaceServiceCommandDefinitions(parseObject(config.workspaceRuntime))
    .map((command) => command.rawConfig);
}

export function listConfiguredRuntimeServiceEntries(config: Record<string, unknown>) {
  return readRuntimeServiceEntries(config);
}

function readConfiguredServiceStates(config: Record<string, unknown>) {
  const raw = parseObject(config.serviceStates);
  const states: WorkspaceRuntimeServiceStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "running" || value === "stopped" || value === "manual") {
      states[key] = value;
    }
  }
  return states;
}

function readDesiredRuntimeState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

export function buildWorkspaceRuntimeDesiredStatePatch(input: {
  config: Record<string, unknown>;
  currentDesiredState: WorkspaceRuntimeDesiredState | null;
  currentServiceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
  action: "start" | "stop" | "restart";
  serviceIndex?: number | null;
}): {
  desiredState: WorkspaceRuntimeDesiredState;
  serviceStates: WorkspaceRuntimeServiceStateMap | null;
} {
  const configuredServices = listConfiguredRuntimeServiceEntries(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.currentDesiredState) ?? "stopped";
  const nextServiceStates: WorkspaceRuntimeServiceStateMap = {};

  for (let index = 0; index < configuredServices.length; index += 1) {
    nextServiceStates[String(index)] = input.currentServiceStates?.[String(index)] ?? fallbackState;
  }

  const nextState: WorkspaceRuntimeDesiredState = input.action === "stop" ? "stopped" : "running";
  const applyActionState = (index: number) => {
    const key = String(index);
    // Manual services are intentionally left under operator control even when
    // an API action targets that individual service.
    if (nextServiceStates[key] === "manual") return;
    nextServiceStates[key] = nextState;
  };
  if (input.serviceIndex === undefined || input.serviceIndex === null) {
    for (let index = 0; index < configuredServices.length; index += 1) {
      applyActionState(index);
    }
  } else if (input.serviceIndex >= 0 && input.serviceIndex < configuredServices.length) {
    applyActionState(input.serviceIndex);
  }

  const desiredState = Object.values(nextServiceStates).some((state) => state === "running")
    ? "running"
    : Object.values(nextServiceStates).some((state) => state === "manual")
      ? "manual"
      : "stopped";

  return {
    desiredState,
    serviceStates: Object.keys(nextServiceStates).length > 0 ? nextServiceStates : null,
  };
}

function selectRuntimeServiceEntries(input: {
  config: Record<string, unknown>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
  defaultDesiredState?: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}) {
  const entries = listConfiguredRuntimeServiceEntries(input.config);
  const states = input.serviceStates ?? readConfiguredServiceStates(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.defaultDesiredState) ?? "stopped";

  return entries.filter((_, index) => {
    if (input.serviceIndex !== undefined && input.serviceIndex !== null) {
      return index === input.serviceIndex;
    }
    if (!input.respectDesiredStates) return true;
    return (states[String(index)] ?? fallbackState) === "running";
  });
}

type EnsureRuntimeServicesForRunInput = {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
};

async function ensureRuntimeServicesForRunUnlocked(
  input: EnsureRuntimeServicesForRunInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    respectDesiredStates: true,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "running",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const acquiredServiceIds: string[] = [];
  const refs: RuntimeServiceRef[] = [];
  runtimeServiceLeasesByRun.set(input.runId, acquiredServiceIds);

  try {
    for (const service of rawServices) {
      const { scopeType, scopeId } = resolveServiceScopeId({
        service,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        issue: input.issue,
        runId: input.runId,
        agent: input.agent,
      });
      const reuseKey = resolveRuntimeServiceReuseIdentity({
        service,
        workspace: input.workspace,
        agent: input.agent,
        issue: input.issue,
        adapterEnv: input.adapterEnv,
        scopeType,
        scopeId,
      }).reuseKey;

      if (reuseKey) {
        const existingId = runtimeServicesByReuseKey.get(
          runtimeServiceReuseMapKey(input.agent.companyId, reuseKey),
        );
        const existing = existingId ? runtimeServicesById.get(existingId) : null;
        if (existing && existing.status === "running") {
          existing.leaseRunIds.add(input.runId);
          existing.lastUsedAt = new Date().toISOString();
          existing.stoppedAt = null;
          clearIdleTimer(existing);
          void touchLocalServiceRegistryRecord(existing.serviceKey, {
            runtimeServiceId: existing.id,
            lastSeenAt: existing.lastUsedAt,
          });
          await persistRuntimeServiceRecord(input.db, existing);
          acquiredServiceIds.push(existing.id);
          refs.push(toRuntimeServiceRef(existing, { reused: true }));
          continue;
        }
      }

      const record = await startAndPersistLocalRuntimeService({
        db: input.db,
        runId: input.runId,
        agent: input.agent,
        issue: input.issue,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        adapterEnv: input.adapterEnv,
        service,
        onLog: input.onLog,
        reuseKey,
        scopeType,
        scopeId,
      });
      acquiredServiceIds.push(record.id);
      refs.push(toRuntimeServiceRef(record));
    }
  } catch (err) {
    await releaseRuntimeServicesForRun(input.runId);
    throw err;
  }

  return refs;
}

export async function ensureRuntimeServicesForRun(
  input: EnsureRuntimeServicesForRunInput,
): Promise<RuntimeServiceRef[]> {
  return withRuntimeServiceOwnerStartFence({
    db: input.db,
    agent: input.agent,
    run: () => ensureRuntimeServicesForRunUnlocked(input),
  });
}

type WorkspaceControlRuntimeStartInput = {
  db?: Db;
  invocationId?: string;
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
  dependencies?: {
    afterLocalServiceStartedBeforePersist?: (record: RuntimeServiceRef) => Promise<void>;
    afterLocalServiceSpawnedBeforeReadiness?: (input: {
      serviceKey: string;
      runtimeServiceId: string;
      pid: number;
      processGroupId: number;
    }) => Promise<void>;
    terminateLocalService?: typeof terminateLocalService;
  };
};

async function startRuntimeServicesForWorkspaceControlUnlocked(
  input: WorkspaceControlRuntimeStartInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    serviceIndex: input.serviceIndex,
    respectDesiredStates: input.respectDesiredStates,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "stopped",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const refs: RuntimeServiceRef[] = [];
  const invocationId = input.invocationId ?? randomUUID();

  for (const service of rawServices) {
    const { scopeType, scopeId } = resolveServiceScopeId({
      service,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      issue: input.issue,
      runId: invocationId,
      agent: input.actor,
    });
    const reuseKey = resolveRuntimeServiceReuseIdentity({
      service,
      workspace: input.workspace,
      agent: input.actor,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      scopeType,
      scopeId,
    }).reuseKey;

    if (reuseKey) {
      const existingId = runtimeServicesByReuseKey.get(
        runtimeServiceReuseMapKey(input.actor.companyId, reuseKey),
      );
      const existing = existingId ? runtimeServicesById.get(existingId) : null;
      if (existing && existing.status === "running") {
        existing.lastUsedAt = new Date().toISOString();
        existing.stoppedAt = null;
        clearIdleTimer(existing);
        void touchLocalServiceRegistryRecord(existing.serviceKey, {
          runtimeServiceId: existing.id,
          lastSeenAt: existing.lastUsedAt,
        });
        await persistRuntimeServiceRecord(input.db, existing);
        refs.push(toRuntimeServiceRef(existing, { reused: true }));
        continue;
      }
    }

    // Manually controlled services are not tied to a heartbeat run lifecycle, so they do not
    // retain a run lease and never persist a startedByRunId foreign key.
    const record = await startAndPersistLocalRuntimeService({
      db: input.db,
      runId: invocationId,
      leaseRunId: null,
      startedByRunId: null,
      agent: input.actor,
      issue: input.issue,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      adapterEnv: input.adapterEnv,
      service,
      onLog: input.onLog,
      reuseKey,
      scopeType,
      scopeId,
      afterStartedBeforePersist: input.dependencies?.afterLocalServiceStartedBeforePersist,
      afterSpawnedBeforeReadiness: input.dependencies?.afterLocalServiceSpawnedBeforeReadiness,
      terminate: input.dependencies?.terminateLocalService,
    });
    refs.push(toRuntimeServiceRef(record));
  }

  return refs;
}

export async function startRuntimeServicesForWorkspaceControl(
  input: WorkspaceControlRuntimeStartInput,
): Promise<RuntimeServiceRef[]> {
  return withRuntimeServiceOwnerStartFence({
    db: input.db,
    agent: input.actor,
    run: () => startRuntimeServicesForWorkspaceControlUnlocked(input),
  });
}

export async function releaseRuntimeServicesForRun(runId: string) {
  const acquired = runtimeServiceLeasesByRun.get(runId) ?? [];
  runtimeServiceLeasesByRun.delete(runId);
  for (const serviceId of acquired) {
    const record = runtimeServicesById.get(serviceId);
    if (!record) continue;
    record.leaseRunIds.delete(runId);
    record.lastUsedAt = new Date().toISOString();
    const stopType = asString(record.stopPolicy?.type, record.lifecycle === "ephemeral" ? "on_run_finish" : "manual");
    await persistRuntimeServiceRecord(record.db, record);
    if (record.leaseRunIds.size === 0) {
      if (record.lifecycle === "ephemeral" || stopType === "on_run_finish") {
        await stopRuntimeService(serviceId);
        continue;
      }
      scheduleIdleStop(record);
    }
  }
}

export async function stopRuntimeServicesForExecutionWorkspace(input: {
  db?: Db;
  executionWorkspaceId: string;
  workspaceCwd?: string | null;
  runtimeServiceId?: string | null;
  dependencies?: RuntimeServiceStopDependencies;
}) {
  const normalizedWorkspaceCwd = input.workspaceCwd ? path.resolve(input.workspaceCwd) : null;
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      if (record.executionWorkspaceId === input.executionWorkspaceId) return true;
      if (!normalizedWorkspaceCwd || !record.cwd) return false;
      const resolvedCwd = path.resolve(record.cwd);
      return (
        resolvedCwd === normalizedWorkspaceCwd ||
        resolvedCwd.startsWith(`${normalizedWorkspaceCwd}${path.sep}`)
      );
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId, input.dependencies);
  }

  if (input.db) {
    const activeRows = await input.db.select().from(workspaceRuntimeServices).where(and(
      input.runtimeServiceId
        ? eq(workspaceRuntimeServices.id, input.runtimeServiceId)
        : eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
      inArray(workspaceRuntimeServices.status, ["starting", "running"]),
    ));
    const unresolvedLocal = activeRows.filter((row) => row.provider === "local_process");
    if (unresolvedLocal.length > 0) {
      throw new Error(
        `Execution workspace stop has ${unresolvedLocal.length} active local runtime service(s) without an in-memory fenced binding`,
      );
    }
    const adapterManagedIds = activeRows
      .filter((row) => row.provider === "adapter_managed")
      .map((row) => row.id);
    if (adapterManagedIds.length > 0) {
      const now = new Date();
      await input.db
        .update(workspaceRuntimeServices)
        .set({
          status: "stopped",
          healthStatus: "unknown",
          stoppedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(and(
          inArray(workspaceRuntimeServices.id, adapterManagedIds),
          inArray(workspaceRuntimeServices.status, ["starting", "running"]),
        ));
    }
  }
}

export async function stopRuntimeServicesForProjectWorkspace(input: {
  db?: Db;
  projectWorkspaceId: string;
  runtimeServiceId?: string | null;
  dependencies?: RuntimeServiceStopDependencies;
}) {
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      return record.projectWorkspaceId === input.projectWorkspaceId && record.scopeType === "project_workspace";
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId, input.dependencies);
  }

  if (input.db) {
    const activeRows = await input.db.select().from(workspaceRuntimeServices).where(and(
      input.runtimeServiceId
        ? eq(workspaceRuntimeServices.id, input.runtimeServiceId)
        : and(
            eq(workspaceRuntimeServices.projectWorkspaceId, input.projectWorkspaceId),
            eq(workspaceRuntimeServices.scopeType, "project_workspace"),
          ),
      inArray(workspaceRuntimeServices.status, ["starting", "running"]),
    ));
    const unresolvedLocal = activeRows.filter((row) => row.provider === "local_process");
    if (unresolvedLocal.length > 0) {
      throw new Error(
        `Project workspace stop has ${unresolvedLocal.length} active local runtime service(s) without an in-memory fenced binding`,
      );
    }
    const adapterManagedIds = activeRows
      .filter((row) => row.provider === "adapter_managed")
      .map((row) => row.id);
    if (adapterManagedIds.length > 0) {
      const now = new Date();
      await input.db.update(workspaceRuntimeServices).set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      }).where(and(
        inArray(workspaceRuntimeServices.id, adapterManagedIds),
        inArray(workspaceRuntimeServices.status, ["starting", "running"]),
      ));
    }
  }
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

export async function reconcilePersistedRuntimeServicesOnStartup(
  db: Db,
  dependencies?: {
    terminateLocalService?: typeof terminateLocalService;
    afterOrphanClaimTerminalizedBeforeRegistryRemove?: (input: {
      companyId: string;
      serviceKey: string;
      claimId: string;
      runtimeServiceId: string;
    }) => Promise<void>;
    afterPersistedTerminalizedBeforeRegistryRemove?: (input: {
      companyId: string;
      serviceKey: string;
      claimId: string;
      runtimeServiceId: string;
    }) => Promise<void>;
    afterPersistedClassifiedBeforeSignal?: (input: {
      companyId: string;
      runtimeServiceId: string;
      ownerAgentId: string | null;
    }) => Promise<void>;
  },
) {
  // Reconciliation is a destructive/adoptive boundary. Validate the entire
  // registry before inspecting DB rows so corrupt, unreadable, or duplicate
  // evidence cannot be downgraded to process absence for any row.
  const registryRecords = await listLocalServiceRegistryRecordsStrict({
    profileKind: "workspace-runtime",
  });
  const candidates = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(eq(workspaceRuntimeServices.provider, "local_process"));
  const candidatesById = new Map(candidates.map((row) => [row.id, row]));
  const startClaims = await db.select().from(workspaceRuntimeStartClaims);
  const startClaimsByCompanyService = new Map(
    startClaims.map((claim) => [`${claim.companyId}\u0000${claim.serviceKey}`, claim] as const),
  );
  const startClaimsByRuntimeServiceId = new Map(
    startClaims.flatMap((claim) => claim.runtimeServiceId
      ? [[claim.runtimeServiceId, claim] as const]
      : []),
  );

  function assertPersistedRegistryClaimBinding(
    row: typeof workspaceRuntimeServices.$inferSelect,
    record: (typeof registryRecords)[number],
    claim: (typeof startClaims)[number] | undefined,
    allowedClaimStatuses: ReadonlySet<string> = new Set(["running"]),
  ) {
    const metadata = record.metadata ?? {};
    const providerPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
    if (
      record.version !== 2 ||
      !claim ||
      claim.companyId !== row.companyId ||
      !allowedClaimStatuses.has(claim.status) ||
      claim.runtimeServiceId !== row.id ||
      claim.ownerAgentId !== row.ownerAgentId ||
      record.runtimeServiceId !== row.id ||
      record.serviceKey !== claim.serviceKey ||
      record.profileKind !== "workspace-runtime" ||
      record.provider !== "local_process" ||
      row.provider !== "local_process" ||
      record.serviceName !== row.serviceName ||
      record.command !== row.command ||
      !row.cwd ||
      path.resolve(record.cwd) !== path.resolve(row.cwd) ||
      (row.reuseKey !== null && record.envFingerprint !== row.reuseKey) ||
      record.reuseKey !== row.reuseKey ||
      record.port !== row.port ||
      record.url !== row.url ||
      Date.parse(record.startedAt) !== row.startedAt.getTime() ||
      !providerPid ||
      (providerPid !== record.pid && providerPid !== record.processGroupId) ||
      metadata.companyId !== row.companyId ||
      metadata.ownerAgentId !== row.ownerAgentId ||
      metadata.projectId !== (row.projectId ?? null) ||
      metadata.projectWorkspaceId !== (row.projectWorkspaceId ?? null) ||
      metadata.executionWorkspaceId !== (row.executionWorkspaceId ?? null) ||
      metadata.issueId !== (row.issueId ?? null) ||
      metadata.scopeType !== row.scopeType ||
      metadata.scopeId !== (row.scopeId ?? null) ||
      metadata.startClaimId !== claim.claimId
    ) {
      throw new Error(
        `Local service registry does not match the exact runtime row and running start claim for ${row.id}`,
      );
    }
    return claim;
  }

  function assertPersistedRegistryBinding(
    row: typeof workspaceRuntimeServices.$inferSelect,
    record: (typeof registryRecords)[number],
    allowedClaimStatuses: ReadonlySet<string> = new Set(["running"]),
  ) {
    return assertPersistedRegistryClaimBinding(
      row,
      record,
      startClaimsByRuntimeServiceId.get(row.id),
      allowedClaimStatuses,
    );
  }

  function assertLegacyDeadRegistryBinding(
    row: typeof workspaceRuntimeServices.$inferSelect,
    record: (typeof registryRecords)[number],
  ) {
    const providerPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
    if (
      record.version !== 1 ||
      record.runtimeServiceId !== row.id ||
      record.profileKind !== "workspace-runtime" ||
      record.provider !== "local_process" ||
      row.provider !== "local_process" ||
      record.serviceName !== row.serviceName ||
      !row.command ||
      record.command !== row.command ||
      !row.cwd ||
      path.resolve(record.cwd) !== path.resolve(row.cwd) ||
      record.reuseKey !== row.reuseKey ||
      record.port !== row.port ||
      record.url !== row.url ||
      Date.parse(record.startedAt) !== row.startedAt.getTime() ||
      !providerPid ||
      (providerPid !== record.pid && providerPid !== record.processGroupId) ||
      row.ownerAgentId !== null ||
      record.metadata !== null
    ) {
      throw new Error(`Legacy dead registry ${record.serviceKey} has no full static runtime binding`);
    }
  }

  // The registry is the durable half of a spawn -> registry -> DB sequence.
  // Classify every strict v2 record before any DB mutation or process signal,
  // including the crash window where its DB row was never committed.
  const registryCompanyIds = [...new Set(registryRecords.flatMap((record) => (
    typeof record.metadata?.companyId === "string" ? [record.metadata.companyId] : []
  )))];
  const registryOwnerIds = [...new Set(registryRecords.flatMap((record) => (
    typeof record.metadata?.ownerAgentId === "string" ? [record.metadata.ownerAgentId] : []
  )))];
  const knownRegistryCompanies = new Set<string>();
  if (registryCompanyIds.length > 0) {
    const rows = await db.select({ id: companies.id }).from(companies)
      .where(inArray(companies.id, registryCompanyIds));
    for (const row of rows) knownRegistryCompanies.add(row.id);
  }
  const registryOwners = new Map<string, { companyId: string }>();
  if (registryOwnerIds.length > 0) {
    const rows = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents)
      .where(inArray(agents.id, registryOwnerIds));
    for (const row of rows) registryOwners.set(row.id, { companyId: row.companyId });
  }
  const deadRegistryRecords: typeof registryRecords = [];
  const orphanRegistryRecords: typeof registryRecords = [];
  for (const record of registryRecords) {
    if (record.version !== 1 && record.version !== 2) {
      throw new Error(`Local service registry ${record.serviceKey} has an unsupported evidence version`);
    }
    if (record.version === 2) {
      const registryCompanyId = record.metadata?.companyId;
      const registryOwnerId = record.metadata?.ownerAgentId;
      const registryClaimId = record.metadata?.startClaimId;
      if (typeof registryCompanyId !== "string" || !knownRegistryCompanies.has(registryCompanyId)) {
        throw new Error(`Local service registry ${record.serviceKey} has no valid company binding`);
      }
      if (registryOwnerId !== null && typeof registryOwnerId !== "string") {
        throw new Error(`Local service registry ${record.serviceKey} has no valid owner binding`);
      }
      if (
        typeof registryOwnerId === "string" &&
        registryOwners.get(registryOwnerId)?.companyId !== registryCompanyId
      ) {
        throw new Error(`Local service registry ${record.serviceKey} owner is outside its company binding`);
      }
      if (typeof registryClaimId !== "string" || typeof record.runtimeServiceId !== "string") {
        throw new Error(
          `Local service registry ${record.serviceKey} does not match an exact runtime row and running start claim binding`,
        );
      }
    }
    const verification = await verifyLocalServiceRegistryRecordIdentity(record);
    if (verification.kind === "not_running") {
      if (isProcessGroupAlive(record.processGroupId)) {
        throw new Error(
          `Local service registry leader ${record.pid} is not running but process group ${record.processGroupId} is still alive for ${record.serviceKey}`,
        );
      }
      deadRegistryRecords.push(record);
      continue;
    }
    if (verification.kind !== "verified" || record.version !== 2) {
      throw new Error(
        `Local service registry identity for ${record.serviceKey} is unproven: ${verification.kind === "unproven" ? verification.reason : "strong_identity_required"}`,
      );
    }
    const registryCompanyId = record.metadata!.companyId as string;
    if (record.runtimeServiceId) {
      const persisted = candidatesById.get(record.runtimeServiceId);
      if (!persisted) {
        const claim = startClaimsByCompanyService.get(`${registryCompanyId}\u0000${record.serviceKey}`);
        const registryClaimId = record.metadata?.startClaimId;
        const exactOrphanClaim = claim && (
          (claim.status === "starting" && claim.runtimeServiceId === null) ||
          (claim.status === "running" && (
            claim.runtimeServiceId === null || claim.runtimeServiceId === record.runtimeServiceId
          ))
        );
        if (
          typeof registryClaimId !== "string" ||
          !claim ||
          claim.claimId !== registryClaimId ||
          !exactOrphanClaim ||
          claim.ownerAgentId !== (record.metadata?.ownerAgentId ?? null)
        ) {
          throw new Error(
            `Orphaned local service registry ${record.serviceKey} has a mismatched durable start claim (${[
              typeof registryClaimId === "string" ? "registry_claim" : "missing_registry_claim",
              claim ? `claim_${claim.status}` : "claim_missing",
              claim?.runtimeServiceId === record.runtimeServiceId ? "runtime_match" : "runtime_mismatch",
              claim?.ownerAgentId === (record.metadata?.ownerAgentId ?? null) ? "owner_match" : "owner_mismatch",
            ].join(",")})`,
          );
        }
        orphanRegistryRecords.push(record);
        continue;
      }
      if (persisted.companyId !== registryCompanyId) {
        throw new Error(
          `Local service registry company ${registryCompanyId} does not match runtime service company ${persisted.companyId} (cross-tenant binding)`,
        );
      }
    }
  }

  function assertRegistryProcessIdentityUnchanged(
    expected: (typeof registryRecords)[number],
    fresh: (typeof registryRecords)[number],
  ) {
    if (
      fresh.serviceKey !== expected.serviceKey ||
      fresh.pid !== expected.pid ||
      fresh.processGroupId !== expected.processGroupId ||
      fresh.processStartedAt !== expected.processStartedAt ||
      fresh.processExecutable !== expected.processExecutable ||
      fresh.processCommandSha256 !== expected.processCommandSha256
    ) {
      throw new Error(`Local service registry ${expected.serviceKey} changed process identity before signal`);
    }
  }

  async function readFreshStrictRegistryRecord(
    expected: (typeof registryRecords)[number],
  ) {
    const fresh = (await listLocalServiceRegistryRecordsStrict({
      profileKind: "workspace-runtime",
    })).find((candidate) => candidate.serviceKey === expected.serviceKey);
    if (!fresh) {
      throw new Error(`Local service registry ${expected.serviceKey} disappeared before signal`);
    }
    assertRegistryProcessIdentityUnchanged(expected, fresh);
    return fresh;
  }

  async function lockSignalOwner(
    txDb: Db,
    companyId: string,
    ownerAgentId: string | null,
    expectedOwner?: { companyId: string; status: string } | null,
  ) {
    if (!ownerAgentId) return;
    const owner = await lockAgentLifecycleReference(txDb, {
      companyId,
      agentId: ownerAgentId,
      mode: "cleanup",
      allowMissingCleanup: false,
    });
    if (
      !owner ||
      (expectedOwner !== undefined && (
        !expectedOwner ||
        owner.companyId !== expectedOwner.companyId ||
        owner.status !== expectedOwner.status
      ))
    ) {
      throw new Error(`Workspace runtime signal owner ${ownerAgentId} changed lifecycle or company binding`);
    }
  }

  function assertClaimSnapshotUnchanged(
    expected: (typeof startClaims)[number],
    locked: (typeof startClaims)[number] | null,
  ) {
    if (
      !locked ||
      locked.id !== expected.id ||
      locked.companyId !== expected.companyId ||
      locked.serviceKey !== expected.serviceKey ||
      locked.claimId !== expected.claimId ||
      locked.status !== expected.status ||
      locked.runtimeServiceId !== expected.runtimeServiceId ||
      locked.ownerAgentId !== expected.ownerAgentId ||
      locked.updatedAt.getTime() !== expected.updatedAt.getTime()
    ) {
      throw new Error(`Workspace runtime start claim ${expected.claimId} changed before signal`);
    }
  }

  function assertRuntimeSnapshotUnchanged(
    expected: typeof workspaceRuntimeServices.$inferSelect,
    locked: typeof workspaceRuntimeServices.$inferSelect | null,
  ) {
    if (
      !locked ||
      locked.id !== expected.id ||
      locked.companyId !== expected.companyId ||
      locked.status !== expected.status ||
      locked.updatedAt.getTime() !== expected.updatedAt.getTime() ||
      locked.projectId !== expected.projectId ||
      locked.projectWorkspaceId !== expected.projectWorkspaceId ||
      locked.executionWorkspaceId !== expected.executionWorkspaceId ||
      locked.issueId !== expected.issueId ||
      locked.scopeType !== expected.scopeType ||
      locked.scopeId !== expected.scopeId ||
      locked.serviceName !== expected.serviceName ||
      locked.lifecycle !== expected.lifecycle ||
      locked.reuseKey !== expected.reuseKey ||
      locked.command !== expected.command ||
      locked.cwd !== expected.cwd ||
      locked.port !== expected.port ||
      locked.url !== expected.url ||
      locked.provider !== expected.provider ||
      locked.providerRef !== expected.providerRef ||
      locked.ownerAgentId !== expected.ownerAgentId ||
      locked.startedAt.getTime() !== expected.startedAt.getTime()
    ) {
      throw new Error(`Persisted runtime service ${expected.id} changed before signal`);
    }
  }

  async function signalPersistedRuntimeWithinFence(input: {
    row: typeof workspaceRuntimeServices.$inferSelect;
    registry: (typeof registryRecords)[number];
    expectedOwner: { companyId: string; status: string } | null;
    sendSignal: () => void;
  }) {
    const expectedClaim = startClaimsByRuntimeServiceId.get(input.row.id);
    if (!expectedClaim) {
      throw new Error(`Persisted runtime service ${input.row.id} has no exact start-claim signal binding`);
    }
    const execute = async () => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockSignalOwner(
          txDb,
          input.row.companyId,
          input.row.ownerAgentId,
          input.expectedOwner,
        );
        await lockWorkspaceRuntimeStartClaimFence(txDb, {
          companyId: input.row.companyId,
          serviceKey: input.registry.serviceKey,
        });
        const lockedClaim = await txDb.select().from(workspaceRuntimeStartClaims).where(and(
          eq(workspaceRuntimeStartClaims.companyId, input.row.companyId),
          eq(workspaceRuntimeStartClaims.serviceKey, input.registry.serviceKey),
        )).for("update").then((rows) => rows[0] ?? null);
        assertClaimSnapshotUnchanged(expectedClaim, lockedClaim);
        const lockedRuntime = await txDb.select().from(workspaceRuntimeServices).where(and(
          eq(workspaceRuntimeServices.id, input.row.id),
          eq(workspaceRuntimeServices.companyId, input.row.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        assertRuntimeSnapshotUnchanged(input.row, lockedRuntime);
        const freshRegistry = await readFreshStrictRegistryRecord(input.registry);
        assertPersistedRegistryClaimBinding(
          lockedRuntime!,
          freshRegistry,
          lockedClaim!,
          new Set([lockedClaim!.status]),
        );
        await assertLocalServiceRegistryRecordIdentity(freshRegistry);
        input.sendSignal();
      });
    };
    if (input.row.ownerAgentId) {
      await withAgentStartLock(input.row.ownerAgentId, execute);
    } else {
      await execute();
    }
  }

  async function signalOrphanRuntimeWithinFence(input: {
    registry: (typeof registryRecords)[number];
    sendSignal: () => void;
  }) {
    const companyId = input.registry.metadata?.companyId;
    const ownerAgentId = input.registry.metadata?.ownerAgentId;
    const claimId = input.registry.metadata?.startClaimId;
    const runtimeServiceId = input.registry.runtimeServiceId;
    if (
      typeof companyId !== "string" ||
      (ownerAgentId !== null && typeof ownerAgentId !== "string") ||
      typeof claimId !== "string" ||
      !runtimeServiceId
    ) {
      throw new Error(`Orphaned local service registry ${input.registry.serviceKey} has no signal binding`);
    }
    const expectedClaim = startClaimsByCompanyService.get(`${companyId}\u0000${input.registry.serviceKey}`);
    if (!expectedClaim) {
      throw new Error(`Orphaned local service registry ${input.registry.serviceKey} lost its start claim`);
    }
    const execute = async () => {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockSignalOwner(txDb, companyId, ownerAgentId);
        await lockWorkspaceRuntimeStartClaimFence(txDb, {
          companyId,
          serviceKey: input.registry.serviceKey,
        });
        const lockedClaim = await txDb.select().from(workspaceRuntimeStartClaims).where(and(
          eq(workspaceRuntimeStartClaims.companyId, companyId),
          eq(workspaceRuntimeStartClaims.serviceKey, input.registry.serviceKey),
        )).for("update").then((rows) => rows[0] ?? null);
        assertClaimSnapshotUnchanged(expectedClaim, lockedClaim);
        const exactOrphanClaim = lockedClaim &&
          lockedClaim.claimId === claimId &&
          lockedClaim.ownerAgentId === ownerAgentId &&
          (
            (lockedClaim.status === "starting" && lockedClaim.runtimeServiceId === null) ||
            (lockedClaim.status === "running" && (
              lockedClaim.runtimeServiceId === null ||
              lockedClaim.runtimeServiceId === runtimeServiceId
            ))
          );
        if (!exactOrphanClaim) {
          throw new Error(`Orphaned local service registry ${input.registry.serviceKey} changed claim binding before signal`);
        }
        const unexpectedRuntime = await txDb.select({ id: workspaceRuntimeServices.id })
          .from(workspaceRuntimeServices)
          .where(and(
            eq(workspaceRuntimeServices.id, runtimeServiceId),
            eq(workspaceRuntimeServices.companyId, companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (unexpectedRuntime) {
          throw new Error(`Orphaned local service registry ${input.registry.serviceKey} gained a runtime row before signal`);
        }
        const freshRegistry = await readFreshStrictRegistryRecord(input.registry);
        if (
          freshRegistry.version !== 2 ||
          freshRegistry.runtimeServiceId !== runtimeServiceId ||
          freshRegistry.metadata?.companyId !== companyId ||
          freshRegistry.metadata?.ownerAgentId !== ownerAgentId ||
          freshRegistry.metadata?.startClaimId !== claimId
        ) {
          throw new Error(`Orphaned local service registry ${input.registry.serviceKey} changed before signal`);
        }
        await assertLocalServiceRegistryRecordIdentity(freshRegistry);
        input.sendSignal();
      });
    };
    if (typeof ownerAgentId === "string") {
      await withAgentStartLock(ownerAgentId, execute);
    } else {
      await execute();
    }
  }

  const orphanCleanupFailures: Error[] = [];
  for (const record of orphanRegistryRecords) {
    try {
      await (dependencies?.terminateLocalService ?? terminateLocalService)(record, {
        signalWithinFence: async (_signal, sendSignal) => {
          await signalOrphanRuntimeWithinFence({ registry: record, sendSignal });
        },
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!isPidAlive(record.pid) && !isProcessGroupAlive(record.processGroupId)) break;
        await delay(20);
      }
      if (isPidAlive(record.pid) || isProcessGroupAlive(record.processGroupId)) {
        throw new Error(
          `Orphaned workspace runtime process group ${record.processGroupId} remained alive after exact cleanup`,
        );
      }
      const companyId = record.metadata!.companyId as string;
      const claimId = record.metadata!.startClaimId as string;
      const claim = startClaimsByCompanyService.get(`${companyId}\u0000${record.serviceKey}`)!;
      await terminalizeWorkspaceRuntimeStartClaim({
        db,
        companyId,
        serviceKey: record.serviceKey,
        claimId,
        runtimeServiceId: record.runtimeServiceId!,
        expectedStatus: claim.status as "starting" | "running",
        expectedRuntimeServiceId: claim.runtimeServiceId,
        terminalRuntimeServiceId: null,
        terminalStatus: "failed",
        failureCode: "registry_orphan_cleaned",
        persist: async (txDb) => {
          const unexpectedRuntime = await txDb.select({ id: workspaceRuntimeServices.id })
            .from(workspaceRuntimeServices)
            .where(and(
              eq(workspaceRuntimeServices.id, record.runtimeServiceId!),
              eq(workspaceRuntimeServices.companyId, companyId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (unexpectedRuntime) {
            throw new Error("Orphaned runtime registry gained a runtime row before claim terminalization");
          }
        },
      });
      await dependencies?.afterOrphanClaimTerminalizedBeforeRegistryRemove?.({
        companyId,
        serviceKey: record.serviceKey,
        claimId,
        runtimeServiceId: record.runtimeServiceId!,
      });
      await removeExactRuntimeRegistryAfterTerminalization({
        db,
        companyId,
        ownerAgentId: record.metadata?.ownerAgentId as string | null,
        serviceKey: record.serviceKey,
        profileKind: record.profileKind,
        expectedRegistry: record,
        expectedClaim: {
          claimId,
          status: "failed",
          runtimeServiceId: null,
        },
      });
    } catch (error) {
      orphanCleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (orphanCleanupFailures.length > 0) {
    throw new AggregateError(
      orphanCleanupFailures,
      `Orphaned workspace runtime registry cleanup failed (${orphanCleanupFailures.length})`,
    );
  }
  const deadRegistryRuntimeIds = new Set<string>();
  let deadPersistedStopped = 0;
  for (const record of deadRegistryRecords) {
    const companyId = record.metadata?.companyId;
    const claimId = record.metadata?.startClaimId;
    const persisted = record.runtimeServiceId ? candidatesById.get(record.runtimeServiceId) : null;
    if (record.version === 1) {
      if (!persisted) {
        throw new Error(`Legacy dead registry ${record.serviceKey} has no exact persisted runtime row`);
      }
      assertLegacyDeadRegistryBinding(persisted, record);
      if (
        startClaimsByRuntimeServiceId.has(persisted.id) ||
        startClaimsByCompanyService.has(`${persisted.companyId}\u0000${record.serviceKey}`)
      ) {
        throw new Error(`Legacy dead registry ${record.serviceKey} is not a proven claimless runtime`);
      }
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockWorkspaceRuntimeStartClaimFence(txDb, {
          companyId: persisted.companyId,
          serviceKey: record.serviceKey,
        });
        const claims = await txDb.select({ id: workspaceRuntimeStartClaims.id })
          .from(workspaceRuntimeStartClaims)
          .where(or(
            eq(workspaceRuntimeStartClaims.runtimeServiceId, persisted.id),
            and(
              eq(workspaceRuntimeStartClaims.companyId, persisted.companyId),
              eq(workspaceRuntimeStartClaims.serviceKey, record.serviceKey),
            ),
          ))
          .for("update");
        if (claims.length > 0) {
          throw new Error(`Legacy dead registry ${record.serviceKey} gained a start claim`);
        }
        const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
          eq(workspaceRuntimeServices.id, persisted.id),
          eq(workspaceRuntimeServices.companyId, persisted.companyId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!locked || locked.status !== persisted.status || locked.updatedAt.getTime() !== persisted.updatedAt.getTime()) {
          throw new Error(`Legacy dead runtime row ${persisted.id} changed before terminalization`);
        }
        assertLegacyDeadRegistryBinding(locked, record);
        const freshRegistry = (await listLocalServiceRegistryRecordsStrict({
          profileKind: "workspace-runtime",
        })).find((candidate) => candidate.serviceKey === record.serviceKey);
        if (!freshRegistry) {
          throw new Error(`Legacy dead registry ${record.serviceKey} disappeared before terminalization`);
        }
        assertLegacyDeadRegistryBinding(locked, freshRegistry);
        const freshVerification = await verifyLocalServiceRegistryRecordIdentity(freshRegistry);
        if (
          freshVerification.kind !== "not_running" ||
          isProcessGroupAlive(freshRegistry.processGroupId)
        ) {
          throw new Error(`Legacy dead registry ${record.serviceKey} changed before terminalization`);
        }
        const now = new Date();
        const updated = await txDb.update(workspaceRuntimeServices).set({
          status: "stopped",
          healthStatus: "unknown",
          stoppedAt: persisted.stoppedAt ?? now,
          lastUsedAt: now,
          updatedAt: now,
        }).where(and(
          eq(workspaceRuntimeServices.id, persisted.id),
          eq(workspaceRuntimeServices.companyId, persisted.companyId),
          eq(workspaceRuntimeServices.status, persisted.status),
          eq(workspaceRuntimeServices.updatedAt, persisted.updatedAt),
        )).returning({ id: workspaceRuntimeServices.id });
        if (updated.length !== 1) {
          throw new Error(`Legacy dead runtime row ${persisted.id} terminalization CAS failed`);
        }
      });
      await removeExactRuntimeRegistryAfterTerminalization({
        db,
        companyId: persisted.companyId,
        ownerAgentId: null,
        serviceKey: record.serviceKey,
        profileKind: record.profileKind,
        expectedRegistry: record,
        expectNoClaim: true,
      });
      deadRegistryRuntimeIds.add(persisted.id);
      deadPersistedStopped += 1;
      continue;
    }
    if (typeof companyId !== "string" || typeof claimId !== "string" || !record.runtimeServiceId) {
      throw new Error(`Dead local service registry ${record.serviceKey} has no exact claim binding`);
    }
    let exactRemovalClaim: {
      claimId: string;
      status: "stopped" | "failed";
      runtimeServiceId: string | null;
    };
    if (persisted) {
      const claim = assertPersistedRegistryBinding(
        persisted,
        record,
        new Set(["running", "stopped", "failed"]),
      );
      const exactTerminalReplay = persisted.status === "stopped" &&
        claim.status === "stopped" &&
        claim.failureCode === "startup_reconciled_stopped";
      if (!exactTerminalReplay) {
        await terminalizeWorkspaceRuntimeStartClaim({
          db,
          companyId,
          serviceKey: record.serviceKey,
          claimId: claim.claimId,
          runtimeServiceId: persisted.id,
          expectedStatus: claim.status as "starting" | "running" | "stopped" | "failed",
          expectedRuntimeServiceId: persisted.id,
          terminalStatus: "stopped",
          failureCode: "startup_reconciled_stopped",
          persist: async (txDb) => {
            const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
              eq(workspaceRuntimeServices.id, persisted.id),
              eq(workspaceRuntimeServices.companyId, companyId),
            )).for("update").then((rows) => rows[0] ?? null);
            if (!locked || locked.status !== persisted.status || locked.updatedAt.getTime() !== persisted.updatedAt.getTime()) {
              throw new Error("Persisted runtime row changed before dead-registry terminalization");
            }
            const now = new Date();
            await txDb.update(workspaceRuntimeServices).set({
              status: "stopped",
              healthStatus: "unknown",
              stoppedAt: now,
              lastUsedAt: now,
              updatedAt: now,
            }).where(and(
              eq(workspaceRuntimeServices.id, persisted.id),
              eq(workspaceRuntimeServices.companyId, companyId),
              eq(workspaceRuntimeServices.status, persisted.status),
              eq(workspaceRuntimeServices.updatedAt, persisted.updatedAt),
            ));
          },
        });
        await dependencies?.afterPersistedTerminalizedBeforeRegistryRemove?.({
          companyId,
          serviceKey: claim.serviceKey,
          claimId: claim.claimId,
          runtimeServiceId: persisted.id,
        });
      }
      deadRegistryRuntimeIds.add(persisted.id);
      deadPersistedStopped += 1;
      exactRemovalClaim = {
        claimId: claim.claimId,
        status: "stopped",
        runtimeServiceId: persisted.id,
      };
    } else {
      const claim = startClaimsByCompanyService.get(`${companyId}\u0000${record.serviceKey}`);
      const exactOrphanClaim = claim && (
        (claim.status === "starting" && claim.runtimeServiceId === null) ||
        (claim.status === "running" && (
          claim.runtimeServiceId === null || claim.runtimeServiceId === record.runtimeServiceId
        ))
      );
      const exactTerminalReplay = claim &&
        claim.claimId === claimId &&
        claim.status === "failed" &&
        claim.runtimeServiceId === null &&
        claim.failureCode === "registry_orphan_cleaned" &&
        claim.ownerAgentId === (record.metadata?.ownerAgentId ?? null);
      if (
        !claim ||
        claim.claimId !== claimId ||
        (!exactOrphanClaim && !exactTerminalReplay) ||
        claim.ownerAgentId !== (record.metadata?.ownerAgentId ?? null)
      ) {
        throw new Error(`Dead orphan registry ${record.serviceKey} has no exact starting claim`);
      }
      if (!exactTerminalReplay) {
        await terminalizeWorkspaceRuntimeStartClaim({
          db,
          companyId,
          serviceKey: record.serviceKey,
          claimId,
          runtimeServiceId: record.runtimeServiceId,
          expectedStatus: claim.status as "starting" | "running",
          expectedRuntimeServiceId: claim.runtimeServiceId,
          terminalRuntimeServiceId: null,
          terminalStatus: "failed",
          failureCode: "registry_orphan_cleaned",
          persist: async () => undefined,
        });
      }
      exactRemovalClaim = {
        claimId: claim.claimId,
        status: "failed",
        runtimeServiceId: null,
      };
    }
    await removeExactRuntimeRegistryAfterTerminalization({
      db,
      companyId,
      ownerAgentId: record.metadata?.ownerAgentId as string | null,
      serviceKey: record.serviceKey,
      profileKind: record.profileKind,
      expectedRegistry: record,
      expectedClaim: exactRemovalClaim,
    });
  }
  const unresolvedStartingClaims = await db
    .select()
    .from(workspaceRuntimeStartClaims)
    .where(eq(workspaceRuntimeStartClaims.status, "starting"));
  for (const claim of unresolvedStartingClaims) {
    const registryStillPresent = registryRecords.some((record) =>
      record.serviceKey === claim.serviceKey &&
      record.metadata?.companyId === claim.companyId &&
      !orphanRegistryRecords.includes(record) &&
      !deadRegistryRecords.includes(record)
    );
    if (!registryStillPresent) {
      throw new Error(
        `Workspace runtime start claim ${claim.claimId} has no verified registry; process absence is unproven`,
      );
    }
  }
  const candidateOwnerIds = [...new Set(
    candidates.flatMap((row) => row.ownerAgentId ? [row.ownerAgentId] : []),
  )];
  const ownerRecords = new Map<string, { status: string; companyId: string }>();
  if (candidateOwnerIds.length > 0) {
    const ownerRows = await db
      .select({ id: agents.id, status: agents.status, companyId: agents.companyId })
      .from(agents)
      .where(inArray(agents.id, candidateOwnerIds));
    for (const owner of ownerRows) {
      ownerRecords.set(owner.id, { status: owner.status, companyId: owner.companyId });
    }
  }
  const isUnsafeRuntimeOwner = (row: typeof workspaceRuntimeServices.$inferSelect) => {
    if (!row.ownerAgentId) return false;
    if (isHistoricalAgentTombstoneId(row.ownerAgentId)) return true;
    const owner = ownerRecords.get(row.ownerAgentId);
    return !owner || owner.status === "terminated" || owner.companyId !== row.companyId;
  };
  // Every persisted local process row must be classified. A terminal-looking
  // status is not proof that its process (or detached process group) is gone.
  const rows = candidates;

  if (rows.length === 0) return { reconciled: 0, adopted: 0, stopped: 0 };

  async function findPersistedRegistryRecord(
    row: typeof workspaceRuntimeServices.$inferSelect,
    options?: { unsafeOwner?: boolean },
  ) {
    let record = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (record && record.metadata?.companyId !== row.companyId) {
      throw new Error(
        `Local service registry company does not match runtime service ${row.id} (cross-tenant binding)`,
      );
    }
    if (record) assertPersistedRegistryBinding(row, record);
    if (!record && row.command && row.cwd) {
      record = await findAdoptableLocalServiceStrict({
        serviceKey: createLocalServiceKey({
          companyId: row.companyId,
          profileKind: "workspace-runtime",
          serviceName: row.serviceName,
          cwd: row.cwd,
          command: row.command,
          envFingerprint: row.reuseKey ?? "",
          port: null,
          scope: {
            scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
            scopeId: row.scopeId ?? null,
            executionWorkspaceId: row.executionWorkspaceId ?? null,
            reuseKey: row.reuseKey ?? null,
          },
        }),
        profileKind: "workspace-runtime",
        serviceName: row.serviceName,
        command: row.command,
        cwd: row.cwd,
        envFingerprint: row.reuseKey ?? "",
        port: row.port ?? null,
        url: row.url ?? null,
      });
      // A service key describes a reusable identity and is not unique to a DB
      // row. Never let a stale historical row claim (or terminate) a registry
      // record that is explicitly bound to a different, current runtime row.
      if (record?.runtimeServiceId && record.runtimeServiceId !== row.id) {
        return null;
      }
      if (record && record.metadata?.companyId !== row.companyId) {
        throw new Error(
          `Local service registry company does not match runtime service ${row.id} (cross-tenant binding)`,
        );
      }
      if (record) assertPersistedRegistryBinding(row, record);
      if (record && record.runtimeServiceId === null) {
        const persistedPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
        if (
          !persistedPid ||
          (persistedPid !== record.pid && persistedPid !== record.processGroupId)
        ) {
          throw new Error(
            `Workspace runtime service ${row.id} matched an unbound local process without exact PID identity`,
          );
        }
      }
    }
    return record;
  }

  let adopted = 0;
  let stopped = deadPersistedStopped;
  async function waitForLocalProcessExit(input: { pid: number; processGroupId?: number | null }) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const alive = isPidAlive(input.pid) || isProcessGroupAlive(input.processGroupId);
      if (!alive) return true;
      await delay(50);
    }
    return false;
  }

  async function terminalizePersistedRuntimeRow(input: {
    row: typeof workspaceRuntimeServices.$inferSelect;
    registryRecord?: (typeof registryRecords)[number] | null;
    terminalStatus: "stopped" | "failed";
    failureCode: string | null;
  }) {
    const claim = startClaimsByRuntimeServiceId.get(input.row.id);
    if (claim && (
      claim.companyId !== input.row.companyId ||
      claim.runtimeServiceId !== input.row.id ||
      claim.ownerAgentId !== input.row.ownerAgentId
    )) {
      throw new Error(`Persisted runtime service ${input.row.id} has no exact start-claim binding`);
    }
    if (input.registryRecord) {
      if (!claim) {
        throw new Error(`Persisted runtime service ${input.row.id} has no exact start-claim binding`);
      }
      assertPersistedRegistryBinding(input.row, input.registryRecord);
    }

    const persistRuntimeTerminalState = async (txDb: Db) => {
      const locked = await txDb.select().from(workspaceRuntimeServices).where(and(
        eq(workspaceRuntimeServices.id, input.row.id),
        eq(workspaceRuntimeServices.companyId, input.row.companyId),
      )).for("update").then((rows) => rows[0] ?? null);
      if (
        !locked ||
        locked.status !== input.row.status ||
        locked.updatedAt.getTime() !== input.row.updatedAt.getTime() ||
        locked.serviceName !== input.row.serviceName ||
        locked.command !== input.row.command ||
        locked.cwd !== input.row.cwd ||
        locked.ownerAgentId !== input.row.ownerAgentId ||
        locked.scopeType !== input.row.scopeType ||
        locked.scopeId !== input.row.scopeId ||
        locked.reuseKey !== input.row.reuseKey
      ) {
        throw new Error(`Persisted runtime service ${input.row.id} changed before terminalization`);
      }
      const now = new Date();
      const updated = await txDb.update(workspaceRuntimeServices).set({
        status: input.terminalStatus,
        healthStatus: input.terminalStatus === "failed" ? "unhealthy" : "unknown",
        stoppedAt: input.terminalStatus === "stopped" ? (input.row.stoppedAt ?? now) : input.row.stoppedAt,
        lastUsedAt: now,
        updatedAt: now,
      }).where(and(
        eq(workspaceRuntimeServices.id, input.row.id),
        eq(workspaceRuntimeServices.companyId, input.row.companyId),
        eq(workspaceRuntimeServices.status, input.row.status),
      )).returning({ id: workspaceRuntimeServices.id });
      if (updated.length !== 1) {
        throw new Error(`Persisted runtime service ${input.row.id} terminalization CAS failed`);
      }
    };

    if (claim) {
      await terminalizeWorkspaceRuntimeStartClaim({
        db,
        companyId: input.row.companyId,
        serviceKey: claim.serviceKey,
        claimId: claim.claimId,
        runtimeServiceId: input.row.id,
        expectedStatus: claim.status as "starting" | "running" | "stopped" | "failed",
        expectedRuntimeServiceId: input.row.id,
        terminalStatus: input.terminalStatus,
        failureCode: input.failureCode,
        persist: persistRuntimeTerminalState,
      });
    } else {
      // Pre-start-claim rows can only reach this branch after process absence
      // was proven and no registry record exists. Preserve compatibility while
      // still locking and CASing the complete persisted row in one transaction.
      await db.transaction(async (tx) => {
        await persistRuntimeTerminalState(tx as unknown as Db);
      });
    }
    if (input.registryRecord) {
      await dependencies?.afterPersistedTerminalizedBeforeRegistryRemove?.({
        companyId: input.row.companyId,
        serviceKey: claim!.serviceKey,
        claimId: claim!.claimId,
        runtimeServiceId: input.row.id,
      });
      await removeExactRuntimeRegistryAfterTerminalization({
        db,
        companyId: input.row.companyId,
        ownerAgentId: input.row.ownerAgentId,
        serviceKey: input.registryRecord.serviceKey,
        profileKind: input.registryRecord.profileKind,
        expectedRegistry: input.registryRecord,
        expectedClaim: {
          claimId: claim!.claimId,
          status: input.terminalStatus,
          runtimeServiceId: input.row.id,
        },
      });
    }
  }

  const expectedActiveStatuses = new Set(["starting", "running"]);
  const cleanupRows = rows.filter((row) =>
    isUnsafeRuntimeOwner(row) || !expectedActiveStatuses.has(row.status)
  );
  const cleanupRowIds = new Set([
    ...cleanupRows.map((row) => row.id),
    ...deadRegistryRuntimeIds,
  ]);
  const cleanupFailures: Error[] = [];
  for (const row of cleanupRows) {
    if (deadRegistryRuntimeIds.has(row.id)) continue;
    let cleanupFailure: Error | null = null;
    let registryRecordFound = false;
    let registryRecordForTerminalization: (typeof registryRecords)[number] | null = null;
    try {
      const runtimeRecord = runtimeServicesById.get(row.id);
      const registryRecord = await findPersistedRegistryRecord(row, { unsafeOwner: true });
      if (registryRecord) {
        registryRecordFound = true;
        registryRecordForTerminalization = registryRecord;
        await dependencies?.afterPersistedClassifiedBeforeSignal?.({
          companyId: row.companyId,
          runtimeServiceId: row.id,
          ownerAgentId: row.ownerAgentId,
        });
        await (dependencies?.terminateLocalService ?? terminateLocalService)(registryRecord, {
          signalWithinFence: async (_signal, sendSignal) => {
            await signalPersistedRuntimeWithinFence({
              row,
              registry: registryRecord,
              expectedOwner: row.ownerAgentId ? (ownerRecords.get(row.ownerAgentId) ?? null) : null,
              sendSignal: () => {
                sendSignal();
                if (runtimeRecord && runtimeServicesById.get(row.id) === runtimeRecord) {
                  runtimeRecord.startFinalizationState = "terminalizing";
                }
              },
            });
          },
        });
        if (!(await waitForLocalProcessExit(registryRecord))) {
          throw new Error(`Workspace runtime process ${registryRecord.pid} remained alive after termination`);
        }
      }
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }

    const wasActive = expectedActiveStatuses.has(row.status);
    const providerPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
    const providerRefUnverifiable = row.providerRef !== null &&
      (providerPid === null || !Number.isInteger(providerPid) || providerPid <= 0);
    const validProviderPid =
      providerPid !== null && Number.isInteger(providerPid) && providerPid > 0;
    const persistedPidOrGroupAlive = validProviderPid &&
      (isPidAlive(providerPid) || isProcessGroupAlive(providerPid));
    const noPersistedProcessIdentityExpected =
      row.providerRef === null && !wasActive && row.status !== "failed";
    const processAbsenceProven =
      noPersistedProcessIdentityExpected ||
      (validProviderPid && !isPidAlive(providerPid) && !isProcessGroupAlive(providerPid));
    const unresolvedCleanupEvidence =
      wasActive ||
      row.status === "failed" ||
      providerRefUnverifiable ||
      persistedPidOrGroupAlive;
    if (!registryRecordFound && unresolvedCleanupEvidence && !processAbsenceProven) {
      cleanupFailure = new Error(
        `Workspace runtime service ${row.id} has no verifiable local process registry record`,
        cleanupFailure ? { cause: cleanupFailure } : undefined,
      );
    }

    if (cleanupFailure) {
      logger.error(
        { err: cleanupFailure, runtimeServiceId: row.id, ownerAgentId: row.ownerAgentId },
        "failed to reconcile persisted workspace runtime service during startup",
      );
      cleanupFailures.push(cleanupFailure);
      continue;
    }

    // Terminal rows with no remaining registry evidence are already inert. A
    // formerly-active row is only terminalized when its persisted PID and PGID
    // is positively absent; otherwise the failed evidence keeps blocking every
    // subsequent startup until an operator resolves it.
    if (!registryRecordFound && row.status === "stopped" && processAbsenceProven) {
      await terminalizePersistedRuntimeRow({
        row,
        terminalStatus: "stopped",
        failureCode: "startup_reconciled_stopped",
      });
      continue;
    }
    if (!registryRecordFound && !processAbsenceProven) continue;

    await terminalizePersistedRuntimeRow({
      row,
      registryRecord: registryRecordForTerminalization,
      terminalStatus: "stopped",
      failureCode: "startup_reconciled_stopped",
    });
    runtimeServicesById.delete(row.id);
    if (row.reuseKey && runtimeServicesByReuseKey.get(
      runtimeServiceReuseMapKey(row.companyId, row.reuseKey),
    ) === row.id) {
      runtimeServicesByReuseKey.delete(runtimeServiceReuseMapKey(row.companyId, row.reuseKey));
    }
    stopped += 1;
  }

  // A potentially live process behind an unsafe owner or contradictory
  // terminal state is a startup boundary violation. Do not adopt any other
  // persisted process while that violation remains unresolved.
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `Persisted workspace runtime service reconciliation failed (${cleanupFailures.length}): ${cleanupFailures.map((error) => error.message).join("; ")}`,
    );
  }

  const activeReconciliationFailures: Error[] = [];
  for (const row of rows) {
    if (cleanupRowIds.has(row.id)) continue;
    let adoptedRecord: Awaited<ReturnType<typeof findPersistedRegistryRecord>> = null;
    try {
      adoptedRecord = await findPersistedRegistryRecord(row);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      activeReconciliationFailures.push(failure);
      continue;
    }
    if (adoptedRecord) {
      const adoptedUrl = adoptedRecord.url ?? row.url ?? null;
      if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, { serviceName: row.serviceName, command: row.command }))) {
        try {
          const runtimeRecord = runtimeServicesById.get(row.id);
          await (dependencies?.terminateLocalService ?? terminateLocalService)(adoptedRecord, {
            signalWithinFence: async (_signal, sendSignal) => {
              await signalPersistedRuntimeWithinFence({
                row,
                registry: adoptedRecord!,
                expectedOwner: row.ownerAgentId ? (ownerRecords.get(row.ownerAgentId) ?? null) : null,
                sendSignal: () => {
                  sendSignal();
                  if (runtimeRecord && runtimeServicesById.get(row.id) === runtimeRecord) {
                    runtimeRecord.startFinalizationState = "terminalizing";
                  }
                },
              });
            },
          });
          if (!(await waitForLocalProcessExit(adoptedRecord))) {
            throw new Error(`Workspace runtime process ${adoptedRecord.pid} remained alive after termination`);
          }
          await terminalizePersistedRuntimeRow({
            row,
            registryRecord: adoptedRecord,
            terminalStatus: "stopped",
            failureCode: "startup_reconciled_stopped",
          });
          stopped += 1;
          continue;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          activeReconciliationFailures.push(failure);
          continue;
        }
      } else {
        const adoptedClaim = startClaimsByRuntimeServiceId.get(row.id)!;
        const record: RuntimeServiceRecord = {
          id: row.id,
          companyId: row.companyId,
          projectId: row.projectId ?? null,
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.executionWorkspaceId ?? null,
          issueId: row.issueId ?? null,
          serviceName: row.serviceName,
          status: "running",
          lifecycle: row.lifecycle as RuntimeServiceRecord["lifecycle"],
          scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
          scopeId: row.scopeId ?? null,
          reuseKey: row.reuseKey ?? null,
          command: row.command ?? null,
          cwd: row.cwd ?? null,
          port: adoptedRecord.port ?? row.port ?? null,
          url: adoptedRecord.url ?? row.url ?? null,
          provider: "local_process",
          providerRef: String(adoptedRecord.processGroupId ?? adoptedRecord.pid),
          ownerAgentId: row.ownerAgentId ?? null,
          startedByRunId: row.startedByRunId ?? null,
          lastUsedAt: new Date().toISOString(),
          startedAt: row.startedAt.toISOString(),
          stoppedAt: null,
          stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
          healthStatus: "healthy",
          reused: true,
          db,
          child: null,
          leaseRunIds: new Set(),
          idleTimer: null,
          envFingerprint: row.reuseKey ?? "",
          serviceKey: adoptedRecord.serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
          startClaimId: adoptedClaim.claimId,
          startFinalizationState: "running",
          exitLatch: null,
        };
        registerRuntimeService(db, record);
        await touchLocalServiceRegistryRecord(adoptedRecord.serviceKey, {
          runtimeServiceId: row.id,
          lastSeenAt: record.lastUsedAt,
        });
        await persistRuntimeServiceRecord(db, record);
        adopted += 1;
        continue;
      }
    }

    const providerPid = row.providerRef ? Number.parseInt(row.providerRef, 10) : null;
    const providerPidValid = providerPid !== null && Number.isInteger(providerPid) && providerPid > 0;
    const processAbsenceProven = providerPidValid &&
      !isPidAlive(providerPid) && !isProcessGroupAlive(providerPid);
    if (!processAbsenceProven) {
      const failure = new Error(
        `Active workspace runtime service ${row.id} has no verified registry and process absence is unproven`,
      );
      activeReconciliationFailures.push(failure);
      continue;
    }

    await terminalizePersistedRuntimeRow({
      row,
      terminalStatus: "stopped",
      failureCode: "startup_reconciled_stopped",
    });
    stopped += 1;
  }

  if (activeReconciliationFailures.length > 0) {
    throw new AggregateError(
      activeReconciliationFailures,
      `Active workspace runtime service reconciliation failed (${activeReconciliationFailures.length}): ${
        activeReconciliationFailures.map((error) => error.message).join("; ")
      }`,
    );
  }

  return { reconciled: rows.length, adopted, stopped };
}

export async function restartDesiredRuntimeServicesOnStartup(db: Db) {
  let restarted = 0;
  let failed = 0;

  const projectWorkspaceRows = await db
    .select()
    .from(projectWorkspaces);
  const projectWorkspaceRowsById = new Map(projectWorkspaceRows.map((row) => [row.id, row] as const));

  for (const row of projectWorkspaceRows) {
    const runtimeConfig = readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null);
    if (runtimeConfig?.desiredState !== "running" || !runtimeConfig.workspaceRuntime || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: null,
        workspace: {
          baseCwd: row.cwd,
          source: "project_primary",
          projectId: row.projectId,
          workspaceId: row.id,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.repoRef ?? null,
          strategy: "project_primary",
          cwd: row.cwd,
          branchName: row.defaultRef ?? row.repoRef ?? null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: runtimeConfig.workspaceRuntime,
          desiredState: runtimeConfig.desiredState,
          serviceStates: runtimeConfig.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  const executionWorkspaceRows = await db
    .select()
    .from(executionWorkspaces)
    .where(inArray(executionWorkspaces.status, ["active", "idle", "in_review", "cleanup_failed"]));

  for (const row of executionWorkspaceRows) {
    const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
    const inheritedRuntimeConfig = row.projectWorkspaceId
      ? readProjectWorkspaceRuntimeConfig(
          (projectWorkspaceRowsById.get(row.projectWorkspaceId)?.metadata as Record<string, unknown> | null) ?? null,
        )?.workspaceRuntime ?? null
      : null;
    const effectiveRuntimeConfig = config?.workspaceRuntime ?? inheritedRuntimeConfig;
    if (config?.desiredState !== "running" || !effectiveRuntimeConfig || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: row.sourceIssueId
          ? {
              id: row.sourceIssueId,
              identifier: null,
              title: row.name,
            }
          : null,
        workspace: {
          baseCwd: row.cwd,
          source: row.mode === "shared_workspace" ? "project_primary" : "task_session",
          projectId: row.projectId,
          workspaceId: row.projectWorkspaceId ?? null,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.baseRef ?? null,
          strategy: row.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
          cwd: row.cwd,
          branchName: row.branchName ?? null,
          worktreePath: row.strategyType === "git_worktree" ? row.cwd : null,
          warnings: [],
          created: false,
        },
        executionWorkspaceId: row.id,
        config: {
          workspaceRuntime: effectiveRuntimeConfig,
          desiredState: config.desiredState,
          serviceStates: config.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  return { restarted, failed };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
  dependencies?: {
    afterReportsNormalizedBeforePersist?: (refs: RuntimeServiceRef[]) => Promise<void>;
  };
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;
  const activeOwnerId = input.agent.id && refs.some((ref) => (
    runtimeServiceStatusNeedsActiveOwner(ref.status)
  )) ? input.agent.id : null;

  const persistRefs = async (targetDb: Db) => {
    const existingRows = await targetDb
      .select()
      .from(workspaceRuntimeServices)
      .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    for (const ref of refs) {
      const existing = existingById.get(ref.id);
      const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
      const createdAt = existing?.createdAt ?? new Date();
      await targetDb
        .insert(workspaceRuntimeServices)
        .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        executionWorkspaceId: ref.executionWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: workspaceRuntimeServices.id,
          set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          executionWorkspaceId: ref.executionWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
          },
        });
    }
  };

  const execute = async () => {
    await input.dependencies?.afterReportsNormalizedBeforePersist?.(refs);
    if (activeOwnerId) {
      await input.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockAgentLifecycleReference(txDb, {
          companyId: input.agent.companyId,
          agentId: activeOwnerId,
          mode: "active",
        });
        await persistRefs(txDb);
      });
    } else {
      await persistRefs(input.db);
    }
    return refs;
  };

  return activeOwnerId ? withAgentStartLock(activeOwnerId, execute) : execute();
}

export function buildWorkspaceReadyComment(input: {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { readSubscriptionAccountId } from "./codex-auth-cache.js";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const MANAGED_MCP_BLOCK_START = "# BEGIN PAPERCLIP MANAGED MCP";
const MANAGED_MCP_BLOCK_END = "# END PAPERCLIP MANAGED MCP";

/**
 * The allowlist of managed `CODEX_HOME` entries that the codex-local adapter
 * stages into the sandbox `home` asset (see {@link stageCodexHomeForSync}).
 * Derived from the seeding constants so it can never drift from what the adapter
 * actually writes into the home: the copied static config files, the symlinked
 * credential file, and the injected `skills/` directory. Everything else the
 * stock upstream `codex` binary writes at runtime (`*.sqlite`, `*-wal`,
 * `plugins/`, `cache/`, `sessions/`, `shell_snapshots/`, …) is intentionally
 * excluded — it is large host-local runtime state the sandbox run never needs.
 */
export const CODEX_SYNC_ALLOWLIST = [
  // Dieser Fork kopiert keine Host-Profildateien mehr in den verwalteten Home,
  // deshalb enthaelt die Allowlist nur die verlinkte Credential-Datei und die
  // eingespielten Skills.
  ...SYMLINKED_SHARED_FILES,
  "skills",
] as const;

export type ManagedCodexMcpGateway = {
  name: string;
  endpointPath: string;
  bearerToken: string;
};

export function mergeManagedCodexMcpGateways(
  primary: ManagedCodexMcpGateway[],
  secondary: ManagedCodexMcpGateway[],
): ManagedCodexMcpGateway[] {
  const merged = [...primary];
  const names = new Set(primary.map((gateway) => gateway.name));
  for (const gateway of secondary) {
    if (names.has(gateway.name)) continue;
    merged.push(gateway);
    names.add(gateway.name);
  }
  return merged;
}
const AUTH_CREDENTIAL_KEYS = /(?:openai[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|session|auth)/i;
const LEGACY_SHARED_PROFILE_FILES = [
  "config.json",
  "config.toml",
  "config.toml.paperclip-backup",
  "instructions.md",
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assertSafePathComponent(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    path.basename(value) !== value
  ) {
    throw new Error(`${label} must be a safe single path component`);
  }
}

function resolveInstanceRoot(env: NodeJS.ProcessEnv): string {
  return resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

// Co-change notice: this function's logic is mirrored by parseAuth in
// packages/adapter-utils/src/sandbox-managed-runtime.ts (buildCodexAuthMergeDecisionScript).
// If the auth format changes (new shape, renamed field), update both sites together.
function hasUsableAuthPayload(authPayload: unknown): boolean {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return false;
  }

  const parsedPayload = authPayload as Record<string, unknown>;
  const apiKey = parsedPayload.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return true;
  }

  const tokens = parsedPayload.tokens;
  if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
    const parsedTokens = tokens as Record<string, unknown>;
    const accountId = parsedTokens.account_id;
    const hasAccountId = typeof accountId === "string" && accountId.trim().length > 0;
    const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
      const value = parsedTokens[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (hasAccountId && hasTokenMaterial) return true;
  }

  return false;
}

function readApiKeyFromAuthPayload(authPayload: unknown): string | null {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return null;
  }
  const raw = (authPayload as Record<string, unknown>).OPENAI_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.PAPERCLIP_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
  agentId?: string,
): string {
  if (companyId) assertSafePathComponent(companyId, "companyId");
  if (agentId) assertSafePathComponent(agentId, "agentId");
  const instanceRoot = resolveInstanceRoot(env);
  if (companyId && agentId) {
    return path.resolve(
      instanceRoot,
      "companies",
      companyId,
      "agents",
      agentId,
      "codex-home",
    );
  }
  if (companyId) return path.resolve(instanceRoot, "companies", companyId, "codex-home");
  return path.resolve(instanceRoot, "codex-home");
}

async function ensureVerifiedDirectory(directory: string, label: string): Promise<string> {
  let existing = await fs.lstat(directory).catch(() => null);
  if (!existing) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    existing = await fs.lstat(directory).catch(() => null);
  }
  if (!existing) throw new Error(`Managed Codex ${label} could not be created`);
  if (existing.isSymbolicLink()) {
    throw new Error(`Managed Codex ${label} must not be a symbolic link`);
  }
  if (!existing.isDirectory()) throw new Error(`Managed Codex ${label} must be a directory`);
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}

export async function ensureManagedCodexHomePath(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
  candidate?: string,
): Promise<string> {
  const expected = resolveManagedCodexHomeDir(env, companyId, agentId);
  if (candidate && path.resolve(candidate) !== expected) {
    throw new Error(`Configured managed CODEX_HOME must match the current agent's managed home`);
  }
  const instanceRoot = resolveInstanceRoot(env);
  await fs.mkdir(instanceRoot, { recursive: true, mode: 0o700 });
  const realInstanceRoot = await fs.realpath(instanceRoot);
  const companiesRoot = path.join(instanceRoot, "companies");
  const realCompaniesRoot = await ensureVerifiedDirectory(companiesRoot, "companies directory");
  const companyRoot = path.join(companiesRoot, companyId);
  const realCompanyRoot = await ensureVerifiedDirectory(companyRoot, "company directory");
  for (const [label, candidateRoot] of [
    ["companies directory", realCompaniesRoot],
    ["company directory", realCompanyRoot],
  ] as const) {
    const relative = path.relative(realInstanceRoot, candidateRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Managed Codex ${label} escapes the instance root`);
    }
  }
  let current = companyRoot;
  for (const [component, label] of [
    ["agents", "agents directory"],
    [agentId, "agent directory"],
    ["codex-home", "home directory"],
  ] as const) {
    current = path.join(current, component);
    const realCurrent = await ensureVerifiedDirectory(current, label);
    const relative = path.relative(realCompanyRoot, realCurrent);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Managed Codex ${label} escapes the company root`);
    }
  }
  return expected;
}

async function quarantineLegacySharedProfileFiles(targetHome: string): Promise<void> {
  const present: Array<{ name: string; path: string }> = [];
  for (const name of LEGACY_SHARED_PROFILE_FILES) {
    const source = path.join(targetHome, name);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing legacy managed Codex profile symbolic link at ${source}`);
    }
    if (!stat.isFile()) throw new Error(`Legacy managed Codex profile entry must be a file: ${source}`);
    present.push({ name, path: source });
  }
  if (present.length === 0) return;
  const quarantine = path.join(path.dirname(targetHome), "codex-home-legacy-profile");
  await ensureVerifiedDirectory(quarantine, "legacy profile quarantine");
  for (const entry of present) {
    let destination = path.join(quarantine, entry.name);
    if (await pathExists(destination)) destination = `${destination}.${randomUUID()}`;
    await fs.rename(entry.path, destination);
    await fs.chmod(destination, 0o600);
  }
}

/**
 * True when `homePath` lives under the Paperclip-managed company tree
 * (`<instanceRoot>/companies/<companyId>/...`). This covers both the shared
 * company `codex-home` and the per-agent `agents/<agentId>/codex-home` set by
 * the server-side isolation guard. A path outside that tree is a genuine
 * external/user-supplied override that Paperclip must not seed or overwrite.
 */
export function isManagedCodexHomePath(
  env: NodeJS.ProcessEnv,
  companyId: string | undefined,
  homePath: string,
  agentId?: string,
): boolean {
  if (!companyId) return false;
  if (agentId) {
    return path.resolve(homePath) === resolveManagedCodexHomeDir(env, companyId, agentId);
  }
  const instanceRoot = resolveInstanceRoot(env);
  const companyRoot = path.resolve(instanceRoot, "companies", companyId);
  const resolved = path.resolve(homePath);
  return resolved === companyRoot || resolved.startsWith(companyRoot + path.sep);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  return fs.realpath(candidate).catch(() => null);
}

async function resolveThroughNearestExistingAncestor(candidate: string): Promise<string | null> {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const realAncestor = await fs.realpath(cursor);
      return path.resolve(realAncestor, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function isReservedCodexHomePath(
  env: NodeJS.ProcessEnv,
  candidate: string,
): Promise<boolean> {
  const resolved = path.resolve(candidate);
  const instanceRoot = resolveInstanceRoot(env);
  const sharedSource = resolveSharedCodexHomeDir(env);
  const defaultHostSource = path.join(os.homedir(), ".codex");
  if (
    isPathWithin(instanceRoot, resolved) ||
    resolved === path.resolve(sharedSource) ||
    resolved === path.resolve(defaultHostSource)
  ) return true;

  const realCandidate = await resolveThroughNearestExistingAncestor(resolved);
  if (!realCandidate) return false;
  const [realInstanceRoot, realSharedSource, realDefaultHostSource] = await Promise.all([
    realpathOrNull(instanceRoot),
    realpathOrNull(sharedSource),
    realpathOrNull(defaultHostSource),
  ]);
  return (
    (realInstanceRoot != null && isPathWithin(realInstanceRoot, realCandidate)) ||
    (realSharedSource != null && realCandidate === realSharedSource) ||
    (realDefaultHostSource != null && realCandidate === realDefaultHostSource)
  );
}

type ManagedCodexHomeLockOwner = {
  pid: number;
  hostname: string;
  token: string;
  createdAt: string;
};

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockOwner(lockDir: string): Promise<ManagedCodexHomeLockOwner | null> {
  const ownerPath = path.join(lockDir, "owner.json");
  const stat = await fs.lstat(ownerPath).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Managed Codex home lock owner must be a regular file`);
  }
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<ManagedCodexHomeLockOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.createdAt !== "string"
    ) return null;
    return parsed as ManagedCodexHomeLockOwner;
  } catch {
    return null;
  }
}

async function moveStaleLockAside(
  lockDir: string,
  observedOwner: ManagedCodexHomeLockOwner | null,
): Promise<boolean> {
  const stalePath = `${lockDir}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockDir, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const movedOwner = await readLockOwner(stalePath);
  if ((observedOwner?.token ?? null) !== (movedOwner?.token ?? null)) {
    await fs.rename(stalePath, lockDir).catch(() => undefined);
    return false;
  }
  await fs.rm(stalePath, { recursive: true, force: true });
  return true;
}

export async function acquireManagedCodexHomeLease(
  home: string,
  options: { waitMs?: number; pollMs?: number; staleOwnerGraceMs?: number } = {},
): Promise<{ release: () => Promise<void> }> {
  const waitMs = Math.max(1, options.waitMs ?? 30_000);
  const pollMs = Math.max(1, options.pollMs ?? 50);
  const staleOwnerGraceMs = Math.max(0, options.staleOwnerGraceMs ?? 1_000);
  const lockDir = `${home}.paperclip-lock`;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, hostname: os.hostname(), token, createdAt: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      );
      return {
        release: async () => {
          const owner = await readLockOwner(lockDir).catch(() => null);
          if (owner?.token !== token) return;
          const releasePath = `${lockDir}.release-${token}`;
          await fs.rename(lockDir, releasePath).catch(() => undefined);
          const movedOwner = await readLockOwner(releasePath).catch(() => null);
          if (movedOwner?.token === token) {
            await fs.rm(releasePath, { recursive: true, force: true });
          } else {
            await fs.rename(releasePath, lockDir).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(lockDir).catch(() => null);
      if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
        throw new Error(`Managed Codex home lock must be a directory`);
      }
      const owner = await readLockOwner(lockDir);
      const ageMs = owner
        ? Date.now() - Date.parse(owner.createdAt)
        : stat ? Date.now() - stat.mtimeMs : 0;
      const ownerIsLive = owner?.hostname === os.hostname() && isPidAlive(owner.pid);
      const stale = ageMs >= staleOwnerGraceMs && !ownerIsLive;
      if (stale && await moveStaleLockAside(lockDir, owner)) continue;
      if (!ownerIsLive && Date.now() >= deadline) {
        throw new Error(`Timed out waiting for managed Codex home lease at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * True when the Codex home has a usable `auth.json`. Uses `fs.access` (follows
 * symlinks), so a dangling auth symlink whose source has been removed counts as
 * no usable credentials.
 */
export async function codexHomeHasUsableAuth(home: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  if (!(await pathExists(authPath))) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return hasUsableAuthPayload(parsed);
  } catch {
    return false;
  }
}

async function codexHomeHasMatchingApiKeyAuth(home: string, apiKey: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  const existing = await fs.lstat(authPath).catch(() => null);
  if (!existing || existing.isSymbolicLink()) return false;
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return readApiKeyFromAuthPayload(parsed) === apiKey.trim();
  } catch {
    return false;
  }
}

async function codexHomeHasRegularApiKeyAuth(home: string): Promise<boolean> {
  const authPath = path.join(home, "auth.json");
  const existing = await fs.lstat(authPath).catch(() => null);
  if (!existing?.isFile() || existing.isSymbolicLink()) return false;
  try {
    const parsed = JSON.parse(await fs.readFile(authPath, "utf8"));
    return readApiKeyFromAuthPayload(parsed) !== null;
  } catch {
    return false;
  }
}

async function hardenRegularAuthFilePermissions(home: string): Promise<void> {
  const authPath = path.join(home, "auth.json");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(authPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Managed Codex auth.json must be a regular file`);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function ensureParentDir(target: string): Promise<void> {
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
}

async function isExpectedSymlink(target: string, source: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return false;

  return path.resolve(path.dirname(target), linkedPath) === path.resolve(source);
}

async function createExpectedSymlink(target: string, source: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && await isExpectedSymlink(target, source)) return;
    throw error;
  }
}

export async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (!existing.isSymbolicLink()) {
    // A previous Paperclip version copied this file into the managed home
    // instead of symlinking it. Codex refresh tokens rotate and are
    // single-use, so a stale copy fails with refresh_token_reused on the next
    // run (#5028). Replace the regular file with a symlink so the CLI follows
    // the live source. Safe to delete: target is always under the
    // Paperclip-managed company home, never the user's real ~/.codex.
    // Directories are left alone — `fs.unlink` would throw EISDIR on Unix
    // (and behave inconsistently on Windows). A directory at this path is not
    // a Paperclip-written stale copy and warrants operator inspection rather
    // than silent removal.
    if (existing.isDirectory()) return;
    await fs.unlink(target);
    await createExpectedSymlink(target, source);
    return;
  }

  if (await isExpectedSymlink(target, source)) return;

  await fs.unlink(target);
  await createExpectedSymlink(target, source);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeMcpServerName(value: string, fallback: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function stripManagedMcpBlock(config: string): string {
  const start = config.indexOf(MANAGED_MCP_BLOCK_START);
  if (start < 0) return config.trimEnd();
  const end = config.indexOf(MANAGED_MCP_BLOCK_END, start);
  if (end < 0) return config.slice(0, start).trimEnd();
  return `${config.slice(0, start)}${config.slice(end + MANAGED_MCP_BLOCK_END.length)}`.trimEnd();
}

function readCodexMcpServerNames(config: string): Set<string> {
  const names = new Set<string>();
  for (const match of config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s#]+))\s*\]/gm)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name.trim());
  }
  return names;
}

function buildManagedMcpBlock(input: {
  gateways: ManagedCodexMcpGateway[];
  apiBaseUrl: string;
  existingNames: Set<string>;
}): { block: string; warnings: string[] } {
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const lines = [
    MANAGED_MCP_BLOCK_START,
    "# Written by Paperclip for governed MCP gateway access. Do not edit this block by hand.",
  ];
  input.gateways.forEach((gateway, index) => {
    const baseName = sanitizeMcpServerName(gateway.name, `gateway-${index + 1}`);
    const directOverlap = input.existingNames.has(gateway.name) || input.existingNames.has(baseName);
    let managedName = directOverlap ? `paperclip-${baseName}` : baseName;
    let suffix = 2;
    while (usedNames.has(managedName) || input.existingNames.has(managedName)) {
      managedName = `paperclip-${baseName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(managedName);
    if (directOverlap) {
      warnings.push(
        `Found unmanaged Codex MCP server "${gateway.name}" overlapping a Paperclip-governed gateway; leaving the direct entry in place and adding managed gateway "${managedName}". Paperclip cannot enforce policies for that direct entry.`,
      );
    }
    const url = new URL(gateway.endpointPath, input.apiBaseUrl).toString();
    lines.push(
      "",
      `[mcp_servers.${tomlString(managedName)}]`,
      `url = ${tomlString(url)}`,
      `headers = { Authorization = ${tomlString(`Bearer ${gateway.bearerToken}`)} }`,
    );
  });
  lines.push(MANAGED_MCP_BLOCK_END);
  return { block: lines.join("\n"), warnings };
}

export async function writeManagedCodexMcpConfig(input: {
  codexHome: string;
  apiBaseUrl: string;
  gateways: ManagedCodexMcpGateway[];
}): Promise<{ configPath: string; warnings: string[] }> {
  const configPath = path.join(input.codexHome, "config.toml");
  await fs.mkdir(input.codexHome, { recursive: true });
  const existing = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const unmanagedConfig = stripManagedMcpBlock(existing);
  const { block, warnings } = buildManagedMcpBlock({
    gateways: input.gateways,
    apiBaseUrl: input.apiBaseUrl,
    existingNames: readCodexMcpServerNames(unmanagedConfig),
  });
  const next = input.gateways.length > 0
    ? `${unmanagedConfig}${unmanagedConfig ? "\n\n" : ""}${block}\n`
    : `${unmanagedConfig}${unmanagedConfig ? "\n" : ""}`;
  await fs.writeFile(configPath, next, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return { configPath, warnings };
}
/**
 * Writes an `auth.json` containing only `OPENAI_API_KEY` so the codex CLI can
 * authenticate via API key. Overwrites any existing file or symlink at that
 * path. Required because the codex CLI (>= 0.122) ignores the `OPENAI_API_KEY`
 * environment variable and only reads credentials from `$CODEX_HOME/auth.json`.
 */
export async function writeApiKeyAuthJson(home: string, apiKey: string): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const target = path.join(home, "auth.json");
  await fs.rm(target, { force: true });
  await fs.writeFile(target, JSON.stringify({ OPENAI_API_KEY: apiKey }), { mode: 0o600 });
}

export interface StageCodexHomeForSyncOptions {
  /** Run id, used only to make the staged temp-dir name traceable in logs. */
  runId?: string;
}

/**
 * True when `candidate` is `root` itself or a descendant of it. Both arguments
 * must be absolute, already-resolved (symlink-free) paths — callers pass
 * `fs.realpath` output — so `path.relative` is a reliable containment test that
 * is not fooled by `..` segments or a trailing-separator prefix collision
 * (`/a/skills` vs `/a/skills-evil`).
 */
function isResolvedPathInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Recursively copies one skill subtree — rooted at its real directory
 * `containmentRoot` — into `targetDir`, dereferencing symlinks to bytes (so the
 * sandbox receives real file content, not host-relative links) and normalizing
 * every copied regular file to mode `0600`. Created directories get mode `0700`.
 *
 * Two containment guards protect the staged upload:
 *
 * - **Allowlist escape (finding 2).** After dereferencing, a symlink whose real
 *   target falls *outside* `containmentRoot` is skipped. A malformed or
 *   compromised skill could otherwise smuggle host files that are not in
 *   `CODEX_SYNC_ALLOWLIST` (e.g. `~/.ssh/id_rsa`) into the upload by pointing a
 *   nested link at them. The skill's own top-level link into the shared skill
 *   store is still honoured — it is what establishes `containmentRoot` in
 *   {@link stageDirectorySecure}; only links that escape *that* root are cut.
 * - **Directory cycles (finding 1).** A directory symlink such as `back -> .` or
 *   `back -> ..` resolves to an ancestor directory instead of raising `ELOOP`;
 *   recursing into it would traverse the same tree forever until disk/memory is
 *   exhausted. A resolved directory already on the active traversal path
 *   (`activePath`) is therefore skipped.
 *
 * Dangling symlinks (`ENOENT`) and self-referential links that do trip `ELOOP`
 * are silently skipped, as are non-file/dir entries (sockets, devices).
 */
async function stageContainedSubtree(
  sourceDir: string,
  targetDir: string,
  containmentRoot: string,
  activePath: Set<string>,
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const entrySource = path.join(sourceDir, entry.name);
    const entryTarget = path.join(targetDir, entry.name);
    // Resolve the real path; dangling or self-referential (`ELOOP`) links skip.
    const resolved = await fs.realpath(entrySource).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") return null;
      throw error;
    });
    if (!resolved) continue;
    // Allowlist containment: never dereference a link that escapes this skill's
    // real root (host files outside CODEX_SYNC_ALLOWLIST) into the upload.
    if (!isResolvedPathInside(resolved, containmentRoot)) continue;
    const entryStat = await fs.stat(resolved).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      // Cycle guard: a directory already open on the active path (reached via a
      // `back -> .`-style link) would otherwise recurse forever.
      if (activePath.has(resolved)) continue;
      activePath.add(resolved);
      await stageContainedSubtree(resolved, entryTarget, containmentRoot, activePath);
      activePath.delete(resolved);
    } else if (entryStat.isFile()) {
      const bytes = await fs.readFile(resolved);
      await fs.writeFile(entryTarget, bytes, { mode: 0o600 });
      await fs.chmod(entryTarget, 0o600);
    }
    // Other types (sockets, devices) are silently skipped.
  }
}

/**
 * Recursively copies `sourceDir` (a directory allowlist entry — currently only
 * `skills/`) into `targetDir`, dereferencing symlinks to bytes and normalizing
 * every copied regular file to mode `0600`. Created directories get mode `0700`.
 *
 * This replaces `fs.cp({ dereference: true })` which preserves source file modes,
 * leaving `0644` documents and `0755` scripts group/other-readable in the staged
 * asset; here all regular files are normalized to `0600` regardless of source mode.
 *
 * `sourceDir`'s *direct* children are the Paperclip-injected skill symlinks that
 * intentionally point into a shared skill store *outside* `CODEX_HOME/skills/`,
 * so each child is allowed to resolve anywhere — and when it resolves to a
 * directory it becomes the containment root for its own subtree. Everything
 * *below* that root is copied via {@link stageContainedSubtree}, which refuses to
 * follow a nested symlink out of the skill (finding 2) and detects directory
 * cycles (finding 1). A direct child that resolves to `sourceDir` itself or to
 * an ancestor of it (a degenerate `-> .` / `-> ..` link at the top level) is
 * skipped rather than used as a root, so it can never drag the wider home into
 * the staged skills asset. The `0700` staged directory and per-file `0600` mode
 * together ensure even externally-sourced skill content is not group/world-readable.
 */
async function stageDirectorySecure(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const realSourceDir = await fs.realpath(sourceDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const entrySource = path.join(sourceDir, entry.name);
    const entryTarget = path.join(targetDir, entry.name);
    // Resolve the real path; dangling or self-referential (`ELOOP`) links skip.
    const resolved = await fs.realpath(entrySource).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") return null;
      throw error;
    });
    if (!resolved) continue;
    // A top-level child that resolves to the skills dir itself or an ancestor
    // of it (`back -> .` / `back -> ..`) is degenerate: using it as a root would
    // re-stage the whole home under `skills/`. Skip it.
    if (isResolvedPathInside(realSourceDir, resolved)) continue;
    const entryStat = await fs.stat(resolved).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      // This child skill establishes its own containment root: nested links may
      // not escape it, and the root seeds the cycle-detection active path.
      await stageContainedSubtree(resolved, entryTarget, resolved, new Set([resolved]));
    } else if (entryStat.isFile()) {
      const bytes = await fs.readFile(resolved);
      await fs.writeFile(entryTarget, bytes, { mode: 0o600 });
      await fs.chmod(entryTarget, 0o600);
    }
    // Other types (sockets, devices) are silently skipped.
  }
}

/**
 * Copies a single allowlist entry from the managed home into the staged dir,
 * dereferencing symlinks to bytes. Missing entries are skipped (keyring mode has
 * no `auth.json`; some homes have no `config.json`). Every staged regular file is
 * written `0600` (least privilege). Any non-`ENOENT` error propagates to the caller.
 */
async function stageCodexHomeEntry(
  sourceHome: string,
  stagedHome: string,
  entry: string,
): Promise<void> {
  const source = path.join(sourceHome, entry);
  // `fs.stat` follows symlinks, so a dangling link (e.g. a removed auth source)
  // reports ENOENT and is skipped exactly like a genuinely absent file.
  const stat = await fs.stat(source).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;

  const target = path.join(stagedHome, entry);
  if (stat.isDirectory()) {
    // Recursively copy with mode normalization — nested regular files land
    // `0600` and dangling/circular symlinks are skipped.
    await stageDirectorySecure(source, target);
    return;
  }

  // `fs.readFile` follows the symlink into the shared source and returns the
  // resolved bytes (the live single-use auth token), which we write as a plain
  // regular file so copy-back and in-sandbox auth read real bytes.
  const bytes = await fs.readFile(source);
  // Stage every regular file `0600`, not just `auth.json`. The staged dir is a
  // 0700 mkdtemp and each file is read back only by the owner (Codex in-sandbox +
  // copy-back), so nothing needs group/other read. This is least privilege and,
  // critically, keeps secret-bearing entries protected: `config.toml` embeds the
  // managed MCP `Authorization = "Bearer …"` header (and the source writer
  // persists it 0600), so a per-file credential allowlist would silently
  // downgrade it to 0644 in a world-readable tmpdir.
  await fs.writeFile(target, bytes, { mode: 0o600 });
  // Explicit chmod so the mode is 0600 regardless of the process umask.
  await fs.chmod(target, 0o600);
}

/**
 * Stages exactly {@link CODEX_SYNC_ALLOWLIST} from `effectiveCodexHome` into a
 * fresh private temp dir and returns its path, for registration as the sandbox
 * `home` asset. This replaces syncing the whole managed home + a name denylist:
 * only the files Codex actually needs are uploaded, so oversized runtime state
 * (`sessions/`, `*.sqlite`, `plugins/`, …) never reaches the sandbox.
 *
 * - **Symlinks are dereferenced to bytes** — the single-use `auth.json`
 *   credential (a symlink into the shared source home) and each `skills/` entry
 *   land as real files, never dangling links.
 * - **Missing-but-optional entries are skipped** — no `auth.json` in
 *   keyring-credential mode, or no `config.json`, is not an error.
 * - **`mkdtemp` guarantees the staged dir is `0700`** on POSIX, and every staged
 *   regular file is written `0600` (least privilege), so staged credentials —
 *   `auth.json` (OAuth token) and `config.toml` (managed MCP bearer header) —
 *   are never group/other-readable.
 * - **Fail-closed** — any *unexpected* I/O error removes the partial temp dir
 *   and re-throws, so a run never proceeds with a partial or empty home.
 *
 * The caller owns removing the returned dir on run teardown.
 */
export async function stageCodexHomeForSync(
  effectiveCodexHome: string,
  options: StageCodexHomeForSyncOptions = {},
): Promise<string> {
  const runIdPart = nonEmpty(options.runId ?? undefined);
  const stagedHome = await fs.mkdtemp(
    path.join(os.tmpdir(), `paperclip-codex-home-sync-${runIdPart ? `${runIdPart}-` : ""}`),
  );
  try {
    for (const entry of CODEX_SYNC_ALLOWLIST) {
      await stageCodexHomeEntry(effectiveCodexHome, stagedHome, entry);
    }
    return stagedHome;
  } catch (error) {
    // Fail-closed: never hand back a partial home. Remove the temp dir we
    // created before propagating the failure.
    await fs.rm(stagedHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Seeds auth into an explicit Paperclip-managed `targetHome`. Symlinks
 * `auth.json` from the shared source home (so ChatGPT-subscription credentials
 * stay live and single-use refresh tokens are not copied) and — when an API key
 * is supplied — writes an API-key `auth.json` instead. Host profile config,
 * instructions, plugins, hooks, MCP declarations, and session state are never
 * inherited. Runtime-owned config and skills are rendered separately by their
 * existing explicit preparation paths.
 * Eine promotete Device-Login-Credential bleibt autoritativ:
 * sie wird weder entfernt noch durch den geteilten Symlink ersetzt.
 */
export async function seedManagedCodexHome(
  targetHome: string,
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  options: { apiKey?: string | null } = {},
): Promise<void> {
  const apiKey = nonEmpty(options.apiKey ?? undefined);

  const sourceHome = resolveSharedCodexHomeDir(env);
  const seedFromShared = path.resolve(sourceHome) !== path.resolve(targetHome);

  await fs.mkdir(targetHome, { recursive: true, mode: 0o700 });
  await fs.chmod(targetHome, 0o700);

  // A regular-file auth.json in the target home is one of two very different
  // things. The device-login promotion writes the company credential as a
  // regular file, and that file is the durable outcome of an interactive login,
  // so it must survive re-seeding. Everything else — an apikey-mode file left by
  // a previous run, a stale pre-symlink copy of the shared credential (#5028),
  // or an unreadable payload — is residue, and removing it lets the chatgpt-mode
  // symlink be restored (ensureSymlink would otherwise replace it and Codex
  // would keep authenticating with the stale key).
  //
  // The discriminator is identity-anchored, like the promotion and the cache
  // vend: keep the file only when it holds a usable subscription identity that
  // the shared source does not also hold. A same-identity regular file is the
  // #5028 stale copy — the symlink serves the same account with live, rotating
  // tokens, so it is strictly better. A different-identity (or source-less)
  // subscription file is the promoted company credential; on a server with no
  // shared login there is nothing to symlink at all, and deleting it would
  // silently sign the company out right after a successful device login.
  let keepPromotedAuth = false;
  if (!apiKey && seedFromShared) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    if (existing && !existing.isSymbolicLink()) {
      const targetBytes = await fs.readFile(authPath).catch(() => null);
      const targetIdentity = targetBytes ? readSubscriptionAccountId(targetBytes) : null;
      if (targetIdentity) {
        // Any source read failure — absent or unreadable — keeps the usable
        // target file. The alternative, removal plus the existence-only
        // symlink pass below, links the home to a source this process just
        // failed to read, and every downstream reader (the probe seeding, the
        // sandbox stage sync, the CLI itself) runs with the same access, so
        // that home is unusable in every scenario. Keeping the target is
        // better or equal in each case: a promoted credential keeps working,
        // and even a stale same-identity copy (#5028) can still work, while
        // the unreadable symlink cannot. A transient read failure also
        // self-corrects — the next seed with a readable source heals a
        // same-identity copy into the symlink — whereas removing the promoted
        // credential is irreversible. The #5028 heal therefore applies
        // exactly when the source is readable and the identities match.
        let sourceReadErrorCode: string | null = null;
        const sourceBytes = await fs
          .readFile(path.join(sourceHome, "auth.json"))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
              sourceReadErrorCode = error.code ?? "unknown";
            }
            return null;
          });
        const sourceIdentity = sourceBytes ? readSubscriptionAccountId(sourceBytes) : null;
        keepPromotedAuth = sourceIdentity !== targetIdentity;
        if (keepPromotedAuth && sourceReadErrorCode) {
          // Deferred heal, made visible: seeding runs before every probe and
          // every execute, so the next call with a readable source applies
          // the same-identity symlink heal this call could not decide.
          await onLog(
            "stdout",
            `[paperclip] Keeping the existing subscription auth.json in Codex home "${targetHome}" (shared source read failed: ${sourceReadErrorCode}); the next seed with a readable source reconciles it.\n`,
          );
        }
      }
      if (keepPromotedAuth) {
        await onLog(
          "stdout",
          `[paperclip] Keeping the promoted subscription auth.json in Codex home "${targetHome}".\n`,
        );
      } else {
        await fs.rm(authPath, { force: true });
      }
    }
  }

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
      // The kept promoted credential is authoritative for this home; the shared
      // symlink would silently swap the account back to the host login.
      if (name === "auth.json" && keepPromotedAuth) continue;
      const source = path.join(sourceHome, name);
      if (!(await pathExists(source))) continue;
      await ensureSymlink(path.join(targetHome, name), source);
    }

    await onLog(
      "stdout",
      `[paperclip] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Paperclip-managed"} Codex home "${targetHome}" (supported auth linked from "${sourceHome}").\n`,
    );
  }

  if (apiKey) {
    await writeApiKeyAuthJson(targetHome, apiKey);
    await onLog(
      "stdout",
      `[paperclip] Wrote API-key auth.json into Codex home "${targetHome}" from configured OPENAI_API_KEY.\n`,
    );
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
  options: { apiKey?: string | null; agentId?: string | null } = {},
): Promise<string> {
  const agentId = nonEmpty(options.agentId ?? undefined) ?? undefined;
  const targetHome = resolveManagedCodexHomeDir(env, companyId, agentId);
  if (companyId && agentId) {
    await ensureManagedCodexHomePath(env, companyId, agentId, targetHome);
    await quarantineLegacySharedProfileFiles(targetHome);
  }
  await seedManagedCodexHome(targetHome, env, onLog, options);
  return targetHome;
}

export type ReconcileManagedCodexHomeStatus =
  | "no_managed_home"
  | "external_override"
  | "already_seeded"
  | "source_auth_missing"
  | "seeded";

export interface ReconcileManagedCodexHomeInput {
  companyId: string | undefined;
  agentId?: string | null;
  configuredCodexHome: string | null | undefined;
  apiKey?: string | null;
  /**
   * Set when the agent's persisted `OPENAI_API_KEY` is a secret binding that
   * could not be resolved in this context (e.g. startup reconciliation, which
   * never resolves secrets). When true and the home already has usable auth,
   * reconciliation preserves that auth instead of downgrading it to the shared
   * subscription symlink.
   */
  apiKeySecretBound?: boolean;
  env?: NodeJS.ProcessEnv;
  onLog?: AdapterExecutionContext["onLog"];
}

export interface ReconcileManagedCodexHomeResult {
  status: ReconcileManagedCodexHomeStatus;
  home: string | null;
}

const noopOnLog: AdapterExecutionContext["onLog"] = async () => {};

/**
 * Idempotently reconciles a persisted `codex_local` agent home. Phase 1 seeds
 * managed homes at execute time; this is the backfill for agents that already
 * carry a persisted (but unseeded) per-agent `CODEX_HOME` and have not run
 * since the seeding fix landed. Shares the managed-home detection
 * (`isManagedCodexHomePath`) and seeding (`seedManagedCodexHome`) logic so a
 * genuine external/user override is never touched. Safe to re-run: when a valid
 * `auth.json` is already present (and no API-key rewrite is requested) it is a
 * no-op and reports `already_seeded`.
 */
export async function reconcileManagedCodexHome(
  input: ReconcileManagedCodexHomeInput,
): Promise<ReconcileManagedCodexHomeResult> {
  const env = input.env ?? process.env;
  const configured = nonEmpty(input.configuredCodexHome ?? undefined);
  if (!configured) return { status: "no_managed_home", home: null };

  const resolved = path.resolve(configured);
  const agentId = nonEmpty(input.agentId ?? undefined) ?? undefined;
  if (!isManagedCodexHomePath(env, input.companyId, resolved, agentId)) {
    return { status: "external_override", home: resolved };
  }
  let lease: Awaited<ReturnType<typeof acquireManagedCodexHomeLease>> | null = null;
  if (input.companyId && agentId) {
    await ensureManagedCodexHomePath(env, input.companyId, agentId, resolved);
    lease = await acquireManagedCodexHomeLease(resolved);
  }
  try {
    if (input.companyId && agentId) await quarantineLegacySharedProfileFiles(resolved);

  const apiKey = nonEmpty(input.apiKey ?? undefined);
  const hadUsableAuth = await codexHomeHasUsableAuth(resolved);

  // A secret-bound OPENAI_API_KEY cannot be resolved here, so we cannot rewrite
  // it into auth.json. If the home already has usable auth — typically an
  // API-key auth.json written at execute time when the secret WAS resolved —
  // preserve it. Re-seeding without the key would delete that file and restore
  // the shared subscription symlink, silently changing the agent's credentials
  // on every boot while the persisted config still says "use the secret key".
  if (input.apiKeySecretBound && await codexHomeHasRegularApiKeyAuth(resolved)) {
    await hardenRegularAuthFilePermissions(resolved);
    return { status: "already_seeded", home: resolved };
  }

  if (apiKey && await codexHomeHasMatchingApiKeyAuth(resolved, apiKey)) {
    await hardenRegularAuthFilePermissions(resolved);
    return { status: "already_seeded", home: resolved };
  }

  await seedManagedCodexHome(resolved, env, input.onLog ?? noopOnLog, { apiKey });

  if (!apiKey && !(await codexHomeHasUsableAuth(resolved))) {
    return { status: "source_auth_missing", home: resolved };
  }

  // Without an API key, seeding only changes disk state when auth was missing.
  // With an API key, the matching-file short-circuit above filters out the
  // already-seeded case before this write path.
  const status: ReconcileManagedCodexHomeStatus =
    !apiKey && hadUsableAuth ? "already_seeded" : "seeded";
  return { status, home: resolved };
  } finally {
    await lease?.release();
  }
}

export type CodexCredentialAuthMode = "api" | "subscription";

export interface CodexCredentialReadinessInput {
  env?: NodeJS.ProcessEnv;
  companyId: string | undefined;
  agentId?: string | null;
  /** `config.env.CODEX_HOME` for the run, if any. */
  configuredCodexHome: string | null | undefined;
  /** Resolved `config.env.OPENAI_API_KEY` value (after secret resolution). */
  configuredApiKey: string | null | undefined;
}

export interface CodexCredentialReadiness {
  /** True when Paperclip owns the effective home and is responsible for its auth. */
  managed: boolean;
  authMode: CodexCredentialAuthMode;
  /** True when a run launched now would be able to authenticate. */
  ready: boolean;
  effectiveHome: string;
  /** The shared source home subscription auth is symlinked from (managed homes only). */
  sharedSourceHome: string;
}

/**
 * Read-only predictor for whether a `codex_local` run will be able to
 * authenticate, without seeding or mutating any home. Mirrors the execute-time
 * fail-fast in `execute.ts`, factored out so the control plane can run the same
 * check *before* dispatch and surface a configuration-incomplete blocker instead
 * of dispatching a run that is guaranteed to fail with "no Codex credentials".
 *
 * - An external/user-supplied `CODEX_HOME` override manages its own auth, so it
 *   is always treated as ready (Paperclip must not seed or inspect it).
 * - A non-empty resolved `OPENAI_API_KEY` means API-key auth, always ready.
 * - Otherwise (subscription mode) the run needs a usable `auth.json`. Because a
 *   managed home symlinks `auth.json` from the shared source home at seed time,
 *   we treat the run as ready when either the (possibly already-seeded) effective
 *   home or the shared source home carries usable auth.
 */
export async function evaluateCodexCredentialReadiness(
  input: CodexCredentialReadinessInput,
): Promise<CodexCredentialReadiness> {
  const env = input.env ?? process.env;
  const configuredRaw = nonEmpty(input.configuredCodexHome ?? undefined);
  const configuredCodexHome = configuredRaw ? path.resolve(configuredRaw) : null;
  const configuredApiKey = nonEmpty(input.configuredApiKey ?? undefined);
  const sharedSourceHome = resolveSharedCodexHomeDir(env);

  const configuredHomeIsManaged =
    configuredCodexHome != null &&
    isManagedCodexHomePath(
      env,
      input.companyId,
      configuredCodexHome,
      nonEmpty(input.agentId ?? undefined) ?? undefined,
    );
  const configuredHomeIsInsideCompanyTree =
    configuredCodexHome != null &&
    await isReservedCodexHomePath(env, configuredCodexHome);
  const configuredManagedHomeMismatch =
    configuredHomeIsInsideCompanyTree && !configuredHomeIsManaged;
  const effectiveHomeIsManaged =
    configuredCodexHome == null || configuredHomeIsManaged || configuredManagedHomeMismatch;
  const effectiveHome = configuredCodexHome ?? resolveManagedCodexHomeDir(
    env,
    input.companyId,
    nonEmpty(input.agentId ?? undefined) ?? undefined,
  );

  if (configuredManagedHomeMismatch) {
    return {
      managed: true,
      authMode: configuredApiKey ? "api" : "subscription",
      ready: false,
      effectiveHome,
      sharedSourceHome,
    };
  }

  if (!effectiveHomeIsManaged) {
    // Genuine external override: Paperclip never seeds or inspects it.
    return {
      managed: false,
      authMode: configuredApiKey ? "api" : "subscription",
      ready: true,
      effectiveHome,
      sharedSourceHome,
    };
  }

  if (configuredApiKey) {
    return { managed: true, authMode: "api", ready: true, effectiveHome, sharedSourceHome };
  }

  const ready = await codexHomeHasUsableAuth(sharedSourceHome);
  return { managed: true, authMode: "subscription", ready, effectiveHome, sharedSourceHome };
}

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
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

function hasUsableAuthPayload(authPayload: unknown): boolean {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return false;
  }

  for (const [key, value] of Object.entries(authPayload as Record<string, unknown>)) {
    if (!AUTH_CREDENTIAL_KEYS.test(key)) continue;
    if (key.toLowerCase() === "token_type") continue;
    if (typeof value === "string" && value.trim().length > 0) return true;
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

/**
 * Seeds auth into an explicit Paperclip-managed `targetHome`. Symlinks
 * `auth.json` from the shared source home (so ChatGPT-subscription credentials
 * stay live and single-use refresh tokens are not copied) and — when an API key
 * is supplied — writes an API-key `auth.json` instead. Host profile config,
 * instructions, plugins, hooks, MCP declarations, and session state are never
 * inherited. Runtime-owned config and skills are rendered separately by their
 * existing explicit preparation paths.
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

  // If a previous run wrote an apikey-mode auth.json (regular file) and this
  // run has no apiKey, remove it so the chatgpt-mode symlink can be restored.
  // Without this cleanup, ensureSymlink bails on a non-symlink and Codex keeps
  // authenticating with the stale key after it is removed from configuration.
  if (!apiKey && seedFromShared) {
    const authPath = path.join(targetHome, "auth.json");
    const existing = await fs.lstat(authPath).catch(() => null);
    const sharedAuthExists = await pathExists(path.join(sourceHome, "auth.json"));
    if (existing && !sharedAuthExists && !existing.isDirectory()) {
      await fs.rm(authPath, { force: true });
    } else if (existing && sharedAuthExists && !existing.isSymbolicLink()) {
      await fs.rm(authPath, { force: true });
    }
  }

  if (seedFromShared) {
    for (const name of SYMLINKED_SHARED_FILES) {
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
